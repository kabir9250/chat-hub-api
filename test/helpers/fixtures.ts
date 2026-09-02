/**
 * T-01 RBAC session — shared test fixtures.
 *
 * Reads the session.json produced by `test/global-setup.ts` (real
 * `POST /auth/login` tokens for all 8 seeded accounts + a Site-name -> id
 * map) so every `*.e2e-spec.ts` file can address a real, current JWT/site id
 * without re-logging in (see global-setup.ts's doc comment for why — the
 * login endpoint's 5/min rate limit) or hardcoding an id that goes stale on
 * the next `npm run seed:test` re-seed.
 */
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_PATH = path.resolve(__dirname, '../.fixtures/session.json');

export type SeededEmail =
  | 'owner@test.local'
  | 'manager@test.local'
  | 'supervisor-a@test.local'
  | 'supervisor-b@test.local'
  | 'agent-a1@test.local'
  | 'agent-a2@test.local'
  | 'agent-b1@test.local'
  | 'agent-multi@test.local';

export type SiteName = 'Site A' | 'Site B' | 'Site C' | 'Site D';

interface SessionFixture {
  generatedAt: string;
  users: Record<
    SeededEmail,
    { token: string; userId: string; organizationId: string }
  >;
  sitesByName: Record<SiteName, string>;
}

let cached: SessionFixture | undefined;

export function loadFixtures(): SessionFixture {
  if (!cached) {
    if (!fs.existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Session fixture not found at ${FIXTURE_PATH} — global-setup.ts should have created it. ` +
          'Make sure tests are run via `npm run test:e2e` (jest-e2e.json wires in globalSetup).',
      );
    }
    cached = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  }
  return cached!;
}

export function tokenFor(email: SeededEmail): string {
  return loadFixtures().users[email].token;
}

export function userIdFor(email: SeededEmail): string {
  return loadFixtures().users[email].userId;
}

export function orgIdFor(email: SeededEmail): string {
  return loadFixtures().users[email].organizationId;
}

export function siteId(name: SiteName): string {
  return loadFixtures().sitesByName[name];
}

export function authHeader(email: SeededEmail): [string, string] {
  return ['Authorization', `Bearer ${tokenFor(email)}`];
}

export const ALL_SEEDED_EMAILS: SeededEmail[] = [
  'owner@test.local',
  'manager@test.local',
  'supervisor-a@test.local',
  'supervisor-b@test.local',
  'agent-a1@test.local',
  'agent-a2@test.local',
  'agent-b1@test.local',
  'agent-multi@test.local',
];
