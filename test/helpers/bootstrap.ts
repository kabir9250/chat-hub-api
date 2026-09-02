/**
 * T-01 RBAC session — shared Nest app bootstrap for e2e spec files.
 *
 * Same pattern `test/app.e2e-spec.ts` already uses
 * (`Test.createTestingModule({ imports: [AppModule] }).compile()`), pulled
 * into one helper so every RBAC spec file boots an identical, real app
 * instance (real Mongo connection to zendesk_test via .env.test, real
 * PermissionGuard, real everything) without repeating the boilerplate.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}
