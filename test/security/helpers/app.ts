/**
 * T-09 Security session — Nest app bootstrap for this track's specs.
 *
 * `test/helpers/bootstrap.ts` (T-01 RBAC session)'s `createTestApp()` boots
 * `AppModule` but does NOT reproduce what `src/main.ts` sets up
 * IMPERATIVELY on the real app (none of it is a global `APP_*` provider
 * inside `AppModule` itself, so `Test.createTestingModule({ imports:
 * [AppModule] }).compile()` alone never gets it): the global
 * `ValidationPipe` (whitelist/transform/forbid-unknown on every DTO),
 * `app.enableCors(...)`, and `app.set('trust proxy', 1)`.
 *
 * T-05 (Data Integrity) already found and documented this exact gap for
 * ValidationPipe/trust-proxy (see `test/data-integrity/helpers/app.ts`'s own
 * doc comment) and built its own local helper rather than changing the
 * shared T-01 one — same call made here, extended to also apply
 * `enableCors` (this session's CORS suite needs the real policy) and
 * `helmet` (harmless to include, matches `main.ts` exactly).
 *
 * REAL FINDING this session (T-09), confirmed empirically while building
 * `nosql-injection.e2e-spec.ts` — not merely re-stating T-05's: because
 * every `T-<NN>` e2e spec file up to and including T-08 was built on
 * `test/helpers/bootstrap.ts`'s validation-pipe-less app (T-05's own
 * `data-integrity/helpers/app.ts` is the one documented exception), any
 * test in this whole project that ever asserted "malformed input → 400"
 * against the SHARED `createTestApp()` helper was actually exercising an
 * app with NO DTO validation at all — a materially different app than the
 * one `main.ts` actually deploys. Confirmed directly: sending
 * `{ email: { "$ne": null } }` to `POST /auth/login` against the shared
 * helper's app reaches `AuthService.login` and throws an unhandled
 * `TypeError: email.trim is not a function` (500), not the `400
 * ValidationError` the real, fully-bootstrapped app produces (verified
 * directly against this file's `createSecurityTestApp()` — see
 * `nosql-injection.e2e-spec.ts`'s own results). See T-09-security.md's
 * "Test-harness finding" for the full writeup and why this session fixes
 * it locally (this file) rather than touching the shared T-01 helper.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from '../../../src/app.module';

export async function createSecurityTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  const configService = app.get(ConfigService);

  app.set('trust proxy', 1);
  app.use(helmet({ hsts: false, contentSecurityPolicy: false }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors({
    origin: configService.get<string>('app.cors.origin'),
    credentials: true,
  });

  await app.init();
  return app;
}
