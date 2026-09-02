/**
 * T-05 TC-05.5 — pastVisitsCount / pastChatsCount increment (FR-VIS-05).
 *
 * `pastVisitsCount` (visitor-session.service.ts `init()`) only increments
 * when `PageVisitsService.isNewVisit()` says the incoming page load starts a
 * genuinely NEW visit (a >30-minute gap since the Visitor's last known page
 * activity, or no history at all) — deliberately NOT on every `init()` call,
 * per that method's own documented bug-fix history (a Visitor browsing 5
 * pages in one sitting must count as 1 visit, not 5). This spec proves both
 * halves: no increment within the same visit, and a real increment once a
 * genuine gap has passed (simulated here by directly back-dating the
 * Visitor's last PageVisit rather than waiting 30 real minutes).
 *
 * `pastChatsCount` (`ConversationsService.create`) increments by exactly 1
 * per Conversation created, independent of the visit-gap logic above.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { siteId } from '../helpers/fixtures';
import { PageVisit, PageVisitDocument, Visitor, VisitorDocument } from '../../src/database/schemas';

describe('T-05 TC-05.5 — pastVisitsCount / pastChatsCount increment (FR-VIS-05)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let pageVisitModel: Model<PageVisitDocument>;
  let visitorModel: Model<VisitorDocument>;
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
    pageVisitModel = app.get(getModelToken(PageVisit.name));
    visitorModel = app.get(getModelToken(Visitor.name));
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.5a: pastVisitsCount does NOT increment across multiple page loads within the same visit, but DOES increment on a genuinely new (>30min gap) visit', async () => {
    const ip = nextFakeIp();

    const initRes1 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes1.body;
    expect(initRes1.body.pastVisitsCount).toBe(1);
    expect(initRes1.body.isReturningVisitor).toBe(false);

    // Second "page load" (full-page-nav style, same resumed session token)
    // immediately after the first — still the SAME visit.
    const initRes2 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/pricing' })
      .expect(200);
    expect(initRes2.body.isReturningVisitor).toBe(true);
    expect(initRes2.body.pastVisitsCount).toBe(1);

    // Simulate 40 real minutes having passed: back-date this Visitor's most
    // recent PageVisit's enteredAt/exitedAt past the 30-minute
    // CURRENT_VISIT_GAP_MINUTES threshold `isNewVisit()` checks against.
    const fortyMinAgo = new Date(Date.now() - 40 * 60_000);
    await pageVisitModel.updateMany(
      { visitorId },
      { $set: { enteredAt: fortyMinAgo, exitedAt: fortyMinAgo } },
    );

    const initRes3 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    expect(initRes3.body.isReturningVisitor).toBe(true);
    expect(initRes3.body.pastVisitsCount).toBe(2);

    const visitorDoc = await visitorModel.findById(visitorId).lean().exec();
    expect(visitorDoc!.pastVisitsCount).toBe(2);
  });

  it('TC-05.5b: pastChatsCount increments by exactly 1 per Conversation created', async () => {
    const ip = nextFakeIp();
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;
    expect(initRes.body.pastChatsCount).toBe(0);

    const conv1 = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(conv1.body.referenceNumber).toBeTruthy();

    let visitorDoc = await visitorModel.findById(visitorId).lean().exec();
    expect(visitorDoc!.pastChatsCount).toBe(1);

    const conv2 = await request(server)
      .post(`/sites/${targetSiteId}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(conv2.body._id).not.toBe(conv1.body._id);

    visitorDoc = await visitorModel.findById(visitorId).lean().exec();
    expect(visitorDoc!.pastChatsCount).toBe(2);
  });
});
