/**
 * T-05 TC-05.1 — Conversation reference number uniqueness (FR-CONV-01, SRS
 * §4.5, `reference-number.service.ts`'s own doc comment).
 *
 * Two layers, deliberately:
 *
 * 1. A direct, in-process concurrency test of `ReferenceNumberService` —
 *    1000 fully-parallel `next()` calls, which is the ONLY thing that
 *    actually exercises the race condition the atomic
 *    `findOneAndUpdate($inc, upsert)` counter (`counters` collection) is
 *    built to prevent. Going through the real `POST /sites/:id/conversations`
 *    HTTP route 1000 times instead would not additionally prove anything
 *    about uniqueness — creation calls `referenceNumberService.next()`
 *    exactly once per call either way — while running into that route's own
 *    10-requests/minute/IP throttle (`ConversationsController.create`),
 *    which would turn "1000 rapidly" into ~100 minutes of wall-clock time
 *    for no extra coverage. See TC-05.1b below for the end-to-end proof that
 *    the counter is actually wired into real Conversation creation.
 * 2. TC-05.1b — a smaller (20) batch of REAL `POST .../conversations` calls,
 *    within the throttle limit, confirming `referenceNumber` is present,
 *    correctly formatted, unique, and persisted on real documents.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { siteId } from '../helpers/fixtures';
import {
  Counter,
  CounterDocument,
  Site,
  SiteDocument,
  Visitor,
  VisitorDocument,
  Department,
  DepartmentDocument,
  Conversation,
  ConversationDocument,
} from '../../src/database/schemas';
import { ReferenceNumberService } from '../../src/conversations/reference-number.service';
import { ConversationsService } from '../../src/conversations/conversations.service';

const REFERENCE_NUMBER_RE = /^#\d{8,}$/;

describe('T-05 TC-05.1 — Conversation reference number uniqueness', () => {
  let app: INestApplication;
  let referenceNumberService: ReferenceNumberService;
  let conversationsService: ConversationsService;
  let counterModel: Model<CounterDocument>;
  let siteModel: Model<SiteDocument>;
  let visitorModel: Model<VisitorDocument>;
  let departmentModel: Model<DepartmentDocument>;
  let conversationModel: Model<ConversationDocument>;

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    referenceNumberService = app.get(ReferenceNumberService);
    conversationsService = app.get(ConversationsService);
    counterModel = app.get(getModelToken(Counter.name));
    siteModel = app.get(getModelToken(Site.name));
    visitorModel = app.get(getModelToken(Visitor.name));
    departmentModel = app.get(getModelToken(Department.name));
    conversationModel = app.get(getModelToken(Conversation.name));
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.1a: 1000 fully-concurrent ReferenceNumberService.next() calls each return a distinct, correctly-formatted value', async () => {
    const before = await counterModel
      .findById('conversationReferenceNumber')
      .lean()
      .exec();
    const startingSeq = before?.seq ?? 0;

    const results = await Promise.all(
      Array.from({ length: 1000 }, () => referenceNumberService.next()),
    );

    expect(results).toHaveLength(1000);
    for (const ref of results) {
      expect(ref).toMatch(REFERENCE_NUMBER_RE);
    }
    const unique = new Set(results);
    expect(unique.size).toBe(1000);

    const after = await counterModel
      .findById('conversationReferenceNumber')
      .lean()
      .exec();
    // The atomic counter must have advanced by exactly 1000 — no lost
    // updates, no double-increments, under real parallel load.
    expect(after!.seq - startingSeq).toBe(1000);
  }, 120_000);

  it('TC-05.1b: 1000 concurrently-created Conversations (direct service calls, bypassing the HTTP throttle that is unrelated to this guarantee) each persist a distinct referenceNumber', async () => {
    const site = await siteModel.findById(siteId('Site D')).exec();
    expect(site).toBeTruthy();
    const department = await departmentModel
      .findOne({ siteId: site!._id })
      .exec();
    expect(department).toBeTruthy();

    // 1000 throwaway Visitors, all pre-created directly (no need to exercise
    // visitor-session/init for this test — visitor-session behavior is
    // covered by its own TC-05.5 spec file).
    const visitorDocs = await visitorModel.insertMany(
      Array.from({ length: 1000 }, (_, i) => ({
        siteId: site!._id,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        pastVisitsCount: 1,
        pastChatsCount: 0,
        name: `RefNumTest Visitor ${i}`,
      })),
    );

    // Batches of 100 concurrent creates (rather than all 1000 at once) to
    // stay within a sane Mongo connection-pool footprint for a local dev
    // Atlas cluster, while still genuinely overlapping in time — the
    // counter's atomicity is what's under test, not raw single-call latency.
    const referenceNumbers: string[] = [];
    for (let batchStart = 0; batchStart < visitorDocs.length; batchStart += 100) {
      const batch = visitorDocs.slice(batchStart, batchStart + 100);
      const created = await Promise.all(
        batch.map((v) =>
          conversationsService.create(
            { visitorId: v._id.toString(), siteId: site!._id.toString() },
            site!._id.toString(),
            { departmentId: department!._id.toString() },
          ),
        ),
      );
      referenceNumbers.push(...created.map((c) => c.referenceNumber));
    }

    expect(referenceNumbers).toHaveLength(1000);
    expect(new Set(referenceNumbers).size).toBe(1000);
    for (const ref of referenceNumbers) {
      expect(ref).toMatch(REFERENCE_NUMBER_RE);
    }

    // Cross-check directly against the DB — the schema's own `unique: true`
    // index on `referenceNumber` (reference-number.service.ts's doc comment:
    // "second line of defense") should make a duplicate impossible to
    // persist at all; confirm via a DB-level aggregation for dupes too, not
    // just the in-memory Set above.
    const dupes = await conversationModel
      .aggregate([
        { $match: { referenceNumber: { $in: referenceNumbers } } },
        { $group: { _id: '$referenceNumber', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .exec();
    expect(dupes).toHaveLength(0);
  }, 180_000);

  it('TC-05.1c (end-to-end sanity): 20 Conversations created via the real HTTP endpoint (within its throttle limit) each get a unique referenceNumber', async () => {
    const server = app.getHttpServer();
    const targetSiteId = siteId('Site D');

    const referenceNumbers: string[] = [];
    for (let i = 0; i < 20; i++) {
      const ip = nextFakeIp();
      const initRes = await request(server)
        .post('/visitor-session/init')
        .set('X-Forwarded-For', ip)
        .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
        .expect(200);

      const convRes = await request(server)
        .post(`/sites/${targetSiteId}/conversations`)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${initRes.body.token}`)
        .send({})
        .expect(201);

      expect(convRes.body.referenceNumber).toMatch(REFERENCE_NUMBER_RE);
      referenceNumbers.push(convRes.body.referenceNumber);
    }

    expect(new Set(referenceNumbers).size).toBe(20);
  }, 60_000);
});
