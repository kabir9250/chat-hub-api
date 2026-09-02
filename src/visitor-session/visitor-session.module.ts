import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  Site,
  SiteSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AttributionModule } from '../attribution/attribution.module';
import { LeadsModule } from '../leads/leads.module';
import { PageVisitsModule } from '../page-visits/page-visits.module';
import { RealtimeEventsModule } from '../realtime/realtime-events.module';
import { VisitorSessionService } from './visitor-session.service';
import { VisitorSessionController } from './visitor-session.controller';
import { IpVisitorIdentityGuardModule } from '../common/rate-limit/ip-visitor-identity-guard.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Site.name, schema: SiteSchema },
      { name: Visitor.name, schema: VisitorSchema },
      // Read-only lookup for visitor.profileUpdated's broadcast target
      // (this session, task requirement 4) — see
      // VisitorSessionService.findLatestConversationId's doc comment.
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    AuditLogModule,
    // Reuses AuthModule's JwtModule registration (same secret/expiry
    // config) rather than re-registering JwtModule with duplicated options.
    AuthModule,
    AttributionModule,
    // FR-WID-05's pre-chat form syncs the Visitor's Lead on submit
    // (same syncLeadForVisitor() Session 6/7 already use elsewhere).
    LeadsModule,
    // This session's additions — both leaf modules, no cycle.
    // PageVisitsModule: init() is also "a page navigation" for a
    // traditional multi-page site (see PageVisitsService's doc comment).
    // RealtimeEventsModule: submitProfile() emits visitor.profileUpdated.
    PageVisitsModule,
    RealtimeEventsModule,
    // This session's addition — AnalyticsEventsService, for totalVisit
    // (every init()) / uniqueVisitor (new Visitor only). AnalyticsModule
    // doesn't import this module back, so no cycle.
    AnalyticsModule,
    // Session Fix-11 — per-IP multi-session abuse guard (§6.3 business
    // decision), shared with RealtimeModule via this same leaf module so
    // both resolve one singleton (see its own doc comment). init()/
    // submitProfile() are the two REST touchpoints where a new distinct
    // Visitor identity is effectively created/confirmed from an IP.
    IpVisitorIdentityGuardModule,
  ],
  controllers: [VisitorSessionController],
  providers: [VisitorSessionService],
})
export class VisitorSessionModule {}
