import { Injectable } from '@nestjs/common';

import {
  isImageMimeType,
  validateUploadedFile,
} from '../storage/attachment-validation';
import type { AttachmentRefInput } from '../storage/attachment.types';
import { StorageService } from '../storage/storage.service';

export interface UploadResult extends AttachmentRefInput {
  isImage: boolean;
  /** Short-lived — lets the composer show an immediate preview before the message is actually sent. A fresh one is minted again once the message is read back (ConversationsService), so this one being allowed to expire is harmless. */
  previewUrl: string;
}

@Injectable()
export class AttachmentsService {
  constructor(private readonly storage: StorageService) {}

  /** Validate → save → return metadata. Never creates a Message — that's the caller's next, separate step through the existing send-message flow (FR-P2-ATT-06/07, task guardrail: no parallel send path). */
  async storeUpload(input: {
    siteId: string;
    conversationId: string;
    file?: Express.Multer.File;
  }): Promise<UploadResult> {
    validateUploadedFile(input.file);
    const file = input.file!;

    const { key } = await this.storage.saveFile({
      siteId: input.siteId,
      conversationId: input.conversationId,
      buffer: file.buffer,
      originalFileName: file.originalname,
      mimeType: file.mimetype,
    });

    return {
      key,
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSizeBytes: file.size,
      isImage: isImageMimeType(file.mimetype),
      previewUrl: this.storage.getSignedUrl({
        key,
        fileName: file.originalname,
        fileType: file.mimetype,
      }),
    };
  }
}
