/**
 * T-05 TC-05.9 — "All Sites" combined view (Phase 2 FR-P2-SITE-02).
 *
 * `agent-multi@test.local` holds two separate Role Assignments — Site A and
 * Site C (reports/README.md's seeded-account table: "the account to use for
 * 'All Sites' combined-view tests"). Site B and Site D data must never
 * appear for this caller; every Site A/Site C item must appear, each badged
 * with its own `siteId` (FR-P2-SITE-03's data-contract half — see
 * `name-vs-reference-id.e2e-spec.ts`'s doc comment on why this suite tests
 * the data contract, not frontend badge rendering).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createDataIntegrityTestApp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-05 TC-05.9 — All Sites combined view (FR-P2-SITE-02)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const AGENT_MULTI_AUTH = authHeader('agent-multi@test.local');
  const OWNER_AUTH = authHeader('owner@test.local');
  const siteAId = siteId('Site A');
  const siteBId = siteId('Site B');
  const siteCId = siteId('Site C');
  const siteDId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.9a: combined Conversations = exactly Site A + Site C, every item badged, no Site B/D leakage', async () => {
    const res = await request(server)
      .get('/conversations?limit=100')
      .set(...AGENT_MULTI_AUTH)
      .expect(200);

    expect(new Set(res.body.siteIds)).toEqual(new Set([siteAId, siteCId]));
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item.siteId).toBeTruthy();
      expect([siteAId, siteCId]).toContain(item.siteId);
      expect(item.siteId).not.toBe(siteBId);
      expect(item.siteId).not.toBe(siteDId);
    }

    // Every Site A Conversation this caller is entitled to see individually
    // (agent-multi holds only conversations.view_own on Site A per the seed
    // — an Agent Role default, reports/README.md) must also show up in the
    // combined feed, i.e. the merge doesn't silently drop entries.
    const singleSiteA = await request(server)
      .get(`/sites/${siteAId}/conversations?limit=100`)
      .set(...AGENT_MULTI_AUTH)
      .expect(200);
    const combinedIdsFromA = res.body.items
      .filter((i: { siteId: string }) => i.siteId === siteAId)
      .map((i: { _id: string }) => i._id);
    for (const item of singleSiteA.body.items) {
      expect(combinedIdsFromA).toContain(item._id);
    }
  });

  it('TC-05.9b: combined Visitors = exactly Site A + Site C, every item badged, no Site B/D leakage', async () => {
    const res = await request(server)
      .get('/visitors?limit=100')
      .set(...AGENT_MULTI_AUTH)
      .expect(200);

    expect(new Set(res.body.siteIds)).toEqual(new Set([siteAId, siteCId]));
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect([siteAId, siteCId]).toContain(item.siteId);
    }
  });

  it('TC-05.9c: combined History search (status filter, flat shape) also stays confined to Site A + Site C', async () => {
    const res = await request(server)
      .get('/conversations?status=closed&limit=100')
      .set(...AGENT_MULTI_AUTH)
      .expect(200);

    expect(res.body.grouped).toBeUndefined();
    for (const item of res.body.items) {
      expect([siteAId, siteCId]).toContain(item.siteId);
      expect(item.status).toBe('closed');
    }
  });

  it('TC-05.9d (control): Owner (Organization-scoped) sees all 4 Sites in the combined view, confirming Site B/D data genuinely exists and is only excluded by agent-multi\'s narrower authorization', async () => {
    const res = await request(server)
      .get('/conversations?limit=100')
      .set(...OWNER_AUTH)
      .expect(200);

    // siteIds is server-resolved from the caller's authorized-Site set
    // (PermissionsService.getAuthorizedSites), independent of pagination —
    // this is the real correctness signal, not which Sites happen to be
    // represented in one 100-item page of a ~200-Conversation merged feed.
    expect(new Set(res.body.siteIds)).toEqual(
      new Set([siteAId, siteBId, siteCId, siteDId]),
    );

    // Confirm Site B/Site D data genuinely exists (independent, single-Site
    // calls — not pagination-dependent) so "Owner sees all 4" is a real
    // claim, not just an empty siteIds list with no backing data.
    const siteBSingle = await request(server)
      .get(`/sites/${siteBId}/conversations?limit=1`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(siteBSingle.body.total).toBeGreaterThan(0);
    const siteDSingle = await request(server)
      .get(`/sites/${siteDId}/conversations?limit=1`)
      .set(...OWNER_AUTH)
      .expect(200);
    expect(siteDSingle.body.total).toBeGreaterThan(0);
  });
});
