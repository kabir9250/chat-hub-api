/**
 * T-04 Attachments — TC-04.3 (client-side bypass) and TC-04.6
 * (attachment-only message, FR-P2-ATT-07).
 *
 * TC-04.3 drives the upload endpoint with raw Supertest HTTP calls only —
 * no browser, no `chat-hub-web` frontend code, no `<input accept=...>`
 * filtering involved anywhere in this file. That IS "bypassing the
 * frontend": proof the backend's `validateUploadedFile` (FR-P2-ATT-05) is
 * the real, load-bearing check, not the Widget/Agent Console's `accept=`
 * attribute (which is a UX nicety only, and doesn't run here at all).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/bootstrap';
import { authHeader, siteId, userIdFor } from '../helpers/fixtures';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('T-04 TC-04.3 — Client-side bypass (raw API call, no frontend involved)', () => {
  let app: INestApplication;
  let siteAId: string;
  let conversationId: string;
  let visitorToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    siteAId = siteId('Site A');

    const initRes = await request(app.getHttpServer())
      .post('/visitor-session/init')
      .send({ siteId: siteAId, pageUrl: 'https://sitea.test.local/' });
    visitorToken = initRes.body.token;

    const convRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .send({ initialMessage: 'T-04 bypass/content test' });
    conversationId = convRes.body._id ?? convRes.body.id;

    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conversationId}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({ agentId: userIdFor('agent-a1@test.local') });
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-04.3.a — a disallowed type posted directly to the Agent upload endpoint (no Widget/Agent Console involved) is rejected server-side', async () => {
    const res = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', Buffer.from('MZ fake exe'), {
        filename: 'not-a-real-frontend-would-block-this.exe',
        contentType: 'application/x-msdownload',
      });
    expect(res.status).toBe(400);
  });

  it('TC-04.3.b — a disallowed type posted directly to the Visitor upload endpoint (no Widget involved) is rejected server-side', async () => {
    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/attachments/mine`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /\n'), {
        filename: 'payload.sh',
        contentType: 'application/x-sh',
      });
    expect(res.status).toBe(400);
  });

  it('TC-04.3.c — a request with no file part at all is rejected with a clear error, not a 500 or silent success', async () => {
    const res = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no file was uploaded/i);
  });

  it('TC-04.3.d — attempting to send a CreateMessageDto with attachments referencing a key that was never actually uploaded is rejected (can\'t bypass upload validation by fabricating attachment metadata directly on the send-message call)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/messages`)
      .set(...authHeader('agent-a1@test.local'))
      .send({
        attachments: [
          {
            key: `${siteAId}/${conversationId}/totally-made-up-nonexistent-file.exe`,
            fileName: 'virus.exe',
            fileType: 'application/x-msdownload',
            fileSizeBytes: 999,
          },
        ],
      });
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe('T-04 TC-04.6 — Attachment-only message (FR-P2-ATT-07)', () => {
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
      .send({ initialMessage: 'T-04 attachment-only-message test' });
    conversationId = convRes.body._id ?? convRes.body.id;

    await request(app.getHttpServer())
      .patch(`/sites/${siteAId}/conversations/${conversationId}/assign`)
      .set(...authHeader('owner@test.local'))
      .send({ agentId: userIdFor('agent-a1@test.local') });
  });

  afterAll(async () => {
    await app.close();
  });

  it('TC-04.6.a — an Agent message with an attachment and NO body text is accepted (body: null, one attachment)', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/attachments`)
      .set(...authHeader('agent-a1@test.local'))
      .attach('file', TINY_PNG, { filename: 'only-attachment.png', contentType: 'image/png' });
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
        // body intentionally omitted
      });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.body === null || sendRes.body.body === undefined || sendRes.body.body === '').toBe(true);
    expect(sendRes.body.attachments).toHaveLength(1);
  });

  it('TC-04.6.b — a truly empty message (no body, no attachments) is rejected (FR-P2-ATT-07\'s complement — at least one of the two is required)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/sites/${siteAId}/conversations/${conversationId}/messages`)
      .set(...authHeader('agent-a1@test.local'))
      .send({});
    expect(res.status).toBe(400);
  });
});
