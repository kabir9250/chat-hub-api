import { Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Leaf module (no dependency on ConversationsModule or anything else) so
 * both ConversationsModule (message serialization — needs signed URLs) and
 * AttachmentsModule (upload — needs saveFile) can import it without a
 * circular dependency either way.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
