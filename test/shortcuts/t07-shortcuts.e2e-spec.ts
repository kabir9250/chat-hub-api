/**
 * T-07 Shortcuts (Canned Responses) session — Phase 2 §3.11
 * (FR-P2-SHORT-01–06), files/reports/README.md task items 1–5 & 10.
 *
 * Covers: Personal-scope creation + visibility (item 1), Personal blocked at
 * Site+ (item 2 — TC-01.5 in shortcuts-scope.e2e-spec.ts already covers this
 * from Session T-01; re-verified here as this session's own item), Site
 * scope by Supervisor + visibility (item 3), Site scope blocked cross-site
 * (item 4), Organization scope by Manager + org-wide visibility (item 5),
 * and the `GET /shortcuts/available` merged-set correctness for all 8
 * seeded users (item 10).
 *
 * Every shortcut this file creates is deleted in an `afterAll` cleanup pass
 * so re-running this spec (or any other session's) against the same
 * `zendesk_test` seed never accumulates leftover records — same convention
 * `shortcuts-scope.e2e-spec.ts` (T-01) already follows per-test.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, ALL_SEEDED_EMAILS, SeededEmail } from '../helpers/fixtures';

describe('T-07 Shortcuts — scope creation, visibility, cross-scope enforcement', () => {
  let app: INestApplication;
  const createdIds: string[] = [];

  const AGENT_A1 = authHeader('agent-a1@test.local');
  const AGENT_A2 = authHeader('agent-a2@test.local');
  const AGENT_B1 = authHeader('agent-b1@test.local');
  const SUPERVISOR_A = authHeader('supervisor-a@test.local');
  const SUPERVISOR_B = authHeader('supervisor-b@test.local');
  const MANAGER = authHeader('manager@test.local');
  const OWNER = authHeader('owner@test.local');

  const SITE_A = () => siteId('Site A');
  const SITE_B = () => siteId('Site B');

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    // Cleanup — owner can manage/delete anything in the Organization via
    // manage_organization/manage_site, but a PERSONAL shortcut can only be
    // deleted by its own creator (assertOwnershipIfPersonal) — delete with
    // the auth that created each record instead of a single blanket pass.
    for (const { id, auth } of createdIds.map((id) => ({ id, auth: idAuthMap[id] }))) {
      if (!auth) continue;
      await request(app.getHttpServer()).delete(`/shortcuts/${id}`).set(...auth);
    }
    await app.close();
  });

  const idAuthMap: Record<string, [string, string]> = {};
  function track(id: string, auth: [string, string]) {
    createdIds.push(id);
    idAuthMap[id] = auth;
    return id;
  }

  async function available(auth: [string, string], site: string) {
    const res = await request(app.getHttpServer())
      .get(`/shortcuts/available?siteId=${site}`)
      .set(...auth);
    expect(res.status).toBe(200);
    return res.body as Array<{
      _id?: string;
      id?: string;
      shortcutKeyword: string;
      scopeLevel: string;
    }>;
  }

  function keywordsOf(list: Array<{ shortcutKeyword: string }>) {
    return list.map((s) => s.shortcutKeyword);
  }

  // --------------------------------------------------------------------
  // Item 1 — Personal scope creation by Agent
  // --------------------------------------------------------------------
  describe('Item 1 — Personal scope creation by Agent (FR-P2-SHORT-01)', () => {
    let keyword: string;
    let id: string;

    it('agent-a1 creates a Personal shortcut — succeeds', async () => {
      keyword = `t07-personal-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...AGENT_A1)
        .send({
          scopeLevel: 'PERSONAL',
          shortcutKeyword: keyword,
          purpose: 'T-07 personal visibility probe',
          message: 'personal-only message',
        });
      expect(res.status).toBe(201);
      expect(res.body.scopeLevel).toBe('PERSONAL');
      id = track(res.body._id ?? res.body.id, AGENT_A1);
    });

    it('is visible to agent-a1 via /shortcuts/available for Site A', async () => {
      const list = await available(AGENT_A1, SITE_A());
      expect(keywordsOf(list)).toContain(keyword);
    });

    it('is NOT visible to agent-a2 (same Site A, different user)', async () => {
      const list = await available(AGENT_A2, SITE_A());
      expect(keywordsOf(list)).not.toContain(keyword);
    });

    it('is NOT visible to agent-b1 (different Site, different user)', async () => {
      const list = await available(AGENT_B1, SITE_B());
      expect(keywordsOf(list)).not.toContain(keyword);
    });

    it('sanity: not returned by GET /shortcuts/:id to a non-owner either', async () => {
      const fetched = await request(app.getHttpServer())
        .get(`/shortcuts/${id}`)
        .set(...AGENT_A2);
      // agent-a2 holds shortcuts.manage_own (guard lets the route through)
      // but ShortcutsService.assertOwnershipIfPersonal rejects a Personal
      // record they don't own.
      expect(fetched.status).toBe(403);
    });
  });

  // --------------------------------------------------------------------
  // Item 2 — Personal scope blocked at Site+ by Agent
  // --------------------------------------------------------------------
  describe('Item 2 — Personal-permission Agent blocked from SITE/ORGANIZATION scope (FR-P2-SHORT-04)', () => {
    it('agent-a1 POSTing a SITE-scope shortcut is rejected (403/400), no record leaked', async () => {
      const keyword = `t07-agent-site-probe-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...AGENT_A1)
        .send({
          scopeLevel: 'SITE',
          siteId: SITE_A(),
          shortcutKeyword: keyword,
          purpose: 'T-07 escalation probe',
          message: 'should be rejected',
        });
      expect([400, 403]).toContain(res.status);
      if (res.status >= 200 && res.status < 300) {
        track(res.body._id ?? res.body.id, AGENT_A1); // safety net, shouldn't happen
      }
      const list = await available(AGENT_A1, SITE_A());
      expect(keywordsOf(list)).not.toContain(keyword);
    });

    it('agent-a1 POSTing an ORGANIZATION-scope shortcut is rejected (403/400), no record leaked', async () => {
      const keyword = `t07-agent-org-probe-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...AGENT_A1)
        .send({
          scopeLevel: 'ORGANIZATION',
          shortcutKeyword: keyword,
          purpose: 'T-07 escalation probe',
          message: 'should be rejected',
        });
      expect([400, 403]).toContain(res.status);
      if (res.status >= 200 && res.status < 300) {
        track(res.body._id ?? res.body.id, AGENT_A1);
      }
      const list = await available(AGENT_A1, SITE_A());
      expect(keywordsOf(list)).not.toContain(keyword);
    });
  });

  // --------------------------------------------------------------------
  // Item 3 — Site scope by Supervisor
  // --------------------------------------------------------------------
  describe('Item 3 — Site scope by Supervisor (FR-P2-SHORT-02)', () => {
    let keyword: string;

    it('supervisor-a creates a SITE shortcut on Site A — succeeds', async () => {
      keyword = `t07-site-a-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...SUPERVISOR_A)
        .send({
          scopeLevel: 'SITE',
          siteId: SITE_A(),
          shortcutKeyword: keyword,
          purpose: 'T-07 site visibility probe',
          message: 'site-a-only message',
        });
      expect(res.status).toBe(201);
      expect(res.body.scopeLevel).toBe('SITE');
      track(res.body._id ?? res.body.id, SUPERVISOR_A);
    });

    it('is visible to agent-a1 and agent-a2 (both Site A)', async () => {
      const listA1 = await available(AGENT_A1, SITE_A());
      const listA2 = await available(AGENT_A2, SITE_A());
      expect(keywordsOf(listA1)).toContain(keyword);
      expect(keywordsOf(listA2)).toContain(keyword);
    });

    it('is NOT visible to agent-b1 (Site B)', async () => {
      const listB1 = await available(AGENT_B1, SITE_B());
      expect(keywordsOf(listB1)).not.toContain(keyword);
    });
  });

  // --------------------------------------------------------------------
  // Item 4 — Site scope blocked cross-site by Supervisor
  // --------------------------------------------------------------------
  describe('Item 4 — Supervisor blocked from creating a SITE shortcut on a Site they do not supervise (FR-P2-SHORT-02/04)', () => {
    it('supervisor-a attempting a Site B shortcut is rejected (403)', async () => {
      const keyword = `t07-cross-site-probe-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...SUPERVISOR_A)
        .send({
          scopeLevel: 'SITE',
          siteId: SITE_B(),
          shortcutKeyword: keyword,
          purpose: 'T-07 cross-site probe',
          message: 'should be rejected',
        });
      expect(res.status).toBe(403);

      // Confirm no record leaked into Site B's available set for supervisor-b.
      const listB = await available(SUPERVISOR_B, SITE_B());
      expect(keywordsOf(listB)).not.toContain(keyword);
    });
  });

  // --------------------------------------------------------------------
  // Item 5 — Organization scope by Manager/Owner
  // --------------------------------------------------------------------
  describe('Item 5 — Organization scope by Manager, visible org-wide (FR-P2-SHORT-03)', () => {
    let keyword: string;

    it('manager creates an ORGANIZATION shortcut — succeeds', async () => {
      keyword = `t07-org-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post('/shortcuts')
        .set(...MANAGER)
        .send({
          scopeLevel: 'ORGANIZATION',
          shortcutKeyword: keyword,
          purpose: 'T-07 org-wide visibility probe',
          message: 'org-wide message',
        });
      expect(res.status).toBe(201);
      expect(res.body.scopeLevel).toBe('ORGANIZATION');
      track(res.body._id ?? res.body.id, MANAGER);
    });

    it('is visible to every seeded user, on every Site they can query', async () => {
      const siteAId = SITE_A();
      const siteBId = SITE_B();
      const checks: Array<[SeededEmail, string]> = [
        ['owner@test.local', siteAId],
        ['manager@test.local', siteAId],
        ['supervisor-a@test.local', siteAId],
        ['supervisor-b@test.local', siteBId],
        ['agent-a1@test.local', siteAId],
        ['agent-a2@test.local', siteAId],
        ['agent-b1@test.local', siteBId],
        ['agent-multi@test.local', siteAId],
      ];
      for (const [email, site] of checks) {
        const list = await available(authHeader(email), site);
        expect(keywordsOf(list)).toContain(keyword);
      }
    });
  });

  // --------------------------------------------------------------------
  // Item 10 — /shortcuts/available correctness for all 8 seeded users
  // --------------------------------------------------------------------
  describe('Item 10 — GET /shortcuts/available returns exactly the correct merged set per user', () => {
    // Seeded baseline (files/reports/README.md "Seeded Shortcuts"):
    //   brb        PERSONAL  agent-a1
    //   thanks     PERSONAL  agent-b1
    //   welcome    SITE A    supervisor-a
    //   hours      SITE B    supervisor-b
    //   escalate   ORGANIZATION owner
    // Plus everything created by this session's own Items 1/3/5 above
    // (t07-personal-*, t07-site-a-*, t07-org-*) — every user's set is
    // checked as a SUPERSET containment (seeded keyword IN/NOT IN the
    // returned list) rather than an exact-length match, so this session's
    // own fixtures don't have to be excluded/predicted here.

    it('agent-a1 (Site A) sees: brb (own), welcome (Site A), escalate (org) — not thanks/hours', async () => {
      const list = keywordsOf(await available(AGENT_A1, SITE_A()));
      expect(list).toEqual(
        expect.arrayContaining(['brb', 'welcome', 'escalate']),
      );
      expect(list).not.toContain('thanks');
      expect(list).not.toContain('hours');
    });

    it('agent-a2 (Site A) sees: welcome (Site A), escalate (org) — not brb/thanks/hours', async () => {
      const list = keywordsOf(await available(AGENT_A2, SITE_A()));
      expect(list).toEqual(expect.arrayContaining(['welcome', 'escalate']));
      expect(list).not.toContain('brb');
      expect(list).not.toContain('thanks');
      expect(list).not.toContain('hours');
    });

    it('agent-b1 (Site B) sees: thanks (own), hours (Site B), escalate (org) — not brb/welcome', async () => {
      const list = keywordsOf(await available(AGENT_B1, SITE_B()));
      expect(list).toEqual(
        expect.arrayContaining(['thanks', 'hours', 'escalate']),
      );
      expect(list).not.toContain('brb');
      expect(list).not.toContain('welcome');
    });

    it('supervisor-a (Site A) sees: welcome (own+Site A), escalate (org) — not brb/thanks/hours', async () => {
      const list = keywordsOf(await available(SUPERVISOR_A, SITE_A()));
      expect(list).toEqual(expect.arrayContaining(['welcome', 'escalate']));
      expect(list).not.toContain('brb');
      expect(list).not.toContain('thanks');
      expect(list).not.toContain('hours');
    });

    it('supervisor-b (Site B) sees: hours (own+Site B), escalate (org) — not brb/thanks/welcome', async () => {
      const list = keywordsOf(await available(SUPERVISOR_B, SITE_B()));
      expect(list).toEqual(expect.arrayContaining(['hours', 'escalate']));
      expect(list).not.toContain('brb');
      expect(list).not.toContain('thanks');
      expect(list).not.toContain('welcome');
    });

    it('manager (Organization-scoped) queried against Site A sees welcome+escalate, against Site B sees hours+escalate — never brb/thanks (not their Personal shortcuts)', async () => {
      const listA = keywordsOf(await available(MANAGER, SITE_A()));
      expect(listA).toEqual(expect.arrayContaining(['welcome', 'escalate']));
      expect(listA).not.toContain('brb');
      expect(listA).not.toContain('thanks');
      expect(listA).not.toContain('hours');

      const listB = keywordsOf(await available(MANAGER, SITE_B()));
      expect(listB).toEqual(expect.arrayContaining(['hours', 'escalate']));
      expect(listB).not.toContain('welcome');
    });

    it('owner (Organization-scoped) queried against Site A sees welcome+escalate (own Personal 0), against Site B sees hours+escalate', async () => {
      const listA = keywordsOf(await available(OWNER, SITE_A()));
      expect(listA).toEqual(expect.arrayContaining(['welcome', 'escalate']));
      expect(listA).not.toContain('brb');
      expect(listA).not.toContain('thanks');

      const listB = keywordsOf(await available(OWNER, SITE_B()));
      expect(listB).toEqual(expect.arrayContaining(['hours', 'escalate']));
    });

    it('agent-multi (Site A AND Site C) sees Site A set when queried with siteId=Site A, and org-only when queried with Site C (no Site-C-level shortcuts seeded)', async () => {
      const listA = keywordsOf(await available(authHeader('agent-multi@test.local'), SITE_A()));
      expect(listA).toEqual(expect.arrayContaining(['welcome', 'escalate']));
      expect(listA).not.toContain('hours');

      const listC = keywordsOf(
        await available(authHeader('agent-multi@test.local'), siteId('Site C')),
      );
      expect(listC).toEqual(expect.arrayContaining(['escalate']));
      expect(listC).not.toContain('welcome');
      expect(listC).not.toContain('hours');
      expect(listC).not.toContain('brb');
      expect(listC).not.toContain('thanks');
    });

    it('every one of the 8 seeded users can successfully call /shortcuts/available for at least one of their own Sites (no unexpected 403/500)', async () => {
      const siteForEmail: Record<SeededEmail, string> = {
        'owner@test.local': SITE_A(),
        'manager@test.local': SITE_A(),
        'supervisor-a@test.local': SITE_A(),
        'supervisor-b@test.local': SITE_B(),
        'agent-a1@test.local': SITE_A(),
        'agent-a2@test.local': SITE_A(),
        'agent-b1@test.local': SITE_B(),
        'agent-multi@test.local': SITE_A(),
      };
      for (const email of ALL_SEEDED_EMAILS) {
        const res = await request(app.getHttpServer())
          .get(`/shortcuts/available?siteId=${siteForEmail[email]}`)
          .set(...authHeader(email));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
      }
    });
  });
});
