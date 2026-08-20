import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  AnalyticsEvent,
  AnalyticsEventDocument,
  AnalyticsEventType,
  Conversation,
  ConversationDocument,
  ConversationStatus,
  CONVERSATION_STATUSES,
  Lead,
  LeadDocument,
  LeadStatus,
  LEAD_STATUSES,
  Message,
  MessageDocument,
  PageVisit,
  PageVisitDocument,
  Site,
  SiteDocument,
  User,
  UserDocument,
} from '../database/schemas';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AnalyticsChartQueryDto,
  ChartGranularity,
} from './dto/analytics-chart.query.dto';
import { DateRangeQueryDto } from './dto/date-range.query.dto';
import { PageVisitStatsQueryDto } from './dto/page-visit-stats.query.dto';

export interface PageVisitStatRow {
  key: string;
  visitCount: number;
  totalDurationSeconds: number;
  avgDurationSeconds: number | null;
}

export interface PageVisitStatsResult {
  siteId: string;
  groupBy: 'category' | 'page';
  rows: PageVisitStatRow[];
}

export interface ChartPoint {
  bucket: string;
  pageView: number;
  totalVisit: number;
  uniqueVisitor: number;
  chatStarted: number;
}

export interface ChartResult {
  mode: 'site' | 'organization';
  siteId: string | null;
  granularity: ChartGranularity;
  points: ChartPoint[];
}

export interface ConversationsByStatusResult {
  mode: 'site' | 'organization';
  siteId: string | null;
  total: number;
  byStatus: Record<ConversationStatus, number>;
  bySite?: {
    siteId: string;
    total: number;
    byStatus: Record<ConversationStatus, number>;
  }[];
}

export interface ResponseResolutionStats {
  conversationCount: number;
  avgFirstResponseSeconds: number | null;
  medianFirstResponseSeconds: number | null;
  avgResolutionSeconds: number | null;
  medianResolutionSeconds: number | null;
}

export interface AgentResponseResolutionStats extends ResponseResolutionStats {
  agentId: string;
  agentName: string | null;
}

export interface SiteResponseResolutionStats extends ResponseResolutionStats {
  siteId: string;
}

export interface ResponseTimesResult {
  mode: 'site' | 'organization';
  siteId: string | null;
  overall: ResponseResolutionStats;
  byAgent: AgentResponseResolutionStats[];
  bySite?: SiteResponseResolutionStats[];
}

export interface AgentActivityRow {
  agentId: string;
  agentName: string | null;
  conversationsHandled: number;
  messagesSent: number;
  avgHandleTimeSeconds: number | null;
  /**
   * Not tracked — PresenceService (Session 8) only ever holds in-memory
   * "is this Agent connected right now" state, no persisted online-duration
   * history. Computing a real per-Agent online-time-over-a-date-range would
   * need new tracking infrastructure (e.g. logging every connect/disconnect
   * transition with a duration), which is presence/realtime business logic,
   * not analytics/reporting — out of scope per this session's guardrail
   * ("do not build new business logic outside of analytics/reporting").
   * Reported as `null` rather than a fabricated number so the frontend can
   * render an honest "not tracked" state instead of a fake zero.
   */
  onlineTimeSeconds: null;
}

export interface AgentActivityResult {
  mode: 'site' | 'organization';
  siteId: string | null;
  agents: AgentActivityRow[];
}

export interface LeadStatsResult {
  mode: 'site' | 'organization';
  siteId: string | null;
  total: number;
  byStatus: Record<LeadStatus, number>;
  bySite?: {
    siteId: string;
    total: number;
    byStatus: Record<LeadStatus, number>;
  }[];
}

const GRANULARITY_UNIT: Record<
  ChartGranularity,
  'hour' | 'day' | 'week' | 'month'
> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function statsOf(
  rows: {
    firstResponseSeconds: number | null;
    resolutionSeconds: number | null;
  }[],
): ResponseResolutionStats {
  const firstResponses = rows
    .map((r) => r.firstResponseSeconds)
    .filter((v): v is number => v !== null);
  const resolutions = rows
    .map((r) => r.resolutionSeconds)
    .filter((v): v is number => v !== null);
  return {
    conversationCount: rows.length,
    avgFirstResponseSeconds: average(firstResponses),
    medianFirstResponseSeconds: median(firstResponses),
    avgResolutionSeconds: average(resolutions),
    medianResolutionSeconds: median(resolutions),
  };
}

/**
 * AnalyticsService — FR-RPT-01–08 (SRS §5.11).
 *
 * `getPageVisitStats` is Session 11.3's original minimal FR-RPT-08 cut,
 * unchanged. Everything else is this session's addition: the dashboard
 * chart (FR-RPT-01), conversations-by-status (FR-RPT-02), first-response/
 * resolution time (FR-RPT-03), Agent activity (FR-RPT-04), and Lead counts
 * (FR-RPT-05) — each with a single-Site method (called by
 * `AnalyticsController`, `analytics.view_site`) and a combined-across-Sites
 * method (called by `OrganizationAnalyticsController`,
 * `analytics.view_organization` — FR-RPT-06). Both variants of each report
 * share one private "compute" implementation parameterized on which Site
 * ids to aggregate over, so there is exactly one aggregation pipeline per
 * report, not two.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(PageVisit.name)
    private readonly pageVisitModel: Model<PageVisitDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(AnalyticsEvent.name)
    private readonly analyticsEventModel: Model<AnalyticsEventDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  // -----------------------------------------------------------------------
  // FR-RPT-08 (Session 11.3, unchanged) — time spent per page/page-category.
  // -----------------------------------------------------------------------
  async getPageVisitStats(
    actor: AuthenticatedUser,
    siteId: string,
    query: PageVisitStatsQueryDto,
  ): Promise<PageVisitStatsResult> {
    const site = await this.assertSite(actor, siteId);

    const groupBy = query.groupBy ?? 'category';
    const match: FilterQuery<PageVisitDocument> = { siteId: site._id };
    this.applyDateRange(match, 'enteredAt', query.dateFrom, query.dateTo);

    const groupField = groupBy === 'page' ? '$pageUrl' : '$pageCategory';

    const rows = await this.pageVisitModel
      .aggregate<{
        _id: string | null;
        visitCount: number;
        totalDurationSeconds: number;
        avgDurationSeconds: number | null;
      }>([
        { $match: match },
        {
          $group: {
            _id: groupField,
            visitCount: { $sum: 1 },
            totalDurationSeconds: {
              $sum: { $ifNull: ['$durationSeconds', 0] },
            },
            avgDurationSeconds: { $avg: '$durationSeconds' },
          },
        },
        { $sort: { totalDurationSeconds: -1 } },
      ])
      .exec();

    return {
      siteId: site._id.toString(),
      groupBy,
      rows: rows.map((r) => ({
        key: r._id ?? 'uncategorized',
        visitCount: r.visitCount,
        totalDurationSeconds: r.totalDurationSeconds,
        avgDurationSeconds: r.avgDurationSeconds ?? null,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // FR-RPT-01 — Home dashboard chart: page views / total visits / unique
  // visitors / chats, Hourly/Daily/Weekly/Monthly.
  // -----------------------------------------------------------------------
  async getChart(
    actor: AuthenticatedUser,
    siteId: string,
    query: AnalyticsChartQueryDto,
  ): Promise<ChartResult> {
    const site = await this.assertSite(actor, siteId);
    const points = await this.computeChart([site._id], query);
    return {
      mode: 'site',
      siteId: site._id.toString(),
      granularity: query.granularity ?? 'daily',
      points,
    };
  }

  async getChartCombined(
    actor: AuthenticatedUser,
    query: AnalyticsChartQueryDto,
  ): Promise<ChartResult> {
    const siteIds = await this.orgSiteIds(actor);
    const points = await this.computeChart(siteIds, query);
    return {
      mode: 'organization',
      siteId: null,
      granularity: query.granularity ?? 'daily',
      points,
    };
  }

  private async computeChart(
    siteIds: Types.ObjectId[],
    query: AnalyticsChartQueryDto,
  ): Promise<ChartPoint[]> {
    const granularity = query.granularity ?? 'daily';
    const unit = GRANULARITY_UNIT[granularity];

    const match: FilterQuery<AnalyticsEventDocument> = {
      siteId: { $in: siteIds },
    };
    this.applyDateRange(match, 'occurredAt', query.dateFrom, query.dateTo);

    const rows = await this.analyticsEventModel
      .aggregate<{
        _id: { bucket: Date; type: AnalyticsEventType };
        count: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: {
              bucket: {
                $dateTrunc: { date: '$occurredAt', unit, timezone: 'UTC' },
              },
              type: '$type',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.bucket': 1 } },
      ])
      .exec();

    const byBucket = new Map<string, ChartPoint>();
    for (const row of rows) {
      const key = row._id.bucket.toISOString();
      let point = byBucket.get(key);
      if (!point) {
        point = {
          bucket: key,
          pageView: 0,
          totalVisit: 0,
          uniqueVisitor: 0,
          chatStarted: 0,
        };
        byBucket.set(key, point);
      }
      point[row._id.type] = row.count;
    }

    return [...byBucket.values()].sort((a, b) =>
      a.bucket.localeCompare(b.bucket),
    );
  }

  // -----------------------------------------------------------------------
  // FR-RPT-02 — total conversations + status breakdown.
  // -----------------------------------------------------------------------
  async getConversationsByStatus(
    actor: AuthenticatedUser,
    siteId: string,
    query: DateRangeQueryDto,
  ): Promise<ConversationsByStatusResult> {
    const site = await this.assertSite(actor, siteId);
    const { total, byStatus } = await this.computeConversationsByStatus(
      [site._id],
      query,
    );
    return { mode: 'site', siteId: site._id.toString(), total, byStatus };
  }

  async getConversationsByStatusCombined(
    actor: AuthenticatedUser,
    query: DateRangeQueryDto,
  ): Promise<ConversationsByStatusResult> {
    const siteIds = await this.orgSiteIds(actor);
    const { total, byStatus } = await this.computeConversationsByStatus(
      siteIds,
      query,
    );
    const bySite = await Promise.all(
      siteIds.map(async (id) => {
        const stats = await this.computeConversationsByStatus([id], query);
        return { siteId: id.toString(), ...stats };
      }),
    );
    return { mode: 'organization', siteId: null, total, byStatus, bySite };
  }

  private async computeConversationsByStatus(
    siteIds: Types.ObjectId[],
    query: DateRangeQueryDto,
  ): Promise<{ total: number; byStatus: Record<ConversationStatus, number> }> {
    const match: FilterQuery<ConversationDocument> = {
      siteId: { $in: siteIds },
    };
    this.applyDateRange(match, 'startedAt', query.dateFrom, query.dateTo);

    const rows = await this.conversationModel
      .aggregate<{ _id: ConversationStatus; count: number }>([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const byStatus = Object.fromEntries(
      CONVERSATION_STATUSES.map((s) => [s, 0]),
    ) as Record<ConversationStatus, number>;
    let total = 0;
    for (const row of rows) {
      byStatus[row._id] = row.count;
      total += row.count;
    }
    return { total, byStatus };
  }

  // -----------------------------------------------------------------------
  // FR-RPT-03 — avg/median first-response time and avg/median resolution
  // time, overall + per Agent (+ per Site for the combined view).
  // -----------------------------------------------------------------------
  async getResponseTimes(
    actor: AuthenticatedUser,
    siteId: string,
    query: DateRangeQueryDto,
  ): Promise<ResponseTimesResult> {
    const site = await this.assertSite(actor, siteId);
    const rows = await this.computeResponseResolutionRows([site._id], query);
    return {
      mode: 'site',
      siteId: site._id.toString(),
      overall: statsOf(rows),
      byAgent: await this.groupByAgent(rows),
    };
  }

  async getResponseTimesCombined(
    actor: AuthenticatedUser,
    query: DateRangeQueryDto,
  ): Promise<ResponseTimesResult> {
    const siteIds = await this.orgSiteIds(actor);
    const rows = await this.computeResponseResolutionRows(siteIds, query);

    const bySiteMap = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.siteId.toString();
      const list = bySiteMap.get(key) ?? [];
      list.push(row);
      bySiteMap.set(key, list);
    }
    const bySite: SiteResponseResolutionStats[] = [...bySiteMap.entries()].map(
      ([id, siteRows]) => ({ siteId: id, ...statsOf(siteRows) }),
    );

    return {
      mode: 'organization',
      siteId: null,
      overall: statsOf(rows),
      byAgent: await this.groupByAgent(rows),
      bySite,
    };
  }

  /**
   * Per-conversation first-response/resolution seconds, one row per
   * Conversation in scope. `$lookup`s each Conversation's first `agent`
   * Message for "first response"; `resolutionSeconds` is only populated for
   * a `closed` Conversation (`closedAt - startedAt`). Fetched as a flat
   * array (Phase 1's data volumes — 4 Sites, 16 Agents — are small enough
   * that grouping/median calculation in application code, rather than a
   * Mongo-version-dependent `$median`/`$percentile` accumulator, is both
   * simpler and more portable — see PROGRESS.md).
   */
  private async computeResponseResolutionRows(
    siteIds: Types.ObjectId[],
    query: DateRangeQueryDto,
  ): Promise<
    {
      agentId: string | null;
      siteId: Types.ObjectId;
      firstResponseSeconds: number | null;
      resolutionSeconds: number | null;
    }[]
  > {
    const match: FilterQuery<ConversationDocument> = {
      siteId: { $in: siteIds },
    };
    this.applyDateRange(match, 'startedAt', query.dateFrom, query.dateTo);

    const rows = await this.conversationModel
      .aggregate<{
        _id: Types.ObjectId;
        siteId: Types.ObjectId;
        assignedAgentId: Types.ObjectId | null;
        startedAt: Date;
        closedAt: Date | null;
        firstAgentMessageAt: Date | null;
      }>([
        { $match: match },
        {
          $lookup: {
            from: 'messages',
            let: { convId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$conversationId', '$$convId'] },
                      { $eq: ['$senderType', 'agent'] },
                    ],
                  },
                },
              },
              { $sort: { sentAt: 1 } },
              { $limit: 1 },
              { $project: { sentAt: 1 } },
            ],
            as: 'firstAgentMessage',
          },
        },
        {
          $project: {
            siteId: 1,
            assignedAgentId: 1,
            startedAt: 1,
            closedAt: 1,
            firstAgentMessageAt: {
              $arrayElemAt: ['$firstAgentMessage.sentAt', 0],
            },
          },
        },
      ])
      .exec();

    return rows.map((r) => ({
      agentId: r.assignedAgentId ? r.assignedAgentId.toString() : null,
      siteId: r.siteId,
      firstResponseSeconds: r.firstAgentMessageAt
        ? (r.firstAgentMessageAt.getTime() - r.startedAt.getTime()) / 1000
        : null,
      resolutionSeconds: r.closedAt
        ? (r.closedAt.getTime() - r.startedAt.getTime()) / 1000
        : null,
    }));
  }

  private async groupByAgent(
    rows: {
      agentId: string | null;
      firstResponseSeconds: number | null;
      resolutionSeconds: number | null;
    }[],
  ): Promise<AgentResponseResolutionStats[]> {
    const byAgent = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.agentId) continue; // unassigned — excluded from per-Agent stats
      const list = byAgent.get(row.agentId) ?? [];
      list.push(row);
      byAgent.set(row.agentId, list);
    }

    const agentIds = [...byAgent.keys()];
    const names = await this.agentNames(agentIds);

    return agentIds.map((agentId) => ({
      agentId,
      agentName: names.get(agentId) ?? null,
      ...statsOf(byAgent.get(agentId)!),
    }));
  }

  // -----------------------------------------------------------------------
  // FR-RPT-04 — Agent activity: conversations handled, messages sent,
  // average handle time (reuses the resolution-time computation above),
  // online time (not tracked — see AgentActivityRow's doc comment).
  // -----------------------------------------------------------------------
  async getAgentActivity(
    actor: AuthenticatedUser,
    siteId: string,
    query: DateRangeQueryDto,
  ): Promise<AgentActivityResult> {
    const site = await this.assertSite(actor, siteId);
    const agents = await this.computeAgentActivity([site._id], query);
    return { mode: 'site', siteId: site._id.toString(), agents };
  }

  async getAgentActivityCombined(
    actor: AuthenticatedUser,
    query: DateRangeQueryDto,
  ): Promise<AgentActivityResult> {
    const siteIds = await this.orgSiteIds(actor);
    const agents = await this.computeAgentActivity(siteIds, query);
    return { mode: 'organization', siteId: null, agents };
  }

  private async computeAgentActivity(
    siteIds: Types.ObjectId[],
    query: DateRangeQueryDto,
  ): Promise<AgentActivityRow[]> {
    const conversationRows = await this.computeResponseResolutionRows(
      siteIds,
      query,
    );

    const conversationsHandled = new Map<string, number>();
    const handleTimesByAgent = new Map<string, number[]>();
    for (const row of conversationRows) {
      if (!row.agentId) continue;
      conversationsHandled.set(
        row.agentId,
        (conversationsHandled.get(row.agentId) ?? 0) + 1,
      );
      if (row.resolutionSeconds !== null) {
        const list = handleTimesByAgent.get(row.agentId) ?? [];
        list.push(row.resolutionSeconds);
        handleTimesByAgent.set(row.agentId, list);
      }
    }

    // Messages sent — matched against every Conversation on these Sites
    // (not just ones started within the date range, since a long-running
    // Conversation can receive messages well after it started), then
    // separately date-filtered on the Message's own `sentAt`.
    const conversationIdsOnSites = await this.conversationModel
      .find({ siteId: { $in: siteIds } })
      .select('_id')
      .lean()
      .exec();
    const messageMatch: FilterQuery<MessageDocument> = {
      conversationId: { $in: conversationIdsOnSites.map((c) => c._id) },
      senderType: 'agent',
      senderId: { $ne: null },
    };
    this.applyDateRange(messageMatch, 'sentAt', query.dateFrom, query.dateTo);
    const messageRows = await this.messageModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: messageMatch },
        { $group: { _id: '$senderId', count: { $sum: 1 } } },
      ])
      .exec();
    const messagesSentByAgent = new Map(
      messageRows.map((r) => [r._id.toString(), r.count]),
    );

    const agentIds = new Set<string>([
      ...conversationsHandled.keys(),
      ...messagesSentByAgent.keys(),
    ]);
    const names = await this.agentNames([...agentIds]);

    return [...agentIds].map((agentId) => ({
      agentId,
      agentName: names.get(agentId) ?? null,
      conversationsHandled: conversationsHandled.get(agentId) ?? 0,
      messagesSent: messagesSentByAgent.get(agentId) ?? 0,
      avgHandleTimeSeconds: average(handleTimesByAgent.get(agentId) ?? []),
      onlineTimeSeconds: null,
    }));
  }

  // -----------------------------------------------------------------------
  // FR-RPT-05 — Lead counts + status breakdown.
  // -----------------------------------------------------------------------
  async getLeadStats(
    actor: AuthenticatedUser,
    siteId: string,
    query: DateRangeQueryDto,
  ): Promise<LeadStatsResult> {
    const site = await this.assertSite(actor, siteId);
    const { total, byStatus } = await this.computeLeadStats([site._id], query);
    return { mode: 'site', siteId: site._id.toString(), total, byStatus };
  }

  async getLeadStatsCombined(
    actor: AuthenticatedUser,
    query: DateRangeQueryDto,
  ): Promise<LeadStatsResult> {
    const siteIds = await this.orgSiteIds(actor);
    const { total, byStatus } = await this.computeLeadStats(siteIds, query);
    const bySite = await Promise.all(
      siteIds.map(async (id) => {
        const stats = await this.computeLeadStats([id], query);
        return { siteId: id.toString(), ...stats };
      }),
    );
    return { mode: 'organization', siteId: null, total, byStatus, bySite };
  }

  private async computeLeadStats(
    siteIds: Types.ObjectId[],
    query: DateRangeQueryDto,
  ): Promise<{ total: number; byStatus: Record<LeadStatus, number> }> {
    const match: FilterQuery<LeadDocument> = { siteId: { $in: siteIds } };
    this.applyDateRange(match, 'createdAt', query.dateFrom, query.dateTo);

    const rows = await this.leadModel
      .aggregate<{ _id: LeadStatus; count: number }>([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const byStatus = Object.fromEntries(
      LEAD_STATUSES.map((s) => [s, 0]),
    ) as Record<LeadStatus, number>;
    let total = 0;
    for (const row of rows) {
      byStatus[row._id] = row.count;
      total += row.count;
    }
    return { total, byStatus };
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------
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

  /** Every Site id in the caller's Organization — the combined (FR-RPT-06) view's scope. */
  private async orgSiteIds(
    actor: AuthenticatedUser,
  ): Promise<Types.ObjectId[]> {
    const sites = await this.siteModel
      .find({ organizationId: actor.organizationId })
      .select('_id')
      .lean()
      .exec();
    return sites.map((s) => s._id);
  }

  private async agentNames(agentIds: string[]): Promise<Map<string, string>> {
    if (agentIds.length === 0) return new Map();
    const users = await this.userModel
      .find({ _id: { $in: agentIds.map((id) => new Types.ObjectId(id)) } })
      .select('displayName')
      .lean()
      .exec();
    return new Map(users.map((u) => [u._id.toString(), u.displayName]));
  }

  private applyDateRange(
    match: Record<string, unknown>,
    field: string,
    dateFrom?: string,
    dateTo?: string,
  ): void {
    if (!dateFrom && !dateTo) return;
    const range: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = this.endOfDayIfBareDate(dateTo);
    match[field] = range;
  }

  /**
   * A bare `YYYY-MM-DD` (what every `<input type="date">` in the frontend
   * sends) parses as UTC midnight — used as-is for an inclusive UPPER bound,
   * that would silently exclude the entire day it names (only matching
   * events at exactly midnight). Bumped to the last instant of that day so
   * "To: 2026-08-19" really does include everything on the 19th. A
   * caller-supplied datetime with an explicit time component (already more
   * precise than a bare date) is left untouched.
   */
  private endOfDayIfBareDate(dateTo: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      const d = new Date(dateTo);
      d.setUTCHours(23, 59, 59, 999);
      return d;
    }
    return new Date(dateTo);
  }
}
