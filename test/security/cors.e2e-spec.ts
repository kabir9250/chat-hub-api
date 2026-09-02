/**
 * T-09 Security session — CORS (SRS §6.3 item 8: "verify the widget embed
 * endpoint allows cross-origin, but the agent/admin APIs do NOT allow
 * arbitrary origins (only the configured Next.js frontend origin)").
 *
 * Real Supertest calls against the real `AppModule`, real `app.enableCors`
 * config (`main.ts`), reading the actual `Access-Control-Allow-Origin`
 * response header for a battery of `Origin` request headers — not reading
 * `main.ts`/`configuration.ts` and assuming.
 *
 * IMPORTANT — what this suite actually found (read before trusting the
 * task's premise at face value): `main.ts` calls `app.enableCors({...})`
 * exactly ONCE, globally, for the whole Nest application — there is no
 * separate, more permissive CORS policy for widget/visitor-facing routes
 * vs. Agent/Admin routes. A single `CORS_ORIGIN` env var (one origin,
 * `.env.test` → `http://localhost:3012`, the `chat-hub-web` Next.js app)
 * is applied identically to every route alike, widget-facing or not.
 *
 * Also confirmed (not assumed): the `origin` option is passed as a plain
 * STRING, not a function — the underlying `cors` package's documented
 * behavior for a string `origin` is to emit that fixed value as
 * `Access-Control-Allow-Origin` on EVERY response, unconditionally,
 * regardless of what `Origin` header (if any) the request actually sent.
 * It never reflects/mirrors the caller's own Origin. An arbitrary/attacker
 * Origin therefore never sees its own value echoed back (real enforcement:
 * a browser discards the response because the fixed value doesn't match
 * the calling page's own origin — the Fetch/CORS spec's actual mechanism),
 * but the header is never simply ABSENT for a mismatched Origin either —
 * this suite asserts the real, observed shape, not a guessed one.
 *
 * This suite confirms that single-policy behavior empirically for BOTH
 * route classes, then the report calls out whether the lack of a
 * widget-specific carve-out actually matters given how the Widget is
 * architecturally delivered (SRS §1.4: iframe/shadow-DOM embed, not a
 * brand-domain-origin `fetch()`).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createSecurityTestApp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

const CONFIGURED_ORIGIN = 'http://localhost:3012'; // .env.test's CORS_ORIGIN
const ARBITRARY_ORIGINS = [
  'https://evil.example.com',
  'http://attacker.local:1337',
  'null',
];

describe('Security — CORS (SRS §6.3 item 8)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await createSecurityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Widget/visitor-facing routes (POST /visitor-session/init)', () => {
    for (const origin of ARBITRARY_ORIGINS) {
      it(`does NOT reflect an arbitrary Origin (${origin}) in Access-Control-Allow-Origin`, async () => {
        const res = await request(server)
          .post('/visitor-session/init')
          .set('Origin', origin)
          .send({ siteId: siteId('Site A') });
        expect(res.headers['access-control-allow-origin']).not.toBe(origin);
      });
    }

    it('DOES reflect the one configured origin', async () => {
      const res = await request(server)
        .post('/visitor-session/init')
        .set('Origin', CONFIGURED_ORIGIN)
        .send({ siteId: siteId('Site A') });
      expect(res.headers['access-control-allow-origin']).toBe(CONFIGURED_ORIGIN);
    });

    it('a real preflight (OPTIONS) from an arbitrary origin is not granted', async () => {
      const res = await request(server)
        .options('/visitor-session/init')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    });
  });

  describe('Agent/Admin-facing routes (GET /sites/:siteId/conversations, GET /auth/me)', () => {
    for (const origin of ARBITRARY_ORIGINS) {
      it(`does NOT reflect an arbitrary Origin (${origin}) on an authenticated Agent route`, async () => {
        const res = await request(server)
          .get(`/sites/${siteId('Site A')}/conversations`)
          .set('Origin', origin)
          .set(...authHeader('supervisor-a@test.local'));
        expect(res.headers['access-control-allow-origin']).not.toBe(origin);
      });
    }

    it('DOES reflect the one configured origin on an authenticated Agent route', async () => {
      const res = await request(server)
        .get('/auth/me')
        .set('Origin', CONFIGURED_ORIGIN)
        .set(...authHeader('owner@test.local'));
      expect(res.headers['access-control-allow-origin']).toBe(CONFIGURED_ORIGIN);
    });
  });

  describe('Cross-check: is the widget route\'s CORS policy actually MORE permissive than the Agent route\'s, as SRS item 8 implies it should be?', () => {
    it('both route classes return the IDENTICAL fixed Access-Control-Allow-Origin value regardless of the real brand-site Origin sent — confirms there is exactly ONE global, static-string CORS policy, not two', async () => {
      // `cors` (wrapped by Nest's `app.enableCors`), when configured with a
      // plain STRING `origin` (not a function that inspects the request),
      // does not "reflect the caller's Origin if it matches" — it always
      // emits that one fixed string as `Access-Control-Allow-Origin`,
      // unconditionally, for every request, regardless of what Origin (if
      // any) the request actually sent. Confirmed directly: both an
      // arbitrary brand-site Origin AND a request with no Origin header at
      // all get back the identical `CONFIGURED_ORIGIN` value on both route
      // classes — proving one shared, origin-blind policy, not a
      // widget-specific carve-out and not a per-request allow/deny decision
      // at all (a real browser is still the actual enforcement point: it
      // discards the response if `Access-Control-Allow-Origin` doesn't
      // match the page's OWN origin, per the Fetch/CORS spec — see this
      // suite's earlier "reflect the one configured origin" cases for that
      // half already confirmed).
      const widgetRes = await request(server)
        .post('/visitor-session/init')
        .set('Origin', 'https://some-brand-site.example.com')
        .send({ siteId: siteId('Site A') });
      const agentRes = await request(server)
        .get('/auth/me')
        .set('Origin', 'https://some-brand-site.example.com')
        .set(...authHeader('owner@test.local'));
      const noOriginRes = await request(server)
        .post('/visitor-session/init')
        .send({ siteId: siteId('Site A') });

      expect(widgetRes.headers['access-control-allow-origin']).toBe(CONFIGURED_ORIGIN);
      expect(agentRes.headers['access-control-allow-origin']).toBe(CONFIGURED_ORIGIN);
      expect(noOriginRes.headers['access-control-allow-origin']).toBe(CONFIGURED_ORIGIN);
    });
  });
});
