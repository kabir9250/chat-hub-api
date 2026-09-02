/**
 * T-05 Data Integrity session — Nest app bootstrap for this track's specs.
 *
 * `test/helpers/bootstrap.ts` (T-01 RBAC session)'s `createTestApp()` boots
 * `AppModule` but does NOT reproduce two things `src/main.ts` sets up on the
 * real app: the global `ValidationPipe` (whitelist/transform/forbid-unknown
 * on every DTO) and `app.set('trust proxy', 1)` (makes Express — and
 * therefore `ThrottlerGuard`'s per-IP buckets and `extractClientIp()` — read
 * the real client IP from `X-Forwarded-For` instead of the loopback socket
 * address). T-01's suites never needed either: RBAC checks don't touch
 * DTO validation edge cases or IP-based logic. This session's suites do
 * (TC-05.2 bans by IP; several tests send distinct `X-Forwarded-For`
 * headers to get distinct Visitors/IPs from one Supertest connection) — so
 * this is a separate helper that mirrors `main.ts`'s real setup instead of
 * changing the shared T-01 helper (no reason to risk that suite's behavior
 * for this session's needs).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../../src/app.module';

export async function createDataIntegrityTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  return app;
}

/** A fresh, unique-looking loopback-style IPv4 for `X-Forwarded-For` spoofing
 * per test case, so per-IP throttler buckets and ban-by-IP checks in one
 * spec file never collide with each other. Deliberately NOT a real private
 * range (10.x/172.16-31.x/192.168.x) or loopback (127.x) — `AttributionService`
 * treats those as "no geolocation" and this session doesn't need geo data,
 * but using an address space that reads as a distinct public IP per call
 * keeps intent obvious in failure output.
 *
 * FINDING (test-harness only, found while running this suite): each
 * `*.e2e-spec.ts` file gets its own fresh Jest module registry, so a
 * module-level counter starting at a fixed literal produced the exact SAME
 * first IP ("22.0.0.2") in every spec file — harmless on its own, but
 * TC-05.2 (`ban-enforcement.e2e-spec.ts`) bans IPs it generates, and bans
 * are real, persistent Site.bannedIps documents in the shared test DB, so a
 * later spec file reusing that same first IP got a spurious 403. Seeding
 * the counter from `Date.now()`/`process.hrtime` instead makes every spec
 * file (and every run) start from a different point in the address space. */
let ipCounter = Number(process.hrtime.bigint() % 100_000n);
export function nextFakeIp(): string {
  ipCounter += 1;
  const a = 20 + (ipCounter % 200);
  const b = (ipCounter >> 8) % 256;
  const c = (ipCounter >> 4) % 256;
  const d = ipCounter % 256;
  return `${a}.${b}.${c}.${d}`;
}
