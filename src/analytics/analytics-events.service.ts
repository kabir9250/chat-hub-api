import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  AnalyticsEvent,
  AnalyticsEventDocument,
  AnalyticsEventType,
} from '../database/schemas';

export interface RecordAnalyticsEventInput {
  siteId: Types.ObjectId | string;
  type: AnalyticsEventType;
  visitorId?: Types.ObjectId | string | null;
  pageUrl?: string;
  occurredAt?: Date;
}

/**
 * AnalyticsEventsService — SRS §4.10, the writer half of the AnalyticsEvent
 * collection FR-RPT-01's dashboard chart aggregates over.
 *
 * Session 1 created the schema/index but nothing ever wrote to it — every
 * session since (Widget, Conversations, PageVisits) tracked its own
 * domain data (PageVisit, Conversation, Message) without ever emitting the
 * raw pageView/totalVisit/uniqueVisitor/chatStarted events the dashboard
 * chart is actually specified against. This service is the one writer,
 * called from the three places that already know when one of these four
 * things happens (see PROGRESS.md "Session 13" for exactly which call
 * sites): `PageVisitsService.recordPageChange` (pageView — every page
 * change, full-page-load or SPA route change alike), `VisitorSessionService
 * .init` (totalVisit on every call, uniqueVisitor only when a brand-new
 * Visitor document is created), and `ConversationsService.create`/
 * `.startProactiveConversation` (chatStarted).
 *
 * Deliberately fire-and-forget-safe, same posture as AuditLogService: a
 * dashboard-metrics write must never break the request that triggered it.
 */
@Injectable()
export class AnalyticsEventsService {
  private readonly logger = new Logger(AnalyticsEventsService.name);

  constructor(
    @InjectModel(AnalyticsEvent.name)
    private readonly analyticsEventModel: Model<AnalyticsEventDocument>,
  ) {}

  async record(input: RecordAnalyticsEventInput): Promise<void> {
    try {
      await this.analyticsEventModel.create({
        siteId: input.siteId,
        type: input.type,
        visitorId: input.visitorId ?? null,
        pageUrl: input.pageUrl,
        occurredAt: input.occurredAt ?? new Date(),
      });
    } catch (err) {
      this.logger.error(
        `Failed to record AnalyticsEvent "${input.type}": ${(err as Error).message}`,
      );
    }
  }
}
