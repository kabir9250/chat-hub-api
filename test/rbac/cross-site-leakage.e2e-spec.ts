/**
 * T-01 RBAC — TC-01.2: Cross-site leakage.
 *
 * supervisor-a@test.local (Site A only) attempting to read/write Site B's
 * data across every resource type the SRS lists (users, conversations,
 * visitors, widget config, triggers, business hours, shortcuts, analytics)
 * must get a real 403 — never a 200 with an empty/filtered array, and never
 * any leaked Site-B data in the denied response body.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-01 TC-01.2 — Cross-site leakage (supervisor-a -> Site B)', () => {
  let app: INestApplication;
  const AUTH = authHeader('supervisor-a@test.local');

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const siteB = () => siteId('Site B');

  const cases: Array<{ name: string; req: () => request.Test }> = [
    {
      name: 'GET Site B users',
      req: () => request(app.getHttpServer()).get(`/sites/${siteB()}/users`).set(...AUTH),
    },
    {
      name: 'POST create a Site B user',
      req: () =>
        request(app.getHttpServer())
          .post(`/sites/${siteB()}/users`)
          .set(...AUTH)
          .send({
            displayName: 'Leak Test',
            fullName: 'Leak Test',
            email: 'leak-test@test.local',
            password: 'Test1234!',
          }),
    },
    {
      name: 'GET Site B conversations',
      req: () =>
        request(app.getHttpServer()).get(`/sites/${siteB()}/conversations`).set(...AUTH),
    },
    {
      name: 'GET Site B visitors',
      req: () => request(app.getHttpServer()).get(`/sites/${siteB()}/visitors`).set(...AUTH),
    },
    {
      name: 'GET Site B widget config',
      req: () =>
        request(app.getHttpServer()).get(`/sites/${siteB()}/widget-config`).set(...AUTH),
    },
    {
      name: 'PATCH Site B widget config',
      req: () =>
        request(app.getHttpServer())
          .patch(`/sites/${siteB()}/widget-config`)
          .set(...AUTH)
          .send({ topTitle: 'hacked' }),
    },
    {
      name: 'GET Site B triggers',
      req: () => request(app.getHttpServer()).get(`/sites/${siteB()}/triggers`).set(...AUTH),
    },
    {
      name: 'POST a Site B trigger',
      req: () =>
        request(app.getHttpServer())
          .post(`/sites/${siteB()}/triggers`)
          .set(...AUTH)
          .send({
            name: 'leak',
            matchType: 'path_prefix',
            matchValue: '/x',
            action: 'showProactiveMessage',
            priority: 1,
          }),
    },
    {
      name: 'GET Site B business hours',
      req: () =>
        request(app.getHttpServer()).get(`/sites/${siteB()}/business-hours`).set(...AUTH),
    },
    {
      name: 'PATCH Site B business hours',
      req: () =>
        request(app.getHttpServer())
          .patch(`/sites/${siteB()}/business-hours`)
          .set(...AUTH)
          .send({ enabled: true }),
    },
    {
      name: 'GET Site B leads',
      req: () => request(app.getHttpServer()).get(`/sites/${siteB()}/leads`).set(...AUTH),
    },
    {
      name: 'GET Site B departments',
      req: () =>
        request(app.getHttpServer()).get(`/sites/${siteB()}/departments`).set(...AUTH),
    },
    {
      name: 'GET Site B analytics chart',
      req: () =>
        request(app.getHttpServer()).get(`/sites/${siteB()}/analytics/chart`).set(...AUTH),
    },
    {
      name: 'POST a Site B shortcut (SITE scope)',
      req: () =>
        request(app.getHttpServer())
          .post(`/shortcuts`)
          .set(...AUTH)
          .send({
            scopeLevel: 'SITE',
            siteId: siteB(),
            shortcutKeyword: 'leak',
            purpose: 'leak test',
            message: 'leak',
          }),
    },
    {
      name: 'GET Site B shortcuts available',
      req: () =>
        request(app.getHttpServer())
          .get(`/shortcuts/available?siteId=${siteB()}`)
          .set(...AUTH),
    },
  ];

  it.each(cases)('$name -> 403, no leaked data', async ({ req }) => {
    const res = await req();
    expect(res.status).toBe(403);
    // Guardrail: a 403 body must never contain actual Site-B resource data
    // — an array of records, or a resource object's own fields (name,
    // items, sitePermissions, etc.). PermissionGuard's rejection message
    // legitimately echoes back the :siteId the CALLER themselves put in the
    // URL (e.g. "for site <id>") — that is not a data leak, just restating
    // the caller's own request, so it is deliberately excluded from this
    // check.
    expect(res.body.items).toBeUndefined();
    expect(res.body.name).toBeUndefined();
    expect(res.body.sitePermissions).toBeUndefined();
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.error).toBe('Forbidden');
  });
});
