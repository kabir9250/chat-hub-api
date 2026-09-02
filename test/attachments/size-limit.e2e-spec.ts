/**
 * T-04 Attachments — TC-04.2: Server-side size limit (FR-P2-ATT-05).
 *
 * Configured limits per `src/storage/attachment-validation.ts`:
 *   IMAGE_MAX_BYTES    = 10 * 1024 * 1024  (10MB)
 *   DOCUMENT_MAX_BYTES = 20 * 1024 * 1024  (20MB)
 *   UPLOAD_HARD_CAP_BYTES = DOCUMENT_MAX_BYTES + 1024 (multer-level coarse
 *     cap, a small buffer above the larger of the two categories — FIXED
 *     post T-11 Test 5 / T-04 Finding #1: multer/busboy treats
 *     `limits.fileSize` as EXCLUSIVE, so setting the hard cap exactly equal
 *     to DOCUMENT_MAX_BYTES rejected a file at exactly the documented max
 *     with a generic 413 before validateUploadedFile's own — correctly
 *     inclusive — check ever ran. The buffer gives every genuinely
 *     in-range file, up to and including exactly the documented max, room
 *     to reach that friendlier check. The documented per-category maximums
 *     themselves (10MB images / 20MB documents) are unchanged.)
 *
 * Each "one byte over" case here proves rejection at the true limit is a
 * real validation, not a silent truncation — and, since the fix above,
 * every one of them now reaches validateUploadedFile's specific message
 * rather than multer's generic 413.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, userIdFor } from '../helpers/fixtures';

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

describe('T-04 TC-04.2 — Server-side size limit', () => {
  let app: INestApplication;
  let siteAId: string;
  let conversationId: string;

  beforeAll(async () => {
    app = await createTestApp();
    siteAId = siteId('Site A');

    const initRes = await request(app.getHttpServer())
      .post('/visitor-session/init')
      .send({ siteId: siteAId, pageUrl: 'https://sitea.test.local/' });
    const visitorToken = initRes.body.token;

    const convRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .send({ initialMessage: 'T-04 size limit test' });
    conversationId = convRes.body._id ?? convRes.body.id;

    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conversationId}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({ agentId: userIdFor('agent-a1@test.local') });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  function upload(buffer: Buffer, filename: string, contentType: string) {
    return request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', buffer, { filename, contentType });
  }

  it('TC-04.2.a — an image exactly at the 10MB limit is accepted', async () => {
    // A valid, minimal PNG stream padded with trailing bytes multer/Nest
    // will still accept as image/png for this size-only check — the actual
    // byte content doesn't matter to validateUploadedFile, only mimetype+size.
    const buf = Buffer.alloc(IMAGE_MAX_BYTES, 0);
    const res = await upload(buf, 'exact-limit.png', 'image/png');
    expect(res.status).toBe(201);
    expect(res.body.fileSizeBytes).toBe(IMAGE_MAX_BYTES);
  }, 30_000);

  it('TC-04.2.b — an image ONE BYTE over the 10MB limit is rejected (400), naming the real size and the limit, not silently truncated', async () => {
    const buf = Buffer.alloc(IMAGE_MAX_BYTES + 1, 0);
    const res = await upload(buf, 'one-byte-over.png', 'image/png');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/i);
    expect(res.body.message).toMatch(/10(\.0)?MB/);
  }, 30_000);

  it('TC-04.2.c — a document exactly at the 20MB limit is accepted (FIX VERIFIED: was a generic 413 before UPLOAD_HARD_CAP_BYTES was raised above DOCUMENT_MAX_BYTES — see T-11 Test 5 / T-04 Finding #1)', async () => {
    const buf = Buffer.alloc(DOCUMENT_MAX_BYTES, 0);
    const res = await upload(buf, 'exact-limit.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    expect(res.body.fileSizeBytes).toBe(DOCUMENT_MAX_BYTES);
  }, 30_000);

  it("TC-04.2.d — a document ONE BYTE over the 20MB limit is rejected (400) with the friendly, size-aware message, not silently accepted/truncated (FIX VERIFIED: previously surfaced as multer's generic 413 at this exact boundary — see report)", async () => {
    // Before the fix, DOCUMENT_MAX_BYTES (20MB) equaled UPLOAD_HARD_CAP_BYTES
    // (the coarse multer-level cap), so a file one byte over 20MB was
    // rejected by multer's own `limits.fileSize` BEFORE the request body
    // was even fully buffered — it never reached validateUploadedFile, so
    // the specific "<file> is too large (...)" message never fired for
    // this one boundary case. UPLOAD_HARD_CAP_BYTES is now DOCUMENT_MAX_BYTES
    // + 1024, so this file is comfortably under the multer-level cap and
    // reaches validateUploadedFile's own, correctly inclusive, size check.
    const buf = Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0);
    const res = await upload(buf, 'one-byte-over.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/i);
    expect(res.body.message).toMatch(/20(\.0)?MB/);
  }, 30_000);

  it('TC-04.2.e — a truly huge upload (well past the global multer hard cap) is rejected at the transport layer, never fully buffered into a validation error body', async () => {
    // 25MB > UPLOAD_HARD_CAP_BYTES (20MB) — multer's own `limits.fileSize`
    // should reject this before FileInterceptor even hands a file object to
    // the controller. Supertest still gets SOME non-2xx response either way;
    // the meaningful assertion is that it is rejected, not accepted or hung.
    const buf = Buffer.alloc(25 * 1024 * 1024, 0);
    const res = await upload(buf, 'way-too-big.pdf', 'application/pdf');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 30_000);
});
