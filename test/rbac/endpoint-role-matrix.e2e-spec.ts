/**
 * T-01 RBAC — TC-01.1: Endpoint x Role matrix.
 *
 * Data-driven: one table of read-only, side-effect-free GET endpoints (each
 * naming the exact PermissionKey(s) that gate it, per the real controllers
 * under src/), crossed against all 8 seeded users x all 4 Sites (or, for
 * Organization-wide endpoints, just the 8 users). The EXPECTED outcome for
 * every cell comes from `helpers/expected-permissions.ts` — an independent
 * re-statement of the permission catalog + seed data, not the app's own
 * code — so a real bug in PermissionGuard/PermissionsService/seed data
 * would actually surface here instead of the test tautologically agreeing
 * with whatever the app already believes.
 *
 * Every request hits the REAL app (`request(app.getHttpServer())`) with a
 * REAL JWT from `POST /auth/login` (global-setup.ts) — no mocking of the
 * permission check anywhere in this file.
 *
 * Mutating (`.manage`) endpoints are deliberately NOT included in this
 * read-only matrix (would corrupt the shared seeded dataset if run
 * exhaustively 8 users x 4 Sites x many mutations) — see
 * `mutation-permissions.e2e-spec.ts` for those, covering every mutating
 * permission key's denial exhaustively plus one representative allowed
 * case per key.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import {
  ALL_SEEDED_EMAILS,
  authHeader,
  SeededEmail,
  siteId,
  SiteName,
  userIdFor,
} from '../helpers/fixtures';
import {
  ALL_SITE_NAMES,
  expectAllowed,
} from '../helpers/expected-permissions';

interface EndpointDef {
  name: string;
  keys: string[];
  siteScoped: boolean; // false => organization-wide (siteSource: 'none' or no permission)
  path: (site: SiteName | null) => string;
  /** When set, the endpoint requires no specific permission (any authenticated user) — always 2xx. */
  anyAuthenticated?: boolean;
}

const ENDPOINTS: EndpointDef[] = [
  {
    name: 'GET /sites/:siteId/users (users.view)',
    keys: ['users.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/users`,
  },
  {
    name: 'GET /sites/:siteId/departments (departments.view)',
    keys: ['departments.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/departments`,
  },
  {
    name: 'GET /sites/:siteId/widget-config (widget_config.view)',
    keys: ['widget_config.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/widget-config`,
  },
  {
    name: 'GET /sites/:siteId/triggers (triggers.view)',
    keys: ['triggers.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/triggers`,
  },
  {
    name: 'GET /sites/:siteId/business-hours (business_hours.manage)',
    keys: ['business_hours.manage'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/business-hours`,
  },
  {
    name: 'GET /sites/:siteId/visitors (visitors.view)',
    keys: ['visitors.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/visitors`,
  },
  {
    name: 'GET /sites/:siteId/leads (leads.view)',
    keys: ['leads.view'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/leads`,
  },
  {
    name: 'GET /sites/:siteId/conversations (view_own OR view_site)',
    keys: ['conversations.view_own', 'conversations.view_site'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/conversations`,
  },
  {
    name: 'GET /sites/:siteId/analytics/chart (analytics.view_site)',
    keys: ['analytics.view_site'],
    siteScoped: true,
    path: (s) => `/sites/${siteId(s!)}/analytics/chart`,
  },
  {
    name: 'GET /shortcuts/available?siteId= (shortcuts.view)',
    keys: ['shortcuts.view'],
    siteScoped: true,
    path: (s) => `/shortcuts/available?siteId=${siteId(s!)}`,
  },
  {
    name: 'GET /roles (roles.view, org-wide)',
    keys: ['roles.view'],
    siteScoped: false,
    path: () => `/roles`,
  },
  {
    name: 'GET /role-assignments?userId= (role_assignments.manage, org-wide)',
    keys: ['role_assignments.manage'],
    siteScoped: false,
    // A real userId (Owner's own) — a fake 24-hex-char id would 404 even
    // for an allowed caller, which isn't the thing this matrix tests.
    path: () => `/role-assignments?userId=${userIdFor('owner@test.local')}`,
  },
  {
    name: 'GET /sites (sites.view, org-wide)',
    keys: ['sites.view'],
    siteScoped: false,
    path: () => `/sites`,
  },
  {
    name: 'GET /analytics/chart (analytics.view_organization, org-wide)',
    keys: ['analytics.view_organization'],
    siteScoped: false,
    path: () => `/analytics/chart`,
  },
  {
    name: 'GET /permissions (no permission required)',
    keys: [],
    siteScoped: false,
    path: () => `/permissions`,
    anyAuthenticated: true,
  },
  {
    name: 'GET /auth/me (no permission required)',
    keys: [],
    siteScoped: false,
    path: () => `/auth/me`,
    anyAuthenticated: true,
  },
];

describe('T-01 TC-01.1 — Endpoint x Role matrix', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe.each(ENDPOINTS)('$name', (endpoint) => {
    const sites = endpoint.siteScoped ? ALL_SITE_NAMES : [null];

    describe.each(sites)('site=%s', (site) => {
      it.each(ALL_SEEDED_EMAILS)('%s', async (email: SeededEmail) => {
        const expectedAllowed =
          endpoint.anyAuthenticated || expectAllowed(email, endpoint.keys, site);

        const res = await request(app.getHttpServer())
          .get(endpoint.path(site))
          .set(...authHeader(email));

        if (expectedAllowed) {
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(300);
        } else {
          expect(res.status).toBe(403);
          // Guardrail: a denied response must never leak the target
          // resource's data (e.g. an `items` array or the resource itself).
          expect(res.body.items).toBeUndefined();
          expect(res.body.sitePermissions).toBeUndefined();
        }
      });
    });
  });
});
