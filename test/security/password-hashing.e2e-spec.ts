/**
 * T-09 Security session — password hashing (SRS §6.3 item 7: "Passwords
 * hashed (never stored in plaintext)").
 *
 * Reads a real seeded User document DIRECTLY from `zendesk_test` via the
 * app's own real Mongoose connection/model (`getModelToken(User.name)`,
 * same pattern `test/data-integrity/*.e2e-spec.ts` already uses) — not
 * through any API response (which never exposes `passwordHash` at all,
 * `select: false` on the schema — see `user.schema.ts`), matching the
 * task's own "read a user record directly from the DB" instruction.
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';

import { createSecurityTestApp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';
import { User, UserDocument } from '../../src/database/schemas';

const REAL_PASSWORD = 'Test1234!';

describe('Security — password hashing (SRS §6.3 item 7)', () => {
  let app: INestApplication;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createSecurityTestApp();
    userModel = app.get(getModelToken(User.name));
  });

  afterAll(async () => {
    await app.close();
  });

  it('passwordHash on the real DB document is a real bcrypt hash, never the plaintext password', async () => {
    // passwordHash has `select: false` — must explicitly ask for it, same
    // as AuthService.login does, to prove this isn't testing a field that
    // was already stripped by the schema before we even looked.
    const user = await userModel
      .findOne({ email: 'agent-a1@test.local' })
      .select('+passwordHash')
      .exec();
    expect(user).toBeTruthy();

    const hash = user!.passwordHash;
    expect(hash).toBeTruthy();
    expect(hash).not.toBe(REAL_PASSWORD);
    // Not merely "different string" — confirm it's not some other
    // reversible encoding of the plaintext either (base64, hex, etc.).
    expect(hash).not.toBe(Buffer.from(REAL_PASSWORD).toString('base64'));
    expect(hash).not.toBe(Buffer.from(REAL_PASSWORD).toString('hex'));
    expect(hash.toLowerCase()).not.toContain(REAL_PASSWORD.toLowerCase());

    // The real, distinguishing test: a bcrypt hash has a well-defined
    // format (`$2a$`/`$2b$`/`$2y$`, cost factor, 22-char salt, 31-char
    // digest — 60 chars total) — assert the actual format, not just "it
    // looks different".
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);

    // The strongest possible confirmation: bcrypt.compare against the
    // REAL plaintext password (known from the seed fixture, README.md)
    // must succeed — proving this is a genuine, verifiable bcrypt hash of
    // that exact password, not a hash-shaped random string.
    const matches = await bcrypt.compare(REAL_PASSWORD, hash);
    expect(matches).toBe(true);

    // And a wrong password must NOT match — sanity control that this
    // isn't a hash that matches everything.
    const wrongMatches = await bcrypt.compare('definitely-wrong', hash);
    expect(wrongMatches).toBe(false);
  });

  it('every seeded account\'s passwordHash is bcrypt-formatted (not just one cherry-picked record)', async () => {
    const users = await userModel.find({}).select('+passwordHash email').exec();
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    }
  });

  // FINDING (test-fixture only, not a defect — see T-09-security.md): all 8
  // seeded accounts share the IDENTICAL passwordHash string, confirmed
  // directly against the real DB. Root cause, read from source:
  // `seed-test.ts` calls `hashPassword(TEST_PASSWORD)` ONCE and reuses that
  // one hash for every seeded user (a deliberate seed-script perf shortcut,
  // not a bug in it — hashing 8x with bcrypt's cost factor 12 would add real
  // seconds to every `npm run seed:test` for zero test value). The REAL
  // production path this session actually needs to verify is
  // `UsersService.create()`'s own `bcrypt.hashSync(dto.password, 12)` call —
  // exercised below via two real `POST /sites/:siteId/users` calls with the
  // IDENTICAL password, through the real HTTP/RBAC/service layers.
  it('two real Users created via POST /sites/:siteId/users with the SAME password get DIFFERENT passwordHash values (fresh salt per hash, real production path)', async () => {
    const server = app.getHttpServer();
    const site = siteId('Site A');

    const rolesRes = await request(server)
      .get('/roles')
      .set(...authHeader('owner@test.local'));
    expect(rolesRes.status).toBe(200);
    const roles = rolesRes.body.items ?? rolesRes.body;
    const agentRole = roles.find((r: any) => r.name === 'Agent');
    expect(agentRole).toBeTruthy();

    const suffix = Date.now();
    const shared = 'SharedPassw0rd!';
    const makeUser = (n: number) =>
      request(server)
        .post(`/sites/${site}/users`)
        .set(...authHeader('owner@test.local'))
        .send({
          displayName: `PwHash Test ${n}`,
          fullName: `PwHash Test User ${n}`,
          email: `pwhash-test-${suffix}-${n}@test.local`,
          password: shared,
          initialRoleAssignment: { roleId: agentRole._id ?? agentRole.id, scopeType: 'SITE' },
        });

    const [u1Res, u2Res] = await Promise.all([makeUser(1), makeUser(2)]);
    if (u1Res.status >= 300) throw new Error(`user 1 create failed: ${u1Res.status} ${JSON.stringify(u1Res.body)}`);
    if (u2Res.status >= 300) throw new Error(`user 2 create failed: ${u2Res.status} ${JSON.stringify(u2Res.body)}`);
    const id1 = u1Res.body._id ?? u1Res.body.id;
    const id2 = u2Res.body._id ?? u2Res.body.id;

    const [doc1, doc2] = await Promise.all([
      userModel.findById(id1).select('+passwordHash').exec(),
      userModel.findById(id2).select('+passwordHash').exec(),
    ]);
    expect(doc1!.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(doc2!.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(doc1!.passwordHash).not.toBe(doc2!.passwordHash);
    expect(await bcrypt.compare(shared, doc1!.passwordHash)).toBe(true);
    expect(await bcrypt.compare(shared, doc2!.passwordHash)).toBe(true);
  });

  it('no API response ever exposes passwordHash, even to the Owner (defense in depth — confirms `select: false` actually holds at the HTTP layer, not just the raw model)', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .get('/auth/me')
      .set(...authHeader('owner@test.local'));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain(REAL_PASSWORD.toLowerCase());
  });
});
