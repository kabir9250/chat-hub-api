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
  /** Visitors "Group by Page title" (this session) — the host page's
   * `document.title`, forwarded from both entry points (`init()`'s full-
   * page-load case and the WS `visitor:page_changed` SPA-route-change
   * case) exactly like `pageUrl` already is. Optional/best-effort — see
   * the schema field's own doc comment. */
  pageTitle?: string | null;
  attribution?: PageVisitAttributionSnapshot | null;
  /** Per-tab id from the widget's `sessionStorage` (see PageVisit schema's
   * own doc comment) — present on `VisitorSessionService.init()`'s calls,
   * absent on the WS `visitor:page_changed` SPA-route-change path (that
   * event carries no fresh one). When absent, `recordPageChange` below
   * carries over the Visitor's own currently-open/most-recent PageVisit's
   * `visitSessionId` instead of leaving the new row's blank — an SPA route
   * change is still the SAME tab session as whatever `init()` last
   * established, it just has no reason to resend the id every time. */
  visitSessionId?: string | null;
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
      this.closeOutPageVisit(previous, now);
      await previous.save();
    }

    const conversationId = await this.resolveOwnConversationId(
      input.conversationId,
      siteId,
      visitorId,
    );

    // See RecordPageChangeInput's own doc comment: a caller that didn't
    // send a fresh `visitSessionId` (the WS SPA-route-change path) is still
    // continuing whatever tab session `init()` last established — carry
    // that id over from `previous` (the PageVisit just closed out above) or,
    // if none was open, the Visitor's most recent PageVisit on file, rather
    // than writing this row with no session id at all.
    let visitSessionId =
      input.visitSessionId ?? previous?.visitSessionId ?? null;
    if (!input.visitSessionId && !previous) {
      const latest = await this.pageVisitModel
        .findOne({ visitorId })
        .sort({ enteredAt: -1 })
        .select('visitSessionId')
        .lean()
        .exec();
      visitSessionId = latest?.visitSessionId ?? null;
    }

    const current = await this.pageVisitModel.create({
      siteId,
      visitorId,
      conversationId,
      pageUrl: input.pageUrl,
      pageCategory: derivePageCategory(input.pageUrl),
      pageTitle: input.pageTitle ?? null,
      enteredAt: now,
      exitedAt: null,
      durationSeconds: null,
      referrer: input.attribution?.referrer ?? null,
      landingPage: input.attribution?.landingPage ?? null,
      utmSource: input.attribution?.utmSource ?? null,
      utmMedium: input.attribution?.utmMedium ?? null,
      utmCampaign: input.attribution?.utmCampaign ?? null,
      visitorPathLabel: input.attribution?.visitorPathLabel ?? null,
      visitSessionId,
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
      pageTitle: current.pageTitle,
      timestamp: now.toISOString(),
    });

    return { previous, current };
  }

  /**
   * Session P2-5 redesign (direct user feedback: "visit count will also be
   * increased if user came to our site and even just open the home page and
   * close the website and go to some other website") — `VisitorSessionService
   * .init()` used to increment `Visitor.pastVisitsCount` on EVERY call, and
   * `init()` fires on every widget boot, i.e. every full page load for a
   * traditional multi-page site — so one real visitor browsing 5 pages in
   * one sitting inflated the counter by 5, not 1. Called BEFORE the new
   * PageVisit for this page load is written (see `VisitorSessionService
   * .init()`), so "latest"/"last-known" below still mean the previous page,
   * not the one about to be created.
   *
   * Direct user feedback — "a new visit" is now the tab being closed and
   * reopened (matches Zendesk's own definition), not a rolling time gap.
   * When the caller supplies `visitSessionId` (the widget's per-tab
   * `sessionStorage` id — see PageVisit schema's doc comment), that's the
   * authoritative signal: a new visit is simply "this id differs from the
   * Visitor's last-known one" (or there is no PageVisit on file yet).
   * Falls back to the OLD 30-minute-gap heuristic only when the caller
   * sends no `visitSessionId` at all — an older cached widget bundle, or a
   * non-browser/direct-API caller (this project's own e2e tests included) —
   * so nothing that predates this feature regresses.
   */
  async isNewVisit(
    visitorId: Types.ObjectId | string,
    visitSessionId?: string | null,
  ): Promise<boolean> {
    const latest = await this.pageVisitModel
      .findOne({ visitorId })
      .sort({ enteredAt: -1 })
      .exec();
    if (!latest) return true;

    if (visitSessionId) {
      return latest.visitSessionId !== visitSessionId;
    }

    const gapMs = CURRENT_VISIT_GAP_MINUTES * 60_000;
    const lastActivityEnd = (latest.exitedAt ?? latest.enteredAt).getTime();
    return Date.now() - lastActivityEnd > gapMs;
  }

  /**
   * T-05 TC-05.3b fix (SRS §4.4a: PageVisit.exitedAt is set "when the
   * Visitor navigates away, closes the tab, or the session ends" — this is
   * the "closes the tab" trigger; "navigates away" is `recordPageChange`
   * above; "the session ends" is out of this fix's scope). Closes out this
   * Visitor's currently-open PageVisit (if any) using the exact same
   * closing logic `recordPageChange` uses for the previous page on a
   * navigate-away — see `closeOutPageVisit`'s own doc comment for that
   * logic. Triggered from `RealtimeGateway.handleDisconnect`'s visitor
   * branch, gated on `VisitorPresenceService`'s existing "zero connections
   * remaining" signal (that service's own `wentOffline`) — no separate
   * disconnect-detection mechanism.
   *
   * Guardrail: only ever touches the ONE currently-open PageVisit
   * (`exitedAt: null`), never an older already-closed record. That same
   * `exitedAt: null` filter also makes this safe against the disconnect
   * racing a genuine page-change: the ordinary case for a real tab
   * close/navigation is the socket disconnecting around the same moment a
   * fresh page load's `init()`/`recordPageChange` call would otherwise have
   * closed this same PageVisit — whichever write actually lands first wins
   * (finds the open document and closes it); the other finds nothing left
   * matching `exitedAt: null` and is a no-op. No PageVisit is ever closed
   * twice, and none is opened or created by this method.
   */
  async closeOpenPageVisitOnDisconnect(
    visitorId: Types.ObjectId | string,
  ): Promise<void> {
    const open = await this.pageVisitModel
      .findOne({ visitorId: new Types.ObjectId(visitorId), exitedAt: null })
      .sort({ enteredAt: -1 })
      .exec();
    if (!open) return;
    this.closeOutPageVisit(open, new Date());
    await open.save();
  }

  /**
   * Direct user feedback ("Time on site" reading wildly high, e.g. 3h21m
   * for a visit that only lasted a couple of minutes) — root cause: closing
   * out a PageVisit here always used the REAL elapsed wall-clock gap since
   * it was entered, with no cap, for BOTH `exitedAt` and `durationSeconds`.
   * A Visitor who opens a page, leaves the tab open for hours (or closes
   * the browser entirely) and only comes back to trigger the NEXT recorded
   * page change much later would have that entire idle gap counted as
   * "time spent on" the page they left.
   *
   * BUG in the first version of this fix, found via a follow-up live test
   * (direct user feedback: "Past visits" stayed at 0 across 4 rounds
   * genuinely 32 minutes apart, when it should have reached 3): capping
   * `exitedAt` ITSELF at 30 minutes past `enteredAt` broke visit-boundary
   * detection everywhere else in this codebase (`groupIntoVisits`'s gap
   * check uses `exitedAt`) — a REAL 32-minute gap was being reported as
   * only a ~2-minute one (32 real minutes minus the 30-minute cap already
   * baked into `exitedAt`), so it never crossed the 30-minute new-visit
   * threshold at all. `exitedAt` MUST stay the true, uncapped closing
   * timestamp (`now`) — it's a structural signal other logic depends on,
   * not just a display value. Only `durationSeconds` (the "how long were
   * they engaged" figure `useTimeOnSite`/`groupIntoVisits`'s totals
   * actually sum) is capped at `CURRENT_VISIT_GAP_MINUTES` — past that
   * point the Visitor is considered to have effectively left, so counting
   * any further elapsed time as genuine engagement would misrepresent it,
   * but that's a display concern, entirely separate from "when did this
   * page visit structurally end."
   *
   * Shared by both closing paths (`recordPageChange`'s navigate-away case
   * and `closeOpenPageVisitOnDisconnect`'s tab-close case, T-05 TC-05.3b) —
   * one capping rule, reused, not reinvented per trigger. Mutates the
   * given document in place; caller is responsible for `.save()`.
   */
  private closeOutPageVisit(pageVisit: PageVisitDocument, now: Date): void {
    pageVisit.exitedAt = now;
    const elapsedMs = now.getTime() - pageVisit.enteredAt.getTime();
    const cappedMs = Math.min(elapsedMs, CURRENT_VISIT_GAP_MINUTES * 60_000);
    pageVisit.durationSeconds = Math.max(0, Math.round(cappedMs / 1000));
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
