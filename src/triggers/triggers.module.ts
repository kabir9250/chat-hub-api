import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  PageVisit,
  PageVisitSchema,
  Site,
  SiteSchema,
  Trigger,
  TriggerFire,
  TriggerFireSchema,
  TriggerSchema,
  User,
  UserSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { PresenceModule } from '../realtime/presence.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';
import { TriggerEvaluationService } from './trigger-evaluation.service';
import { TriggerActionExecutorService } from './trigger-action-executor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Trigger.name, schema: TriggerSchema },
      { name: TriggerFire.name, schema: TriggerFireSchema },
      { name: Site.name, schema: SiteSchema },
      { name: Visitor.name, schema: VisitorSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: PageVisit.name, schema: PageVisitSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditLogModule,
    RbacModule,
    PresenceModule,
    // Session Feature-2c-complex-actions — TriggerActionExecutorService's
    // "Block visitor" action calls VisitorsService.banFromTrigger directly
    // (Feature 2a's exact BannedEntry mechanism, no parallel ban path). No
    // cycle: VisitorsModule doesn't import TriggersModule.
    VisitorsModule,
  ],
  controllers: [TriggersController],
  providers: [
    TriggersService,
    TriggerEvaluationService,
    TriggerActionExecutorService,
  ],
  // Session Feature-2c-complex-actions gave TriggerActionExecutorService
  // its first real caller — RealtimeGateway.handleVisitorTriggerActivated
  // (RealtimeModule imports this module for it). TriggerEvaluationService
  // (findMatches/recordFire) still has no caller — this session's engine
  // executes the ALREADY-validated Trigger the WS handler loaded, it
  // doesn't re-run condition evaluation server-side; wiring
  // findMatches/recordFire into a real event path (widget-bootstrap? a
  // separate server-authoritative evaluation pass?) remains a future
  // session's scope, same posture Feature-2b-engine left it in.
  exports: [TriggerEvaluationService, TriggerActionExecutorService],
})
export class TriggersModule {}
