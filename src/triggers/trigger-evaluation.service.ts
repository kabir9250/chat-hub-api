import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  PageVisit,
  PageVisitDocument,
  Site,
  SiteDocument,
  Trigger,
  TriggerCondition,
  TriggerDocument,
  TriggerFire,
  TriggerFireDocument,
  TriggerRunEvent,
  User,
  UserDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { PermissionsService } from '../rbac/permissions.service';
import { PresenceService } from '../realtime/presence.service';
import { aggregateAccountStatus } from '../realtime/account-status.util';
import { parseReferrerSearch } from '../attribution/referrer-search.util';

/**
 * Everything the engine needs about "this Visitor, right now" to evaluate
 * every condition in SRS §2.2's categorized list. Assembled once per
 * evaluation call by `buildContext()` (which does all the async DB/
 * presence reads up front) so every individual condition check afterwards
 * is a plain synchronous read against this object.
 */
export interface TriggerEvalContext {
  visitor: VisitorDocument;
  site: SiteDocument;
  /** The page URL being evaluated against (widget-supplied — the widget always knows its own current URL). */
  currentPageUrl: string;
  /** `document.title` at the current page, if the widget forwarded one. */
  currentPageTitle: string | null;
  /** This session's page-view count so far (matches the widget's existing `pageViewCount` semantics). */
  pageViewCount: number;
  /** Total seconds the visitor has been on the CURRENT page. */
  timeOnPageSeconds: number;
  /** Total seconds since this Visitor's session began (all pages combined) — SRS "Still on site". */
  timeOnSiteSeconds: number;
  /** The URL of the page immediately before the current one, if any — SRS "Previous page". */
  previousPageUrl: string | null;
  /** Has an open ('open' status) Conversation — SRS "Visitor is chatting". */
  isChatting: boolean;
  /** Has a 'pending' Conversation — SRS "Visitor requesting chat". */
  isRequestingChat: boolean;
  /** Has a Conversation with `assignedAgentId` set — SRS "Visitor served". */
  isServed: boolean;
  /** aggregateAccountStatus() over this Site's Agents — SRS "Account status". */
  accountStatus: 'online' | 'away' | 'offline';
}

const GTE_CONDITION_TYPES = new Set([
  'timeOnPage',
  'pageViews',
  'pastVisits',
  'pastChats',
  'stillOnSite',
]);

const TRUE_FALSE_CONDITION_TYPES = new Set([
  'visitorTriggered',
  'visitorIsChatting',
  'visitorRequestingChat',
  'visitorServed',
]);

/**
 * TriggerEvaluationService — Session Feature-2b-engine
 * (`12-zendesk-feature-parity-srs.md` §2.2). Server-side condition
 * evaluation: given a Visitor + a firing event, returns which enabled
 * Triggers on that Visitor's Site match, in priority order. Deliberately
 * stops there — actions are NOT executed here (next session's scope, per
 * this task's own guardrail); callers get back `TriggerDocument[]` and
 * decide what to do with a match themselves.
 *
 * This is a NEW, server-side evaluator — distinct from (and not a
 * replacement of) the Widget's pre-existing CLIENT-side one
 * (`chat-hub-web/src/widget/triggers.ts`). The client evaluator only ever
 * had access to page/session data the browser itself knows; most of SRS
 * §2.2's "Visitor information" category (tags, wasTriggered, department,
 * account status, search-engine parsing, chat state) is server-only data,
 * so a faithful full-parity engine has to live here. Wiring an actual
 * caller to this service (the widget-bootstrap/WS event path that decides
 * when to invoke it) is out of scope for this session too — see
 * PROGRESS-PHASE2.md.
 */
@Injectable()
export class TriggerEvaluationService {
  constructor(
    @InjectModel(Trigger.name)
    private readonly triggerModel: Model<TriggerDocument>,
    @InjectModel(TriggerFire.name)
    private readonly triggerFireModel: Model<TriggerFireDocument>,
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(PageVisit.name)
    private readonly pageVisitModel: Model<PageVisitDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly presenceService: PresenceService,
  ) {}

  /**
   * Returns every enabled Trigger on `visitor.siteId` whose `runEvent`
   * matches and whose conditions evaluate true, ordered by
   * `TriggersService.findAll`'s existing priority-desc/createdAt-asc sort
   * (GUARDRAIL: this ordering is preserved unchanged, not recomputed here).
   * `fireOncePerVisitor` Triggers already recorded in `TriggerFire` for
   * this Visitor are excluded — same dedupe semantics as the widget's
   * pre-existing client-side `firedIds` check, just server-persisted.
   *
   * Does NOT record a fire itself — see `recordFire()`. Evaluation and
   * recording are kept separate so a caller can evaluate speculatively
   * (e.g. "would this fire" for a preview) without side effects, and so
   * the eventual action-execution session decides exactly when a match
   * counts as "fired" (e.g. only after its actions actually run).
   */
  async findMatches(
    visitorId: string | Types.ObjectId,
    runEvent: TriggerRunEvent,
    pageContext: {
      currentPageUrl: string;
      currentPageTitle?: string | null;
      pageViewCount: number;
      timeOnPageSeconds: number;
    },
  ): Promise<TriggerDocument[]> {
    const visitor = await this.visitorModel.findById(visitorId).exec();
    if (!visitor) return [];

    const site = await this.siteModel.findById(visitor.siteId).exec();
    if (!site) return [];

    const triggers = await this.triggerModel
      .find({ siteId: visitor.siteId, isEnabled: true, runEvent })
      .sort({ priority: -1, createdAt: 1 })
      .exec();
    if (triggers.length === 0) return [];

    const context = await this.buildContext(visitor, site, pageContext);

    const firedTriggerIds = await this.alreadyFiredTriggerIds(
      visitor._id,
      triggers.filter((t) => t.fireOncePerVisitor).map((t) => t._id),
    );

    const matches: TriggerDocument[] = [];
    for (const trigger of triggers) {
      if (
        trigger.fireOncePerVisitor &&
        firedTriggerIds.has(trigger._id.toString())
      ) {
        continue;
      }
      if (this.evaluateTrigger(trigger, context)) {
        matches.push(trigger);
      }
    }
    return matches;
  }

  /**
   * Records that `trigger` fired for `visitor` — the server-persisted half
   * of "Fire only once per visitor". Idempotent: a duplicate-key error
   * (two concurrent evaluations racing for the same Visitor) is swallowed,
   * not thrown — the row existing at all is the desired end state, not the
   * specific insert that produced it. No-ops for a Trigger that doesn't
   * have `fireOncePerVisitor` set, so callers can call this unconditionally
   * after acting on a match without checking the flag themselves.
   */
  async recordFire(
    trigger: Pick<Trigger, 'fireOncePerVisitor'> & { _id: Types.ObjectId },
    visitorId: Types.ObjectId,
  ): Promise<void> {
    if (!trigger.fireOncePerVisitor) return;
    try {
      await this.triggerFireModel.create({
        triggerId: trigger._id,
        visitorId,
      });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 11000) throw err; // 11000 = duplicate key — already recorded, fine
    }
  }

  /** Evaluates a single Trigger against an already-built context. Exposed (not just `findMatches`) so a caller with its own context — e.g. a "preview this rule" admin action — can reuse the same logic without a DB round trip. */
  evaluateTrigger(
    trigger: TriggerDocument,
    context: TriggerEvalContext,
  ): boolean {
    if (trigger.conditions.length === 0) return true; // no conditions = always fires, same as the widget's existing evaluator
    const results = trigger.conditions.map((c) =>
      this.evaluateCondition(c, context),
    );
    return trigger.conditionLogic === 'any'
      ? results.some(Boolean)
      : results.every(Boolean);
  }

  private async alreadyFiredTriggerIds(
    visitorId: Types.ObjectId,
    onceOnlyTriggerIds: Types.ObjectId[],
  ): Promise<Set<string>> {
    if (onceOnlyTriggerIds.length === 0) return new Set();
    const rows = await this.triggerFireModel
      .find({ visitorId, triggerId: { $in: onceOnlyTriggerIds } })
      .select('triggerId')
      .lean()
      .exec();
    return new Set(rows.map((r) => r.triggerId.toString()));
  }

  private async buildContext(
    visitor: VisitorDocument,
    site: SiteDocument,
    pageContext: {
      currentPageUrl: string;
      currentPageTitle?: string | null;
      pageViewCount: number;
      timeOnPageSeconds: number;
    },
  ): Promise<TriggerEvalContext> {
    const [pageVisits, conversations, accountStatus] = await Promise.all([
      // "Still on site" / "Previous page" (SRS §2.2) — reuses the same
      // PageVisit trail `page-visits.service.ts` already writes
      // (Feature-2b-schema's PROGRESS entry: "already have the underlying
      // data").
      this.pageVisitModel
        .find({ visitorId: visitor._id })
        .sort({ enteredAt: 1 })
        .select('pageUrl enteredAt')
        .lean()
        .exec(),
      // "Visitor is chatting" / "requesting chat" / "served" (SRS §2.2) —
      // all derivable from this Visitor's Conversation state, per
      // Feature-2b-schema's own cross-reference table.
      this.conversationModel
        .find({ visitorId: visitor._id })
        .select('status assignedAgentId')
        .lean()
        .exec(),
      this.resolveAccountStatus(site._id),
    ]);

    const firstEnteredAt = pageVisits[0]?.enteredAt ?? visitor.firstSeenAt;
    const timeOnSiteSeconds = Math.max(
      0,
      Math.floor((Date.now() - firstEnteredAt.getTime()) / 1000),
    );

    // "Previous page" = the second-to-last PageVisit row (the last one is
    // the page the visitor is now leaving/on).
    const previousPageUrl =
      pageVisits.length >= 2 ? pageVisits[pageVisits.length - 2].pageUrl : null;

    return {
      visitor,
      site,
      currentPageUrl: pageContext.currentPageUrl,
      currentPageTitle: pageContext.currentPageTitle ?? null,
      pageViewCount: pageContext.pageViewCount,
      timeOnPageSeconds: pageContext.timeOnPageSeconds,
      timeOnSiteSeconds,
      previousPageUrl,
      isChatting: conversations.some((c) => c.status === 'open'),
      isRequestingChat: conversations.some((c) => c.status === 'pending'),
      isServed: conversations.some((c) => c.assignedAgentId != null),
      accountStatus,
    };
  }

  /**
   * "Account status" (SRS §2.2) — same "enabled User who `isUserOnSite`"
   * definition `WidgetBootstrapService.getStatus` already uses for its
   * online/offline widget-status check, just resolving every candidate's
   * individual status (not only the online/offline boolean) and folding
   * them through `aggregateAccountStatus` for the 3-way hierarchy.
   */
  private async resolveAccountStatus(
    siteId: Types.ObjectId,
  ): Promise<'online' | 'away' | 'offline'> {
    const enabledUsers = await this.userModel
      .find({ enabled: true })
      .select('_id')
      .lean()
      .exec();

    const statuses: Array<'online' | 'away' | 'offline'> = [];
    for (const u of enabledUsers) {
      const idStr = u._id.toString();
      if (await this.permissionsService.isUserOnSite(idStr, siteId)) {
        statuses.push(this.presenceService.getStatus(idStr));
      }
    }
    return aggregateAccountStatus(statuses);
  }

  private evaluateCondition(
    condition: TriggerCondition,
    ctx: TriggerEvalContext,
  ): boolean {
    const { type, operator, value } = condition;

    if (GTE_CONDITION_TYPES.has(type)) {
      const threshold = safeNumber(value);
      switch (type) {
        case 'timeOnPage':
          return ctx.timeOnPageSeconds >= threshold;
        case 'pageViews':
          return ctx.pageViewCount >= threshold;
        case 'pastVisits':
          return ctx.visitor.pastVisitsCount >= threshold;
        case 'pastChats':
          return ctx.visitor.pastChatsCount >= threshold;
        case 'stillOnSite':
          return ctx.timeOnSiteSeconds >= threshold;
      }
    }

    if (TRUE_FALSE_CONDITION_TYPES.has(type)) {
      const expected = value === 'true';
      switch (type) {
        case 'visitorTriggered':
          return ctx.visitor.wasTriggered === expected;
        case 'visitorIsChatting':
          return ctx.isChatting === expected;
        case 'visitorRequestingChat':
          return ctx.isRequestingChat === expected;
        case 'visitorServed':
          return ctx.isServed === expected;
      }
    }

    switch (type) {
      // --- Original 9 (unchanged from the earlier "practical expanded set") ---
      case 'url':
        return matchUrl(operator, value, ctx.currentPageUrl);
      case 'referrer':
        return (ctx.visitor.referrer ?? '')
          .toLowerCase()
          .includes(value.toLowerCase());
      case 'utmSource':
        return (ctx.visitor.utmSource ?? '') === value;
      case 'deviceType':
        return (ctx.visitor.deviceType ?? '') === value;
      case 'onlineStatus':
        return (
          (ctx.accountStatus === 'offline' ? 'offline' : 'online') === value
        );

      // --- Time/Date ---
      case 'hourOfDay':
        return (
          this.currentHourInSiteTz(ctx.site.timezone) === safeNumber(value)
        );
      case 'dayOfWeek':
        return this.currentDayKeyInSiteTz(ctx.site.timezone) === value;

      // --- Location of visitor ---
      case 'visitorIp':
        return (ctx.visitor.currentIp ?? '') === value;
      case 'visitorHostName':
        // SRS §2.2 flags this "lower priority/optional" — no reverse-DNS
        // lookup exists anywhere in this app (no hostname is ever
        // resolved/stored), so this condition can never legitimately
        // match. Deliberately always false rather than silently matching
        // on an unrelated field — an admin who configures it sees it never
        // fire, which is the honest behavior until DNS lookup is built.
        return false;
      case 'visitorCity':
        return (ctx.visitor.location?.city ?? '') === value;
      case 'visitorRegion':
        return (ctx.visitor.location?.region ?? '') === value;
      case 'visitorCountryCode':
        return (ctx.visitor.location?.country ?? '') === value;
      case 'visitorCountryName':
        return (ctx.visitor.location?.country ?? '') === value;

      // --- Page information ---
      case 'pageTitle':
        return operator === 'equals'
          ? (ctx.currentPageTitle ?? '') === value
          : (ctx.currentPageTitle ?? '')
              .toLowerCase()
              .includes(value.toLowerCase());
      case 'previousPage':
        return ctx.previousPageUrl != null
          ? matchUrl(operator, value, ctx.previousPageUrl)
          : false;

      // --- Visitor information ---
      case 'visitorName':
        return operator === 'equals'
          ? (ctx.visitor.name ?? '') === value
          : (ctx.visitor.name ?? '')
              .toLowerCase()
              .includes(value.toLowerCase());
      case 'visitorEmail':
        return operator === 'equals'
          ? (ctx.visitor.email ?? '') === value
          : (ctx.visitor.email ?? '')
              .toLowerCase()
              .includes(value.toLowerCase());
      case 'visitorDepartment':
        return ctx.visitor.department?.toString() === value;
      case 'visitorTag':
        return ctx.visitor.tags.includes(value);
      case 'userAgent':
        return (ctx.visitor.userAgentRaw ?? '')
          .toLowerCase()
          .includes(value.toLowerCase());
      case 'browser':
        return (ctx.visitor.browser ?? '') === value;
      case 'platform':
        return (ctx.visitor.os ?? '') === value;
      case 'searchEngine':
        return parseReferrerSearch(ctx.visitor.referrer).engine === value;
      case 'searchTerms': {
        const terms = parseReferrerSearch(ctx.visitor.referrer).terms;
        return (
          terms != null && terms.toLowerCase().includes(value.toLowerCase())
        );
      }
      case 'accountStatus':
        return ctx.accountStatus === value;

      default:
        return false;
    }
  }

  private currentHourInSiteTz(timezone: string): number {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || 'UTC',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const hour = Number(hourStr);
      return hour === 24 ? 0 : hour;
    } catch {
      return new Date().getUTCHours();
    }
  }

  private currentDayKeyInSiteTz(timezone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || 'UTC',
        weekday: 'short',
      }).formatToParts(new Date());
      return (parts.find((p) => p.type === 'weekday')?.value ?? '')
        .toLowerCase()
        .slice(0, 3);
    } catch {
      return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
        new Date().getUTCDay()
      ];
    }
  }
}

function safeNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function matchUrl(operator: string, value: string, pageUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return false;
  }
  const pathname = parsed.pathname;
  const href = parsed.href;

  switch (operator) {
    case 'exact path':
      return pathname === value;
    case 'path prefix':
      return pathname.startsWith(value);
    case 'contains':
      return href.includes(value);
    case 'regex':
      try {
        return new RegExp(value).test(href);
      } catch {
        return false;
      }
    default:
      return false;
  }
}
