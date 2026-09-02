/**
 * T-05 TC-05.6 — Business hours + online state (FR-HRS-01/02, FR-WID-09/10).
 *
 * `WidgetBootstrapService.getStatus()` (widget-bootstrap.service.ts) is the
 * one function under test: `online = agentOnline && withinBusinessHours`.
 * `withinBusinessHours` is computed from `new Date()` at call time via
 * `Intl.DateTimeFormat`, so the clock is mocked with Jest's modern fake
 * timers restricted to JUST `Date` (`doNotFake` lists every timer/async
 * primitive Mongoose/Socket.IO/Supertest need to keep working for real) —
 * this runs the REAL app in-process (`createDataIntegrityTestApp`), so
 * faking the process's global `Date` genuinely changes what the server-side
 * code being tested sees, without needing to wait real wall-clock hours.
 *
 * `agentOnline` needs a real Socket.IO connection from an enabled User
 * scoped to the Site (PresenceService.isOnline, in-memory, real) —
 * `owner@test.local` is Organization-scoped so it reaches Site D (the seed
 * data's dedicated "no dedicated Agent/Supervisor" fixture Site, per
 * reports/README.md), keeping this test's Site untouched by any other
 * spec's business-hours/agent-presence side effects.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';

import { createDataIntegrityTestApp } from './helpers/app';
import { authHeader, siteId, tokenFor } from '../helpers/fixtures';

function connectUser(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    socket.on('connected', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** The exact weekday-key derivation `WidgetBootstrapService.isWithinBusinessHours`
 * uses internally (`Intl.DateTimeFormat` weekday, lowercased/sliced to 3 chars),
 * reused here so the test's business-hours schedule always targets whatever day
 * the (possibly mocked) `atTime` actually falls on — never a hardcoded weekday
 * name that could silently mismatch. */
function dayKeyFor(atTime: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).formatToParts(atTime);
  return (parts.find((p) => p.type === 'weekday')?.value ?? '').toLowerCase().slice(0, 3);
}

describe('T-05 TC-05.6 — Business hours + online state (FR-HRS-01/02)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;
  let ownerSocket: Socket;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');

  // Fixed reference date — only the wall-clock TIME OF DAY varies between
  // test cases below; the weekday (and therefore which weeklySchedule key
  // applies) stays identical, computed dynamically via dayKeyFor() so this
  // test never depends on which real day it happens to run on.
  const REFERENCE_DATE = new Date('2026-03-10T00:00:00.000Z');
  const TIMEZONE = 'UTC';
  const dayKey = dayKeyFor(REFERENCE_DATE, TIMEZONE);

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    await app.listen(0);
    server = app.getHttpServer();
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Business hours: 9am-5pm on the reference weekday only.
    await request(server)
      .patch(`/sites/${targetSiteId}/business-hours`)
      .set(...OWNER_AUTH)
      .send({
        enabled: true,
        timezone: TIMEZONE,
        weeklySchedule: { [dayKey]: ['09:00-17:00'] },
      })
      .expect(200);

    // Bring an Owner-scoped (reaches Site D) Agent connection online.
    ownerSocket = await connectUser(baseUrl, tokenFor('owner@test.local'));
  });

  afterAll(async () => {
    ownerSocket?.disconnect();
    jest.useRealTimers();
    // Deliberately NOT calling app.close() here — same documented
    // test-harness trade-off T-01's websocket-authorization.e2e-spec.ts
    // takes (see its own afterAll comment): closing right after a socket
    // disconnect races RealtimeGateway.handleDisconnect's own in-flight
    // async Mongo work and reproducibly crashes the whole Jest process with
    // an uncaught MongoNotConnectedError outside any Promise this file can
    // catch. Confirmed live while running this exact spec file.
  });

  function mockTimeOfDay(hour: number, minute = 0): void {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    const mocked = new Date(REFERENCE_DATE);
    mocked.setUTCHours(hour, minute, 0, 0);
    jest.setSystemTime(mocked);
  }

  it('TC-05.6a: 10am (within 9-5 business hours) + an online Agent -> widget reports Online', async () => {
    mockTimeOfDay(10);
    try {
      const res = await request(server)
        .get(`/widget-bootstrap/${targetSiteId}/status`)
        .expect(200);
      expect(res.body.agentOnline).toBe(true);
      expect(res.body.withinBusinessHours).toBe(true);
      expect(res.body.online).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TC-05.6b: 8pm (outside 9-5 business hours) -> widget reports Offline and offers the offline form', async () => {
    mockTimeOfDay(20);
    try {
      const statusRes = await request(server)
        .get(`/widget-bootstrap/${targetSiteId}/status`)
        .expect(200);
      // Agent presence is unaffected by the clock — still connected — but
      // business hours alone must be enough to flip `online` to false.
      expect(statusRes.body.agentOnline).toBe(true);
      expect(statusRes.body.withinBusinessHours).toBe(false);
      expect(statusRes.body.online).toBe(false);

      const bootstrapRes = await request(server)
        .get(`/widget-bootstrap/${targetSiteId}`)
        .expect(200);
      expect(bootstrapRes.body.widgetConfig.offlineFormEnabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TC-05.6c (control): with the Agent disconnected, 10am (within hours) is still reported Offline', async () => {
    ownerSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300)); // let handleDisconnect's presence update land
    mockTimeOfDay(10);
    try {
      const res = await request(server)
        .get(`/widget-bootstrap/${targetSiteId}/status`)
        .expect(200);
      expect(res.body.agentOnline).toBe(false);
      expect(res.body.withinBusinessHours).toBe(true);
      expect(res.body.online).toBe(false);
    } finally {
      jest.useRealTimers();
      ownerSocket = await connectUser(baseUrl, tokenFor('owner@test.local'));
    }
  });
});
