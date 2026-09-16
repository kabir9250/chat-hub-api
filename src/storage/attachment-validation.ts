import { BadRequestException } from '@nestjs/common';

/**
 * Phase 2 §3.9/§4 "Attachment security" (FR-P2-ATT-05) — the exact,
 * business-reviewable allow-list and size limits, chosen this session (see
 * PROGRESS.md). RGD Assumption 12: no malware/virus scanning is built —
 * this MIME allow-list + size check is the ONLY safeguard on an upload, so
 * `validateUploadedFile` below must run on every single upload, server-side,
 * with no bypass.
 */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const ALLOWED_ATTACHMENT_MIME_TYPES: readonly string[] = [
  ...IMAGE_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
];

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024; // 20MB

// Coarse multer-level cap (fails fast before an oversized file is even
// fully buffered into memory) — the real, per-category limits above are
// enforced precisely by validateUploadedFile once the file's mimetype is
// known. Set a small buffer ABOVE the larger of the two categories, not
// equal to it: multer/busboy treats `limits.fileSize` as EXCLUSIVE (it
// rejects a file whose size is exactly equal to the configured limit, not
// just one that exceeds it), so a hard cap set exactly to DOCUMENT_MAX_BYTES
// would reject a file at exactly the documented max size with a generic 413
// before validateUploadedFile's own — correctly inclusive — size check ever
// runs (see T-11 Test 5 / T-04 Finding #1). This buffer exists purely to
// give every genuinely-in-range file (up to and including exactly
// DOCUMENT_MAX_BYTES) room to reach that friendlier check; it does not
// raise the documented, business-reviewed per-category maximums above,
// which are enforced exactly (inclusive) by validateUploadedFile.
export const UPLOAD_HARD_CAP_BYTES = DOCUMENT_MAX_BYTES + 1024;

// A generous but bounded cap on attachments per single message — not in
// the SRS explicitly, a sensible engineering default to prevent a single
// message from referencing an unbounded attachment list.
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export function isImageMimeType(mimeType: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function extensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? '';
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

// Personal Settings → Profile avatar upload (this session, SRS "12-zendesk-
// feature-parity" §1.1) — reuses this module's own image allow-list
// (`IMAGE_MIME_TYPES`) rather than inventing a second one, but with its own,
// much smaller size cap: matches the reference Zendesk screen's own helper
// text ("Maximum size 100 KB, recommended dimensions 50x50px") — an avatar
// has no business being anywhere near a 10MB chat-attachment image.
export const AVATAR_MAX_BYTES = 100 * 1024; // 100KB, matches the reference screen's own copy

/**
 * Same "validate → the caller saves via StorageService" shape as
 * `validateUploadedFile` below, deliberately kept separate rather than
 * parameterizing that one: an avatar is never a chat attachment (no
 * Conversation, no document-MIME branch, a much smaller cap) and mixing the
 * two call shapes would make `validateUploadedFile`'s signature murkier for
 * its one real caller (`AttachmentsService`).
 */
export function validateAvatarFile(file?: {
  mimetype: string;
  size: number;
  originalname: string;
}): void {
  if (!file) {
    throw new BadRequestException(
      'No file was uploaded (expected multipart field "file").',
    );
  }
  if (file.size <= 0) {
    throw new BadRequestException('Uploaded file is empty.');
  }
  if (!isImageMimeType(file.mimetype)) {
    throw new BadRequestException(
      `"${file.originalname}" is not an allowed image type (${file.mimetype}). ` +
        'Allowed: JPG, PNG, GIF, WEBP.',
    );
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new BadRequestException(
      `"${file.originalname}" is too large (${megabytes(file.size)}MB). ` +
        `Max allowed for an avatar is ${(AVATAR_MAX_BYTES / 1024).toFixed(0)}KB.`,
    );
  }
}

/**
 * FR-P2-ATT-05: server-side MIME allow-list + max file size, run
 * unconditionally on every upload regardless of what the client already
 * checked — rejects with a clear, specific message rather than a generic
 * 400 or silently dropping the file.
 */
export function validateUploadedFile(file?: {
  mimetype: string;
  size: number;
  originalname: string;
}): void {
  if (!file) {
    throw new BadRequestException(
      'No file was uploaded (expected multipart field "file").',
    );
  }
  if (file.size <= 0) {
    throw new BadRequestException('Uploaded file is empty.');
  }
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      `"${file.originalname}" is not an allowed file type (${file.mimetype}). ` +
        'Allowed: images (JPG, PNG, GIF, WEBP) up to 10MB, or documents (PDF, DOC, DOCX, XLS, XLSX) up to 20MB.',
    );
  }
  const isImage = isImageMimeType(file.mimetype);
  const maxBytes = isImage ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `"${file.originalname}" is too large (${megabytes(file.size)}MB). ` +
        `Max allowed for ${isImage ? 'images' : 'documents'} is ${megabytes(maxBytes)}MB.`,
    );
  }
}
