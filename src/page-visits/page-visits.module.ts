import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  PageVisit,
  PageVisitSchema,
} from '../database/schemas';
import { AnalyticsModule } from '../analytics/analytics.module';
import { RealtimeEventsModule } from '../realtime/realtime-events.module';
import { PageVisitsService } from './page-visits.service';

/**
 * PageVisitsModule — SRS §4.4a. A leaf module (same shape as
 * PresenceModule/RealtimeEventsModule, Session 8) — imported by both
 * `VisitorSessionModule` (the full-page-load entry point) and
 * `RealtimeModule` (the SPA-route-change WS entry point), depends on
 * neither, so no circular module dependency.
 *
 * Also imports `AnalyticsModule` (this session) for `AnalyticsEventsService`
 * — `recordPageChange()` is the one place a "page view" genuinely happens,
 * so it's also the one place that emits the `pageView` AnalyticsEvent
 * FR-RPT-01's dashboard chart aggregates over. `AnalyticsModule` doesn't
 * import this module back (only schemas), so no cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PageVisit.name, schema: PageVisitSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    RealtimeEventsModule,
    AnalyticsModule,
  ],
  providers: [PageVisitsService],
  exports: [PageVisitsService],
})
export class PageVisitsModule {}
