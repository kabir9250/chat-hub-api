import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  AnalyticsEvent,
  AnalyticsEventSchema,
  Conversation,
  ConversationSchema,
  Lead,
  LeadSchema,
  Message,
  MessageSchema,
  PageVisit,
  PageVisitSchema,
  Site,
  SiteSchema,
  User,
  UserSchema,
} from '../database/schemas';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AnalyticsController } from './analytics.controller';
import { OrganizationAnalyticsController } from './organization-analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsEventsService } from './analytics-events.service';

/**
 * AnalyticsModule — FR-RPT-01–08 (SRS §5.11).
 *
 * Exports `AnalyticsEventsService` — the AnalyticsEvent *writer* — so
 * `PageVisitsModule`, `VisitorSessionModule`, and `ConversationsModule` can
 * each inject it to emit the pageView/totalVisit/uniqueVisitor/chatStarted
 * events this module's own dashboard-chart reads aggregate over. None of
 * those three modules is imported here (only their schemas would be), so
 * there is no circular module dependency.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PageVisit.name, schema: PageVisitSchema },
      { name: Site.name, schema: SiteSchema },
      { name: AnalyticsEvent.name, schema: AnalyticsEventSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuthModule,
    RbacModule,
  ],
  controllers: [AnalyticsController, OrganizationAnalyticsController],
  providers: [AnalyticsService, AnalyticsEventsService],
  exports: [AnalyticsEventsService],
})
export class AnalyticsModule {}
