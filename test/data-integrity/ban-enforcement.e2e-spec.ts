/**
 * T-05 TC-05.2 — Ban enforcement (FR-VIS-07, SRS §6.3 "Ban list enforcement
 * at both the widget (blocked from opening chat) and API level").
 *
 * `VisitorsService.ban()` (visitors.service.ts) does two things: sets
 * `Visitor.isBanned = true` AND pushes the Visitor's `currentIp` onto the
 * owning Site's `bannedIps[]`. `VisitorSessionService.init()` enforces BOTH
 * independently (site.bannedIps check first, then the resolved Visitor's
 * own `isBanned` flag) — this spec proves each enforcement path on its own,
 * plus the combined "fresh browser, same IP" case the task asks for.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-05 TC-05.2 — Ban enforcement (FR-VIS-07)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const targetSiteId = siteId('Site D'); // no dedicated Agent/Supervisor — owner only needed to ban
  const OWNER_AUTH = authHeader('owner@test.local');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-05.2a: session token from a banned Visitor is rejected on init, even with a fresh (never-banned) IP', async () => {
    const originalIp = nextFakeIp();

    // 1. Fresh visitor session.
    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', originalIp)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;
    expect(token).toBeTruthy();

    // 2. Owner bans that Visitor.
    const banRes = await request(server)
      .post(`/sites/${targetSiteId}/visitors/${visitorId}/ban`)
      .set(...OWNER_AUTH)
      .send({})
      .expect(201);
    expect(banRes.body.isBanned).toBe(true);

    // 3. Re-init with the SAME session token but a brand-new, never-seen IP —
    // must still be rejected (proves the ban follows the Visitor identity,
    // not just the IP it happened to be banned from).
    const freshIp = nextFakeIp();
    const rejectByToken = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', freshIp)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId })
      .expect(403);
    expect(rejectByToken.body.message).toMatch(/banned/i);
  });

  it('TC-05.2b: a banned Visitor\'s original IP is also blocked outright — even for a request carrying no session token at all (a "fresh browser")', async () => {
    const originalIp = nextFakeIp();

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', originalIp)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { visitorId } = initRes.body;

    await request(server)
      .post(`/sites/${targetSiteId}/visitors/${visitorId}/ban`)
      .set(...OWNER_AUTH)
      .send({})
      .expect(201);

    // Same original IP, no Authorization header at all, no visitorId body
    // field either — simulates a fresh browser session (cleared cookies)
    // on the same physical connection. Must be rejected at the IP-ban check
    // BEFORE any Visitor lookup even happens.
    const rejectByIp = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', originalIp)
      .send({ siteId: targetSiteId })
      .expect(403);
    expect(rejectByIp.body.message).toMatch(/ip address has been banned/i);
  });

  it('TC-05.2c: combined case — same token AND same IP both independently rejected, and a genuinely different Visitor from the same banned IP is also blocked', async () => {
    const bannedIp = nextFakeIp();

    const initRes = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', bannedIp)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token, visitorId } = initRes.body;

    await request(server)
      .post(`/sites/${targetSiteId}/visitors/${visitorId}/ban`)
      .set(...OWNER_AUTH)
      .send({})
      .expect(201);

    // Same token + same (now-banned) IP together.
    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', bannedIp)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId })
      .expect(403);

    // A totally different, never-before-seen Visitor arriving from that same
    // now-banned IP (no token, no visitorId — a genuinely new person on that
    // IP, e.g. a shared office network) is blocked too — the ban is on the
    // IP itself at this point, not just "this one Visitor's future logins".
    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', bannedIp)
      .send({ siteId: targetSiteId })
      .expect(403);
  });

  it('TC-05.2d (control): an un-banned Visitor from a fresh IP is accepted normally', async () => {
    await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
  });
});
