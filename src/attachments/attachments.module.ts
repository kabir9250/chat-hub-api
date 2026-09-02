import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { StorageModule } from '../storage/storage.module';
import { WidgetConfigModule } from '../widget-config/widget-config.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  imports: [
    AuthModule,
    RbacModule,
    ConversationsModule,
    StorageModule,
    // Phase 2 §3.9 — the Site-level attachmentsEnabled on/off switch,
    // checked on both upload routes (Agent + Visitor alike, per the
    // "both surfaces" product decision) — see
    // WidgetConfigService.isAttachmentsEnabledForSite.
    WidgetConfigModule,
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
