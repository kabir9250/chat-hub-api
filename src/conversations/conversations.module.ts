import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  Counter,
  CounterSchema,
  Department,
  DepartmentSchema,
  Message,
  MessageSchema,
  PageVisit,
  PageVisitSchema,
  Site,
  SiteSchema,
  User,
  UserSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RbacModule } from '../rbac/rbac.module';
import { LeadsModule } from '../leads/leads.module';
import { PresenceModule } from '../realtime/presence.module';
import { RealtimeEventsModule } from '../realtime/realtime-events.module';
import { VisitorPresenceModule } from '../realtime/visitor-presence.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ReferenceNumberService } from './reference-number.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Site.name, schema: SiteSchema },
      { name: Department.name, schema: DepartmentSchema },
      { name: Visitor.name, schema: VisitorSchema },
      { name: User.name, schema: UserSchema },
      { name: Counter.name, schema: CounterSchema },
      // This session's addition — backs getPageVisits() (task requirement
      // 11's "optional recent page-history trail").
      { name: PageVisit.name, schema: PageVisitSchema },
    ]),
    AuditLogModule,
    // Exports JwtModule (for VisitorAuthGuard's JwtService injection) and
    // is also where JwtAuthGuard/JwtStrategy live for the User-facing routes.
    AuthModule,
    RbacModule,
    // For LeadsService.syncLeadForVisitor() on conversation create (FR-VIS-08).
    LeadsModule,
    // For auto-routing's "is this candidate Agent Online" check (FR-RTE-01).
    PresenceModule,
    // For emitting conversation.created/updated/message.created so
    // RealtimeGateway can broadcast them — see RealtimeEventsService's doc
    // comment for why this indirection avoids a circular module dependency.
    RealtimeEventsModule,
    // For findOne()'s `visitorOnline` field (this session, task requirement
    // 14's "Send anyway" affordance) — a leaf module, no cycle.
    VisitorPresenceModule,
    // This session's addition — AnalyticsEventsService, for the
    // `chatStarted` event emitted on every new Conversation (create() and
    // startProactiveConversation() alike). No cycle (AnalyticsModule
    // doesn't import this module back).
    AnalyticsModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService, ReferenceNumberService],
  // RealtimeModule (Session 8) injects ConversationsService directly so its
  // WebSocket handlers reuse the exact same persistence/scoping logic the
  // REST layer uses — see RealtimeModule's doc comment.
  exports: [ConversationsService],
})
export class ConversationsModule {}
