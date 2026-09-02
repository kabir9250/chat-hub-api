/**
 * T-05 TC-05.8 — Search grouped by visitor (Phase 2 FR-P2-GRP-01/02/03).
 *
 * `ConversationsService.findAll`'s `query.search` branch
 * (`findAllGroupedByVisitor`) is the backend half of FR-P2-GRP-01–03: a
 * name/email search groups by Visitor (one row, full Conversation list,
 * most-recent-first) instead of returning a flat list. The "+3 more chats"
 * indicator text itself (FR-P2-GRP-02) is a frontend rendering concern this
 * suite can't observe — what it verifies is that the backend gives the
 * frontend exactly what it needs to render that: `groups[0].conversations`
 * containing all 4 of this Visitor's Conversations, most-recent-first, so a
 * frontend showing "1 of them + 3 more" needs no extra data or requests.
 *
 * Also verifies FR-P2-GRP-03's other explicit guarantee: a status-filter-only
 * search (no `search` term at all) is completely unaffected and keeps
 * returning the flat, non-grouped shape.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-05 TC-05.8 — Search grouped by visitor (FR-P2-GRP-01/02/03)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const OWNER_AUTH = authHeader('owner@test.local');
  const targetSiteId = siteId('Site D');
  const uniqueEmail = `grouped-search-${Date.now()}@example.com`;
  let visitorId: string;
  const conversationIds: string[] = [];

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();

    const ip = nextFakeIp();
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const token = initRes.body.token;
    visitorId = initRes.body.visitorId;

    await request(server)
      .patch('/visitor-session/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Grouped Search Visitor', email: uniqueEmail })
      .expect(200);

    // 4 Conversations for this one Visitor, sequentially (so each has a
    // distinct, later startedAt than the previous, for a deterministic
    // most-recent-first check).
    for (let i = 0; i < 4; i++) {
      const convRes = await request(server)
        .post(`/sites/${targetSiteId}/conversations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ initialMessage: `message ${i}` })
        .expect(201);
      conversationIds.push(convRes.body._id);
      await new Promise((r) => setTimeout(r, 50)); // ensure distinct startedAt ordering
    }
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.8a/b: searching by email returns ONE grouped row for this Visitor with all 4 Conversations, most-recent-first', async () => {
    const res = await request(server)
      .get(
        `/sites/${targetSiteId}/conversations?search=${encodeURIComponent(uniqueEmail)}`,
      )
      .set(...OWNER_AUTH)
      .expect(200);

    expect(res.body.grouped).toBe(true);
    expect(res.body.groups).toHaveLength(1);

    const group = res.body.groups[0];
    expect(group.visitor.id).toBe(visitorId);
    expect(group.visitor.email).toBe(uniqueEmail);
    expect(group.visitor.name).toBe('Grouped Search Visitor');
    expect(group.conversations).toHaveLength(4);

    // "+3 more chats" (FR-P2-GRP-02): exactly 1 conversation is the
    // "collapsed" summary, 3 more are the drill-down — i.e. length - 1 === 3.
    expect(group.conversations.length - 1).toBe(3);

    // Most-recent-first.
    const returnedIds = group.conversations.map((c: { _id: string }) => c._id);
    expect(returnedIds).toEqual([...conversationIds].reverse());
    const startedAts = group.conversations.map((c: { startedAt: string }) =>
      new Date(c.startedAt).getTime(),
    );
    const sortedDesc = [...startedAts].sort((a, b) => b - a);
    expect(startedAts).toEqual(sortedDesc);
  });

  it('TC-05.8c: searching by name (partial, case-insensitive) also groups correctly', async () => {
    const res = await request(server)
      .get(`/sites/${targetSiteId}/conversations?search=grouped search`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(res.body.grouped).toBe(true);
    const group = res.body.groups.find(
      (g: { visitor: { id: string } }) => g.visitor.id === visitorId,
    );
    expect(group).toBeTruthy();
    expect(group.conversations).toHaveLength(4);
  });

  it('TC-05.8d: a status filter ALONE (no search term) returns the flat, non-grouped shape as before', async () => {
    const res = await request(server)
      .get(`/sites/${targetSiteId}/conversations?status=open&limit=100`)
      .set(...OWNER_AUTH)
      .expect(200);

    expect(res.body.grouped).toBeUndefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const item of res.body.items) {
      expect(item.status).toBe('open');
    }
  });
});
