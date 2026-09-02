/**
 * T-05 TC-05.3 — PageVisit exit + duration (SRS §4.4a, `PageVisitsService
 * .recordPageChange` / `.closeOpenPageVisitOnDisconnect`).
 *
 * Part A (page-change closes out the previous PageVisit): drives the same
 * "full page load" path a real multi-page site uses
 * (`POST /visitor-session/init` called again with a new `pageUrl`, per that
 * service's own doc comment on why `init()` is also a page-navigation event)
 * and confirms the FIRST PageVisit gets `exitedAt` set and `durationSeconds`
 * computed as the real elapsed time between the two calls.
 *
 * Part B (tab close / disconnect — Session Fix-08 fix, was TC-05.3b's
 * "finding"): connects a real Socket.IO visitor client (same pattern as
 * T-01's `websocket-authorization.e2e-spec.ts`) and disconnects it, then
 * confirms the last open PageVisit now DOES get closed out —
 * `RealtimeGateway.handleDisconnect`'s visitor branch now calls
 * `PageVisitsService.closeOpenPageVisitOnDisconnect`, gated on
 * `VisitorPresenceService`'s existing "zero connections remaining" signal,
 * reusing `recordPageChange`'s own exitedAt/capped-durationSeconds logic.
 * SRS §4.4a's "closes the tab" trigger is now implemented (see T-05 report's
 * "Fix Verified" section for the previous gap write-up).
 *
 * Part C (TC-05.3c, new — race guardrail): confirms a disconnect that
 * arrives just after a genuine page-change already closed the Visitor's
 * previous PageVisit does not re-touch/double-close that already-closed
 * record — it only ever affects whichever PageVisit is CURRENTLY open at
 * the moment the disconnect is processed.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { siteId } from '../helpers/fixtures';
import { PageVisit, PageVisitDocument } from '../../src/database/schemas';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Emits `visitor:page_changed` and waits for the handler's own response,
 * rather than an arbitrary sleep, so the race test below can reason
 * precisely about "the page-change has definitely landed" before triggering
 * the disconnect. Documented finding (T-01 report, `realtime-manual/helpers
 * .js`): this gateway's `@SubscribeMessage` handlers return `{event, data}`
 * shapes that NestJS's WS adapter delivers as a SEPARATE EMITTED event
 * (`socket.emit(event, data)`), NOT a socket.io ack callback — so this
 * listens for the named `page_change_recorded`/`error` response events
 * instead of using `emitWithAck`/an ack callback (which would silently time
 * out even on the success path). */
function emitPageChanged(socket: Socket, pageUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('page_change_recorded', onOk);
      socket.off('error', onErr);
      reject(new Error('timeout waiting for page_change_recorded/error'));
    }, 5000);
    function onOk() {
      clearTimeout(timer);
      socket.off('error', onErr);
      resolve();
    }
    function onErr(payload: { message?: string }) {
      clearTimeout(timer);
      socket.off('page_change_recorded', onOk);
      reject(new Error(payload?.message ?? 'page change rejected'));
    }
    socket.once('page_change_recorded', onOk);
    socket.once('error', onErr);
    socket.emit('visitor:page_changed', { pageUrl });
  });
}

function connectVisitor(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const timer = setTimeout(
      () => reject(new Error('WS connect timeout')),
      8000,
    );
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

describe('T-05 TC-05.3 — PageVisit exit + duration (SRS §4.4a)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;
  let pageVisitModel: Model<PageVisitDocument>;
  const targetSiteId = siteId('Site D');
  const sockets: Socket[] = [];

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    await app.listen(0);
    server = app.getHttpServer();
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    pageVisitModel = app.get(getModelToken(PageVisit.name));
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    // Deliberately not calling app.close() — same documented test-harness
    // trade-off T-01's websocket-authorization.e2e-spec.ts takes (see its
    // own afterAll comment): closing right after a socket disconnect races
    // RealtimeGateway.handleDisconnect's own in-flight async Mongo work and
    // reproducibly crashes the whole Jest process with an uncaught
    // MongoNotConnectedError outside any Promise this file can catch.
  });

  it('TC-05.3a: a page-change closes out the previous PageVisit with exitedAt + correctly-computed durationSeconds', async () => {
    const ip = nextFakeIp();
    const pageA = 'https://site-d.example.com/pricing';
    const pageB = 'https://site-d.example.com/features';

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: pageA })
      .expect(200);
    const { token, visitorId } = initRes.body;

    const firstVisit = await pageVisitModel
      .findOne({ visitorId, pageUrl: pageA })
      .sort({ enteredAt: -1 })
      .exec();
    expect(firstVisit).toBeTruthy();
    expect(firstVisit!.exitedAt).toBeNull();

    const waitMs = 2500;
    await sleep(waitMs);

    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: pageB })
      .expect(200);

    const closedFirstVisit = await pageVisitModel
      .findById(firstVisit!._id)
      .exec();
    expect(closedFirstVisit!.exitedAt).not.toBeNull();
    const actualElapsedSeconds =
      (closedFirstVisit!.exitedAt!.getTime() -
        closedFirstVisit!.enteredAt.getTime()) /
      1000;
    expect(actualElapsedSeconds).toBeGreaterThanOrEqual(waitMs / 1000 - 1);
    expect(closedFirstVisit!.durationSeconds).not.toBeNull();
    // durationSeconds should equal the real elapsed gap here (well under the
    // 30-minute cap page-visits.service.ts applies) — allow slack for
    // request/network overhead either side of the `waitMs` sleep.
    expect(closedFirstVisit!.durationSeconds).toBeGreaterThanOrEqual(
      Math.floor(waitMs / 1000) - 1,
    );
    expect(closedFirstVisit!.durationSeconds).toBeLessThan(waitMs / 1000 + 5);

    const secondVisit = await pageVisitModel
      .findOne({ visitorId, pageUrl: pageB })
      .sort({ enteredAt: -1 })
      .exec();
    expect(secondVisit).toBeTruthy();
    expect(secondVisit!.exitedAt).toBeNull();
    expect(secondVisit!.durationSeconds).toBeNull();
  }, 30_000);

  it('TC-05.3b (Session Fix-08 — was a FINDING, now fixed): closing the tab (WS disconnect) DOES close out the open PageVisit', async () => {
    const ip = nextFakeIp();
    const pageUrl = 'https://site-d.example.com/contact';

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl })
      .expect(200);
    const { token, visitorId } = initRes.body;

    const openVisit = await pageVisitModel
      .findOne({ visitorId, pageUrl })
      .sort({ enteredAt: -1 })
      .exec();
    expect(openVisit!.exitedAt).toBeNull();

    // Connect a visitor WebSocket (what the widget holds open while the tab
    // is open) then disconnect it (what happens when the tab/browser is
    // actually closed), and give the server a moment to process it.
    const socket = await connectVisitor(baseUrl, token);
    sockets.push(socket);
    const waitMs = 1200;
    await sleep(waitMs);
    socket.disconnect();
    await sleep(1000);

    const afterDisconnect = await pageVisitModel
      .findById(openVisit!._id)
      .exec();
    // FIXED per SRS §4.4a ("set when the Visitor ... closes the tab, or the
    // session ends"): RealtimeGateway.handleDisconnect's visitor branch now
    // calls PageVisitsService.closeOpenPageVisitOnDisconnect, gated on
    // VisitorPresenceService's "zero connections remaining" signal
    // (`wentOffline`) — see that method's own doc comment. exitedAt should
    // now be set, and durationSeconds a sensible, non-null figure reflecting
    // the real elapsed gap (well under the 30-minute cap here).
    expect(afterDisconnect!.exitedAt).not.toBeNull();
    const actualElapsedSeconds =
      (afterDisconnect!.exitedAt!.getTime() -
        afterDisconnect!.enteredAt.getTime()) /
      1000;
    expect(actualElapsedSeconds).toBeGreaterThanOrEqual(waitMs / 1000 - 1);
    expect(afterDisconnect!.durationSeconds).not.toBeNull();
    expect(afterDisconnect!.durationSeconds).toBeGreaterThanOrEqual(
      Math.floor(waitMs / 1000) - 1,
    );
    // Sensible upper bound too — this must be the real elapsed gap (~1-3s
    // here), not something wildly inflated or the full 30-minute cap.
    expect(afterDisconnect!.durationSeconds).toBeLessThan(waitMs / 1000 + 10);
  }, 20_000);

  it('TC-05.3c (Session Fix-08 — race guardrail): a disconnect racing a genuine page-change never double-closes / re-touches the already-closed PageVisit', async () => {
    const ip = nextFakeIp();
    const pageA = 'https://site-d.example.com/race-a';
    const pageB = 'https://site-d.example.com/race-b';

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: pageA })
      .expect(200);
    const { token, visitorId } = initRes.body;

    const visitA = await pageVisitModel
      .findOne({ visitorId, pageUrl: pageA })
      .sort({ enteredAt: -1 })
      .exec();
    expect(visitA!.exitedAt).toBeNull();

    const socket = await connectVisitor(baseUrl, token);
    sockets.push(socket);

    // Genuine page-change first (the "recordPageChange already closed this
    // moments earlier" half of the race) — this closes out visitA and opens
    // visitB, exactly like a real SPA route change over the same socket the
    // widget already holds open.
    await sleep(200);
    await emitPageChanged(socket, pageB);

    const visitAAfterPageChange = await pageVisitModel
      .findById(visitA!._id)
      .exec();
    expect(visitAAfterPageChange!.exitedAt).not.toBeNull();
    const closedExitedAt = visitAAfterPageChange!.exitedAt!.getTime();
    const closedDuration = visitAAfterPageChange!.durationSeconds;

    const visitB = await pageVisitModel
      .findOne({ visitorId, pageUrl: pageB })
      .sort({ enteredAt: -1 })
      .exec();
    expect(visitB!.exitedAt).toBeNull();

    // Now the disconnect (the "racing" half) — at this point visitB, not
    // visitA, is the currently-open PageVisit, so the disconnect handler
    // must close out visitB and must leave visitA's already-set
    // exitedAt/durationSeconds completely untouched.
    await sleep(150);
    socket.disconnect();
    await sleep(1000);

    const visitAFinal = await pageVisitModel.findById(visitA!._id).exec();
    expect(visitAFinal!.exitedAt!.getTime()).toBe(closedExitedAt);
    expect(visitAFinal!.durationSeconds).toBe(closedDuration);

    const visitBFinal = await pageVisitModel.findById(visitB!._id).exec();
    expect(visitBFinal!.exitedAt).not.toBeNull();
    expect(visitBFinal!.durationSeconds).not.toBeNull();
  }, 20_000);
});
