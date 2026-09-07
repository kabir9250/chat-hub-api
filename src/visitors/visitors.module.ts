import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  PageVisit,
  PageVisitSchema,
  Site,
  SiteSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { LeadsModule } from '../leads/leads.module';
import { RealtimeEventsModule } from '../realtime/realtime-events.module';
import { VisitorPresenceModule } from '../realtime/visitor-presence.module';
import { VisitorsController } from './visitors.controller';
import { CombinedVisitorsController } from './combined-visitors.controller';
import { VisitorsService } from './visitors.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Visitor.name, schema: VisitorSchema },
      { name: Site.name, schema: SiteSchema },
      // Read-only lookup for visitor.profileUpdated's broadcast target
      // (this session, task requirement 4) — same pattern
      // VisitorSessionModule uses.
      { name: Conversation.name, schema: ConversationSchema },
      // FR-RPT-07's live Visitors list — current page per online Visitor.
      { name: PageVisit.name, schema: PageVisitSchema },
    ]),
    AuditLogModule,
    RbacModule,
    // For LeadsService.syncLeadForVisitor(), called after an edit that sets
    // name/email (FR-VIS-08).
    LeadsModule,
    // update()/ban()/unban() emit visitor.profileUpdated.
    RealtimeEventsModule,
    // FR-RPT-07 — findLive() reads which Visitors are currently online.
    VisitorPresenceModule,
  ],
  controllers: [VisitorsController, CombinedVisitorsController],
  providers: [VisitorsService],
  // Perf fix — RealtimeModule now imports this module so RealtimeGateway can
  // attach a full LiveVisitor row directly to its `visitor.online` broadcast
  // (see VisitorsService.getLiveVisitor's doc comment). No cycle: nothing
  // this module imports depends on RealtimeModule.
  exports: [VisitorsService],
})
export class VisitorsModule {}
