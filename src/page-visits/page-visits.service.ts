import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  PageVisit,
  PageVisitDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { AnalyticsEventsService } from '../analytics/analytics-events.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { CURRENT_VISIT_GAP_MINUTES } from '../conversations/current-visit.util';
import { derivePageCategory } from './page-category.util';

/** Session P2-5 redesign — attribution snapshot to persist onto the newly-
 * opened PageVisit row (see that schema's own doc comment on these fields
 * for why they live here, not just on Visitor). Optional/best-effort: only
 * `VisitorSessionService.init()` has fresh attribution to hand over; the WS
 * `visitor:page_changed` path (a mid-session SPA route change) has none. */
export interface PageVisitAttributionSnapshot {
  referrer: string | null;
  landingPage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  visitorPathLabel: string | null;
}

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
  attribution?: PageVisitAttributionSnapshot | null;
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
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
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
      // Direct user feedback ("Time on site" reading wildly high, e.g.
      // 3h21m for a visit that only lasted a couple of minutes) — root
      // cause: closing out `previous` here always used the REAL elapsed
      // wall-clock gap since it was entered, with no cap. A Visitor who
      // opens a page, leaves the tab open for hours (or closes the browser
      // entirely) and only comes back to trigger the NEXT recorded page
      // change much later would have that entire idle gap counted as
      // "time spent on" the page they left — they were AWAY, not actively
      // reading, for nearly all of it. Capped at `CURRENT_VISIT_GAP_MINUTES`
      // (the same 30-minute threshold that already defines a visit
      // boundary everywhere else in this codebase) — past that point the
      // Visitor is considered to have effectively left, so counting any
      // further elapsed time toward this page's duration would misrepresent
      // it as genuine engagement it wasn't.
      const elapsedMs = now.getTime() - previous.enteredAt.getTime();
      const cappedMs = Math.min(elapsedMs, CURRENT_VISIT_GAP_MINUTES * 60_000);
      previous.exitedAt = new Date(previous.enteredAt.getTime() + cappedMs);
      previous.durationSeconds = Math.max(0, Math.round(cappedMs / 1000));
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
      referrer: input.attribution?.referrer ?? null,
      landingPage: input.attribution?.landingPage ?? null,
      utmSource: input.attribution?.utmSource ?? null,
      utmMedium: input.attribution?.utmMedium ?? null,
      utmCampaign: input.attribution?.utmCampaign ?? null,
      visitorPathLabel: input.attribution?.visitorPathLabel ?? null,
    });

    // Direct user feedback ("First seen"/"Last seen" reading identical
    // timestamps for a Visitor with real, spread-out history) — the ONLY
    // place `Visitor.lastSeenAt` was ever updated used to be
    // `VisitorSessionService.init()`, which fires once per FULL page load.
    // For an SPA route change (this method's OTHER entry point, the WS
    // `visitor:page_changed` handler) that never re-runs `init()`,
    // `lastSeenAt` would silently stop advancing mid-visit even while the
    // Visitor keeps actively navigating. Since this IS the one writer for
    // every page-navigation event regardless of which entry point triggered
    // it (this class's own doc comment), it's also the right single place
    // to keep `lastSeenAt` current — best-effort, never lets a failure here
    // break page-visit tracking itself.
    this.visitorModel
      .updateOne({ _id: visitorId }, { $set: { lastSeenAt: now } })
      .exec()
      .catch((err) => {
        this.logger.warn(
          `Failed to bump Visitor.lastSeenAt during a page change: ${(err as Error).message}`,
        );
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
   * Session P2-5 redesign (direct user feedback: "visit count will also be
   * increased if user came to our site and even just open the home page and
   * close the website and go to some other website") — found while
   * investigating that feedback: `VisitorSessionService.init()` was
   * incrementing `Visitor.pastVisitsCount` on EVERY call, and `init()` fires
   * on every widget boot, i.e. every full page load for a traditional
   * multi-page site — so one real visitor browsing 5 pages in one sitting
   * was inflating the counter by 5, not 1. This is the fix: "is the page
   * load that's about to happen a genuinely NEW visit," using the exact same
   * `CURRENT_VISIT_GAP_MINUTES` boundary `current-visit.util.ts` already
   * defines for "current visit" grouping — reused, not re-derived. `true`
   * when this Visitor has no PageVisit history at all yet (nothing to
   * compare against — the very first page of the very first visit) or when
   * the gap since their last-known page activity exceeds the threshold;
   * `false` for a page navigated to within the same ongoing visit. Called
   * BEFORE the new PageVisit for this page load is written (see
   * `VisitorSessionService.init()`), so "latest" here still means the
   * previous page, not the one about to be created.
   */
  async isNewVisit(visitorId: Types.ObjectId | string): Promise<boolean> {
    const latest = await this.pageVisitModel
      .findOne({ visitorId })
      .sort({ enteredAt: -1 })
      .exec();
    if (!latest) return true;

    const gapMs = CURRENT_VISIT_GAP_MINUTES * 60_000;
    const lastActivityEnd = (latest.exitedAt ?? latest.enteredAt).getTime();
    return Date.now() - lastActivityEnd > gapMs;
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
