/**
 * T-01 RBAC — TC-01.7: /auth/me effective permissions, exact-match.
 *
 * For each of the 8 seeded users, GET /auth/me must return
 * organizationPermissions/sitePermissions matching EXACTLY (as sets — no
 * more, no less permissions, no extra/missing Sites) what SRS §5.13's
 * default Role definitions + seed-test.ts's Role Assignments imply, per the
 * independent `helpers/expected-permissions.ts` model.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { ALL_SEEDED_EMAILS, authHeader, SeededEmail, siteId } from '../helpers/fixtures';
import {
  accessibleSites,
  ALL_SITE_NAMES,
  effectivePermissions,
} from '../helpers/expected-permissions';

function sortedArray(s: Iterable<string>): string[] {
  return [...s].sort();
}

describe('T-01 TC-01.7 — /auth/me effective permissions exact-match', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(ALL_SEEDED_EMAILS)('%s', async (email: SeededEmail) => {
    const res = await request(app.getHttpServer()).get('/auth/me').set(...authHeader(email));
    expect(res.status).toBe(200);

    const expectedOrgPerms = sortedArray(effectivePermissions(email, null));
    expect(sortedArray(res.body.organizationPermissions)).toEqual(expectedOrgPerms);

    const expectedSites = accessibleSites(email);
    const actualSiteIds = Object.keys(res.body.sitePermissions);

    // Exactly the expected set of Sites — no extra, none missing.
    const expectedSiteIds = expectedSites.map((name) => siteId(name)).sort();
    expect(actualSiteIds.sort()).toEqual(expectedSiteIds);

    for (const siteName of ALL_SITE_NAMES) {
      const id = siteId(siteName);
      const expected = sortedArray(effectivePermissions(email, siteName));
      if (expectedSites.includes(siteName)) {
        expect(sortedArray(res.body.sitePermissions[id])).toEqual(expected);
      } else {
        expect(res.body.sitePermissions[id]).toBeUndefined();
      }
    }
  });
});
