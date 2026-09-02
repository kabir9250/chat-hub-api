/**
 * T-01 RBAC session — Jest e2e globalSetup.
 *
 * Logs in all 8 seeded test accounts via the REAL `POST /auth/login` HTTP
 * route (real bcrypt compare + real JWT sign — no mocking), and caches the
 * resulting tokens/user ids/site ids to a JSON fixture file that every
 * `*.e2e-spec.ts` file reads instead of logging in again itself.
 *
 * WHY a shared global login instead of each spec file logging in its own
 * accounts: many spec files across many `*.e2e-spec.ts` files would each
 * need to log in some/all of the 8 seeded accounts if they didn't share
 * this cache — logging in once, globally, for the whole run avoids that
 * repetition while still exercising the real HTTP login endpoint end-to-end.
 *
 * All 8 logins below run back-to-back, no artificial delay between them
 * (Session Fix-04, PROGRESS.md): `POST /auth/login`'s brute-force
 * protection (`LoginAttemptService`) only counts FAILED attempts — a
 * successful login is never throttled. Before that fix, this route
 * counted every attempt (right or wrong) toward a flat 5/60s-per-IP cap
 * (`@Throttle`), so this file had to split the 8 real logins into two
 * waves of 4 with a 65s cooldown between them just to stay under it —
 * that wait is gone now that success never counts.
 *
 * Runs once before any spec file, via jest-e2e.json's `globalSetup`. Boots
 * one throwaway Nest application instance (same `AppModule` every spec file
 * uses), drives it with Supertest, and shuts it down again — spec files each
 * boot their own separate instance as before, they just don't need to
 * re-login.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const PASSWORD = 'Test1234!';

const SEEDED_EMAILS = [
  'owner@test.local',
  'manager@test.local',
  'supervisor-a@test.local',
  'supervisor-b@test.local',
  'agent-a1@test.local',
  'agent-a2@test.local',
  'agent-b1@test.local',
  'agent-multi@test.local',
] as const;

const FIXTURE_PATH = path.resolve(__dirname, '.fixtures/session.json');

export default async function globalSetup(): Promise<void> {
  // Idempotent across repeated `npm run test:e2e` invocations within the
  // same T-01 session: skip re-login (and its ~65s two-wave throttle-safe
  // pacing) if a fixture from this session already exists. Delete
  // test/.fixtures/session.json to force a fresh login (e.g. after
  // `npm run seed:test` re-mints user/site ids).
  if (fs.existsSync(FIXTURE_PATH)) {
    return;
  }

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication = moduleFixture.createNestApplication();
  await app.init();

  const server = app.getHttpServer();

  const users: Record<
    string,
    { token: string; userId: string; organizationId: string }
  > = {};

  // All 8, back-to-back — no wave-splitting/cooldown needed now that
  // successful logins are never throttled (see this file's own header
  // comment, Session Fix-04).
  for (const email of SEEDED_EMAILS) {
    const res = await request(server)
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    if (res.status !== 200) {
      throw new Error(
        `global-setup: login failed for ${email} — status ${res.status}, body ${JSON.stringify(res.body)}`,
      );
    }
    users[email] = {
      token: res.body.accessToken,
      userId: res.body.user.userId,
      organizationId: res.body.user.organizationId,
    };
  }

  // Owner is Organization-scoped -> /auth/me's siteNames covers all 4 seeded
  // Sites. Use it to build a name -> id map ("Site A" -> id) so spec files
  // never have to hardcode/re-derive an id (ids are re-minted on every
  // `npm run seed:test`, per the project's own standing convention).
  const meRes = await request(server)
    .get('/auth/me')
    .set('Authorization', `Bearer ${users['owner@test.local'].token}`);
  if (meRes.status !== 200) {
    throw new Error(
      `global-setup: GET /auth/me for owner failed — status ${meRes.status}`,
    );
  }
  const siteNames: Record<string, string> = meRes.body.siteNames;
  const sitesByName: Record<string, string> = {};
  for (const [id, name] of Object.entries(siteNames)) {
    sitesByName[name] = id;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    users,
    sitesByName, // { "Site A": "<id>", "Site B": "<id>", ... }
  };

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(output, null, 2), 'utf-8');

  // Deliberately NOT calling `app.close()` here. FINDING (test-harness only,
  // not application code): closing this throwaway bootstrap app's Mongoose
  // connection immediately after driving 9 real HTTP requests reproducibly
  // crashed the entire Jest process with an uncaught
  // `MongoNotConnectedError: Client must be connected before running
  // operations` thrown from the MongoDB Node driver's own internals (a
  // shutdown-timing race — a background driver operation firing while the
  // connection is mid-teardown) — this happens OUTSIDE any Promise this
  // code awaits, so it cannot be caught with try/catch here. Since
  // `globalSetup` runs in Jest's main process (not a worker), an uncaught
  // exception there aborts the whole run before a single spec file
  // executes — confirmed live during this session (see the T-01 report's
  // Environment Notes). Leaving this one throwaway connection open for the
  // remaining lifetime of the `test:e2e` process (which exits once every
  // spec file finishes, closing it anyway) is a safe, deliberate trade-off
  // to avoid that crash. Every real spec file's own app instance still
  // closes itself normally in its own `afterAll`.
}
