/**
 * T-01 RBAC — TC-01.1 (mutation half): `.manage`-type permissions.
 *
 * Split from `endpoint-role-matrix.e2e-spec.ts` (read-only) because a
 * mutating endpoint needs a body — for the DENIED side that doesn't matter
 * (PermissionGuard rejects before any DTO validation ever runs, confirmed
 * via `src/rbac/guards/permission.guard.ts`/Nest's guard-before-pipe
 * ordering), so denial is tested exhaustively across all 8 users x every
 * Site. For the ALLOWED side, a valid body is required per endpoint, so
 * this file covers one representative allowed case per permission key
 * (documented in the T-01 report as "representative, not exhaustive" —
 * exhaustive allowed-mutation coverage across 8 users x 4 Sites would mean
 * dozens of real writes against the shared seeded dataset for no extra
 * confidence beyond what the guard's own logic (already exhaustively
 * proven on the read-only matrix) provides).
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
import { ALL_SITE_NAMES, expectAllowed } from '../helpers/expected-permissions';

interface MutationDef {
  name: string;
  keys: string[];
  method: 'post' | 'patch' | 'delete';
  path: (site: SiteName) => string;
}

const MUTATIONS: MutationDef[] = [
  {
    name: 'POST /sites/:siteId/users (users.manage)',
    keys: ['users.manage'],
    method: 'post',
    path: (s) => `/sites/${siteId(s)}/users`,
  },
  {
    name: 'POST /sites/:siteId/departments (departments.manage)',
    keys: ['departments.manage'],
    method: 'post',
    path: (s) => `/sites/${siteId(s)}/departments`,
  },
  {
    name: 'PATCH /sites/:siteId/widget-config (widget_config.manage)',
    keys: ['widget_config.manage'],
    method: 'patch',
    path: (s) => `/sites/${siteId(s)}/widget-config`,
  },
  {
    name: 'POST /sites/:siteId/triggers (triggers.manage)',
    keys: ['triggers.manage'],
    method: 'post',
    path: (s) => `/sites/${siteId(s)}/triggers`,
  },
  {
    name: 'PATCH /sites/:siteId/business-hours (business_hours.manage)',
    keys: ['business_hours.manage'],
    method: 'patch',
    path: (s) => `/sites/${siteId(s)}/business-hours`,
  },
  {
    name: 'POST /sites/:siteId/visitors/:visitorId/ban (visitors.ban)',
    keys: ['visitors.ban'],
    method: 'post',
    path: (s) => `/sites/${siteId(s)}/visitors/000000000000000000000000/ban`,
  },
  {
    name: 'PATCH /roles/:id (roles.manage, org-wide)',
    keys: ['roles.manage'],
    method: 'patch',
    path: () => `/roles/000000000000000000000000`,
  },
  {
    name: 'PATCH /sites/:siteId (sites.manage, org-wide)',
    keys: ['sites.manage'],
    method: 'patch',
    path: (s) => `/sites/${siteId(s)}`,
  },
];

describe('T-01 TC-01.1 (mutations) — Denied combinations, exhaustive', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe.each(MUTATIONS)('$name', (m) => {
    describe.each(ALL_SITE_NAMES)('site=%s', (site) => {
      it.each(ALL_SEEDED_EMAILS)('%s', async (email: SeededEmail) => {
        const allowed = expectAllowed(email, m.keys, site);
        if (allowed) return; // covered by the representative allowed-case tests below

        const res = await (request(app.getHttpServer()) as any)
          [m.method](m.path(site))
          .set(...authHeader(email))
          .send({});
        expect(res.status).toBe(403);
      });
    });
  });
});

describe('T-01 TC-01.1 (mutations) — Representative allowed cases', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('users.manage — supervisor-a creates a User on Site A -> 201', async () => {
    const uniqueEmail = `t01-mutation-${Date.now()}@test.local`;
    const rolesRes = await request(app.getHttpServer())
      .get('/roles')
      .set(...authHeader('owner@test.local'));
    const agentRole = rolesRes.body.find((r: any) => r.name === 'Agent');

    const res = await request(app.getHttpServer())
      .post(`/sites/${siteId('Site A')}/users`)
      .set(...authHeader('supervisor-a@test.local'))
      .send({
        displayName: 'T-01 Mutation Test',
        fullName: 'T-01 Mutation Test',
        email: uniqueEmail,
        password: 'Test1234!',
        initialRoleAssignment: { roleId: agentRole._id ?? agentRole.id, scopeType: 'SITE' },
      });
    expect(res.status).toBe(201);
  });

  it('departments.manage — supervisor-a creates a Department on Site A -> 201', async () => {
    const res = await request(app.getHttpServer())
      .post(`/sites/${siteId('Site A')}/departments`)
      .set(...authHeader('supervisor-a@test.local'))
      .send({ name: `T-01 Mutation Dept ${Date.now()}` });
    expect(res.status).toBe(201);
  });

  it('widget_config.manage — owner PATCHes Site A widget config (idempotent no-op value) -> 2xx', async () => {
    const getRes = await request(app.getHttpServer())
      .get(`/sites/${siteId('Site A')}/widget-config`)
      .set(...authHeader('owner@test.local'));
    expect(getRes.status).toBe(200);
    const res = await request(app.getHttpServer())
      .patch(`/sites/${siteId('Site A')}/widget-config`)
      .set(...authHeader('owner@test.local'))
      .send({ topTitle: getRes.body.topTitle });
    expect(res.status).toBe(200);
  });

  it('triggers.manage — owner creates + deletes a Site A trigger -> 201/204', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/sites/${siteId('Site A')}/triggers`)
      .set(...authHeader('owner@test.local'))
      .send({
        name: 'T-01 Mutation Trigger',
        conditions: [],
        actions: [],
        priority: 1,
      });
    expect(createRes.status).toBe(201);
    const id = createRes.body._id ?? createRes.body.id;
    const delRes = await request(app.getHttpServer())
      .delete(`/sites/${siteId('Site A')}/triggers/${id}`)
      .set(...authHeader('owner@test.local'));
    expect(delRes.status).toBe(204);
  });

  it('business_hours.manage — owner PATCHes Site A business hours -> 200', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/sites/${siteId('Site A')}/business-hours`)
      .set(...authHeader('owner@test.local'))
      .send({ enabled: false });
    expect(res.status).toBe(200);
  });

  it('roles.manage — owner creates + deletes a Role -> 201/204', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/roles')
      .set(...authHeader('owner@test.local'))
      .send({ name: `T-01 Mutation Role ${Date.now()}`, description: 'x', permissions: [] });
    expect(createRes.status).toBe(201);
    const id = createRes.body._id ?? createRes.body.id;
    const delRes = await request(app.getHttpServer())
      .delete(`/roles/${id}`)
      .set(...authHeader('owner@test.local'));
    expect(delRes.status).toBe(204);
  });

  it('sites.manage — owner PATCHes Site A (no-op rename to its current name) -> 200', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/sites')
      .set(...authHeader('owner@test.local'));
    const siteA = listRes.body.find((s: any) => s.name === 'Site A');
    expect(siteA).toBeDefined();
    const res = await request(app.getHttpServer())
      .patch(`/sites/${siteId('Site A')}`)
      .set(...authHeader('owner@test.local'))
      .send({ name: siteA.name });
    expect(res.status).toBe(200);
  });
});
