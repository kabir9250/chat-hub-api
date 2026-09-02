/**
 * T-05 TC-05.10 — Rating post-close (FR-CONV-07 / FR-WID-13).
 *
 * Closes a real Conversation, submits a Visitor rating+comment via the
 * public `POST .../rating` endpoint (`ConversationsController.submitRating`
 * — no auth, only requires the Conversation to already be closed), then
 * confirms it shows up both in the History list (score) and the transcript
 * detail view (score + comment) — FR-CONV-07's exact wording. Also checks
 * the guard that a rating cannot be submitted before closing (submitRating
 * throws `BadRequestException` unless `status === 'closed'`).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-05 TC-05.10 — Rating post-close (FR-CONV-07)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.10a: rating is rejected before the Conversation is closed', async () => {
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const convRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${initRes.body.token}`)
      .send({})
      .expect(201);
    const conversationId = convRes.body._id;

    const rejected = await request(server)
      .post(`/sites/${targetSiteId}/conversations/${conversationId}/rating`)
      .send({ ratingScore: 5, ratingComment: 'too early' })
      .expect(400);
    expect(rejected.body.message).toMatch(/closed/i);
  });

  it('TC-05.10b: after closing, a rating+comment is accepted (no auth) and appears in both History and the transcript detail', async () => {
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const convRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${initRes.body.token}`)
      .send({ initialMessage: 'Need help with billing' })
      .expect(201);
    const conversationId = convRes.body._id;

    await request(server)
      .patch(`/sites/${targetSiteId}/conversations/${conversationId}/status`)
      .set(...OWNER_AUTH)
      .send({ status: 'closed' })
      .expect(200);

    const ratingRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations/${conversationId}/rating`)
      .send({ ratingScore: 4, ratingComment: 'Quick and helpful, thanks!' })
      .expect(200);
    expect(ratingRes.body.ratingScore).toBe(4);
    expect(ratingRes.body.ratingComment).toBe('Quick and helpful, thanks!');

    // History list — score visible (FR-CONV-07: "History list (score)").
    const listRes = await request(server)
      .get(`/sites/${targetSiteId}/conversations?rating=4&limit=100`)
      .set(...OWNER_AUTH)
      .expect(200);
    const listItem = listRes.body.items.find(
      (c: { _id: string }) => c._id === conversationId,
    );
    expect(listItem).toBeTruthy();
    expect(listItem.ratingScore).toBe(4);

    // Transcript/detail panel — score + comment (FR-CONV-07: "transcript
    // panel (score + comment)").
    const detailRes = await request(server)
      .get(`/sites/${targetSiteId}/conversations/${conversationId}`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(detailRes.body.conversation.ratingScore).toBe(4);
    expect(detailRes.body.conversation.ratingComment).toBe(
      'Quick and helpful, thanks!',
    );
    expect(detailRes.body.messages.length).toBeGreaterThan(0);
  });

  it('TC-05.10c: a second rating submission on the same (already-rated) Conversation is rejected, not overwritten — Post-QA Fix 6 / FR-CONV-07 updated', async () => {
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const convRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${initRes.body.token}`)
      .send({})
      .expect(201);
    const conversationId = convRes.body._id;
    await request(server)
      .patch(`/sites/${targetSiteId}/conversations/${conversationId}/status`)
      .set(...OWNER_AUTH)
      .send({ status: 'closed' })
      .expect(200);

    await request(server)
      .post(`/sites/${targetSiteId}/conversations/${conversationId}/rating`)
      .send({ ratingScore: 2, ratingComment: 'meh' })
      .expect(200);
    const second = await request(server)
      .post(`/sites/${targetSiteId}/conversations/${conversationId}/rating`)
      .send({ ratingScore: 5, ratingComment: 'actually great' })
      .expect(400);

    // Fixed behavior (was: silent overwrite, score 2→5): the second
    // submission is now rejected with a clear "already rated" error, and
    // the original rating is left completely untouched.
    expect(second.body.message).toMatch(/already.*rated/i);

    const detailRes = await request(server)
      .get(`/sites/${targetSiteId}/conversations/${conversationId}`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(detailRes.body.conversation.ratingScore).toBe(2);
    expect(detailRes.body.conversation.ratingComment).toBe('meh');
  });

  it('TC-05.10d (guardrail): a returning Visitor rating a DIFFERENT (new) Conversation is unaffected by the same-Conversation guard', async () => {
    // Same Visitor session/token reused across two separate Conversations —
    // simulates a returning Visitor chatting again on a later occasion.
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const visitorAuth = `Bearer ${initRes.body.token}`;

    const firstConvRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', visitorAuth)
      .send({})
      .expect(201);
    const firstConversationId = firstConvRes.body._id;
    await request(server)
      .patch(
        `/sites/${targetSiteId}/conversations/${firstConversationId}/status`,
      )
      .set(...OWNER_AUTH)
      .send({ status: 'closed' })
      .expect(200);
    await request(server)
      .post(
        `/sites/${targetSiteId}/conversations/${firstConversationId}/rating`,
      )
      .send({ ratingScore: 3, ratingComment: 'first visit' })
      .expect(200);

    const secondConvRes = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', visitorAuth)
      .send({})
      .expect(201);
    const secondConversationId = secondConvRes.body._id;
    await request(server)
      .patch(
        `/sites/${targetSiteId}/conversations/${secondConversationId}/status`,
      )
      .set(...OWNER_AUTH)
      .send({ status: 'closed' })
      .expect(200);

    // A brand-new Conversation for the same Visitor rates independently —
    // the already-rated guard is scoped to one Conversation document only.
    const secondRatingRes = await request(server)
      .post(
        `/sites/${targetSiteId}/conversations/${secondConversationId}/rating`,
      )
      .send({ ratingScore: 5, ratingComment: 'second visit, much better' })
      .expect(200);
    expect(secondRatingRes.body.ratingScore).toBe(5);

    const firstDetail = await request(server)
      .get(`/sites/${targetSiteId}/conversations/${firstConversationId}`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(firstDetail.body.conversation.ratingScore).toBe(3);
  });
});
