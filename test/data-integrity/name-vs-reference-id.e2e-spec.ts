/**
 * T-05 TC-05.7 — Name-vs-ID display rule (Phase 2 FR-P2-ID-01/02).
 *
 * FR-P2-ID-01/02 are UI rendering rules ("the display label shall be: the
 * Visitor's name if set, otherwise the Conversation's reference number ...
 * evaluated fresh at render time" / "the window title, the Inbox list entry
 * ... shall update live"). This is a Jest+Supertest (backend) suite, so it
 * cannot assert what actually renders in the Inbox list, window title bar,
 * or History list — that is `chat-hub-web`'s concern, covered (if at all)
 * by a Playwright spec, not this one. What this suite DOES verify is the
 * data contract those views are built from: (a) an unnamed Visitor's
 * Conversation is returned with `visitor.name: null` and a real
 * `referenceNumber` everywhere the frontend would need to fall back to it
 * (list, detail), and (b) submitting the pre-chat form flips `name` to a
 * real value on every one of those same read paths AND fires the exact
 * `visitor.profileUpdated` WebSocket event FR-P2-ID-02 says the frontend
 * reuses to update live, with the new name in the payload — i.e. the
 * backend gives the frontend everything it needs to satisfy FR-P2-ID-01/02;
 * whether the frontend actually does so live, with no manual refresh, is
 * NOT verified here and should be confirmed with a Playwright spec.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

function connectAndJoin(
  url: string,
  token: string,
  siteIdValue: string,
  conversationId: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const timer = setTimeout(() => reject(new Error('WS timeout')), 8000);
    socket.on('connected', () => {
      socket.once('joined_conversation', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('exception', (err) => {
        clearTimeout(timer);
        reject(new Error(`join rejected: ${JSON.stringify(err)}`));
      });
      socket.emit('agent:join_conversation', { siteId: siteIdValue, conversationId });
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('T-05 TC-05.7 — Name-vs-ID display data contract (FR-P2-ID-01/02)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    await app.listen(0);
    server = app.getHttpServer();
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    // Deliberately NOT calling app.close() here — this spec disconnects a
    // WebSocket mid-test; closing right after races
    // RealtimeGateway.handleDisconnect's own in-flight async Mongo work and
    // can crash the whole Jest process with an uncaught
    // MongoNotConnectedError (same documented trade-off as T-01's
    // websocket-authorization.e2e-spec.ts and this session's
    // business-hours-online-state.e2e-spec.ts).
  });

  it('TC-05.7a/b: unnamed Visitor -> name null + real referenceNumber everywhere; submitting the pre-chat form updates name live via visitor.profileUpdated', async () => {
    const ip = nextFakeIp();

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;

    const convRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    const conversationId = convRes.body._id;
    expect(convRes.body.referenceNumber).toMatch(/^#\d{8,}$/);

    // (a) Unnamed state, verified on every read path an Inbox/History
    // list or a detail view could source its label from.
    const detail = await request(server)
      .get(`/sites/${targetSiteId}/conversations/${conversationId}`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(detail.body.conversation.visitorId.name).toBeNull();
    expect(detail.body.conversation.referenceNumber).toBe(convRes.body.referenceNumber);

    const listRes = await request(server)
      .get(`/sites/${targetSiteId}/conversations?limit=50`)
      .set(...OWNER_AUTH)
      .expect(200);
    const listItem = listRes.body.items.find(
      (c: { _id: string }) => c._id === conversationId,
    );
    expect(listItem).toBeTruthy();
    expect(listItem.visitorId.name).toBeNull();
    expect(listItem.referenceNumber).toBe(convRes.body.referenceNumber);

    // (b) Agent has the conversation window open (joined the room) BEFORE
    // the name is submitted — this is the live-update scenario FR-P2-ID-02
    // describes.
    const agentSocket = await connectAndJoin(
      baseUrl,
      // Re-use the JWT from an authenticated user login for the room join —
      // fetched fresh here rather than importing tokenFor to keep this
      // spec file's only external dependency on shared fixtures to siteId.
      (
        await request(server)
          .post('/auth/login')
          .send({ email: 'owner@test.local', password: 'Test1234!' })
      ).body.accessToken,
      targetSiteId,
      conversationId,
    );

    const profileUpdatedPromise = new Promise<any>((resolve) => {
      agentSocket.once('visitor.profileUpdated', resolve);
    });

    await request(server)
      .patch('/visitor-session/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jordan Rivera', email: 'jordan.rivera@example.com' })
      .expect(200);

    const event = await profileUpdatedPromise;
    expect(event.visitor.name).toBe('Jordan Rivera');
    expect(event.conversationId).toBe(conversationId);
    agentSocket.disconnect();

    // Same data, now reflecting the name, on every read path again.
    const detailAfter = await request(server)
      .get(`/sites/${targetSiteId}/conversations/${conversationId}`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(detailAfter.body.conversation.visitorId.name).toBe('Jordan Rivera');

    const listAfter = await request(server)
      .get(`/sites/${targetSiteId}/conversations?limit=50`)
      .set(...OWNER_AUTH)
      .expect(200);
    const listItemAfter = listAfter.body.items.find(
      (c: { _id: string }) => c._id === conversationId,
    );
    expect(listItemAfter.visitorId.name).toBe('Jordan Rivera');
  }, 30_000);
});
