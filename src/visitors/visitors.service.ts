import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  PageVisit,
  PageVisitDocument,
  Site,
  SiteDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { LeadsService } from '../leads/leads.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { VisitorPresenceService } from '../realtime/visitor-presence.service';
import { UpdateVisitorDto } from './dto/update-visitor.dto';

export interface LiveVisitor {
  visitorId: string;
  name: string | null;
  email: string | null;
  currentPage: string | null;
  pageCategory: string | null;
  enteredCurrentPageAt: string | null;
  location: {
    city: string | null;
    region: string | null;
    country: string | null;
  };
  browser: string | null;
  deviceType: string | null;
  referrer: string | null;
  landingPage: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  pastVisitsCount: number;
  pastChatsCount: number;
  activeConversationId: string | null;
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
    private readonly auditLogService: AuditLogService,
    private readonly leadsService: LeadsService,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly visitorPresenceService: VisitorPresenceService,
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

    const onlineIds = this.visitorPresenceService.getOnlineVisitorIds(
      site._id.toString(),
    );
    if (onlineIds.length === 0) return [];

    const objectIds = onlineIds.map((id) => new Types.ObjectId(id));

    const [visitors, openPageVisits, activeConversations] = await Promise.all([
      this.visitorModel
        .find({ _id: { $in: objectIds }, siteId: site._id, isBanned: false })
        .lean()
        .exec(),
      this.pageVisitModel
        .find({ visitorId: { $in: objectIds }, exitedAt: null })
        .lean()
        .exec(),
      this.conversationModel
        .find({
          visitorId: { $in: objectIds },
          siteId: site._id,
          status: { $ne: 'closed' },
        })
        .sort({ startedAt: -1 })
        .select('_id visitorId')
        .lean()
        .exec(),
    ]);

    const pageByVisitor = new Map(
      openPageVisits.map((pv) => [pv.visitorId.toString(), pv]),
    );
    // sort() above puts the most recent first; only the first match per
    // visitorId (Map.set on a repeat key is a no-op-equivalent overwrite,
    // so iterate in order and only set if absent) should win.
    const conversationByVisitor = new Map<string, Types.ObjectId>();
    for (const conv of activeConversations) {
      const key = conv.visitorId.toString();
      if (!conversationByVisitor.has(key)) {
        conversationByVisitor.set(key, conv._id);
      }
    }

    return visitors.map((v) => {
      const page = pageByVisitor.get(v._id.toString());
      const activeConversationId = conversationByVisitor.get(v._id.toString());
      return {
        visitorId: v._id.toString(),
        name: v.name ?? null,
        email: v.email ?? null,
        currentPage: page?.pageUrl ?? null,
        pageCategory: page?.pageCategory ?? null,
        enteredCurrentPageAt: page?.enteredAt
          ? page.enteredAt.toISOString()
          : null,
        location: {
          city: v.location?.city ?? null,
          region: v.location?.region ?? null,
          country: v.location?.country ?? null,
        },
        browser: v.browser ?? null,
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
      };
    });
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
   * FR-VIS-07: Ban a Visitor by id, and also block by IP — the Visitor's
   * `currentIp` (or an explicit override, e.g. from server logs) is added
   * to the Site's `bannedIps` list so the ban survives the Visitor clearing
   * cookies/localStorage and coming back as an anonymous new session
   * (enforced in VisitorSessionService.init).
   */
  async ban(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    ipOverride?: string,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    visitor.isBanned = true;
    await visitor.save();

    const ipToBan = ipOverride ?? visitor.currentIp;
    if (ipToBan && !site.bannedIps.includes(ipToBan)) {
      site.bannedIps.push(ipToBan);
      await site.save();
    }

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'visitor.banned',
      siteId: site._id,
      targetType: 'Visitor',
      targetId: visitor._id,
      metadata: { ip: ipToBan ?? null },
    });

    await this.emitProfileUpdated(visitor);

    return visitor;
  }

  /** Not asked for by the SRS, but trivial and useful for reversing a mistaken ban / test cleanup — gated by the same `visitors.ban` permission. */
  async unban(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
  ): Promise<VisitorDocument> {
    const site = await this.assertSite(actor, siteId);
    const visitor = await this.findVisitorOnSite(site, visitorId);

    visitor.isBanned = false;
    await visitor.save();

    if (visitor.currentIp && site.bannedIps.includes(visitor.currentIp)) {
      site.bannedIps = site.bannedIps.filter((ip) => ip !== visitor.currentIp);
      await site.save();
    }

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
