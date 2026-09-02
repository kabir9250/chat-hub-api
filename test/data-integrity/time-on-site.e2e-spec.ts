/**
 * T-05 TC-05.4 — Time-on-site calculation (Phase 2 FR-P2-PANEL-03).
 *
 * FR-P2-PANEL-03: "a live 'Time on site' value for the current/active visit
 * — computed as the sum of durationSeconds across the current visit's
 * PageVisit records, including the still-open (no exitedAt) entry counted
 * up to 'now'." The panel itself sums this client-side (per
 * `ConversationsController.getCurrentVisit`'s own doc comment: "the source
 * the floating window Visitor Info panel builds ... the live Time-on-site
 * sum from, client-side") — this test verifies the backend source data
 * (`GET .../current-visit`'s `pages` array) is exactly right for a Visitor
 * with 3 PageVisits summing to 5m30s (330s), which is the one thing that
 * actually determines whether the panel's client-side sum comes out
 * correct.
 *
 * All 3 PageVisits are pre-closed with fixed `durationSeconds` (not the
 * still-open case) — deliberately, so the expected total is a fixed 330s
 * rather than "whatever `Date.now()` happens to be" at assertion time.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';

import { createDataIntegrityTestApp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';
import {
  Site,
  SiteDocument,
  Visitor,
  VisitorDocument,
  PageVisit,
  PageVisitDocument,
} from '../../src/database/schemas';
import { ConversationsService } from '../../src/conversations/conversations.service';

describe('T-05 TC-05.4 — Time-on-site calculation (FR-P2-PANEL-03)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let visitorModel: Model<VisitorDocument>;
  let pageVisitModel: Model<PageVisitDocument>;
  let siteModel: Model<SiteDocument>;
  let conversationsService: ConversationsService;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
    visitorModel = app.get(getModelToken(Visitor.name));
    pageVisitModel = app.get(getModelToken(PageVisit.name));
    siteModel = app.get(getModelToken(Site.name));
    conversationsService = app.get(ConversationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.4: 3 PageVisits summing to 5m30s (330s) produce a current-visit `pages` list whose durationSeconds sum to exactly 330', async () => {
    const site = await siteModel.findById(targetSiteId).exec();
    const visitor = await visitorModel.create({
      siteId: site!._id,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      pastVisitsCount: 1,
      pastChatsCount: 0,
      name: 'Time On Site Test Visitor',
    });

    const t0 = new Date(Date.now() - 20 * 60_000); // 20 min ago
    const durations = [100, 120, 110]; // seconds, sums to 330 (5m30s)
    const pageVisitDocs: { enteredAt: Date; exitedAt: Date }[] = [];
    let cursor = t0.getTime();
    for (const d of durations) {
      const enteredAt = new Date(cursor);
      const exitedAt = new Date(cursor + d * 1000);
      pageVisitDocs.push({ enteredAt, exitedAt });
      cursor = exitedAt.getTime() + 5_000; // 5s gap between pages, well under the 30-min new-visit threshold
    }

    await pageVisitModel.insertMany(
      pageVisitDocs.map((p, i) => ({
        siteId: site!._id,
        visitorId: visitor._id,
        conversationId: null,
        pageUrl: `https://site-d.example.com/page-${i}`,
        pageCategory: null,
        enteredAt: p.enteredAt,
        exitedAt: p.exitedAt,
        durationSeconds: durations[i],
      })),
    );

    // Conversation starts just after the last page visit closed — no
    // earlier/later Conversation exists for this Visitor, so the whole
    // 3-page visit session (all within the 30-min gap) falls inside this
    // Conversation's own path lower/upper bound.
    const conversation = await conversationsService.create(
      { visitorId: visitor._id.toString(), siteId: site!._id.toString() },
      site!._id.toString(),
      {},
    );

    const res = await request(server)
      .get(
        `/sites/${targetSiteId}/conversations/${conversation._id.toString()}/current-visit`,
      )
      .set(...OWNER_AUTH)
      .expect(200);

    expect(res.body.pages).toHaveLength(3);
    const total = res.body.pages.reduce(
      (sum: number, p: { durationSeconds: number | null }) =>
        sum + (p.durationSeconds ?? 0),
      0,
    );
    expect(total).toBe(330);

    // Cross-check via the identical /conversation-visit alias endpoint
    // (ConversationsController doc comment: "computes exactly the same
    // thing" as /current-visit).
    const resAlias = await request(server)
      .get(
        `/sites/${targetSiteId}/conversations/${conversation._id.toString()}/conversation-visit`,
      )
      .set(...OWNER_AUTH)
      .expect(200);
    const totalAlias = resAlias.body.pages.reduce(
      (sum: number, p: { durationSeconds: number | null }) =>
        sum + (p.durationSeconds ?? 0),
      0,
    );
    expect(totalAlias).toBe(330);
  }, 30_000);
});
