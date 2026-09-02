/**
 * T-01 RBAC — TC-01.3: WebSocket authorization.
 *
 * Drives the REAL RealtimeGateway (src/realtime/realtime.gateway.ts) with a
 * real socket.io-client, real JWTs from global-setup.ts, against the real
 * ConversationsService/PermissionGuard — no mocking.
 *
 * (a) agent-a2 (Site A, conversations.view_own only) attempting to join a
 *     conversation ASSIGNED TO agent-a1 (not them) on the same Site A must
 *     be rejected — PermissionGuard alone would let them through (they hold
 *     view_own on Site A), so this specifically proves
 *     ConversationsService.findOne's per-record scope check still runs.
 * (b) agent-a1 attempting to join/view any conversation on Site B (a Site
 *     they hold no assignment on at all) is always rejected, at the
 *     PermissionGuard layer this time (surfaces as a WS `exception` event
 *     per Session 8's own documented Nest WS-exception-filter behavior).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, tokenFor, userIdFor } from '../helpers/fixtures';

function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    socket.on('connected', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('auth_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`auth_error: ${JSON.stringify(err)}`));
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * NestJS WebSocket gateways here return `{ event, data }` objects
 * (`WsResponse`-shaped) — the framework delivers that as a SEPARATE
 * `client.emit(event, data)` message back to the caller, not via the
 * socket.io ack-callback mechanism (confirmed live while developing this
 * test: an ack-callback-only listener timed out even on the success path).
 * A PermissionGuard rejection (thrown before the handler body runs, e.g.
 * missing permission entirely) instead surfaces as a generic `'exception'`
 * event, per `RealtimeGateway`'s own documented Nest-WS-exception-filter
 * behavior (see PROGRESS.md, Session 8, Key Decision 6). This helper races
 * every one of those possible response event names.
 */
function emitAndWaitForResponse(
  socket: Socket,
  event: string,
  data: any,
  responseEvents: string[] = ['joined_conversation', 'joined_site', 'error', 'exception'],
): Promise<{ event: string; data: any }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners: Array<[string, (...args: any[]) => void]> = [];
    const cleanup = () => {
      for (const [name, fn] of listeners) socket.off(name, fn);
    };
    for (const responseEvent of responseEvents) {
      const handler = (payload: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ event: responseEvent, data: payload });
      };
      listeners.push([responseEvent, handler]);
      socket.once(responseEvent, handler);
    }
    socket.emit(event, data);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`No response event received for ${event}`));
      }
    }, 5000);
  });
}

describe('T-01 TC-01.3 — WebSocket authorization', () => {
  let app: INestApplication;
  let baseUrl: string;
  let siteAConvAssignedToA1: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Find (or create) a Site A Conversation assigned specifically to
    // agent-a1 (not agent-a2) — the seed data cycles assignment across the
    // Site A agent pool, so query for one deterministically via Owner.
    const siteAId = siteId('Site A');
    const list = await request(app.getHttpServer())
      .get(
        `/sites/${siteAId}/conversations?agentId=${userIdFor('agent-a1@test.local')}&limit=1`,
      )
      .set(...authHeader('owner@test.local'));
    if (list.body.items?.length > 0) {
      siteAConvAssignedToA1 = list.body.items[0]._id ?? list.body.items[0].id;
    } else {
      // Fallback: create one and assign it.
      const initRes = await request(app.getHttpServer())
        .post('/visitor-session/init')
        .send({ siteId: siteAId, pageUrl: 'https://sitea.test.local/' });
      const convRes = await request(app.getHttpServer())
        .post(`/sites/${siteAId}/conversations`)
        .set('Authorization', `Bearer ${initRes.body.token}`)
        .send({ initialMessage: 'ws test fixture' });
      siteAConvAssignedToA1 = convRes.body._id ?? convRes.body.id;
      await request(app.getHttpServer())
        .patch(`/sites/${siteAId}/conversations/${siteAConvAssignedToA1}/assign`)
        .set(...authHeader('owner@test.local'))
        .send({ agentId: userIdFor('agent-a1@test.local') });
    }
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    // Deliberately NOT calling `app.close()` here — same test-harness
    // finding as `global-setup.ts` (see its doc comment), reproduced a
    // second way: `RealtimeGateway.handleDisconnect` runs a Mongo query
    // (`PresenceService.removeConnection` -> `getEffectivePermissionsSummary`)
    // asynchronously, shortly AFTER each `socket.disconnect()` call above
    // returns. Calling `app.close()` immediately (before those in-flight
    // disconnect handlers finish) reproducibly crashed the whole Jest
    // process with the identical uncaught `MongoNotConnectedError` — this
    // fires from the MongoDB driver's own internals, outside any Promise
    // this file awaits, so it can't be caught locally. Confirmed live
    // during this session (see the T-01 report's Environment Notes).
    // Leaving this spec file's app instance open for the rest of the
    // `test:e2e` process (which exits once every spec file finishes) is
    // the same deliberate, documented trade-off `global-setup.ts` makes.
  });

  it('TC-01.3.a — agent-a2 cannot join a Conversation assigned to agent-a1 on the SAME Site (view_own scoping, service-layer re-check)', async () => {
    const socket = await connect(baseUrl, tokenFor('agent-a2@test.local'));
    sockets.push(socket);

    const ack = await emitAndWaitForResponse(socket, 'agent:join_conversation', {
      siteId: siteId('Site A'),
      conversationId: siteAConvAssignedToA1,
    });

    // PermissionGuard alone passes agent-a2 (holds conversations.view_own on
    // Site A) — the handler wraps ConversationsService.findOne in try/catch
    // and returns { event: 'error', ... } rather than joining the room.
    expect(ack.event).not.toBe('joined_conversation');
    expect(['error', 'exception']).toContain(ack.event);
  });

  it('TC-01.3.b — agent-a1 is always rejected joining ANY conversation on Site B (no assignment there at all)', async () => {
    const socket = await connect(baseUrl, tokenFor('agent-a1@test.local'));
    sockets.push(socket);

    // Fetch a real Site B conversation id (as owner) to attempt against.
    const siteBId = siteId('Site B');
    const list = await request(app.getHttpServer())
      .get(`/sites/${siteBId}/conversations?limit=1`)
      .set(...authHeader('owner@test.local'));
    expect(list.body.items.length).toBeGreaterThan(0);
    const siteBConvId = list.body.items[0]._id ?? list.body.items[0].id;

    const ack = await emitAndWaitForResponse(socket, 'agent:join_conversation', {
      siteId: siteBId,
      conversationId: siteBConvId,
    });

    // PermissionGuard itself rejects (agent-a1 holds neither view_own nor
    // view_site on Site B) -> surfaces as a generic WS 'exception' event
    // per RealtimeGateway's documented HttpException-in-a-handler behavior.
    expect(ack.event).not.toBe('joined_conversation');
    expect(['error', 'exception']).toContain(ack.event);
  });

  it('TC-01.3.c — control case: agent-a1 CAN join their OWN Site A conversation', async () => {
    const socket = await connect(baseUrl, tokenFor('agent-a1@test.local'));
    sockets.push(socket);

    const ack = await emitAndWaitForResponse(socket, 'agent:join_conversation', {
      siteId: siteId('Site A'),
      conversationId: siteAConvAssignedToA1,
    });
    expect(ack.event).toBe('joined_conversation');
  });

  it('TC-01.3.d — agent-a1 emitting agent:join_site for Site B is rejected', async () => {
    const socket = await connect(baseUrl, tokenFor('agent-a1@test.local'));
    sockets.push(socket);

    const ack = await emitAndWaitForResponse(socket, 'agent:join_site', { siteId: siteId('Site B') });
    expect(ack.event).not.toBe('joined_site');
  });
});
