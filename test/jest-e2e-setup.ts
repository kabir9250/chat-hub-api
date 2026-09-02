/**
 * Jest e2e global setup — QA Testing Foundation session.
 *
 * Loads `.env.test` (NOT `.env`) into `process.env` before any spec file
 * (and therefore before Nest's own `ConfigModule.forRoot()`) runs. dotenv
 * never overwrites a variable already present in `process.env`, so this
 * must run first — `jest-e2e.json`'s `setupFiles` (not `setupFilesAfterEach`)
 * guarantees that.
 *
 * Effect: every `*.e2e-spec.ts` under `test/` boots `AppModule` against the
 * dedicated test database (`MONGODB_URI` from `.env.test`), never the dev
 * database — see `apps/files/reports/README.md`.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });
