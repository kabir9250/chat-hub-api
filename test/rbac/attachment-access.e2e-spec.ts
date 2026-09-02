/**
 * T-01 RBAC — TC-01.6: Attachment access control (P2-9, FR-P2-ATT-08).
 *
 * Real flow: a Visitor starts a Conversation on Site A, agent-a1 (who has
 * access to it) uploads and sends an attachment, we read back the
 * freshly-signed `url` from the transcript. Then:
 *   (a) agent-b1 (no access to Site A / this Conversation at all) cannot
 *       reach the transcript to ever obtain that URL in the first place
 *       (404 on the conversation itself — the real access boundary).
 *   (b) the signed URL, once obtained legitimately, is protected by its
 *       HMAC signature: tampering the signature or omitting it is rejected
 *       — proving the "URL is guessable/public but signature is not" model
 *       actually holds, i.e. simply knowing/guessing a `key` isn't enough.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, userIdFor } from '../helpers/fixtures';

// A minimal valid 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('T-01 TC-01.6 — Attachment access control', () => {
  let app: INestApplication;
  let visitorToken: string;
  let conversationId: string;
  let attachmentUrl: string;

  beforeAll(async () => {
    app = await createTestApp();

    const siteAId = siteId('Site A');

    const initRes = await request(app.getHttpServer())
      .post('/visitor-session/init')
      .send({ siteId: siteAId, pageUrl: 'https://sitea.test.local/' });
    expect([200, 201]).toContain(initRes.status);
    visitorToken = initRes.body.token;

    const convRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .send({ initialMessage: 'T-01 attachment access test' });
    expect(convRes.status).toBe(201);
    conversationId = convRes.body._id ?? convRes.body.id;

    // agent-a1 is Site A-scoped (conversations.view_own) — assign via
    // owner first so agent-a1 can act on it (view_own requires assignment).
    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conversationId}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({ agentId: userIdFor('agent-a1@test.local') });

    const uploadRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'tiny.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);

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

    const transcript = await request(app.getHttpServer())
      .get(`/sites/${siteAId}/conversations/${conversationId}`)
      .set(...authHeader('agent-a1@test.local'));
    expect(transcript.status).toBe(200);
    const messages = transcript.body.messages;
    const withAttachment = messages.find((m: any) => m.attachments?.length > 0);
    expect(withAttachment).toBeDefined();
    attachmentUrl = withAttachment.attachments[0].url;
    expect(attachmentUrl).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-01.6.a — agent-b1 (no access to this Site A Conversation) cannot reach the transcript to obtain the URL', async () => {
    const siteAId = siteId('Site A');
    // agent-b1 has no assignment on Site A at all -> 403 at the guard,
    // never even reaching the point of learning this Conversation exists.
    const res = await request(app.getHttpServer())
      .get(`/sites/${siteAId}/conversations/${conversationId}`)
      .set(...authHeader('agent-b1@test.local'));
    expect(res.status).toBe(403);
    // Guardrail: no transcript/message/attachment data in the denied body
    // (the guard's own message legitimately echoes the :siteId the caller
    // put in the URL — that's not a leak of the Conversation's data).
    expect(res.body.messages).toBeUndefined();
    expect(res.body.conversation).toBeUndefined();
  });

  it('TC-01.6.b — a legitimately-obtained signed attachment URL actually serves the file', async () => {
    const relativeUrl = new URL(attachmentUrl).pathname + new URL(attachmentUrl).search;
    const res = await request(app.getHttpServer()).get(relativeUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('TC-01.6.c — tampering the signature is rejected (403), not served', async () => {
    const url = new URL(attachmentUrl);
    const sig = url.searchParams.get('sig')!;
    // Flip the last character of the signature.
    const tampered = sig.slice(0, -1) + (sig.at(-1) === 'a' ? 'b' : 'a');
    url.searchParams.set('sig', tampered);
    const res = await request(app.getHttpServer()).get(url.pathname + url.search);
    expect(res.status).toBe(403);
  });

  it('TC-01.6.d — omitting the signature entirely is rejected (400), not served', async () => {
    const url = new URL(attachmentUrl);
    url.searchParams.delete('sig');
    const res = await request(app.getHttpServer()).get(url.pathname + url.search);
    expect(res.status).toBe(400);
  });

  it('TC-01.6.e — reusing an existing key with a mismatched conversationId prefix is rejected when sending a NEW message (cross-conversation attachment theft)', async () => {
    const siteAId = siteId('Site A');
    // Start a second, unrelated Conversation the same agent CAN see, and
    // try to reference the first Conversation's uploaded attachment key.
    const initRes = await request(app.getHttpServer())
      .post('/visitor-session/init')
      .send({ siteId: siteAId, pageUrl: 'https://sitea.test.local/' });
    const token2 = initRes.body.token;
    const conv2 = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations`)
      .set('Authorization', `Bearer ${token2}`)
      .send({ initialMessage: 'second conversation' });
    const conv2Id = conv2.body._id ?? conv2.body.id;
    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conv2Id}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({
        agentId: userIdFor('agent-a1@test.local'),
      });

    const uploadRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'tiny2.png', contentType: 'image/png' });

    const res = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conv2Id}/messages`)
      .set(...authHeader('agent-a1@test.local'))
      .send({
        attachments: [
          {
            key: uploadRes.body.key, // belongs to `conversationId`, not `conv2Id`
            fileName: uploadRes.body.fileName,
            fileType: uploadRes.body.fileType,
            fileSizeBytes: uploadRes.body.fileSizeBytes,
          },
        ],
      });
    expect([400, 403]).toContain(res.status);
  });
});
