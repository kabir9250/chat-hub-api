/**
 * Shared shapes between the upload endpoint (AttachmentsController), the
 * message-send flow (ConversationsService), and the WebSocket gateway — see
 * PROGRESS.md's "Object storage" entry for the two-step flow these support:
 * upload first (returns an AttachmentRefInput), then send a message
 * referencing it (existing send-message flow, REST or WS, unchanged
 * otherwise — FR-P2-ATT-06/07).
 */

/** What a client sends back on `POST .../messages` to attach a file it already uploaded. */
export interface AttachmentRefInput {
  key: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
}

/** What a client receives — SRS §2.3's exact field names — on every message read/broadcast. `url`/`thumbnailUrl` are freshly signed per request (FR-P2-ATT-08), never persisted. */
export interface AttachmentWire {
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  thumbnailUrl: string | null;
}
