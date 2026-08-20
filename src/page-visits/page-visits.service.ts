import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  PageVisit,
  PageVisitDocument,
} from '../database/schemas';
import { AnalyticsEventsService } from '../analytics/analytics-events.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { derivePageCategory } from './page-category.util';

export interface RecordPageChangeInput {
  siteId: Types.ObjectId | string;
  visitorId: Types.ObjectId | string;
  /**
   * The Visitor's currently-active Conversation, if any/known to the
   * caller — used ONLY to pick a broadcast target (task requirement 3:
   * "any Agent currently viewing that Visitor's Conversation"). Verified
   * against the actual Conversation record below before being trusted for
   * that; an unrelated/spoofed id just means no broadcast happens; it can
   * never widen what PageVisit is written.
   */
  conversationId?: string | null;
  pageUrl: string;
}

export interface RecordPageChangeResult {
  previous: PageVisitDocument | null;
  current: PageVisitDocument;
}

/**
 * PageVisitsService — SRS §4.4a. The one writer for PageVisit documents,
 * called from two entry points (task requirement 2, "add an endpoint (or
 * WebSocket message)"):
 *   - `VisitorSessionService.init()` — every widget boot/resume already
 *     captures the current `pageUrl` (FR-VIS-01); this is also, for free,
 *     "a page navigation" for a traditional multi-page site (a fresh full
 *     page load = a fresh iframe = a fresh `init` call with the new URL) —
 *     so the very first PageVisit, and every subsequent full-page-load
 *     navigation, are tracked with NO extra widget-side wiring.
 *   - `RealtimeGateway`'s new `visitor:page_changed` WS handler — for a
 *     single-page-app style site, where the widget iframe persists across
 *     client-side route changes and must explicitly notify the backend
 *     (task requirement 8, widget-side).
 *
 * Both call the SAME method below, so "close out the previous PageVisit,
 * open a new one" is exactly one code path no matter which transport
 * triggered it — the same reuse discipline ConversationsService's
 * addAgentMessage/addVisitorMessage already established (Session 7/8).
 */
@Injectable()
export class PageVisitsService {
  private readonly logger = new Logger(PageVisitsService.name);

  constructor(
    @InjectModel(PageVisit.name)
    private readonly pageVisitModel: Model<PageVisitDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly analyticsEvents: AnalyticsEventsService,
  ) {}

  async recordPageChange(
    input: RecordPageChangeInput,
  ): Promise<RecordPageChangeResult> {
    const siteId = new Types.ObjectId(input.siteId);
    const visitorId = new Types.ObjectId(input.visitorId);
    const now = new Date();

    // At most one PageVisit should ever be open (exitedAt: null) for a
    // given Visitor at a time — close it out before opening the new one.
    const previous = await this.pageVisitModel
      .findOne({ visitorId, exitedAt: null })
      .sort({ enteredAt: -1 })
      .exec();
    if (previous) {
      previous.exitedAt = now;
      previous.durationSeconds = Math.max(
        0,
        Math.round((now.getTime() - previous.enteredAt.getTime()) / 1000),
      );
      await previous.save();
    }

    const conversationId = await this.resolveOwnConversationId(
      input.conversationId,
      siteId,
      visitorId,
    );

    const current = await this.pageVisitModel.create({
      siteId,
      visitorId,
      conversationId,
      pageUrl: input.pageUrl,
      pageCategory: derivePageCategory(input.pageUrl),
      enteredAt: now,
      exitedAt: null,
      durationSeconds: null,
    });

    // FR-RPT-01 (this session) — every PageVisit opened is, by definition, a
    // page view. This is the one writer for PageVisit (see this class's own
    // doc comment), so it's also the one place a `pageView` AnalyticsEvent
    // needs emitting from, covering both entry points (full-page-load
    // `init()` and SPA-route-change `visitor:page_changed`) for free.
    await this.analyticsEvents.record({
      siteId,
      type: 'pageView',
      visitorId,
      pageUrl: current.pageUrl,
      occurredAt: now,
    });

    // Task requirement 3: broadcast only when there's an actual
    // Conversation an Agent could be viewing — no conversation, nobody
    // could have that room open, nothing to send.
    if (conversationId) {
      this.realtimeEvents.emit({
        kind: 'visitor.pageChanged',
        siteId: siteId.toString(),
        conversationId: conversationId.toString(),
        visitorId: visitorId.toString(),
        newPage: current.pageUrl,
        previousPage: previous?.pageUrl ?? null,
        timestamp: now.toISOString(),
      });
    }

    // FR-RPT-07 (this session) — the live Visitors list needs a Visitor's
    // current page even with NO Conversation yet, so this one is
    // unconditional (site-room broadcast, not conversation-room), unlike
    // visitor.pageChanged above. Deliberately still just ONE PageVisit
    // write producing (up to) two broadcasts, not two separate tracking
    // paths — see this method's own doc comment on why there's exactly one
    // writer for PageVisit.
    this.realtimeEvents.emit({
      kind: 'visitor.siteActivity',
      siteId: siteId.toString(),
      visitorId: visitorId.toString(),
      conversationId: conversationId ? conversationId.toString() : null,
      pageUrl: current.pageUrl,
      pageCategory: current.pageCategory,
      timestamp: now.toISOString(),
    });

    return { previous, current };
  }

  /**
   * Never trust a bare `conversationId` from a Visitor-originated call at
   * face value (same posture as `ConversationsService.addVisitorMessage`'s
   * ownership check) — it's only ever used to pick a broadcast target, but
   * an unverified one could still leak a page-navigation signal into a
   * Conversation room the Visitor has nothing to do with. A mismatch is
   * silently treated as "no conversation known" rather than an error —
   * page tracking must never fail a request over a stale/bad id (task
   * guardrail: keep this lightweight).
   */
  private async resolveOwnConversationId(
    conversationId: string | null | undefined,
    siteId: Types.ObjectId,
    visitorId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    if (!conversationId) return null;
    try {
      const conversation = await this.conversationModel
        .findOne({ _id: conversationId, siteId, visitorId })
        .select('_id')
        .lean()
        .exec();
      return conversation ? conversation._id : null;
    } catch (err) {
      this.logger.debug(
        `Ignoring unresolvable conversationId on a page change: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
