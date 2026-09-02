/**
 * T-01 RBAC — TC-01.4: Privilege escalation (FR-RBAC-09).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, userIdFor } from '../helpers/fixtures';

describe('T-01 TC-01.4 — Privilege escalation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-01.4.a — agent-a1 tries to create a Role -> 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/roles')
      .set(...authHeader('agent-a1@test.local'))
      .send({ name: 'Escalation Test Role', description: 'x', permissions: [] });
    expect(res.status).toBe(403);
  });

  it('TC-01.4.a2 — agent-a1 tries to edit a Role -> 403', async () => {
    // Fetch a real Role id as Owner first (agent-a1 can't list Roles at all).
    const asOwner = await request(app.getHttpServer())
      .get('/roles')
      .set(...authHeader('owner@test.local'));
    expect(asOwner.status).toBe(200);
    const agentRole = asOwner.body.find((r: any) => r.name === 'Agent');
    expect(agentRole).toBeDefined();

    const res = await request(app.getHttpServer())
      .patch(`/roles/${agentRole._id ?? agentRole.id}`)
      .set(...authHeader('agent-a1@test.local'))
      .send({ permissions: ['roles.manage'] });
    expect(res.status).toBe(403);
  });

  it('TC-01.4.b — agent-a1 tries to grant themselves a permission via Role Assignment API -> 403', async () => {
    const asOwner = await request(app.getHttpServer())
      .get('/roles')
      .set(...authHeader('owner@test.local'));
    const ownerRole = asOwner.body.find((r: any) => r.name === 'Owner');
    expect(ownerRole).toBeDefined();

    // agent-a1 doesn't even hold role_assignments.manage, so this should be
    // a straight 403 from PermissionGuard before any escalation logic runs.
    const res = await request(app.getHttpServer())
      .post('/role-assignments')
      .set(...authHeader('agent-a1@test.local'))
      .send({
        userId: userIdFor('agent-a1@test.local'),
        roleId: ownerRole._id ?? ownerRole.id,
        scopeType: 'ORGANIZATION',
      });
    expect(res.status).toBe(403);
  });

  it('TC-01.4.c — supervisor-a tries to grant a permission they don\'t themselves hold -> 403', async () => {
    // supervisor-a doesn't hold role_assignments.manage or roles.manage at
    // all (not in the Supervisor default set) -> a straight 403 either way.
    // This still proves FR-RBAC-09(a)'s spirit: someone without roles.manage
    // cannot use the Roles API to grant a permission they lack (widget_config.manage,
    // which Supervisor doesn't hold by default).
    const asOwner = await request(app.getHttpServer())
      .get('/roles')
      .set(...authHeader('owner@test.local'));
    const supervisorRole = asOwner.body.find((r: any) => r.name === 'Supervisor');

    const res = await request(app.getHttpServer())
      .patch(`/roles/${supervisorRole._id ?? supervisorRole.id}`)
      .set(...authHeader('supervisor-a@test.local'))
      .send({ permissions: [...supervisorRole.permissions, 'widget_config.manage'] });
    expect(res.status).toBe(403);
  });

  it('TC-01.4.c2 — a role_assignments.manage-only holder cannot self-assign a Role granting permissions they lack (server-side escalation check)', async () => {
    // Build the exact FR-RBAC-09(a) scenario: create a limited custom Role
    // holding ONLY role_assignments.manage (no roles.manage), grant it to
    // agent-a1 (Site A), then confirm agent-a1 still cannot self-assign the
    // Owner Role (which grants many permissions agent-a1 doesn't hold).
    const ownerAuth = authHeader('owner@test.local');
    const createRoleRes = await request(app.getHttpServer())
      .post('/roles')
      .set(...ownerAuth)
      .send({
        name: 'T-01 Escalation Probe Role',
        description: 'role_assignments.manage only, for TC-01.4.c2',
        permissions: ['role_assignments.manage'],
      });
    expect(createRoleRes.status).toBe(201);
    const probeRoleId = createRoleRes.body._id ?? createRoleRes.body.id;

    const grantRes = await request(app.getHttpServer())
      .post('/role-assignments')
      .set(...ownerAuth)
      .send({
        userId: userIdFor('agent-a1@test.local'),
        roleId: probeRoleId,
        scopeType: 'ORGANIZATION',
      });
    expect(grantRes.status).toBe(201);

    // Re-login is unnecessary — PermissionGuard re-reads effective
    // permissions from the DB on every request, so agent-a1's EXISTING
    // token now carries role_assignments.manage without a fresh login.
    const asOwner = await request(app.getHttpServer()).get('/roles').set(...ownerAuth);
    const ownerRole = asOwner.body.find((r: any) => r.name === 'Owner');

    const selfAssignRes = await request(app.getHttpServer())
      .post('/role-assignments')
      .set(...authHeader('agent-a1@test.local'))
      .send({
        userId: userIdFor('agent-a1@test.local'),
        roleId: ownerRole._id ?? ownerRole.id,
        scopeType: 'ORGANIZATION',
      });
    expect(selfAssignRes.status).toBe(403);

    // Cleanup: revoke the probe assignment and delete the probe role so the
    // shared seeded dataset isn't left with an extra permanent grant.
    // IMPORTANT: string-normalize both sides — `roleId` may come back as a
    // populated object ({_id: ObjectId}), a raw ObjectId, or a plain
    // string depending on the API's serialization, so a strict `===`
    // against the string `probeRoleId` silently fails to match and leaves
    // the probe assignment (and its role_assignments.manage grant)
    // permanently in place — confirmed to happen live during this
    // session's own test-development pass (agent-a1 was left holding
    // role_assignments.manage org-wide after an earlier buggy version of
    // this cleanup; fixed here AND the polluted seed data was reset via a
    // fresh `npm run seed:test` before the final test run — see the T-01
    // report's Environment Notes).
    const listRes = await request(app.getHttpServer())
      .get(`/role-assignments?userId=${userIdFor('agent-a1@test.local')}`)
      .set(...ownerAuth);
    const probeAssignment = listRes.body.find((a: any) => {
      const rid = a.roleId?._id ?? a.roleId;
      return String(rid) === String(probeRoleId);
    });
    expect(probeAssignment).toBeDefined();
    const revokeRes = await request(app.getHttpServer())
      .delete(
        `/role-assignments/${userIdFor('agent-a1@test.local')}/${probeAssignment._id ?? probeAssignment.id}`,
      )
      .set(...ownerAuth);
    expect(revokeRes.status).toBe(204);
    const deleteRoleRes = await request(app.getHttpServer())
      .delete(`/roles/${probeRoleId}`)
      .set(...ownerAuth);
    expect(deleteRoleRes.status).toBe(204);

    // Confirm the cleanup actually took (agent-a1 no longer holds
    // role_assignments.manage anywhere) — this is what
    // effective-permissions.e2e-spec.ts's exact-match assertion for
    // agent-a1 depends on staying true.
    const meRes = await request(app.getHttpServer())
      .get('/auth/me')
      .set(...authHeader('agent-a1@test.local'));
    expect(meRes.body.organizationPermissions).not.toContain('role_assignments.manage');
  });

  it('TC-01.4.d — deleting/revoking the last Organization-scoped role_assignments.manage holder is blocked (FR-RBAC-09b)', async () => {
    const ownerAuth = authHeader('owner@test.local');

    const listRes = await request(app.getHttpServer())
      .get(`/role-assignments?userId=${userIdFor('owner@test.local')}`)
      .set(...ownerAuth);
    expect(listRes.status).toBe(200);

    const asRoles = await request(app.getHttpServer()).get('/roles').set(...ownerAuth);
    const ownerRoleId = asRoles.body.find((r: any) => r.name === 'Owner')._id;

    const ownerAssignment = listRes.body.find((a: any) => {
      const rid = a.roleId?._id ?? a.roleId;
      return String(rid) === String(ownerRoleId);
    });
    expect(ownerAssignment).toBeDefined();

    // owner@test.local is the ONLY seeded Organization-scoped
    // role_assignments.manage holder (manager/supervisors/agents hold
    // neither roles.manage nor role_assignments.manage by default) — this
    // revoke attempt must be blocked, not silently succeed and not 500.
    const res = await request(app.getHttpServer())
      .delete(
        `/role-assignments/${userIdFor('owner@test.local')}/${ownerAssignment._id ?? ownerAssignment.id}`,
      )
      .set(...ownerAuth);

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(JSON.stringify(res.body).toLowerCase()).toMatch(
      /last|orphan|lock/,
    );

    // Re-confirm the assignment is still intact (not partially/silently removed).
    const reListRes = await request(app.getHttpServer())
      .get(`/role-assignments?userId=${userIdFor('owner@test.local')}`)
      .set(...ownerAuth);
    const stillThere = reListRes.body.some(
      (a: any) => (a._id ?? a.id) === (ownerAssignment._id ?? ownerAssignment.id),
    );
    expect(stillThere).toBe(true);
  });
});
