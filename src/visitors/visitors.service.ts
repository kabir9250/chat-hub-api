import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  BannedEntry,
  BannedEntryDocument,
  Conversation,
  ConversationDocument,
  Department,
  DepartmentDocument,
  PageVisit,
  PageVisitDocument,
  Site,
  SiteDocument,
  User,
  UserDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { LeadsService } from '../leads/leads.service';
import { PermissionsService } from '../rbac/permissions.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { VisitorPresenceService } from '../realtime/visitor-presence.service';
import { UpdateVisitorDto } from './dto/update-visitor.dto';
import { ListVisitorsCombinedQueryDto } from './dto/list-visitors-combined.query.dto';
import { ListVisitsQueryDto } from './dto/list-visits.query.dto';
import { ListBannedQueryDto } from './dto/list-banned.query.dto';
import {
  computeVisitorPathLowerBound,
  groupIntoVisits,
  VisitGroup,
  VISIT_HISTORY_LOOKBACK,
} from '../conversations/current-visit.util';

export interface VisitorListResult {
  items: VisitorDocument[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Phase 2, FR-P2-SITE-01–04 — `findAllCombined`'s result also names exactly
 * which Sites were queried (server-resolved, per
 * `PermissionsService.getAuthorizedSites`) — same transparency
 * `CombinedConversationListResult` provides, for the same reason.
 */
export interface CombinedVisitorListResult extends VisitorListResult {
  siteIds: string[];
}

/**
 * One row of the Banned Visitors screen (Settings → Banned) — now one row
 * per `BannedEntry` document (Feature-2a-backend), not a merge-on-read over
 * `Visitor.isBanned` + audit-log lookups. `kind` still distinguishes the two
 * shapes the reference screenshot mixes in one column: a `'visitor'` row
 * (`visitorId` populated — banned via History → "Ban visitor") and an
 * `'ip'` row (`visitorId: null` — banned via "Add banned IP address" with no
 * Visitor behind it). See `VisitorsService.findBanned`.
 */
export interface BannedVisitorRow {
  /** The `BannedEntry` document id — stable, and now a real deletable/listable row key (not a synthesized `ip:<address>` string). */
  id: string;
  kind: 'visitor' | 'ip';
  visitorId: string | null;
  /** Display label for the identifier column — name/email if known, else `Visitor <id suffix>` (same fallback convention `VisitorRow.tsx`/`PendingMenu.tsx` already use), else the raw banned IP. */
  label: string;
  ip: string | null;
  reason: string | null;
  /** ISO timestamp of `BannedEntry.createdAt` — always populated now (every ban path writes one), unlike the old audit-log-lookup which could come back `null`. */
  bannedAt: string | null;
}

export interface LiveVisitor {
  visitorId: string;
  /** Phase 2, FR-P2-SITE-03 — always populated (single-Site call already
   * knows it, combined mode's whole point is badging by it) so the frontend
   * never needs a separate lookup either way. */
  siteId: string;
  name: string | null;
  email: string | null;
  currentPage: string | null;
  pageCategory: string | null;
  /** Visitors "Group by Page title" (this session) — see
   * `PageVisit.pageTitle`'s doc comment. */
  pageTitle: string | null;
  enteredCurrentPageAt: string | null;
  location: {
    city: string | null;
    region: string | null;
    country: string | null;
  };
  browser: string | null;
  /** Visitor-table icon-trio work (agent Visitors tab) — `VisitorProfile`
   * already carried this; the live-list row never did, so the table's new
   * OS/platform icon had no per-row field to key off. Backed by the same
   * `Visitor.os` (`AttributionService.parseUserAgent`'s `ua.os`) the info
   * panel's "Platform" field already reads. */
  os: string | null;
  deviceType: string | null;
  referrer: string | null;
  landingPage: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  pastVisitsCount: number;
  pastChatsCount: number;
  activeConversationId: string | null;
  /** Visitors "Group by Serving agent"/"Group by Department" (this
   * session) — the Agent/Department of the Visitor's `activeConversationId`
   * Conversation, if any. `null` whenever there's no active Conversation
   * (nothing to be "served by" yet), or the Conversation is routed but not
   * yet assigned to a specific Agent (`assignedAgentId: null`) — both cases
   * the frontend buckets as "Unserved". */
  servingAgentName: string | null;
  /** Direct user request — the Visitors table's "Assign To" picker needs
   * the actual id (not just the display name) to pre-select the current
   * holder and to compare-and-swap against on reassign. Same null cases as
   * `servingAgentName` above. */
  servingAgentId: string | null;
  departmentName: string | null;
}

/**
 * VisitorsService — FR-VIS-06/07 (§5.2) and FR-AGT-08's Visitor Info panel
 * data source. `:siteId` is the multi-tenant boundary here (Visitor already
 * carries `siteId` directly, unlike User — no roleAssignments join needed
 * to decide "does this Visitor belong to this Site").
 */
@Injectable()
export class VisitorsService {
  constructor(
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(PageVisit.name)
    private readonly pageVisitModel: Model<PageVisitDocument>,
    // Visitors "Group by Serving agent"/"Group by Department" (this
    // session) — read-only lookups to resolve an active Conversation's
    // assignedAgentId/departmentId to a display name.
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(BannedEntry.name)
    private readonly bannedEntryModel: Model<BannedEntryDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly leadsService: LeadsService,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly visitorPresenceService: VisitorPresenceService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * FR-RPT-07 — "a Visitors list view … showing currently active/recent
   * visitors per Site with basic attribution info, usable to proactively
   * start a chat." Scoped to currently-ONLINE Visitors (a live socket
   * connection open right now, per `VisitorPresenceService` — the same
   * signal task requirement 14's "widget closed" affordance already uses)
   * rather than a broader time-window "recent" query — this is deliberately
   * the live-monitoring half of FR-RPT-07, not a historical report (that's
   * what the Leads view + Session 13's Analytics endpoints already cover).
   * Gated by `visitors.view` (VisitorsController) — no new permission; this
   * is "which Visitors can this User see," the exact same right that
   * already governs `GET /sites/:siteId/visitors`.
   */
  async findLive(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<LiveVisitor[]> {
    const site = await this.assertSite(actor, siteId);
    return this.buildLiveVisitorsForSite(site._id);
  }

  /**
   * Phase 2, FR-P2-SITE-01–04 — `GET /visitors/live?combined=true`. Same
   * "currently-online" definition as `findLive` (FR-RPT-07), merged across
   * every Site the caller holds `visitors.view` on, resolved server-side via
   * `PermissionsService.getAuthorizedSites` (never a client-supplied Site
   * list — this task's own guardrail, same as `findAllCombined` above).
   * Queried per-Site in parallel (`VisitorPresenceService`'s online-id set is
   * already Site-scoped) then merged/sorted by `lastSeenAt` descending across
   * the whole set, matching `findAllCombined`'s own merge rule.
   */
  async findLiveCombined(actor: AuthenticatedUser): Promise<{
    items: LiveVisitor[];
    siteIds: string[];
  }> {
    const authorizedSites = await this.permissionsService.getAuthorizedSites(
      actor.userId,
      ['visitors.view'],
    );
    const siteIds = authorizedSites.map((s) => s.siteId);

    const perSite = await Promise.all(
      siteIds.map((id) =>
        this.buildLiveVisitorsForSite(new Types.ObjectId(id)),
      ),
    );
    const items = perSite
      .flat()
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));

    return { items, siteIds };
  }

  /** Shared by `findLive`/`findLiveCombined` — everyone currently online on
   * ONE already-authorized Site. Never called with an unchecked `siteId`;
   * both callers resolve/authorize the Site first (`assertSite`, or
   * `getAuthorizedSites` itself only ever names Sites the caller holds
   * `visitors.view` on). */
  private async buildLiveVisitorsForSite(
    siteObjectId: Types.ObjectId,
  ): Promise<LiveVisitor[]> {
    const siteId = siteObjectId.toString();
    const onlineIds = this.visitorPresenceService.getOnlineVisitorIds(siteId);
    if (onlineIds.length === 0) return [];

    const objectIds = onlineIds.map((id) => new Types.ObjectId(id));

    const [visitors, openPageVisits, activeConversations] = await Promise.all([
      this.visitorModel
        .find({
          _id: { $in: objectIds },
          siteId: siteObjectId,
          isBanned: false,
        })
        .lean()
        .exec(),
      this.pageVisitModel
        .find({ visitorId: { $in: objectIds }, exitedAt: null })
        .lean()
        .exec(),
      this.conversationModel
        .find({
          visitorId: { $in: objectIds },
          siteId: siteObjectId,
          status: { $ne: 'closed' },
        })
        .sort({ startedAt: -1 })
        // Visitors "Group by Serving agent"/"Group by Department" (this
        // session) — pulled alongside `_id` so the caller can resolve a
        // display name for each without a second round-trip per row.
        .select('_id visitorId assignedAgentId departmentId')
        .lean()
        .exec(),
    ]);

    const pageByVisitor = new Map(
      openPageVisits.map((pv) => [pv.visitorId.toString(), pv]),
    );
    // sort() above puts the most recent first; only the first match per
    // visitorId (Map.set on a repeat key is a no-op-equivalent overwrite,
    // so iterate in order and only set if absent) should win.
    const conversationByVisitor = new Map<
      string,
      (typeof activeConversations)[number]
    >();
    for (const conv of activeConversations) {
      const key = conv.visitorId.toString();
      if (!conversationByVisitor.has(key)) {
        conversationByVisitor.set(key, conv);
      }
    }

    const { agentNames, departmentNames } =
      await this.resolveConversationNames(activeConversations);

    return visitors.map((v) => {
      const conv = conversationByVisitor.get(v._id.toString());
      return this.mapLiveVisitorRow(
        v,
        siteId,
        pageByVisitor.get(v._id.toString()),
        conv?._id,
        conv?.assignedAgentId
          ? (agentNames.get(conv.assignedAgentId.toString()) ?? null)
          : null,
        conv?.assignedAgentId ? conv.assignedAgentId.toString() : null,
        conv?.departmentId
          ? (departmentNames.get(conv.departmentId.toString()) ?? null)
          : null,
      );
    });
  }

  /** Visitors "Group by Serving agent"/"Group by Department" (this session)
   * — shared by `buildLiveVisitorsForSite`/`getLiveVisitor`: batch-resolves
   * every distinct `assignedAgentId`/`departmentId` among a set of active
   * Conversations to their display names in (up to) two queries total,
   * rather than one per Visitor. */
  private async resolveConversationNames(
    conversations: Array<{
      assignedAgentId?: Types.ObjectId | null;
      departmentId?: Types.ObjectId | null;
    }>,
  ): Promise<{
    agentNames: Map<string, string>;
    departmentNames: Map<string, string>;
  }> {
    const agentIds = [
      ...new Set(
        conversations
          .map((c) => c.assignedAgentId?.toString())
          .filter((id): id is string => !!id),
      ),
    ];
    const departmentIds = [
      ...new Set(
        conversations
          .map((c) => c.departmentId?.toString())
          .filter((id): id is string => !!id),
      ),
    ];

    const [agents, departments] = await Promise.all([
      agentIds.length
        ? this.userModel
            .find({
              _id: { $in: agentIds.map((id) => new Types.ObjectId(id)) },
            })
            .select('_id displayName')
            .lean()
            .exec()
        : Promise.resolve([]),
      departmentIds.length
        ? this.departmentModel
            .find({
              _id: { $in: departmentIds.map((id) => new Types.ObjectId(id)) },
            })
            .select('_id name')
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    return {
      agentNames: new Map(agents.map((a) => [a._id.toString(), a.displayName])),
      departmentNames: new Map(
        departments.map((d) => [d._id.toString(), d.name]),
      ),
    };
  }

  /**
   * Perf fix (direct user feedback — "visitor takes a while to show up in
   * the live Visitors table even though we use Socket.IO") — the actual
   * delay was never the socket, it was `RealtimeGateway.handleConnection`
   * broadcasting a bare `{visitorId, siteId, timestamp}` on `visitor.online`
   * and leaving `VisitorsPanel.tsx` to treat that as a "go find out what
   * changed" signal: a 300ms debounce, then a full `GET .../visitors/live`
   * REST round-trip that re-queries every online Visitor on the Site just to
   * learn about the ONE that just connected. Same shape as
   * `buildLiveVisitorsForSite` above but scoped to a single, already-known
   * visitorId — lets the gateway attach the finished `LiveVisitor` row
   * directly to the `visitor.online` payload, so the frontend can splice it
   * straight into state with no refetch at all. `null` return (banned
   * Visitor, or a race where the Visitor doc was deleted between connect and
   * this lookup) tells the caller to fall back to its own refetch instead of
   * emitting a payload with no row to show.
   */
  async getLiveVisitor(
    visitorId: string,
    siteId: string,
  ): Promise<LiveVisitor | null> {
    const visitorObjectId = new Types.ObjectId(visitorId);
    const siteObjectId = new Types.ObjectId(siteId);

    const [visitor, openPage, activeConversation] = await Promise.all([
      this.visitorModel
        .findOne({
          _id: visitorObjectId,
          siteId: siteObjectId,
          isBanned: false,
        })
        .lean()
        .exec(),
      this.pageVisitModel
        .findOne({ visitorId: visitorObjectId, exitedAt: null })
        .sort({ enteredAt: -1 })
        .lean()
        .exec(),
      this.conversationModel
        .findOne({
          visitorId: visitorObjectId,
          siteId: siteObjectId,
          status: { $ne: 'closed' },
        })
        .sort({ startedAt: -1 })
        .select('_id assignedAgentId departmentId')
        .lean()
        .exec(),
    ]);
    if (!visitor) return null;

    const { agentNames, departmentNames } = await this.resolveConversationNames(
      activeConversation ? [activeConversation] : [],
    );

    return this.mapLiveVisitorRow(
      visitor,
      siteId,
      openPage ?? undefined,
      activeConversation?._id,
      activeConversation?.assignedAgentId
        ? (agentNames.get(activeConversation.assignedAgentId.toString()) ??
            null)
        : null,
      activeConversation?.assignedAgentId
        ? activeConversation.assignedAgentId.toString()
        : null,
      activeConversation?.departmentId
        ? (departmentNames.get(activeConversation.departmentId.toString()) ??
            null)
        : null,
    );
  }

  /** Shared row-shaping for `buildLiveVisitorsForSite`/`getLiveVisitor` — kept as one place so the two never drift on which fields the live list actually shows. Takes plain `.lean()` shapes (not the `*Document` Mongoose wrapper), matching what both callers actually query with. */
  private mapLiveVisitorRow(
    v: Visitor,
    siteId: string,
    page: PageVisit | undefined,
    activeConversationId: Types.ObjectId | undefined,
    servingAgentName: string | null,
    servingAgentId: string | null,
    departmentName: string | null,
  ): LiveVisitor {
    return {
      visitorId: v._id.toString(),
      siteId,
      name: v.name ?? null,
      email: v.email ?? null,
      currentPage: page?.pageUrl ?? null,
      pageCategory: page?.pageCategory ?? null,
      pageTitle: page?.pageTitle ?? null,
      enteredCurrentPageAt: page?.enteredAt
        ? page.enteredAt.toISOString()
        : null,
      location: {
        city: v.location?.city ?? null,
        region: v.location?.region ?? null,
        country: v.location?.country ?? null,
      },
      browser: v.browser ?? null,
      os: v.os ?? null,
      deviceType: v.deviceType ?? null,
      referrer: v.referrer ?? null,
      landingPage: v.landingPage ?? null,
      firstSeenAt: v.firstSeenAt.toISOString(),
      lastSeenAt: v.lastSeenAt.toISOString(),
      pastVisitsCount: v.pastVisitsCount,
      pastChatsCount: v.pastChatsCount,
      activeConversationId: activeConversationId
        ? activeConversationId.toString()
        : null,
      servingAgentName,
      servingAgentId,
      departmentName,
    };
  }

  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
    banned?: boolean,
  ): Promise<VisitorDocument[]> {
    const site = await this.assertSite(actor, siteId);

    const filter: FilterQuery<VisitorDocument> = { siteId: site._id };
    if (banned !== undefined) {
      filter.isBanned = banned;
    }

    return this.visitorModel.find(filter).sort({ lastSeenAt: -1 }).exec();
  }

  /**
   * Banned Visitors screen (Settings → Banned) — Feature-2a-backend: now
   * reads `BannedEntry` rows directly instead of merging
   * `Visitor.isBanned: true` scans with best-effort audit-log lookups for
   * date/reason. One `BannedEntry` = one row; `kind` is derived from whether
   * `visitorId` is set. `search` matches (case-insensitive substring) IP,
   * Visitor name/email, or reason; `dateFrom`/`dateTo` filter on
   * `createdAt`, inclusive, same convention `DateRangeQueryDto` uses
   * elsewhere (FR-RPT filters) — `dateTo` is treated as end-of-day so a
   * same-day `dateFrom`/`dateTo` still includes that whole day.
   */
  async findBanned(
    actor: AuthenticatedUser,
    siteId: string,
    query: ListBannedQueryDto = {},
  ): Promise<BannedVisitorRow[]> {
    const site = await this.assertSite(actor, siteId);

    const filter: FilterQuery<BannedEntryDocument> = { siteId: site._id };
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const entries = await this.bannedEntryModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const visitorIds = entries
      .map((e) => e.visitorId)
      .filter((id): id is Types.ObjectId => !!id);
    const visitors = visitorIds.length
      ? await this.visitorModel
          .find({ _id: { $in: visitorIds } })
          .select('_id name email')
          .lean()
          .exec()
      : [];
    const visitorById = new Map(visitors.map((v) => [v._id.toString(), v]));

    const rows: BannedVisitorRow[] = entries.map((e) => {
      const id = e._id.toString();
      const visitor = e.visitorId
        ? visitorById.get(e.visitorId.toString())
        : undefined;
      const label = e.visitorId
        ? visitor?.name ||
          visitor?.email ||
          `Visitor ${e.visitorId.toString().slice(-6)}`
        : (e.ipAddress ?? '(unknown IP)');
      return {
        id,
        kind: e.visitorId ? 'visitor' : 'ip',
        visitorId: e.visitorId ? e.visitorId.toString() : null,
        label,
        ip: e.ipAddress,
        reason: e.reason,
        bannedAt: e.createdAt.toISOString(),
      };
    });

    if (!query.search) return rows;
    const q = query.search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        (r.ip ?? '').toLowerCase().includes(q) ||
        (r.reason ?? '').toLowerCase().includes(q),
    );
  }

  /**
   * "Add banned IP address" — the Banned Visitors screen's own creation
   * flow (Settings → Banned → Add visitor), direct user request. Bans a raw
   * IP with no Visitor behind it at all: writes one `BannedEntry` with
   * `visitorId: null` (Feature-2a-backend — was a push onto
   * `Site.bannedIps` before this session; `VisitorSessionService.init()`'s
   * enforcement now queries `BannedEntry` by `{siteId, ipAddress}`, so this
   * needs no separate enforcement wiring).
   */
  async banIp(
    actor: AuthenticatedUser,
    siteId: string,
    ip: string,
    reason?: string,
  ): Promise<void> {
    const site = await this.assertSite(actor, siteId);

    await this.bannedEntryModel.create({
      siteId: site._id,
      visitorId: null,
      ipAddress: ip,
      reason: reason || null,
      createdByUserId: new Types.ObjectId(actor.userId),
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'visitor.banned',
      siteId: site._id,
      targetType: 'ip',
      metadata: { ip, reason: reason || undefined },
    });
  }

  /**
   * Phase 2, FR-P2-SITE-01–04 — `GET /visitors?combined=true`. Same shape as
   * `findAll` above, merged across every Site the caller holds `visitors.view`
   * on, resolved server-side via `PermissionsService.getAuthorizedSites`
   * (never a client-supplied Site list — this task's guardrail). Unlike
   * Conversations, Visitors carries no `view_own`-style narrower scope
   * (`visitors.view` is the only relevant key, SRS §5.13) — so, unlike
   * `ConversationsService.findAllCombined`, there is no per-Site scope split
   * to build; every authorized Site contributes every matching Visitor.
   *
   * Adds page/limit pagination `findAll` doesn't have — `findAll`'s
   * single-Site result set is already naturally bounded by that one Site's
   * Visitor count, but a merged multi-Site set has no such bound, so this
   * task's "pagination/sorting that works sensibly across the merged
   * result set" applies here specifically. `findAll` itself is unchanged
   * (out of scope — a behavior change there wasn't asked for and risks a
   * frontend regression on the working single-Site Visitors screen).
   */
  async findAllCombined(
    actor: AuthenticatedUser,
    query: ListVisitorsCombinedQueryDto,
  ): Promise<CombinedVisitorListResult> {
    const authorizedSites = await this.permissionsService.getAuthorizedSites(
      actor.userId,
      ['visitors.view'],
    );
    const siteObjectIds = authorizedSites.map(
      (s) => new Types.ObjectId(s.siteId),
    );
    const siteIds = authorizedSites.map((s) => s.siteId);

    const filter: FilterQuery<VisitorDocument> = {
      siteId: { $in: siteObjectIds },
    };
    if (query.banned !== undefined) {
      filter.isBanned = query.banned === 'true';
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Merged sort: most-recent activity across every authorized Site,
    // regardless of which Site a Visitor belongs to — same `lastSeenAt`
    // field/direction `findAll()` already sorts a single Site's list by.
    // Each returned item still carries its own `siteId` (Visitor's own
    // field, always populated) so the frontend can badge it (FR-P2-SITE-03).
    const [items, total] = await Promise.all([
      this.visitorModel
        .find(filter)
        .sort({ lastSeenAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.visitorModel.countDocuments(filter).exec(),
    ]);

    return { items, total, page, limit, siteIds };
  }

  /**
   * Phase 2, FR-P2-HIST-02 (Session P2-5) — "Past visits" drill-down: this
   * Visitor's WHOLE `PageVisit` history grouped into distinct visit
   * sessions (via `current-visit.util.ts`'s `groupIntoVisits` — the exact
   * same gap-boundary rule Session P2-4's "current visit" already uses,
   * reused rather than re-derived), most-recent-first, paginated over the
   * GROUPS (not the raw PageVisit rows — a page of "visits" should mean a
   * page of visits, matching FR-P2-HIST-02's "distinct visit sessions").
   * Gated by `visitors.view` (VisitorsController) — same as every other
   * Visitor-entity read; PageVisit history isn't tied to any one
   * Conversation's assignedAgentId the way `conversations.view_own` scoping
   * is, so there's no narrower-scope split to apply here (see
   * `findAllCombined`'s own doc comment making the same point for Visitors
   * generally).
   *
   * Session P2-5 redesign (direct user feedback, two rounds) —
   * `query.beforeConversationId` scopes this the same way
   * `ConversationsService.findAll`'s `beforeConversationId` scopes "Past
   * chats": only visit sessions that ended at-or-before the lower bound of
   * THAT Conversation's own "Visitor path" range count as "past" for it —
   * i.e. exactly the visit sessions `ConversationsService`'s
   * `computeConversationPath` does NOT already claim for that Conversation's
   * own path, so the two drill-downs never show overlapping/duplicated page
   * data. That lower bound is computed by the exact same
   * `computeVisitorPathLowerBound` (`current-visit.util.ts`) —
   * reused, not re-derived — so it correctly yields zero past visits for a
   * Visitor's first-ever Conversation, AND correctly still counts an
   * earlier, entirely chat-less visit session as one of the "past visits"
   * for whichever LATER Conversation is the first to actually chat (the
   * exact scenario the user's 4-visit walkthrough spec covers: visit 1 has
   * no chat at all, but still counts as visit 2's one past visit).
   */
  async findVisits(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    query: ListVisitsQueryDto,
  ): Promise<{
    items: VisitGroup<PageVisitDocument>[];
    total: number;
    page: number;
    limit: number;
  }> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    const recentDesc = await this.pageVisitModel
      .find({ visitorId: visitor._id })
      .sort({ enteredAt: -1 })
      .limit(VISIT_HISTORY_LOOKBACK)
      .exec();

    let allVisits = groupIntoVisits(recentDesc);

    if (query.beforeConversationId) {
      const ref = await this.conversationModel
        .findOne({
          _id: query.beforeConversationId,
          siteId: site._id,
          visitorId: visitor._id,
        })
        .select('startedAt')
        .lean()
        .exec();
      if (ref) {
        const previousConversation = await this.conversationModel
          .findOne({
            visitorId: visitor._id,
            startedAt: { $lt: ref.startedAt },
          })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean()
          .exec();
        const upperBoundExclusive = computeVisitorPathLowerBound(
          allVisits,
          ref.startedAt,
          previousConversation?.startedAt ?? null,
        );
        allVisits = allVisits.filter(
          (g) => g.endedAt.getTime() <= upperBoundExclusive.getTime(),
        );
      }
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const start = (page - 1) * limit;
    const items = allVisits.slice(start, start + limit);

    return { items, total: allVisits.length, page, limit };
  }

  async findOne(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    return this.findVisitorOnSite(site, visitorId);
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    dto: UpdateVisitorDto,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    const before = {
      name: visitor.name,
      email: visitor.email,
      phone: visitor.phone,
      notes: visitor.notes,
    };

    if (dto.name !== undefined) visitor.name = dto.name.trim();
    if (dto.email !== undefined) visitor.email = dto.email.trim().toLowerCase();
    if (dto.phone !== undefined) visitor.phone = dto.phone.trim();
    if (dto.notes !== undefined) visitor.notes = dto.notes;

    await visitor.save();

    // FR-VIS-08: a Visitor with a name or email now on file becomes a Lead
    // (or stays one — this never overwrites an existing Lead's status).
    await this.leadsService.syncLeadForVisitor(visitor);

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'visitor.updated',
      siteId: site._id,
      targetType: 'Visitor',
      targetId: visitor._id,
      metadata: {
        before,
        after: {
          name: visitor.name,
          email: visitor.email,
          phone: visitor.phone,
          notes: visitor.notes,
        },
      },
    });

    await this.emitProfileUpdated(visitor);

    return visitor;
  }

  /**
   * Session Feature-2c-complex-actions (SRS §2.2 "Block visitor" action) —
   * the Trigger-driven counterpart to `ban()` above. GUARDRAIL: reuses
   * Feature 2a's exact `BannedEntry` mechanism (same schema, same
   * `visitor.isBanned` sync, same `emitProfileUpdated` live-panel refresh) —
   * this is not a parallel ban path, just a different caller. Split out
   * because a Trigger match has no `AuthenticatedUser` actor to satisfy
   * `ban()`'s `assertSite(actor, siteId)`/organization check: the caller
   * (`RealtimeGateway.handleVisitorTriggerActivated`) has already loaded and
   * validated `visitor`/`site` itself via the Visitor's own verified socket
   * session, so there is nothing left for an actor-based re-check to add.
   * `createdByUserId: null` + `actorType: 'system'` on the audit entry (same
   * precedent `ConversationsService`/`VisitorSessionService` already use for
   * automatic, non-human-initiated actions) record this honestly as system-
   * initiated rather than attributing it to whichever Admin happened to
   * configure the Trigger.
   */
  async banFromTrigger(
    site: SiteDocument,
    visitor: VisitorDocument,
    reason?: string,
  ): Promise<void> {
    visitor.isBanned = true;
    await visitor.save();

    await this.bannedEntryModel.create({
      siteId: site._id,
      visitorId: visitor._id,
      ipAddress: visitor.currentIp ?? null,
      reason: reason || null,
      createdByUserId: null,
    });

    await this.auditLogService.record({
      actorType: 'system',
      action: 'visitor.banned',
      siteId: site._id,
      targetType: 'Visitor',
      targetId: visitor._id,
      metadata: {
        ip: visitor.currentIp ?? undefined,
        reason: reason || undefined,
        source: 'trigger',
      },
    });

    await this.emitProfileUpdated(visitor);
  }

  /**
   * FR-VIS-07: Ban a Visitor by id, and also block by IP — the Visitor's
   * `currentIp` (or an explicit override, e.g. from server logs) is banned
   * alongside them so the ban survives the Visitor clearing
   * cookies/localStorage and coming back as an anonymous new session
   * (enforced in VisitorSessionService.init).
   *
   * Feature-2a-backend: writes one `BannedEntry` (`visitorId` + `ipAddress`
   * both populated) instead of flipping `Visitor.isBanned` and pushing onto
   * `Site.bannedIps`. `visitor.isBanned` is still set `true` alongside it —
   * kept in sync rather than removed outright (still read by
   * `findAll`/`findLive`'s "hide banned Visitors from the live list" filter
   * and the existing `banned=true/false` list filter — out of this task's
   * scope to touch) — but is no longer what enforcement or the Banned
   * Visitors screen actually trust; `BannedEntry` is the source of truth for
   * both now. `ipToBan` can be `null` (a Visitor with no `currentIp` on file
   * and no override given) — still recorded as a Visitor-only ban so
   * unbanning has something to look up, it just enforces nothing on the IP
   * side (there's no IP known to enforce).
   */
  async ban(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    ipOverride?: string,
    reason?: string,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    visitor.isBanned = true;
    await visitor.save();

    const ipToBan = ipOverride ?? visitor.currentIp ?? null;

    await this.bannedEntryModel.create({
      siteId: site._id,
      visitorId: visitor._id,
      ipAddress: ipToBan,
      reason: reason || null,
      createdByUserId: new Types.ObjectId(actor.userId),
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'visitor.banned',
      siteId: site._id,
      targetType: 'Visitor',
      targetId: visitor._id,
      metadata: { ip: ipToBan, reason: reason || undefined },
    });

    await this.emitProfileUpdated(visitor);

    return visitor;
  }

  /**
   * Not asked for by the SRS, but trivial and useful for reversing a
   * mistaken ban / test cleanup — gated by the same `visitors.ban`
   * permission. Feature-2a-backend: removes every `BannedEntry` for this
   * Visitor (covers a Visitor banned more than once, e.g. re-banned after an
   * earlier unban) rather than clearing a boolean/array entry.
   */
  async unban(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    visitor.isBanned = false;
    await visitor.save();

    await this.bannedEntryModel
      .deleteMany({ siteId: site._id, visitorId: visitor._id })
      .exec();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'visitor.unbanned',
      siteId: site._id,
      targetType: 'Visitor',
      targetId: visitor._id,
    });

    await this.emitProfileUpdated(visitor);

    return visitor;
  }

  /**
   * This session's addition (task requirement 4) — same broadcast
   * `VisitorSessionService.emitProfileUpdated` sends for the pre-chat form,
   * fired here for every Agent/Admin-facing mutation to the Visitor record
   * (edit, ban, unban all count as "otherwise updated") so the Agent
   * Console's Visitor Info panel stays live no matter which side changed
   * it. Duplicated rather than promoted into a shared service — exactly
   * two call sites (this one and VisitorSessionService's), below this
   * codebase's own "promote on the third" threshold (Session 7's note on
   * `PermissionsService.isUserOnSite`).
   */
  private async emitProfileUpdated(visitor: VisitorDocument): Promise<void> {
    const conversation = await this.conversationModel
      .findOne({ visitorId: visitor._id })
      .sort({ startedAt: -1 })
      .select('_id')
      .lean()
      .exec();
    if (!conversation) return;

    this.realtimeEvents.emit({
      kind: 'visitor.profileUpdated',
      siteId: visitor.siteId.toString(),
      conversationId: conversation._id.toString(),
      visitor: visitor.toObject() as Record<string, unknown>,
    });
  }

  private async assertSite(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteDocument> {
    const site = await this.siteModel
      .findOne({ _id: siteId, organizationId: actor.organizationId })
      .exec();
    if (!site) {
      throw new NotFoundException('Site not found in this Organization.');
    }
    return site;
  }

  private async findVisitorOnSite(
    site: SiteDocument,
    visitorId: string,
  ): Promise<VisitorDocument> {
    const visitor = await this.visitorModel
      .findOne({ _id: visitorId, siteId: site._id })
      .exec();
    if (!visitor) {
      throw new NotFoundException('Visitor not found on this Site.');
    }
    return visitor;
  }
}
