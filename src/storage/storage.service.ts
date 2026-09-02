import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';

import { extensionForMimeType } from './attachment-validation';

export interface SaveFileInput {
  siteId: string;
  conversationId: string;
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
}

export interface SignParams {
  key: string;
  fileName: string;
  fileType: string;
}

export interface VerifyParams extends SignParams {
  exp: number;
  sig: string;
}

/**
 * Object-storage abstraction — Phase 2 §3.9/§5.1 (FR-P2-ATT-06). Product
 * decision this session (see PROGRESS.md "Object storage" entry): rather
 * than wiring up a real S3-compatible provider (AWS S3 / Cloudflare R2 /
 * Backblaze B2 — no account credentials available yet), this stores files
 * on the API server's own local disk, under a dedicated `uploads/` folder,
 * organized the same way a bucket's key namespace would be
 * (`<siteId>/<conversationId>/<uuid><ext>`).
 *
 * Every caller (AttachmentsService/Controller, ConversationsService) talks
 * ONLY to this class's `save`/`getSignedUrl`/`resolveAbsolutePath` methods —
 * never to `fs`/a path directly. That's deliberate: swapping this for a
 * real S3-compatible client (`@aws-sdk/client-s3` + its request-presigner,
 * both npm-installable and API-compatible with S3/R2/B2 alike) later is a
 * new class implementing the same three methods + one DI registration
 * change in storage.module.ts — no caller changes.
 *
 * "Signed URL" here is this app's own short-lived HMAC-signed link
 * (`GET /attachments/file?key=&name=&type=&exp=&sig=`), not a cloud
 * provider's presigned-URL mechanism — but it gives the exact same
 * guarantee FR-P2-ATT-08 asks for: a non-guessable object key, PLUS a
 * time-limited signature (`ATTACHMENT_SIGNED_URL_TTL_SECONDS`, default 5
 * minutes) that's verified on every fetch — never a permanent public link.
 */
@Injectable()
export class StorageService {
  private readonly uploadsDir: string;
  private readonly publicBaseUrl: string;
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.uploadsDir = path.resolve(
      this.configService.get<string>('app.storage.uploadsDir')!,
    );
    this.publicBaseUrl = this.configService
      .get<string>('app.storage.publicBaseUrl')!
      .replace(/\/+$/, '');
    this.secret = this.configService.get<string>('app.storage.signingSecret')!;
    this.ttlSeconds = this.configService.get<number>(
      'app.storage.signedUrlTtlSeconds',
    )!;
  }

  /** Writes the buffer under a fresh, non-guessable key (FR-P2-ATT-08) — never the original filename (kept only on the Message document, for display). */
  async saveFile(input: SaveFileInput): Promise<{ key: string }> {
    const ext = extensionForMimeType(input.mimeType);
    const key = `${input.siteId}/${input.conversationId}/${randomUUID()}${ext}`;
    const absolutePath = this.resolveAbsolutePath(key);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);
    return { key };
  }

  fileExists(key: string): boolean {
    try {
      return existsSync(this.resolveAbsolutePath(key));
    } catch {
      return false;
    }
  }

  /** Guards against a key escaping the uploads root (defense in depth — keys are always server-generated, but this makes traversal impossible even so). */
  resolveAbsolutePath(key: string): string {
    const absolute = path.resolve(this.uploadsDir, key);
    if (
      absolute !== this.uploadsDir &&
      !absolute.startsWith(this.uploadsDir + path.sep)
    ) {
      throw new ForbiddenException('Invalid attachment key.');
    }
    return absolute;
  }

  /**
   * FR-P2-ATT-08 — called fresh on every message read/broadcast
   * (ConversationsService), never cached/persisted. `fileName`/`fileType`
   * are signed too (not just `key`) so the file-serving route can set the
   * correct Content-Type/Content-Disposition straight from the URL, with no
   * separate DB lookup and no way to tamper with either without
   * invalidating the signature.
   */
  getSignedUrl({ key, fileName, fileType }: SignParams): string {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const sig = this.sign(key, fileName, fileType, exp);
    const qs = new URLSearchParams({
      key,
      name: fileName,
      type: fileType,
      exp: String(exp),
      sig,
    });
    return `${this.publicBaseUrl}/attachments/file?${qs.toString()}`;
  }

  /** The file-serving route's ONLY access check — see AttachmentsController.serveFile's doc comment for why no separate permission check happens here. */
  verifySignedAccess({
    key,
    fileName,
    fileType,
    exp,
    sig,
  }: VerifyParams): boolean {
    if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) {
      return false;
    }
    const expected = this.sign(key, fileName, fileType, exp);
    const expectedBuf = Buffer.from(expected, 'hex');
    let gotBuf: Buffer;
    try {
      gotBuf = Buffer.from(sig ?? '', 'hex');
    } catch {
      return false;
    }
    if (expectedBuf.length !== gotBuf.length) return false;
    return timingSafeEqual(expectedBuf, gotBuf);
  }

  private sign(
    key: string,
    fileName: string,
    fileType: string,
    exp: number,
  ): string {
    return createHmac('sha256', this.secret)
      .update(`${key}:${fileName}:${fileType}:${exp}`)
      .digest('hex');
  }
}
