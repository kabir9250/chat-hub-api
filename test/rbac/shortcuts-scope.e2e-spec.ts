/**
 * T-01 RBAC — TC-01.5: Shortcuts scope enforcement (P2-11, FR-P2-SHORT-04).
 *
 * agent-a1 (holds only shortcuts.manage_own + shortcuts.view, per the
 * default Agent Role) attempting to create a SITE or ORGANIZATION scope
 * Shortcut via a direct API call must be rejected — and, in case the
 * endpoint somehow returns 2xx, the actual created record's scope is
 * checked directly (not just the response body) to rule out a silent
 * downgrade-to-PERSONAL bug.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId } from '../helpers/fixtures';

describe('T-01 TC-01.5 — Shortcuts scope enforcement', () => {
  let app: INestApplication;
  const AUTH = authHeader('agent-a1@test.local');
  const OWNER_AUTH = authHeader('owner@test.local');

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-01.5.a — agent-a1 attempting a SITE-scope shortcut is rejected (403/400), not silently downgraded', async () => {
    const res = await request(app.getHttpServer())
      .post('/shortcuts')
      .set(...AUTH)
      .send({
        scopeLevel: 'SITE',
        siteId: siteId('Site A'),
        shortcutKeyword: 't01-site-probe',
        purpose: 'escalation probe',
        message: 'should be rejected',
      });

    expect([400, 403]).toContain(res.status);

    // If the API somehow returned 2xx despite the expectation above, verify
    // directly that no record was silently created/downgraded.
    if (res.status >= 200 && res.status < 300) {
      const createdId = res.body._id ?? res.body.id;
      const fetched = await request(app.getHttpServer())
        .get(`/shortcuts/${createdId}`)
        .set(...OWNER_AUTH);
      expect(fetched.body.scopeLevel).not.toBe('PERSONAL');
    }

    // Confirm no shortcut with this keyword exists at all (covers the
    // "silently downgraded to Personal" case even if the create call itself
    // returned an error status but wrote a record anyway).
    const listAsAgent = await request(app.getHttpServer())
      .get('/shortcuts?scopeLevel=PERSONAL')
      .set(...AUTH);
    expect(listAsAgent.status).toBe(200);
    const leaked = listAsAgent.body.find(
      (s: any) => s.shortcutKeyword === 't01-site-probe',
    );
    expect(leaked).toBeUndefined();
  });

  it('TC-01.5.b — agent-a1 attempting an ORGANIZATION-scope shortcut is rejected (403/400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/shortcuts')
      .set(...AUTH)
      .send({
        scopeLevel: 'ORGANIZATION',
        shortcutKeyword: 't01-org-probe',
        purpose: 'escalation probe',
        message: 'should be rejected',
      });

    expect([400, 403]).toContain(res.status);

    const listAsAgent = await request(app.getHttpServer())
      .get('/shortcuts?scopeLevel=PERSONAL')
      .set(...AUTH);
    const leaked = listAsAgent.body.find(
      (s: any) => s.shortcutKeyword === 't01-org-probe',
    );
    expect(leaked).toBeUndefined();
  });

  it('TC-01.5.c — control case: agent-a1 CAN create a PERSONAL shortcut (proves the endpoint works at all)', async () => {
    const res = await request(app.getHttpServer())
      .post('/shortcuts')
      .set(...AUTH)
      .send({
        scopeLevel: 'PERSONAL',
        shortcutKeyword: 't01-personal-ok',
        purpose: 'control case',
        message: 'this should succeed',
      });
    expect(res.status).toBe(201);
    expect(res.body.scopeLevel).toBe('PERSONAL');

    // Cleanup.
    await request(app.getHttpServer())
      .delete(`/shortcuts/${res.body._id ?? res.body.id}`)
      .set(...AUTH);
  });

  it('TC-01.5.d — agent-a1 attempting to UPDATE their own Personal shortcut into SITE scope is rejected', async () => {
    const create = await request(app.getHttpServer())
      .post('/shortcuts')
      .set(...AUTH)
      .send({
        scopeLevel: 'PERSONAL',
        shortcutKeyword: 't01-move-probe',
        purpose: 'move probe',
        message: 'x',
      });
    expect(create.status).toBe(201);
    const id = create.body._id ?? create.body.id;

    const move = await request(app.getHttpServer())
      .patch(`/shortcuts/${id}`)
      .set(...AUTH)
      .send({ scopeLevel: 'SITE', siteId: siteId('Site A') });
    expect([400, 403]).toContain(move.status);

    // Verify the record itself was not actually moved.
    const fetched = await request(app.getHttpServer())
      .get(`/shortcuts/${id}`)
      .set(...AUTH);
    expect(fetched.body.scopeLevel).toBe('PERSONAL');

    await request(app.getHttpServer()).delete(`/shortcuts/${id}`).set(...AUTH);
  });
});
