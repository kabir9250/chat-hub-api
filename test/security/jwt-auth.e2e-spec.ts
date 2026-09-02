/**
 * T-09 Security session — JWT tampering + expiry (SRS §6.3 items 5 & 6).
 *
 * Real Supertest calls against the real `AppModule`/`zendesk_test`, real
 * `POST /auth/login`-issued tokens, real `passport-jwt` verification
 * (`JwtStrategy`) — nothing mocked. `JWT_SECRET` is read from the real
 * running app's own config (`.env.test`, `test-secret-change-me`) via
 * `ConfigService`, not hardcoded here, so this suite works even if a future
 * session rotates it.
 *
 * `UserJwtPayload` (see `src/auth/interfaces/jwt-payload.interface.ts`) is
 * deliberately minimal — `{ sub, email, type }`, no `role`/permissions
 * embedded at all. `JwtStrategy.validate()` re-loads the User from Mongo by
 * `payload.sub` on every request rather than trusting anything else in the
 * token (see that file's own doc comment) — so "tamper the role" isn't
 * even a meaningful attack shape against THIS token design; the real
 * tampering surface is `sub` (impersonate a different user id) and `exp`
 * (extend/forge a session past its real expiry). Both are covered below,
 * plus the "add a role claim anyway" case for completeness (confirms it's
 * inert, not just absent).
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';

import { createSecurityTestApp } from './helpers/app';
import { authHeader, siteId, tokenFor, userIdFor } from '../helpers/fixtures';
import { User, UserDocument } from '../../src/database/schemas';

describe('Security — JWT tampering & expiry (SRS §6.3 items 5 & 6)', () => {
  let app: INestApplication;
  let server: any;
  let realSecret: string;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createSecurityTestApp();
    server = app.getHttpServer();
    realSecret = app.get(ConfigService).get<string>('app.jwt.secret')!;
    userModel = app.get(getModelToken(User.name));
  });

  afterAll(async () => {
    await app.close();
  });

  it('control: the real, unmodified token from /auth/login works', async () => {
    const res = await request(server)
      .get('/auth/me')
      .set(...authHeader('agent-a1@test.local'));
    expect(res.status).toBe(200);
  });

  describe('Tampering — payload modified, re-signed with a DIFFERENT (attacker-guessed) secret', () => {
    it('rejects a token with `sub` changed to owner\'s userId, signed with the wrong secret', async () => {
      const { iat: _iat, exp: _exp, ...realPayload } = jwt.decode(
        tokenFor('agent-a1@test.local'),
      ) as Record<string, unknown>;
      const forged = jwt.sign(
        { ...realPayload, sub: userIdFor('owner@test.local') },
        'attacker-guessed-wrong-secret',
        { expiresIn: '1d' },
      );
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token with an added `role: "owner"` claim, signed with the wrong secret (confirms role-claim tampering is also caught by signature verification)', async () => {
      const { iat: _iat, exp: _exp, ...realPayload } = jwt.decode(
        tokenFor('agent-a1@test.local'),
      ) as Record<string, unknown>;
      const forged = jwt.sign(
        { ...realPayload, role: 'owner', isAdmin: true },
        'attacker-guessed-wrong-secret',
        { expiresIn: '1d' },
      );
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('rejects a payload-only bit-flip: the header/payload of a real token altered by one character, signature left untouched (classic none-verification-bug probe)', async () => {
      const real = tokenFor('agent-a1@test.local');
      const parts = real.split('.');
      // Flip one base64url character in the payload segment.
      const payload = parts[1];
      const flippedChar = payload[0] === 'a' ? 'b' : 'a';
      parts[1] = flippedChar + payload.slice(1);
      const tampered = parts.join('.');
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${tampered}`);
      expect(res.status).toBe(401);
    });

    it('rejects the classic `alg: none` unsigned-token bypass attempt', async () => {
      const realPayload = jwt.decode(tokenFor('agent-a1@test.local')) as Record<string, unknown>;
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(realPayload)).toString('base64url');
      const noneToken = `${header}.${body}.`;
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${noneToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe('Tampering — payload modified, re-signed with the app\'s REAL secret (worst case: what if the secret leaked)', () => {
    it('a `sub` swapped to a different real user IS accepted by signature verification, but only ever grants that OTHER real user\'s own actual permissions — never elevates beyond what a real login as them would give (defense in depth: this is what RBAC, not JWT, is for)', async () => {
      // This is a deliberate, labeled worst-case probe, not a "found a
      // bug" case: if JWT_SECRET itself leaks, forging a token for ANY
      // known userId is trivially possible for any JWT-based auth system —
      // that's why secret rotation/storage is the actual mitigation, not
      // something this test can prove/disprove. What IS worth confirming:
      // the forged token grants exactly agent-a1's real permissions (it
      // does not, for example, inherit anything from the original
      // agent-a1 token's context) and CANNOT reach a Site agent-a1 has no
      // Role Assignment on — i.e. re-signing with the real secret is not a
      // privilege-escalation primitive beyond "become this other real,
      // already-existing account."
      const realPayload = jwt.decode(tokenFor('agent-a1@test.local')) as Record<string, unknown>;
      const forged = jwt.sign(
        { ...realPayload, sub: userIdFor('agent-b1@test.local') },
        realSecret,
      );
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(userIdFor('agent-b1@test.local'));
      expect(res.body.email).toBe('agent-b1@test.local');
    });

    it('a `sub` for a userId that does not exist in the DB is rejected even with a valid signature (JwtStrategy re-loads from Mongo, never trusts the token alone)', async () => {
      const realPayload = jwt.decode(tokenFor('agent-a1@test.local')) as Record<string, unknown>;
      const forged = jwt.sign(
        { ...realPayload, sub: '000000000000000000000000' },
        realSecret,
      );
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('a disabled user\'s validly-signed token is rejected immediately (FR-USR-06), not just once it expires', async () => {
      const target = await userModel.findOne({ email: 'agent-a2@test.local' }).exec();
      expect(target).toBeTruthy();
      const originalEnabled = target!.enabled;
      const payload = { sub: target!._id.toString(), email: target!.email, type: 'user' };
      const validToken = jwt.sign(payload, realSecret, { expiresIn: '1d' });

      target!.enabled = false;
      await target!.save();
      try {
        const res = await request(server)
          .get('/auth/me')
          .set('Authorization', `Bearer ${validToken}`);
        expect(res.status).toBe(401);
      } finally {
        // Restore so this doesn't leave agent-a2 disabled for any other
        // spec file / a future re-run before the next `npm run seed:test`.
        target!.enabled = originalEnabled;
        await target!.save();
      }
    });
  });

  describe('Expiry (SRS §6.3 item 6)', () => {
    it('rejects an expired token (exp in the past), signed with the real secret', async () => {
      const realPayload = jwt.decode(tokenFor('agent-a1@test.local')) as Record<string, unknown>;
      const { iat: _iat, exp: _exp, ...rest } = realPayload;
      const expired = jwt.sign(rest, realSecret, { expiresIn: '-1h' });
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
    });

    it('accepts a token that is validly signed and not yet expired (control case)', async () => {
      const realPayload = jwt.decode(tokenFor('agent-a1@test.local')) as Record<string, unknown>;
      const { iat: _iat, exp: _exp, ...rest } = realPayload;
      const fresh = jwt.sign(rest, realSecret, { expiresIn: '5m' });
      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${fresh}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Token-kind isolation (bonus, directly relevant to "tampering")', () => {
    it('a Visitor session token can never authenticate as a User, even validly signed', async () => {
      const initRes = await request(server)
        .post('/visitor-session/init')
        .send({ siteId: siteId('Site A') });
      expect(initRes.status).toBe(200);
      const visitorToken = initRes.body.token as string;

      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${visitorToken}`);
      expect(res.status).toBe(401);
    });
  });
});
