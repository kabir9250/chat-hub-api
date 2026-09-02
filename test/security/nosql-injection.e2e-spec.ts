/**
 * T-09 Security session — NoSQL injection (SRS §6.3 item 1).
 *
 * Targets every user-supplied field that ultimately participates in a
 * Mongoose query and is reachable without first being authenticated as a
 * trusted party: the conversation search/filter fields (FR-AGT-09), the
 * visitor pre-chat form (FR-WID-05), and the login credentials themselves
 * (the classic `{ email: { "$ne": null }, password: { "$ne": null } }`
 * auth-bypass payload). Real Supertest calls against the real `AppModule`/
 * `zendesk_test`, no mocking of `ValidationPipe`, Mongoose, or the DB.
 *
 * Hypothesis going in (per the task's own "confirm, don't assume"
 * instruction): the global `ValidationPipe({ whitelist: true, transform:
 * true, forbidNonWhitelisted: true })` in `main.ts`, combined with every
 * DTO field in this codebase being typed with a concrete `class-validator`
 * decorator (`@IsString`/`@IsEmail`/`@IsMongoId`/...), should reject an
 * operator-object payload (`{ "$ne": null }`) before it ever reaches a
 * Mongoose query — `@IsString()`/`@IsEmail()` both fail `typeof value ===
 * 'string'` for a plain object. This suite exercises that against the real
 * app rather than reading the DTOs and assuming.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createSecurityTestApp } from './helpers/app';
import { authHeader, siteId } from '../helpers/fixtures';

describe('Security — NoSQL injection (SRS §6.3 item 1)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await createSecurityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/login — classic operator-injection auth bypass', () => {
    it('rejects { "$ne": null } as email (JSON body)', async () => {
      const res = await request(server)
        .post('/auth/login')
        .send({ email: { $ne: null }, password: { $ne: null } });
      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
    });

    it('rejects { "$gt": "" } as email', async () => {
      const res = await request(server)
        .post('/auth/login')
        .send({ email: { $gt: '' }, password: { $gt: '' } });
      expect(res.status).toBe(400);
    });

    it('rejects a well-typed but wrong password (sanity control — real 401, not a bypass)', async () => {
      const res = await request(server)
        .post('/auth/login')
        .send({ email: 'owner@test.local', password: 'not-the-real-password' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /sites/:siteId/conversations?search=... — FR-AGT-09 visitor name/email search', () => {
    const site = () => siteId('Site A');

    it('rejects search[$ne]=null via query-string bracket-operator injection', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query('search[$ne]=null')
        .set(...authHeader('supervisor-a@test.local'));
      // qs's extended parser turns `search[$ne]=null` into
      // `search: { $ne: 'null' }` — an object, not a string. @IsString()
      // on ListConversationsQueryDto.search must reject it.
      expect(res.status).toBe(400);
    });

    it('rejects search[$regex]=.* (ReDoS/enumerate-everything attempt)', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query('search[$regex]=.*&search[$options]=i')
        .set(...authHeader('supervisor-a@test.local'));
      expect(res.status).toBe(400);
    });

    it('rejects search[$where]=... (server-side JS execution attempt)', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query('search[$where]=1==1')
        .set(...authHeader('supervisor-a@test.local'));
      expect(res.status).toBe(400);
    });

    it('a plain string search still works normally (control case, proves the endpoint itself is healthy)', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query({ search: 'not-a-real-visitor-name-xyz' })
        .set(...authHeader('supervisor-a@test.local'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items ?? res.body.groups ?? res.body)).toBe(
        true,
      );
    });

    it('rejects agentId[$ne]=null (IsMongoId field, same operator-injection shape)', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query('agentId[$ne]=null')
        .set(...authHeader('supervisor-a@test.local'));
      expect(res.status).toBe(400);
    });

    it('rejects tag[$ne]=null (IsString field)', async () => {
      const res = await request(server)
        .get(`/sites/${site()}/conversations`)
        .query('tag[$ne]=null')
        .set(...authHeader('supervisor-a@test.local'));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /visitor-session/init — siteId (IsMongoId) operator injection', () => {
    it('rejects siteId as an object (would otherwise match "any Site")', async () => {
      const res = await request(server)
        .post('/visitor-session/init')
        .send({ siteId: { $ne: null } });
      expect(res.status).toBe(400);
    });

    it('rejects a non-ObjectId siteId string cleanly (sanity control)', async () => {
      const res = await request(server)
        .post('/visitor-session/init')
        .send({ siteId: 'not-an-object-id' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /visitor-session/profile — pre-chat form name/email operator injection', () => {
    it('rejects an operator object for name/email even with a valid visitor session', async () => {
      // Establish a real visitor session first (the route requires
      // VisitorAuthGuard), then attempt the injection on the profile submit.
      const initRes = await request(server)
        .post('/visitor-session/init')
        .send({ siteId: siteId('Site A') });
      expect(initRes.status).toBe(200);
      const visitorToken = initRes.body.token;

      const res = await request(server)
        .patch('/visitor-session/profile')
        .set('Authorization', `Bearer ${visitorToken}`)
        .send({ name: { $ne: null }, email: { $gt: '' } });
      expect(res.status).toBe(400);
    });
  });
});
