/**
 * T-04 Attachments — TC-04.4 (attachment URL access control, FR-P2-ATT-08)
 * and TC-04.5 (non-guessable storage keys).
 *
 * Builds on T-01's own attachment-access.e2e-spec.ts (which already covers
 * signature tampering/omission and cross-conversation key theft at
 * send-message time) — this file adds the specific T-04 task scenarios:
 * a different-Site Agent (agent-b1) trying to reach the attachment, and a
 * fully unauthenticated request against both a real and a guessed key.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, userIdFor } from '../helpers/fixtures';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('T-04 TC-04.4/04.5 — Attachment URL access control & non-guessable keys', () => {
  let app: INestApplication;
  let siteAId: string;
  let conversationId: string;
  let attachmentKey: string;
  let attachmentUrl: string;

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
      .send({ initialMessage: 'T-04 URL access control test' });
    conversationId = convRes.body._id ?? convRes.body.id;

    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conversationId}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({ agentId: userIdFor('agent-a1@test.local') });

    const uploadRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'access-control.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentKey = uploadRes.body.key;

    const sendRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/messages`)
      .set(...authHeader('agent-a1@test.local'))
      .send({
        attachments: [
          {
            key: uploadRes.body.key,
            fileName: uploadRes.body.fileName,
            fileType: uploadRes.body.fileType,
            fileSizeBytes: uploadRes.body.fileSizeBytes,
          },
        ],
      });
    expect(sendRes.status).toBe(201);

    // The raw POST /messages response only carries the message document as
    // persisted (attachments[].key, no signed url — signing only happens on
    // READ paths, see ConversationsService.toMessageWire). Re-fetch the
    // transcript, same as a real client would on load, to get a freshly
    // signed url.
    const transcript = await request(app.getHttpServer())
      .get(`/sites/${siteAId}/conversations/${conversationId}`)
      .set(...authHeader('agent-a1@test.local'));
    expect(transcript.status).toBe(200);
    // The wire format (toAttachmentWire) deliberately never exposes the raw
    // `key` to the client at all — only fileName/fileType/fileSizeBytes/
    // url/thumbnailUrl — so match by the filename used for this upload.
    const withAttachment = transcript.body.messages.find((m: any) =>
      m.attachments?.some((a: any) => a.fileName === 'access-control.png'),
    );
    expect(withAttachment).toBeDefined();
    attachmentUrl = withAttachment.attachments.find(
      (a: any) => a.fileName === 'access-control.png',
    ).url;
    expect(attachmentUrl).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  // --- TC-04.5: non-guessable keys ---------------------------------------

  it('TC-04.5.a — the storage key is UUID-based, not a predictable sequential id', () => {
    // "<siteId>/<conversationId>/<uuidv4>.<ext>" — the leaf segment must be
    // a real v4 UUID, not "1", "2", "attachment-3", etc.
    const leaf = attachmentKey.split('/').pop()!;
    const uuidPart = leaf.replace(/\.[a-z0-9]+$/i, '');
    expect(uuidPart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('TC-04.5.b — uploading the same file twice yields two different, unrelated keys (not incrementing/predictable)', async () => {
    const res1 = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'dup.png', contentType: 'image/png' });
    const res2 = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'dup.png', contentType: 'image/png' });
    expect(res1.body.key).not.toBe(res2.body.key);
    // Not sequential/near-sequential in any obvious lexical sense — the two
    // UUID leaves should differ in more than a trailing counter digit.
    const leaf1 = res1.body.key.split('/').pop();
    const leaf2 = res2.body.key.split('/').pop();
    expect(leaf1.slice(0, 8)).not.toBe(leaf2.slice(0, 8));
  });

  // --- TC-04.4: access control ---------------------------------------------

  it('TC-04.4.a — agent-b1 (different Site, no access to this Conversation) cannot reach the transcript to ever obtain this attachment URL', async () => {
    const res = await request(app.getHttpServer())
      .get(`/sites/${siteAId}/conversations/${conversationId}`)
      .set(...authHeader('agent-b1@test.local'));
    expect(res.status).toBe(403);
  });

  it('TC-04.4.b — a fully unauthenticated request (no Authorization header, no valid signature) guessing the real key is denied (400/403), not served', async () => {
    // "Unauthenticated" here means: no Bearer token AND no legitimately
    // minted signature — i.e. exactly what an outsider who merely guessed
    // or intercepted a bare key (without ever seeing a full signed link)
    // would be able to construct.
    const res = await request(app.getHttpServer()).get(
      `/attachments/file?key=${encodeURIComponent(attachmentKey)}&name=access-control.png&type=image/png`,
    );
    // No exp/sig at all -> malformed link.
    expect(res.status).toBe(400);
  });

  it('TC-04.4.c — a fully unauthenticated request with a GUESSED key (not this attachment\'s real key) and a forged signature is denied (403)', async () => {
    const guessedKey = `${siteAId}/${conversationId}/00000000-0000-4000-8000-000000000000.png`;
    const exp = Math.floor(Date.now() / 1000) + 300;
    const res = await request(app.getHttpServer()).get(
      `/attachments/file?key=${encodeURIComponent(guessedKey)}&name=access-control.png&type=image/png&exp=${exp}&sig=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
    );
    expect(res.status).toBe(403);
  });

  it('TC-04.4.d — FINDING (design note, not a bug): a legitimately-obtained signed URL is authorized by its signature alone, portable to any bearer (no Authorization header required) until it expires — mirrors a real S3/R2 presigned GET URL', async () => {
    // This is the flip side of 4.4.a: agent-b1 has no legitimate way to
    // OBTAIN this URL (blocked above), but IF a valid signed URL leaks
    // (copied from devtools, shared out of band, etc.), the route itself
    // does not re-check the requester's identity/site — only the HMAC
    // signature and expiry (see StorageService.verifySignedAccess /
    // AttachmentsController.serveFile's own doc comments — deliberate).
    // Documented here so the 5-minute exposure window
    // (ATTACHMENT_SIGNED_URL_TTL_SECONDS) is a known, reviewed trade-off,
    // not a silent gap. See T-04-attachments.md Findings for the writeup.
    const relativeUrl =
      new URL(attachmentUrl).pathname + new URL(attachmentUrl).search;
    const res = await request(app.getHttpServer()).get(relativeUrl); // zero headers set
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});
