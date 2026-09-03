/**
 * Regression test for a live QA finding (screenshot: visitor "ali",
 * "Past visits: 0, Past chats: 1", only 8 minutes between First/Last seen).
 *
 * Root cause: `ConversationsService.findAll`'s `beforeConversationId`
 * scoping ("Past chats") used to count ANY earlier Conversation by a bare
 * `startedAt < ref.startedAt`, with no awareness of visit sessions — while
 * `VisitorsService.findVisits`'s `beforeConversationId` scoping ("Past
 * visits") already deliberately excludes any visit-group that's part of
 * the CURRENT Conversation's own visit session
 * (`computeVisitorPathLowerBound`). Two Conversations only minutes apart,
 * in the same continuous browsing session, produced "Past chats: 1" (the
 * earlier Conversation counted) alongside "Past visits: 0" (correctly, no
 * separate earlier visit exists) — individually correct, contradictory
 * together.
 *
 * The fix makes `findAll`'s `beforeConversationId` use the exact same
 * visit-boundary helpers `findVisits` already does, so the two agree by
 * construction: a same-visit-session earlier chat no longer counts as
 * "past," but a genuinely earlier VISIT's chat still does.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';
import { PageVisit, PageVisitDocument } from '../../src/database/schemas';

describe('Regression — "Past chats" agrees with "Past visits" across the same visit session', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let pageVisitModel: Model<PageVisitDocument>;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
    pageVisitModel = app.get(getModelToken(PageVisit.name));
  });

  afterAll(async () => {
    await app.close();
  });

  it('two Conversations minutes apart in the SAME visit session: Past chats and Past visits both read 0 for the second one', async () => {
    const ip = nextFakeIp();

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;

    // Chat 1 — the visitor's very first Conversation.
    const convA = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ initialMessage: 'hello (chat 1)' })
      .expect(201);

    await new Promise((r) => setTimeout(r, 50));

    // A real page load in between (the "ali" scenario: browsed a bit more,
    // same tab, same never-closed session) — without this, the Visitor's
    // only PageVisit is the one `init()` opened above and never revisited,
    // which is an unrealistic shape for "still actively on the same visit"
    // and isn't what this regression is about.
    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/pricing' })
      .expect(200);

    // Chat 2 — a few seconds later, same tab, same never-closed browsing
    // session (closed chat 1, reopened the widget, started chat 2, all
    // within the same visit).
    const convB = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ initialMessage: 'hello again (chat 2)' })
      .expect(201);

    const [pastChatsRes, pastVisitsRes] = await Promise.all([
      request(server)
        .get(`/sites/${targetSiteId}/conversations`)
        .query({ visitorId, beforeConversationId: convB.body._id, limit: 20 })
        .set(...OWNER_AUTH)
        .expect(200),
      request(server)
        .get(`/sites/${targetSiteId}/visitors/${visitorId}/visits`)
        .query({ beforeConversationId: convB.body._id, limit: 20 })
        .set(...OWNER_AUTH)
        .expect(200),
    ]);

    // Before the fix: pastChatsRes.body.total was 1 (counted convA) while
    // pastVisitsRes.body.total was already (correctly) 0 — the exact
    // contradiction from the live QA screenshot.
    expect(pastChatsRes.body.total).toBe(0);
    expect(
      pastChatsRes.body.items.map((c: { _id: string }) => c._id),
    ).not.toContain(convA.body._id);
    expect(pastVisitsRes.body.total).toBe(0);
  });

  it('control: a genuinely earlier, separate visit\'s Conversation still counts as a past chat', async () => {
    const ip = nextFakeIp();

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;

    const convA = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ initialMessage: 'visit 1 chat' })
      .expect(201);

    // Back-date this Visitor's PageVisit history past the 30-minute gap —
    // same technique TC-05.5a uses to simulate a genuinely separate later
    // visit without a real 30-minute wait.
    const fortyMinAgo = new Date(Date.now() - 40 * 60_000);
    await pageVisitModel.updateMany(
      { visitorId },
      { $set: { enteredAt: fortyMinAgo, exitedAt: fortyMinAgo } },
    );

    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/pricing' })
      .expect(200);

    const convB = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ initialMessage: 'visit 2 chat' })
      .expect(201);

    const pastChatsRes = await request(server)
      .get(`/sites/${targetSiteId}/conversations`)
      .query({ visitorId, beforeConversationId: convB.body._id, limit: 20 })
      .set(...OWNER_AUTH)
      .expect(200);

    expect(pastChatsRes.body.total).toBe(1);
    expect(pastChatsRes.body.items[0]._id).toBe(convA.body._id);
  });
});
