import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  ConversationStatus,
  Department,
  DepartmentDocument,
  Message,
  MessageDocument,
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
import { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';
import { AnalyticsEventsService } from '../analytics/analytics-events.service';
import { PermissionsService } from '../rbac/permissions.service';
import { LeadsService } from '../leads/leads.service';
import { PresenceService } from '../realtime/presence.service';
import { isWithinBusinessHours } from '../sites/business-hours.util';
import type { ConversationSubmissionChannel } from '../database/schemas';
import {
  RealtimeEventsService,
  type RealtimeMessagePayload,
} from '../realtime/realtime-events.service';
import { VisitorPresenceService } from '../realtime/visitor-presence.service';
import {
  isImageMimeType,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../storage/attachment-validation';
import type {
  AttachmentRefInput,
  AttachmentWire,
} from '../storage/attachment.types';
import { StorageService } from '../storage/storage.service';
import { ReferenceNumberService } from './reference-number.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.query.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { GetMessagesSinceQueryDto } from './dto/get-messages-since.query.dto';
import { CONVERSATION_VIEW_PERMISSIONS } from './conversations.constants';
import {
  computeVisitorPathLowerBound,
  groupIntoVisits,
  VISIT_HISTORY_LOOKBACK,
} from './current-visit.util';

/** Session P2-5 redesign — a Conversation's own "Visitor path" is now
 * conversation-adjacency-bounded (see `computeConversationPath`'s doc
 * comment), not just a list of pages: it also carries the attribution
 * label ("Direct traffic" / referring domain / UTM source) for however the
 * Visitor actually landed on THIS specific visit, not just their latest
 * ever landing (`Visitor.visitorPath`).
 *
 * `pages` is plain (lean) objects, not hydrated `PageVisitDocument`s —
 * `computeConversationPath` may need to hand back a PATCHED copy of the
 * trailing entry (see its own doc comment on the frozen-Conversation
 * duration-capping fix) without ever writing that synthetic value back to
 * the database, which a hydrated Mongoose document's own `.save()`-shaped
 * identity makes easy to do by accident. */
export interface ConversationPathPage {
  _id: Types.ObjectId;
  pageUrl: string;
  pageCategory: string | null;
  enteredAt: Date;
  exitedAt: Date | null;
  durationSeconds: number | null;
  visitorPathLabel: string | null;
}

export interface ConversationPathResult {
  pages: ConversationPathPage[];
  attributionLabel: string;
}

export interface ConversationListResult {
  items: ConversationDocument[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Phase 2, FR-P2-GRP-01–03 — the shape `findAll`/`findAllCombined` return
 * instead of `ConversationListResult` when the caller searched by visitor
 * name/email (`query.search`): one entry per matched Visitor, each carrying
 * ALL of that Visitor's matching Conversations (most-recent-first), so the
 * frontend never has to re-derive grouping from a flat list (FR-P2-GRP-03's
 * explicit wording). `grouped: true` is a discriminant literal — present
 * only on this shape, absent on `ConversationListResult` — so a caller can
 * branch on `'groups' in result` without guessing from field shape alone.
 * `total`/`page`/`limit` here paginate GROUPS (Visitors), not individual
 * Conversations — see `findAllGroupedByVisitor`'s doc comment for why.
 */
export interface ConversationVisitorGroup {
  visitor: { id: string; name: string | null; email: string | null };
  conversations: ConversationDocument[];
}

export interface GroupedConversationListResult {
  grouped: true;
  groups: ConversationVisitorGroup[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Phase 2, FR-P2-SITE-01–04 — `findAllCombined`'s result also names exactly
 * which Sites were queried (server-resolved, per `getAuthorizedSites`) so a
 * caller/tester can confirm the merged set is exactly the caller's
 * authorized Sites, never more, never fewer.
 */
export interface CombinedConversationListResult extends ConversationListResult {
  siteIds: string[];
}

/** Combined-mode counterpart to `GroupedConversationListResult` — see above. */
export interface CombinedGroupedConversationListResult extends GroupedConversationListResult {
  siteIds: string[];
}

/** A Message document, JSON-shaped, with `attachments` replaced by freshly-signed wire entries (FR-P2-ATT-08) — see `ConversationsService.toMessageWire`. */
export type MessageWire = Record<string, unknown>;

export interface ConversationWithTranscript {
  conversation: ConversationDocument;
  messages: MessageWire[];
  /**
   * This session's addition (task requirement 14) — is the Visitor's
   * widget socket currently connected at all? Only populated by
   * `findOne`/the WS `agent:join_conversation` handler (the two places an
   * Agent actually needs to decide whether to show a "widget closed / Send
   * anyway" affordance) — omitted elsewhere rather than always computed.
   */
  visitorOnline?: boolean;
}

/**
 * ConversationsService — FR-CONV-01–07, FR-AGT-06/07/09/10/11, FR-WID-13.
 *
 * The view-scope split (`conversations.view_own` vs `conversations.view_site`)
 * is deliberately NOT expressed as two different `@RequirePermission` keys
 * on two different routes — `PermissionGuard` (extended this session to
 * accept an ANY-of array) only gates "does the caller hold at least one of
 * these," yes/no. This service is where the actual scope decision happens,
 * per the task's own instruction ("not just yes/no access") — every
 * read/mutation below re-derives the caller's own view_site vs view_own
 * standing via `PermissionsService` and narrows the query/target
 * accordingly, so a `view_own`-only Agent can never see or touch a
 * Conversation that isn't assigned to them, even if they also separately
 * hold e.g. `conversations.close`.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(PageVisit.name)
    private readonly pageVisitModel: Model<PageVisitDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLog: AuditLogService,
    private readonly referenceNumberService: ReferenceNumberService,
    private readonly leadsService: LeadsService,
    private readonly presenceService: PresenceService,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly visitorPresenceService: VisitorPresenceService,
    private readonly analyticsEvents: AnalyticsEventsService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------
  // Create (FR-CONV-01, FR-RTE-01) — visitor-facing, see CreateConversationDto.
  // ---------------------------------------------------------------------
  async create(
    visitor: AuthenticatedVisitor,
    siteId: string,
    dto: CreateConversationDto,
  ): Promise<ConversationDocument> {
    if (visitor.siteId !== siteId) {
      throw new ForbiddenException(
        'This visitor session token was not issued for this Site.',
      );
    }

    const site = await this.siteModel.findById(siteId).exec();
    if (!site) {
      throw new NotFoundException('Unknown siteId.');
    }

    const visitorDoc = await this.visitorModel
      .findOne({ _id: visitor.visitorId, siteId: site._id })
      .exec();
    if (!visitorDoc) {
      throw new NotFoundException('Visitor not found on this Site.');
    }
    if (visitorDoc.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from starting new chats on this Site.',
      );
    }

    // Department resolution order (Session Feature-2c-complex-actions —
    // "confirm FR-RTE-01's auto-routing respects a Trigger-assigned
    // Department"):
    //   1. An explicit `dto.departmentId` — the WIDGET's own client-side
    //      `setDepartment` trigger action, one-conversation-only (see
    //      trigger.schema.ts's TRIGGER_ACTION_TYPES comment) — still wins
    //      when given, exactly as before this session. An explicit id that
    //      doesn't resolve is still a 400, not a silent fallback.
    //   2. Else the persistent, server-set `Visitor.department` — the
    //      "Set visitor department" action (Feature-2b-schema's field) —
    //      so a Trigger-assigned Department actually reaches routing.
    //   3. Else the Site's oldest Department, same default as before.
    let department: DepartmentDocument | null = null;
    if (dto.departmentId) {
      department = await this.departmentModel
        .findOne({ _id: dto.departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
    } else if (visitorDoc.department) {
      department = await this.departmentModel
        .findOne({ _id: visitorDoc.department, siteId: site._id })
        .exec();
    }
    if (!department) {
      department = await this.departmentModel
        .findOne({ siteId: site._id })
        .sort({ createdAt: 1 })
        .exec();
    }
    if (!department) {
      throw new BadRequestException(
        'This Site has no Department to route the Conversation to.',
      );
    }

    const referenceNumber = await this.referenceNumberService.next();

    // FR-RTE-01/02: route to an available (Online) Agent in this Department
    // holding a view permission on this Site, or leave unassigned/pending if
    // none is available — see pickAgentForRouting()'s doc comment for the
    // strategy chosen.
    const assignedAgentId = await this.pickAgentForRouting(
      site._id,
      department._id,
    );

    const submissionChannel = await this.computeSubmissionChannel(site);

    const conversation = await this.conversationModel.create({
      siteId: site._id,
      departmentId: department._id,
      visitorId: visitorDoc._id,
      assignedAgentId,
      submissionChannel,
      status: assignedAgentId ? 'open' : 'pending',
      startedAt: new Date(),
      referenceNumber,
      tags: dto.tags ?? [],
      // Agent-lock-fix — see the field's own doc comment
      // (database/schemas/conversation.schema.ts): only the "nobody was
      // available to auto-route to" branch ever actually goes through
      // FR-RTE-02's whole-Department queue.
      deptQueueVisible: !assignedAgentId,
    });

    if (dto.customFields !== undefined) {
      visitorDoc.customFields = {
        ...visitorDoc.customFields,
        ...dto.customFields,
      };
    }

    if (dto.initialMessage) {
      await this.messageModel.create({
        conversationId: conversation._id,
        senderType: 'visitor',
        senderId: null,
        body: dto.initialMessage,
        sentAt: new Date(),
      });
    }

    // FR-VIS-05: increment the Visitor's pastChatsCount — stubbed at 0 since
    // Session 6 (no Conversation existed to count yet); this is the wiring
    // Session 6's PROGRESS.md entry explicitly deferred to this session.
    visitorDoc.pastChatsCount += 1;
    await visitorDoc.save();

    // FR-VIS-08's Lead tracking: if this Visitor now qualifies (or already
    // did), make sure the Lead exists and record this Conversation against
    // it — per Session 6's note ("push the new Conversation's id onto the
    // Visitor's Lead's conversationIds ... if the Visitor qualifies").
    const lead = await this.leadsService.syncLeadForVisitor(visitorDoc);
    if (
      lead &&
      !lead.conversationIds.some((id) => id.equals(conversation._id))
    ) {
      lead.conversationIds.push(conversation._id);
      await lead.save();
    }

    // FR-RPT-01 (this session) — "chat-started event when a Conversation is
    // created," exactly per the task's own wording.
    await this.analyticsEvents.record({
      siteId: site._id,
      type: 'chatStarted',
      visitorId: visitorDoc._id,
    });

    await this.auditLog.record({
      actorType: 'visitor',
      actorId: visitorDoc._id,
      action: 'conversation.created',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: {
        referenceNumber,
        departmentId: department._id.toString(),
        assignedAgentId: assignedAgentId?.toString() ?? null,
      },
    });
    if (assignedAgentId) {
      await this.auditLog.record({
        actorType: 'system',
        action: 'conversation.auto_assigned',
        siteId: site._id,
        targetType: 'Conversation',
        targetId: conversation._id,
        metadata: {
          agentId: assignedAgentId.toString(),
          strategy: 'least-active-conversations',
        },
      });
    }

    this.realtimeEvents.emit({
      kind: 'conversation.created',
      siteId: site._id.toString(),
      departmentId: department._id.toString(),
      conversationId: conversation._id.toString(),
      referenceNumber,
      status: conversation.status,
      assignedAgentId: assignedAgentId ? assignedAgentId.toString() : null,
      visitorId: visitorDoc._id.toString(),
      initialMessage: dto.initialMessage,
      departmentQueueMemberIds: assignedAgentId
        ? undefined
        : await this.getDepartmentQueueMemberIds(department._id, site._id),
    });

    return conversation;
  }

  /**
   * FR-RTE-01 auto-routing. Strategy chosen: **least-active-conversations**
   * (over round-robin) — see PROGRESS.md ("Session 8") for the reasoning:
   * it needs no persisted "who's next" cursor (stateless, simpler to reason
   * about and to run concurrently) and naturally balances load across a
   * Department's Agents. Candidates are: `enabled`, in this Conversation's
   * Department, currently marked Online (in-memory `PresenceService` —
   * "available" per FR-RTE-01 means actually connected right now, not just
   * a DB flag), and holding `conversations.view_own` OR
   * `conversations.view_site` on this Site (the same permission pair
   * `PermissionGuard`/`ConversationsController` gate reads with — an Agent
   * who couldn't see the Conversation once assigned would be a broken
   * assignment). Returns `null` (unassigned/pending, FR-RTE-02) if no
   * candidate qualifies.
   *
   * Chat Limit (Personal Settings → Profile, this session): a candidate
   * whose own `User.chatLimit` is set (non-null) and whose current
   * open+pending count has already reached it is skipped in favor of
   * another eligible candidate — same least-active loop below, just
   * excluding at-limit Agents from `best` consideration. `chatLimit: null`
   * (the default/"not set" state) means no limit, unchanged from before
   * this field existed — never treated as a limit of zero. If every
   * eligible Agent is at their limit, falls through to the existing
   * FR-RTE-02 "leave unassigned/pending" behavior, same as the
   * no-eligible-candidates case.
   */
  /**
   * Tickets screen — real, persisted "online vs offline" signal for a
   * newly-created Conversation, computed once at creation time using the
   * exact same definition WidgetBootstrapService.getStatus already uses for
   * the widget's own "We're online" indicator (FR-WID-09/FR-HRS-01):
   * within Business Hours (or Business Hours isn't enabled at all) AND at
   * least one enabled User who belongs to this Site is currently connected.
   * Site-wide, no Department/permission filtering — deliberately broader
   * than pickAgentForRouting()'s own eligibility check, which answers "who
   * can this Conversation be routed to," not "is this Site generally
   * staffed right now."
   */
  private async computeSubmissionChannel(
    site: SiteDocument,
  ): Promise<ConversationSubmissionChannel> {
    if (!isWithinBusinessHours(site.businessHoursConfig)) return 'offline';

    const enabledUsers = await this.userModel
      .find({ enabled: true })
      .select('_id')
      .lean()
      .exec();
    for (const u of enabledUsers) {
      const idStr = u._id.toString();
      if (!this.presenceService.isOnline(idStr)) continue;
      if (await this.permissionsService.isUserOnSite(idStr, site._id)) {
        return 'online';
      }
    }
    return 'offline';
  }

  private async pickAgentForRouting(
    siteId: Types.ObjectId,
    departmentId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    const candidates = await this.userModel
      .find({ departmentId, enabled: true })
      .select('_id chatLimit')
      .lean()
      .exec();
    const chatLimitById = new Map<string, number | null>(
      candidates.map((c) => [c._id.toString(), c.chatLimit ?? null]),
    );

    const onlineCandidateIds = candidates
      .map((c) => c._id.toString())
      .filter((id) => this.presenceService.isOnline(id));
    if (onlineCandidateIds.length === 0) return null;

    const eligible: string[] = [];
    for (const id of onlineCandidateIds) {
      const [viewSite, viewOwn] = await Promise.all([
        this.permissionsService.hasPermission(
          id,
          'conversations.view_site',
          siteId,
        ),
        this.permissionsService.hasPermission(
          id,
          'conversations.view_own',
          siteId,
        ),
      ]);
      if (viewSite || viewOwn) eligible.push(id);
    }
    if (eligible.length === 0) return null;

    let best: { id: string; count: number } | null = null;
    for (const id of eligible) {
      const count = await this.conversationModel
        .countDocuments({
          assignedAgentId: new Types.ObjectId(id),
          status: { $in: ['open', 'pending'] },
        })
        .exec();
      const chatLimit = chatLimitById.get(id) ?? null;
      if (chatLimit !== null && count >= chatLimit) continue; // at their own Chat Limit — skip in favor of another eligible Agent
      // Ties keep the first (stable, iteration-order) candidate — simple
      // over clever, per the task's own "keep the routing strategy simple"
      // guardrail.
      if (!best || count < best.count) {
        best = { id, count };
      }
    }
    return best ? new Types.ObjectId(best.id) : null;
  }

  /**
   * Agent-lock-fix — every `enabled` User in `departmentId` who holds
   * `conversations.view_own` but NOT `conversations.view_site` on this Site
   * (a `view_site` holder already gets everything via `siteRoom` — see
   * `siteAlertRoom`'s doc comment in `realtime.types.ts`, so listing them
   * here too would just be a harmless-but-pointless duplicate emit). Online
   * status is deliberately NOT filtered here (unlike `pickAgentForRouting`'s
   * routing candidates) — this only feeds a WebSocket push to each id's own
   * `agentRoom`, which is simply empty for anyone not currently connected.
   */
  private async getDepartmentQueueMemberIds(
    departmentId: Types.ObjectId,
    siteId: Types.ObjectId,
  ): Promise<string[]> {
    const candidates = await this.userModel
      .find({ departmentId, enabled: true })
      .select('_id')
      .lean()
      .exec();

    const memberIds: string[] = [];
    for (const candidate of candidates) {
      const id = candidate._id.toString();
      const [viewSite, viewOwn] = await Promise.all([
        this.permissionsService.hasPermission(
          id,
          'conversations.view_site',
          siteId,
        ),
        this.permissionsService.hasPermission(
          id,
          'conversations.view_own',
          siteId,
        ),
      ]);
      if (viewOwn && !viewSite) memberIds.push(id);
    }
    return memberIds;
  }

  // ---------------------------------------------------------------------
  // List (FR-AGT-09, FR-CONV-03/06) — Agent/Admin-facing.
  // ---------------------------------------------------------------------
  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
    query: ListConversationsQueryDto,
  ): Promise<ConversationListResult | GroupedConversationListResult> {
    const site = await this.assertSite(actor, siteId);
    const scope = await this.resolveScope(actor, site._id);

    const filter: FilterQuery<ConversationDocument> = { siteId: site._id };

    if (!scope.canViewSite) {
      // conversations.view_own only — hard-pinned to Conversations assigned
      // to the caller, regardless of any ?agentId= passed... PLUS
      // (Agent-lock-fix) any Conversation this caller's own Department was
      // ever handed via FR-RTE-02's whole-Department queue
      // (`deptQueueVisible`), whether it's still unassigned or has since
      // been claimed by a colleague — same "everyone in the queue keeps
      // watching it get handled" visibility this fix's `assertVisible`
      // grants for a single GET. Never widened by ?agentId=, same as the
      // plain assignedAgentId branch it replaces.
      const departmentId = await this.getActorDepartmentId(actor.userId);
      filter.$or = [
        { assignedAgentId: new Types.ObjectId(actor.userId) },
        ...(departmentId ? [{ departmentId, deptQueueVisible: true }] : []),
      ];
    } else if (query.agentId) {
      filter.assignedAgentId = new Types.ObjectId(query.agentId);
    }

    // Phase 2, FR-P2-HIST-01 (Session P2-5) — "Past chats" drill-down.
    // Applied on top of (never in place of) the view_own/.view_site scoping
    // above, so a view_own-only Agent drilling into a Visitor's history
    // still only ever sees Conversations assigned to them — the same rule
    // that already governs every other read on this endpoint.
    if (query.visitorId) filter.visitorId = new Types.ObjectId(query.visitorId);

    if (query.status) filter.status = query.status;
    if (query.channel) filter.submissionChannel = query.channel;
    if (query.tag) filter.tags = query.tag;
    if (query.rating !== undefined) filter.ratingScore = query.rating;

    const startedAtRange: { $gte?: Date; $lte?: Date; $lt?: Date } = {};
    if (query.dateFrom) startedAtRange.$gte = new Date(query.dateFrom);
    if (query.dateTo) startedAtRange.$lte = new Date(query.dateTo);

    // Session P2-5 redesign (direct user feedback) — "Past chats" is
    // relative to whichever Conversation the agent is currently looking at.
    // Resolved server-side from the referenced Conversation's own record
    // (never a client-supplied timestamp) — same posture every other
    // server-resolved boundary in this codebase takes. A bad/foreign id is
    // silently ignored (falls back to no bound) rather than erroring — this
    // filter is additive UI sugar, not a security boundary.
    //
    // Fix (direct user feedback, live QA screenshot: "Past visits: 0, Past
    // chats: 1" for a Visitor with only 2 Conversations 8 minutes apart) —
    // this used to be a bare `startedAt < ref.startedAt`, which counts ANY
    // earlier Conversation as "past" even one that happened minutes ago in
    // the exact same, still-ongoing browsing session. Meanwhile "Past
    // visits" (`VisitorsService.findVisits`) already deliberately excludes
    // that same current visit session via `computeVisitorPathLowerBound` —
    // so the two badges disagreed on whether a same-session earlier chat
    // counts as "past" at all. Now uses the exact same boundary
    // `computeConversationPath`/`findVisits` compute for "which visit
    // session does this Conversation belong to" (reused, not re-derived):
    // only a Conversation that started strictly before THAT boundary — i.e.
    // genuinely in an earlier visit, not just an earlier message in this
    // one — counts as a past chat. This makes "Past chats" and "Past
    // visits" agree by construction.
    if (query.beforeConversationId) {
      const ref = await this.conversationModel
        .findOne({ _id: query.beforeConversationId, siteId: site._id })
        .select('startedAt visitorId')
        .lean()
        .exec();
      if (ref) {
        const [previousConversation, recentDesc] = await Promise.all([
          this.conversationModel
            .findOne({
              visitorId: ref.visitorId,
              startedAt: { $lt: ref.startedAt },
            })
            .sort({ startedAt: -1 })
            .select('startedAt')
            .lean()
            .exec(),
          this.pageVisitModel
            .find({ visitorId: ref.visitorId })
            .sort({ enteredAt: -1 })
            .limit(VISIT_HISTORY_LOOKBACK)
            .lean()
            .exec(),
        ]);
        const visitGroups = groupIntoVisits(recentDesc);
        const boundary = computeVisitorPathLowerBound(
          visitGroups,
          ref.startedAt,
          previousConversation?.startedAt ?? null,
        );
        startedAtRange.$lt = boundary;
      }
    }

    if (Object.keys(startedAtRange).length > 0) {
      filter.startedAt = startedAtRange;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Phase 2, FR-P2-GRP-01–03 (this session) — a name/email search groups
    // its results by Visitor rather than returning a flat list; every OTHER
    // filter combination (status/date range/tag/rating/agentId alone, with
    // no `search` term) is completely unaffected and keeps returning the
    // exact flat shape Session 10.2 built — `query.search` is the ONLY
    // thing that branches here.
    if (query.search) {
      const matchingVisitors = await this.findMatchingVisitorIds(
        { siteId: site._id },
        query.search,
      );
      if (matchingVisitors.length === 0) {
        return { grouped: true, groups: [], total: 0, page, limit };
      }
      filter.visitorId = { $in: matchingVisitors };
      return this.findAllGroupedByVisitor(filter, page, limit);
    }

    const [items, total] = await Promise.all([
      this.conversationModel
        .find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('visitorId', 'name email')
        .populate('assignedAgentId', 'displayName email')
        .exec(),
      this.conversationModel.countDocuments(filter).exec(),
    ]);

    return { items, total, page, limit };
  }

  // ---------------------------------------------------------------------
  // Combined/"All Sites" list (Phase 2, FR-P2-SITE-01–04) — Agent/Admin-
  // facing, same as findAll() above but merged across every Site the caller
  // is authorized on, resolved server-side (never from client input, per
  // this task's guardrail). Backs BOTH the Inbox's "All Sites" mode and the
  // History search's "All Sites" mode (same shared filter set — see
  // ListConversationsCombinedQueryDto's doc comment).
  // ---------------------------------------------------------------------
  async findAllCombined(
    actor: AuthenticatedUser,
    query: ListConversationsQueryDto,
  ): Promise<
    CombinedConversationListResult | CombinedGroupedConversationListResult
  > {
    // Server-side Site-set resolution (FR-P2-SITE-02) — the ONLY input this
    // ever uses is the caller's own effective permissions, via the same
    // PermissionsService/PermissionGuard already used everywhere else in
    // this codebase (guardrail: reuse, don't build a parallel path). By the
    // time this runs, PermissionGuard's `{ siteSource: 'any' }` check has
    // already proven this list is non-empty.
    const authorizedSites = await this.permissionsService.getAuthorizedSites(
      actor.userId,
      [...CONVERSATION_VIEW_PERMISSIONS],
    );

    const viewSiteIds: Types.ObjectId[] = [];
    const viewOwnOnlySiteIds: Types.ObjectId[] = [];
    for (const site of authorizedSites) {
      if (site.permissions.includes('conversations.view_site')) {
        viewSiteIds.push(new Types.ObjectId(site.siteId));
      } else {
        // Guaranteed to be conversations.view_own if it's not view_site —
        // getAuthorizedSites only ever returns a Site here because at least
        // one of the two keys matched.
        viewOwnOnlySiteIds.push(new Types.ObjectId(site.siteId));
      }
    }
    const allSiteIds = [...viewSiteIds, ...viewOwnOnlySiteIds];

    // Same per-Site scoping rule findAll()/assertVisible() apply to a
    // single Site, just expressed as an $or across every authorized Site at
    // once: a view_site Site contributes every Conversation on it
    // (optionally narrowed by ?agentId=); a view_own-only Site contributes
    // ONLY Conversations assigned to the caller, regardless of ?agentId=
    // (identical "hard-pinned, ignores ?agentId=" rule findAll() already
    // enforces for a single Site).
    const scopeConditions: FilterQuery<ConversationDocument>[] = [];
    if (viewSiteIds.length > 0) {
      const cond: FilterQuery<ConversationDocument> = {
        siteId: { $in: viewSiteIds },
      };
      if (query.agentId)
        cond.assignedAgentId = new Types.ObjectId(query.agentId);
      scopeConditions.push(cond);
    }
    if (viewOwnOnlySiteIds.length > 0) {
      scopeConditions.push({
        siteId: { $in: viewOwnOnlySiteIds },
        assignedAgentId: new Types.ObjectId(actor.userId),
      });
      // Agent-lock-fix — same Department-queue widening as findAll() above,
      // applied per-Site here since "All Sites" mode can span Departments
      // on different Sites; a caller with no departmentId at all
      // contributes nothing extra (getActorDepartmentId returns null, same
      // as before this fix).
      const departmentId = await this.getActorDepartmentId(actor.userId);
      if (departmentId) {
        scopeConditions.push({
          siteId: { $in: viewOwnOnlySiteIds },
          departmentId,
          deptQueueVisible: true,
        });
      }
    }

    const filter: FilterQuery<ConversationDocument> =
      scopeConditions.length === 1
        ? scopeConditions[0]
        : { $or: scopeConditions };

    if (query.status) filter.status = query.status;
    if (query.channel) filter.submissionChannel = query.channel;
    if (query.tag) filter.tags = query.tag;
    if (query.rating !== undefined) filter.ratingScore = query.rating;

    if (query.dateFrom || query.dateTo) {
      const startedAtRange: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) startedAtRange.$gte = new Date(query.dateFrom);
      if (query.dateTo) startedAtRange.$lte = new Date(query.dateTo);
      filter.startedAt = startedAtRange;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const siteIds = allSiteIds.map((id) => id.toString());

    // Phase 2, FR-P2-GRP-01–03 — identical branch to findAll() above: a
    // name/email search groups by Visitor across every authorized Site;
    // every other filter combination keeps the flat shape unchanged.
    if (query.search) {
      const matchingVisitors = await this.findMatchingVisitorIds(
        { siteId: { $in: allSiteIds } },
        query.search,
      );
      if (matchingVisitors.length === 0) {
        return { grouped: true, groups: [], total: 0, page, limit, siteIds };
      }
      filter.visitorId = { $in: matchingVisitors };
      const grouped = await this.findAllGroupedByVisitor(filter, page, limit);
      return { ...grouped, siteIds };
    }

    // Merged sort: most-recent activity across every authorized Site,
    // regardless of which Site an item belongs to — same `startedAt` field
    // (and direction) findAll() already sorts a single Site's list by, just
    // applied over the merged set so "All Sites" reads as one interleaved
    // timeline rather than Site-by-Site blocks. Each returned item still
    // carries its own `siteId` (Conversation's own field, always populated)
    // so the frontend can badge it (FR-P2-SITE-03) without any extra join.
    const [items, total] = await Promise.all([
      this.conversationModel
        .find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('visitorId', 'name email')
        .populate('assignedAgentId', 'displayName email')
        .exec(),
      this.conversationModel.countDocuments(filter).exec(),
    ]);

    return { items, total, page, limit, siteIds };
  }

  // ---------------------------------------------------------------------
  // Get one + transcript (FR-CONV-04, FR-AGT-10) — Agent/Admin-facing.
  // ---------------------------------------------------------------------
  async findOne(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationWithTranscript> {
    const site = await this.assertSite(actor, siteId);
    let conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    // Requirement 1 (agent-lock-fix) — a `conversations.view_own`-only
    // caller (never `view_site` — see the doc's own Section 1: "Do NOT
    // apply this trigger to a User whose access ... comes from
    // conversations.view_site (Supervisor/Manager/Owner)") opening a
    // Conversation that's still unassigned claims it right now, at the
    // earliest possible point — before they've even seen the transcript,
    // let alone typed anything. `assertVisible` above already proved they
    // reached this Conversation legitimately (either it's already theirs,
    // in which case this is a no-op, or FR-RTE-02's Department-queue
    // visibility just let them in).
    const scope = await this.resolveScope(actor, site._id);
    if (!scope.canViewSite && !conversation.assignedAgentId) {
      conversation = await this.autoClaimIfUnassigned(
        actor,
        site,
        conversation,
        'open',
      );
    }

    // Captured BEFORE populate() below replaces conversation.visitorId with
    // the full Visitor document — VisitorPresenceService is keyed by the
    // raw id string.
    const visitorId = conversation.visitorId.toString();

    await conversation.populate([
      { path: 'visitorId' },
      { path: 'assignedAgentId', select: 'displayName email' },
    ]);

    const messages = await this.messageModel
      .find({ conversationId: conversation._id })
      .sort({ sentAt: 1 })
      .exec();

    const visitorOnline = this.visitorPresenceService.isConnected(visitorId);
    const senderNames = await this.resolveSenderNames(messages);

    return {
      conversation,
      messages: this.toMessageWireList(messages, senderNames),
      visitorOnline,
    };
  }

  /**
   * This session's addition (task requirement 11's "(optionally) a short
   * recent page-history trail for that session") — same view scope as
   * every other Agent-facing Conversation read. Queried by the
   * Conversation's Visitor (not by `PageVisit.conversationId`, which is
   * only ever set on a page change that happens to occur once a
   * Conversation already exists — see PageVisitsService) so the trail
   * covers the Visitor's whole recent browsing, including pages visited
   * before the chat started, which is the more useful "context" view for
   * an Agent.
   */
  async getPageVisits(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    limit = 20,
  ): Promise<PageVisitDocument[]> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    return this.pageVisitModel
      .find({ visitorId: conversation.visitorId })
      .sort({ enteredAt: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Phase 2, FR-P2-PANEL-02/03 (Session P2-4) — the current visit's
   * PageVisit slice for a floating window's Visitor Info panel. Session
   * P2-5 redesign (direct user feedback, screenshots showing two different
   * Conversations for the same Visitor sharing an identical "Visitor path")
   * — thin wrapper over `computeConversationPath` now; see that method's
   * doc comment for the boundary rule. Kept as its own route/method (rather
   * than collapsing onto `getConversationVisitPageVisits` at the HTTP layer)
   * purely so the two existing frontend call sites don't both need to
   * change which URL they hit in the same pass — they now compute the
   * exact same thing.
   */
  async getCurrentVisitPageVisits(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationPathResult> {
    return this.getConversationVisitPageVisits(actor, siteId, conversationId);
  }

  /**
   * Session P2-5 redesign (direct user feedback, two rounds) — root cause of
   * the first report (two screenshots: a returning Visitor's separate
   * Conversations showing an identical "Visitor path"/"Past visits"): the
   * previous implementation bounded a Conversation's path by a pure
   * 30-minute PageVisit gap, so two real Conversations that happened only
   * minutes apart landed in the SAME gap-derived group and shared its
   * entire page list. The follow-up spec (a precise 4-visit walkthrough,
   * including a first visit with NO chat at all) then surfaced a second gap
   * in the first fix's own approach (bounding purely by adjacent
   * Conversations): a Visitor's first-ever chat-less VISIT would bleed its
   * pages into whichever LATER Conversation came next, since there was no
   * earlier Conversation to bound against at all.
   *
   * `computeVisitorPathLowerBound` (`current-visit.util.ts`) is the actual
   * fix — see its own doc comment for why it needs BOTH the previous
   * Conversation's `startedAt` AND the gap-derived visit-session boundary,
   * taking whichever is more recent. The upper bound is simpler: THIS
   * Conversation's own `startedAt` if a later Conversation already exists
   * (freezing this one's path at exactly what led into it — so the NEXT
   * Conversation's own lower bound, which is this Conversation's
   * `startedAt`, never overlaps with what this one already claims), or
   * "now" if this is still the Visitor's most recent Conversation (so a
   * LIVE Conversation's path keeps growing as the Visitor navigates,
   * exactly like the old `extractCurrentVisit`-based "current visit" did —
   * the two concepts are unified into one rule instead of two).
   *
   * Also returns `attributionLabel` — the "Direct traffic"/referring-domain/
   * UTM chip for THIS Conversation's own path specifically, sourced from
   * whichever PageVisit is chronologically earliest in the returned trail
   * (its own attribution snapshot — see PageVisit schema's doc comment),
   * falling back to the Visitor's current `visitorPath` field only when no
   * page in the trail carries a snapshot (pages written before this
   * session's schema change, or an empty trail).
   */
  async getConversationVisitPageVisits(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationPathResult> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const visitor = await this.visitorModel
      .findById(conversation.visitorId)
      .select('visitorPath')
      .lean()
      .exec();

    return this.computeConversationPath(
      conversation.visitorId,
      conversation.startedAt,
      visitor?.visitorPath ?? 'Direct traffic',
    );
  }

  /**
   * The shared boundary rule both public methods above now compute — see
   * `getConversationVisitPageVisits`'s doc comment for the reasoning.
   */
  private async computeConversationPath(
    visitorId: Types.ObjectId,
    conversationStartedAt: Date,
    fallbackAttributionLabel: string,
  ): Promise<ConversationPathResult> {
    const [previousConversation, hasNextConversation, recentDesc] =
      await Promise.all([
        this.conversationModel
          .findOne({ visitorId, startedAt: { $lt: conversationStartedAt } })
          .sort({ startedAt: -1 })
          .select('startedAt')
          .lean()
          .exec(),
        this.conversationModel.exists({
          visitorId,
          startedAt: { $gt: conversationStartedAt },
        }),
        this.pageVisitModel
          .find({ visitorId })
          .sort({ enteredAt: -1 })
          .limit(VISIT_HISTORY_LOOKBACK)
          .lean()
          .exec(),
      ]);

    const visitGroups = groupIntoVisits(recentDesc);
    const lowerBoundInclusive = computeVisitorPathLowerBound(
      visitGroups,
      conversationStartedAt,
      previousConversation?.startedAt ?? null,
    );

    // Upper bound is THIS Conversation's own `startedAt` — NOT the next
    // Conversation's — whenever a later Conversation already exists.
    // Bounding by the next Conversation's own start instead (an earlier,
    // buggier version of this method) would let this Conversation's path
    // silently absorb any pages the Visitor browsed AFTER this chat ended
    // but BEFORE the next one started — exactly the pages the NEXT
    // Conversation's own path (its own lowerBoundInclusive is this
    // Conversation's startedAt) is supposed to own, producing the very
    // "two Conversations sharing overlapping/duplicated path data" bug this
    // whole redesign exists to fix. Only when this IS the Visitor's most
    // recent Conversation (no later one yet) does the bound extend to "now"
    // — so a still-open chat's path keeps growing live as the Visitor
    // navigates during it (the same live behavior Session P2-4 built);
    // once a next Conversation exists, this one's own path is frozen at
    // exactly "what led into it."
    const upperBoundInclusive = hasNextConversation
      ? conversationStartedAt
      : new Date();

    const pages: ConversationPathPage[] = recentDesc.filter(
      (pv) =>
        pv.enteredAt.getTime() >= lowerBoundInclusive.getTime() &&
        pv.enteredAt.getTime() <= upperBoundInclusive.getTime(),
    );

    // Direct user feedback ("Time on site" reading hours for a frozen,
    // long-closed Conversation's own window) — `pages[0]` (most recent,
    // since `pages` is desc-sorted) is this Conversation's own trailing
    // page. In normal operation, once a LATER Conversation exists
    // (`hasNextConversation`), that trailing page should already have a
    // real `exitedAt`/`durationSeconds` — the Visitor's next real page
    // visit (however much later) closes it out (`PageVisitsService
    // .recordPageChange`, itself capped at `CURRENT_VISIT_GAP_MINUTES` as
    // of this same fix). But it can still show up `null` here for older
    // data written before that write-side cap existed. Rather than let the
    // frontend's `useTimeOnSite`/`VisitorPathTrail` treat a `null`
    // `exitedAt` as "still happening right now" (counting all the way to
    // the REAL current moment — the exact wrong, wildly-inflated number the
    // user's screenshots showed) for a Conversation that is definitely NOT
    // live, patch a plain-object COPY with `exitedAt`/`durationSeconds`
    // capped at this Conversation's own `upperBoundInclusive` — never
    // written back to the database (`recentDesc` is `.lean()`, a plain
    // object here, not a hydrated document with its own `.save()`).
    if (hasNextConversation && pages.length > 0 && pages[0].exitedAt == null) {
      const capped = pages[0];
      pages[0] = {
        ...capped,
        exitedAt: upperBoundInclusive,
        durationSeconds: Math.max(
          0,
          Math.round(
            (upperBoundInclusive.getTime() - capped.enteredAt.getTime()) / 1000,
          ),
        ),
      };
    }

    // `pages` is most-recent-first (same order `recentDesc` already has —
    // no re-sort needed); the chronologically EARLIEST page (last element)
    // is the one whose own attribution snapshot describes how the Visitor
    // actually landed on this particular visit.
    const earliest = pages[pages.length - 1];
    const attributionLabel =
      earliest?.visitorPathLabel ?? fallbackAttributionLabel;

    return { pages, attributionLabel };
  }

  // ---------------------------------------------------------------------
  // Status (FR-CONV-02, FR-AGT-07) — conversations.close.
  // ---------------------------------------------------------------------
  async updateStatus(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const before = conversation.status;
    conversation.status = status;
    conversation.closedAt = status === 'closed' ? new Date() : null;
    await conversation.save();

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.status_updated',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: { before, after: status },
    });

    this.realtimeEvents.emit({
      kind: 'conversation.updated',
      siteId: site._id.toString(),
      conversationId: conversation._id.toString(),
      changeType: 'status',
      data: { before, after: status },
    });

    return conversation;
  }

  // ---------------------------------------------------------------------
  // Assign (FR-AGT-06) — conversations.assign.
  // ---------------------------------------------------------------------
  async assign(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    agentId: string,
    // Fix for T-08 Finding #1 (files/reports/T-08-concurrency.md) — whatever
    // the CALLER's own view of the current holder is: `null` for a first
    // claim (Inbox "Claim" / "Assign to me" on an unassigned Conversation),
    // a specific Agent id for "Reassign…". This is the compare-and-swap's
    // expected-previous-value, not a new field the caller invents — see
    // AssignControl.tsx/Inbox.tsx, which both already know the currently-
    // displayed `assignedAgent` for exactly this reason and always pass it
    // (real UI paths are never `undefined` here — only a raw API caller
    // that doesn't opt in reaches the `undefined` branch below).
    //
    // `undefined` (the field genuinely omitted from the request body) is
    // deliberately NOT the same as `null` ("I believe this is
    // unassigned"): `undefined` means the caller isn't making any claim
    // about the current holder at all, so the write proceeds unconditionally
    // (still via the same single atomic findOneAndUpdate below — just
    // without the compare-guard) exactly like the pre-fix behavior, so
    // this doesn't silently reject callers who were never part of the
    // "Assign to me"/"Reassign…"/"Claim" race this fix targets.
    expectedCurrentAgentId?: string | null,
    // Agent-lock-fix — set by `autoClaimIfUnassigned` (below) for the two
    // SYSTEM-triggered claims this fix adds (opening or replying into a
    // still-unassigned Conversation). Every real caller (AssignControl.tsx/
    // Inbox.tsx's explicit "Assign to me"/"Reassign…"/"Claim") never passes
    // this — it only changes the audit-log action name/metadata so the two
    // kinds of claim stay distinguishable after the fact; the write itself
    // (the atomic compare-and-swap below) and the real-time broadcast are
    // byte-identical either way, per the guardrail to reuse this exact
    // mechanism rather than build a second one.
    autoClaimTrigger?: 'open' | 'reply',
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const agentOnSite = await this.permissionsService.isUserOnSite(
      agentId,
      site._id,
    );
    if (!agentOnSite) {
      throw new BadRequestException(
        'That Agent does not have access to this Site.',
      );
    }

    // Atomic compare-and-swap (T-08 Finding #1 fix) — the old code did a
    // plain read -> mutate-in-JS -> save(), so two near-simultaneous claims
    // on the same unassigned Conversation both returned 200, the second
    // silently overwriting the first with zero indication to either caller
    // that a race occurred (confirmed live, TC-08.4). The write is now a
    // single conditional findOneAndUpdate keyed on the CURRENT
    // assignedAgentId matching what the caller believes it to be —
    // MongoDB only lets one concurrent caller's filter match, so exactly
    // one of two racing calls actually updates the document; the loser's
    // filter simply matches zero documents and falls into the 409 branch
    // below instead of overwriting anything. The `status: pending -> open`
    // transition rides the same atomic write (aggregation-pipeline update
    // form) so it can't race independently of the assignment itself.
    const before = conversation.assignedAgentId?.toString() ?? null;
    const matchQuery: FilterQuery<ConversationDocument> = {
      _id: conversation._id,
      siteId: site._id,
    };
    if (expectedCurrentAgentId !== undefined) {
      matchQuery.assignedAgentId = expectedCurrentAgentId
        ? new Types.ObjectId(expectedCurrentAgentId)
        : null;
    }
    const updated = await this.conversationModel
      .findOneAndUpdate(
        matchQuery,
        [
          {
            $set: {
              assignedAgentId: new Types.ObjectId(agentId),
              status: {
                $cond: [{ $eq: ['$status', 'pending'] }, 'open', '$status'],
              },
            },
          },
        ],
        { new: true },
      )
      .exec();

    if (!updated) {
      // Someone else's write won the race (or the caller's own view of the
      // current holder was simply stale) — re-fetch to name who actually
      // holds it right now, rather than a bare, unhelpful "conflict."
      const current = await this.conversationModel
        .findOne({ _id: conversation._id, siteId: site._id })
        .exec();
      const currentHolderId = current?.assignedAgentId?.toString() ?? null;
      const holder = currentHolderId
        ? await this.userModel.findById(currentHolderId, 'displayName').exec()
        : null;
      throw new ConflictException(
        holder
          ? `Already claimed by ${holder.displayName}.`
          : 'This conversation was just reassigned — it is no longer unassigned.',
      );
    }

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: autoClaimTrigger
        ? 'conversation.auto_claimed'
        : 'conversation.assigned',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: updated._id,
      metadata: autoClaimTrigger
        ? { before, after: agentId, trigger: autoClaimTrigger }
        : { before, after: agentId },
    });

    this.realtimeEvents.emit({
      kind: 'conversation.updated',
      siteId: site._id.toString(),
      conversationId: updated._id.toString(),
      changeType: 'assigned',
      data: { before, after: agentId },
      // Agent-lock-fix — keeps the "Assign To" column live for every
      // `view_own`-only Agent who was in this Department's queue, not just
      // whoever holds `conversations.view_site` (already covered by the
      // `siteRoom` emit RealtimeGateway does for every 'conversation.updated').
      departmentQueueMemberIds: updated.deptQueueVisible
        ? await this.getDepartmentQueueMemberIds(updated.departmentId, site._id)
        : undefined,
    });

    return updated;
  }

  /**
   * Direct user request — the Visitors list's "Assign To" picker also needs
   * to work for a Visitor who is only BROWSING, with no Conversation yet at
   * all, so a Supervisor/Owner/Team Lead can hand them straight to a
   * specific Agent instead of that Agent having to notice and claim them.
   * `assign()` above can't do this — it requires an existing
   * `conversationId`. This either reassigns an already-open Conversation
   * (reuses `assign()` verbatim, same compare-and-swap/audit/broadcast) or,
   * if none exists, creates one the same way `startProactiveConversation`
   * does (department pick, referenceNumber, pastChatsCount/Lead bookkeeping,
   * `conversation.created` broadcast) but assigned to `agentId` — never
   * `actor.userId` — and with NO message, since the actor isn't the one
   * chatting with this Visitor. The Agent sees it appear in their Inbox
   * exactly like any other assigned Conversation; nothing is sent to the
   * Visitor's widget until that Agent actually writes something.
   */
  async assignVisitorToAgent(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    agentId: string,
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);

    const agentOnSite = await this.permissionsService.isUserOnSite(
      agentId,
      site._id,
    );
    if (!agentOnSite) {
      throw new BadRequestException(
        'That Agent does not have access to this Site.',
      );
    }

    const visitorDoc = await this.visitorModel
      .findOne({ _id: visitorId, siteId: site._id })
      .exec();
    if (!visitorDoc) {
      throw new NotFoundException('Visitor not found on this Site.');
    }
    if (visitorDoc.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from receiving messages on this Site.',
      );
    }

    // Same "send into whatever's already open instead of creating a
    // duplicate" race guard `startProactiveConversation` applies — the
    // Visitor may have started their own chat, or another Agent/Admin
    // already reached out, between this Visitor appearing on the list and
    // this click landing.
    const existing = await this.conversationModel
      .findOne({
        siteId: site._id,
        visitorId: visitorDoc._id,
        status: { $ne: 'closed' },
      })
      .exec();
    if (existing) {
      return this.assign(
        actor,
        siteId,
        existing._id.toString(),
        agentId,
        existing.assignedAgentId?.toString() ?? null,
      );
    }

    const department = await this.departmentModel
      .findOne({ siteId: site._id })
      .sort({ createdAt: 1 })
      .exec();
    if (!department) {
      throw new BadRequestException(
        'This Site has no Department to route the Conversation to.',
      );
    }

    const referenceNumber = await this.referenceNumberService.next();
    const conversation = await this.conversationModel.create({
      siteId: site._id,
      departmentId: department._id,
      visitorId: visitorDoc._id,
      assignedAgentId: new Types.ObjectId(agentId),
      submissionChannel: 'online',
      status: 'open',
      startedAt: new Date(),
      referenceNumber,
    });

    visitorDoc.pastChatsCount += 1;
    await visitorDoc.save();
    const lead = await this.leadsService.syncLeadForVisitor(visitorDoc);
    if (
      lead &&
      !lead.conversationIds.some((id) => id.equals(conversation._id))
    ) {
      lead.conversationIds.push(conversation._id);
      await lead.save();
    }

    await this.analyticsEvents.record({
      siteId: site._id,
      type: 'chatStarted',
      visitorId: visitorDoc._id,
    });

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.created',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: {
        referenceNumber,
        departmentId: department._id.toString(),
        assignedTo: agentId,
        proactive: false,
      },
    });

    this.realtimeEvents.emit({
      kind: 'conversation.created',
      siteId: site._id.toString(),
      departmentId: department._id.toString(),
      conversationId: conversation._id.toString(),
      referenceNumber,
      status: conversation.status,
      assignedAgentId: agentId,
      visitorId: visitorDoc._id.toString(),
    });

    return conversation;
  }

  // ---------------------------------------------------------------------
  // Agent-lock-fix (files/agent-lock-fix/10-conversation-lock-and-assign-
  // column.md) — the two SYSTEM-triggered claims (open/reply) plus the
  // send-time lock check. See the doc's own Section 3 table for the full
  // trigger matrix this implements.
  // ---------------------------------------------------------------------

  /**
   * Requirement 1/2 — if `conversation` is still unassigned, atomically
   * claims it for `actor` by reusing `assign()`'s own compare-and-swap
   * (`expectedCurrentAgentId: null`), race-safe against another simultaneous
   * open/reply the exact same way an explicit "Assign to me" click already
   * is. If the race is LOST (someone else's claim landed a moment earlier),
   * that's not an error here — the caller just proceeds against whatever
   * the Conversation's current state now actually is, and
   * `assertCanSend`/the refreshed `assignedAgent` in the response decide
   * what happens next.
   */
  private async autoClaimIfUnassigned(
    actor: AuthenticatedUser,
    site: SiteDocument,
    conversation: ConversationDocument,
    trigger: 'open' | 'reply',
  ): Promise<ConversationDocument> {
    if (conversation.assignedAgentId) return conversation;
    try {
      return await this.assign(
        actor,
        site._id.toString(),
        conversation._id.toString(),
        actor.userId,
        null,
        trigger,
      );
    } catch (err) {
      if (err instanceof ConflictException) {
        // Lost the race — re-fetch rather than propagate. `assign()` itself
        // already re-fetched to build its 409 message, but doesn't return
        // that document, so one more read here is the simplest correct way
        // to hand the caller the CURRENT state.
        const fresh = await this.conversationModel
          .findOne({ _id: conversation._id, siteId: site._id })
          .exec();
        if (fresh) return fresh;
      }
      throw err;
    }
  }

  /**
   * Requirement 3 — the core lock: once a Conversation has an assignee, only
   * that assignee may send into it. `conversations.assign` does NOT bypass
   * this on its own (Requirement 4/6's whole point — a Supervisor must
   * explicitly "Take over" first, which makes them the assignee via
   * `assign()`, before they can send); this check is deliberately blind to
   * every permission except who currently holds the Conversation. Called
   * AFTER `autoClaimIfUnassigned` in every send path, so a still-unassigned
   * Conversation never reaches this at all — it's claimed by the sender
   * first, same as Requirement 2 describes.
   */
  private async assertCanSend(
    actor: AuthenticatedUser,
    conversation: ConversationDocument,
  ): Promise<void> {
    const assignedAgentId = conversation.assignedAgentId?.toString() ?? null;
    if (!assignedAgentId || assignedAgentId === actor.userId) return;
    const assignee = await this.userModel
      .findById(assignedAgentId, 'displayName')
      .lean()
      .exec();
    throw new ForbiddenException(
      assignee
        ? `This conversation is already assigned to ${assignee.displayName}. Take over the conversation to send a message.`
        : 'This conversation is already assigned to another Agent. Take over the conversation to send a message.',
    );
  }

  // ---------------------------------------------------------------------
  // Tags (FR-AGT-11) — conversations.tag.
  // ---------------------------------------------------------------------
  async addTag(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    tag: string,
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const normalized = tag.trim();
    if (!conversation.tags.includes(normalized)) {
      conversation.tags.push(normalized);
      await conversation.save();
      await this.auditLog.record({
        actorType: 'user',
        actorId: actor.userId,
        action: 'conversation.tag_added',
        siteId: site._id,
        targetType: 'Conversation',
        targetId: conversation._id,
        metadata: { tag: normalized },
      });
      this.realtimeEvents.emit({
        kind: 'conversation.updated',
        siteId: site._id.toString(),
        conversationId: conversation._id.toString(),
        changeType: 'tag_added',
        data: { tag: normalized },
      });
    }

    return conversation;
  }

  async removeTag(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    tag: string,
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const normalized = tag.trim();
    const before = conversation.tags.length;
    conversation.tags = conversation.tags.filter((t) => t !== normalized);
    if (conversation.tags.length !== before) {
      await conversation.save();
      await this.auditLog.record({
        actorType: 'user',
        actorId: actor.userId,
        action: 'conversation.tag_removed',
        siteId: site._id,
        targetType: 'Conversation',
        targetId: conversation._id,
        metadata: { tag: normalized },
      });
      this.realtimeEvents.emit({
        kind: 'conversation.updated',
        siteId: site._id.toString(),
        conversationId: conversation._id.toString(),
        changeType: 'tag_removed',
        data: { tag: normalized },
      });
    }

    return conversation;
  }

  // ---------------------------------------------------------------------
  // Messages — FR-MSG-01/02/06. Both the REST endpoint (Session 7, still
  // usable as a fallback/testing tool) AND the WebSocket gateway's
  // `agent:send_message`/`visitor:send_message` handlers (Session 8) call
  // these SAME two methods, so persistence + the resulting real-time
  // broadcast (via RealtimeEventsService, consumed by RealtimeGateway) are
  // identical regardless of transport — no parallel message-send logic
  // anywhere else in the codebase.
  // ---------------------------------------------------------------------
  async addAgentMessage(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    body: string | null | undefined,
    attachments?: AttachmentRefInput[],
  ): Promise<MessageDocument> {
    let conversation = await this.assertAgentConversationAccess(
      actor,
      siteId,
      conversationId,
    );

    // Requirement 2 (agent-lock-fix) — the safety net: if this send is
    // landing on a still-unassigned Conversation (the open-trigger above
    // didn't fire, or this message arrived via a path that skips it), claim
    // it for the sender atomically, right here, before anything is
    // persisted. Requirement 3's lock check right below then runs against
    // whichever Conversation state actually won that race — see
    // `autoClaimIfUnassigned`'s own doc comment.
    if (!conversation.assignedAgentId) {
      const site = await this.assertSite(actor, siteId);
      conversation = await this.autoClaimIfUnassigned(
        actor,
        site,
        conversation,
        'reply',
      );
    }
    // Requirement 3 — once assigned, only the assignee may send. Enforced
    // here, at the service layer, so it holds regardless of transport
    // (REST or the WebSocket `agent:send_message`/`agent:send_proactive_message`
    // handlers, both of which call this same method — see this class's own
    // doc comment on why there is no parallel send path) and regardless of
    // any client-side composer disabling.
    await this.assertCanSend(actor, conversation);

    const resolvedAttachments = this.resolveAttachmentRefs(
      siteId,
      conversationId,
      attachments,
    );
    this.assertHasContent(body, resolvedAttachments);

    // T-08 TC-08.5 fix (Findings #2, `T-08-concurrency.md`): mirrors
    // addVisitorMessage's FR-CONV-02 reopen exactly, via the shared
    // `reopenIfClosed` helper, instead of silently persisting an Agent
    // message onto a Conversation another Agent closed moments earlier
    // while leaving `status: 'closed'`.
    await this.reopenIfClosed(conversation, {
      actorType: 'user',
      actorId: actor.userId,
    });

    const { deliveredAt, readAt } = this.computeInitialTickState(conversation);
    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'agent',
      senderId: new Types.ObjectId(actor.userId),
      body: body?.trim() ? body : null,
      attachments: resolvedAttachments,
      sentAt: new Date(),
      deliveredAt,
      readAt,
    });

    this.emitMessageCreated(
      conversation.siteId.toString(),
      message,
      conversation.referenceNumber,
    );
    return message;
  }

  /**
   * Phase 2 §3.10 (FR-P2-READ-02–05) — the tick state a brand-new
   * Agent-sent message starts at, decided ONCE at creation from the
   * Visitor's CURRENT live state:
   *   - not connected at all → Sent (both null) — FR-P2-READ-04. Picked up
   *     later by `deliverPendingMessages` (below) when the Visitor
   *     reconnects.
   *   - connected but that Conversation isn't reported foreground →
   *     Delivered (`deliveredAt` only) — FR-P2-READ-02.
   *   - connected AND currently foreground → Read (both set) immediately —
   *     matches the confirmation requirement that a message sent to an
   *     already-open, already-foregrounded Visitor "quickly shows Read"
   *     without waiting on a second round-trip event for THIS message.
   * Every field set here is a forward-only starting point — nothing already
   * persisted is ever touched by this method (FR-P2-READ-05), and every
   * later transition (`deliverPendingMessages`/`markDeliveredMessagesRead`)
   * only ever advances a still-null field, never overwrites a set one.
   */
  private computeInitialTickState(conversation: ConversationDocument): {
    deliveredAt: Date | null;
    readAt: Date | null;
  } {
    const visitorId = conversation.visitorId.toString();
    if (!this.visitorPresenceService.isConnected(visitorId)) {
      return { deliveredAt: null, readAt: null };
    }
    const now = new Date();
    const isForeground = this.visitorPresenceService.isForeground(
      visitorId,
      conversation._id.toString(),
    );
    return { deliveredAt: now, readAt: isForeground ? now : null };
  }

  /**
   * Agent-initiated proactive message (this session, task requirement 6) —
   * an Agent explicitly sending to a Visitor whose widget session shows as
   * "closed" (task requirement 14's "Send anyway"). Same scope check +
   * same Message persistence as `addAgentMessage` above (reuses the
   * identical Session 7 logic, per the task's own instruction) — the ONLY
   * difference is the additional `agent.proactiveMessage` broadcast below,
   * so the Widget can distinguish this from an ordinary reply and render it
   * as a floating proactive bubble instead of silently appending to a
   * transcript nobody's looking at. The normal `message:new`/
   * `conversation:updated` broadcasts (via emitMessageCreated) still fire
   * too, so any Agent Console open on this Conversation sees it exactly
   * like a normal reply.
   */
  async addAgentProactiveMessage(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    body: string,
  ): Promise<MessageDocument> {
    // Proactive outreach stays text-only this session (attachments weren't
    // asked for on this specific flow) — no attachments param, unlike
    // addAgentMessage above.
    let conversation = await this.assertAgentConversationAccess(
      actor,
      siteId,
      conversationId,
    );

    // Agent-lock-fix Requirements 2/3 — identical claim-then-lock-check as
    // addAgentMessage above; this is still a send, just via a different
    // Widget-facing broadcast on top.
    if (!conversation.assignedAgentId) {
      const site = await this.assertSite(actor, siteId);
      conversation = await this.autoClaimIfUnassigned(
        actor,
        site,
        conversation,
        'reply',
      );
    }
    await this.assertCanSend(actor, conversation);

    const { deliveredAt, readAt } = this.computeInitialTickState(conversation);
    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'agent',
      senderId: new Types.ObjectId(actor.userId),
      body,
      sentAt: new Date(),
      deliveredAt,
      readAt,
    });

    this.emitMessageCreated(
      conversation.siteId.toString(),
      message,
      conversation.referenceNumber,
    );

    const messagePayload = {
      id: message._id.toString(),
      conversationId: message.conversationId.toString(),
      senderType: message.senderType,
      senderId: message.senderId ? message.senderId.toString() : null,
      body: message.body,
      sentAt: message.sentAt.toISOString(),
      attachments: [] as AttachmentWire[],
      deliveredAt: message.deliveredAt
        ? message.deliveredAt.toISOString()
        : null,
      readAt: message.readAt ? message.readAt.toISOString() : null,
    };
    this.realtimeEvents.emit({
      kind: 'agent.proactiveMessage',
      siteId: conversation.siteId.toString(),
      conversationId: conversation._id.toString(),
      visitorId: conversation.visitorId.toString(),
      message: messagePayload,
    });

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.proactive_message_sent',
      siteId: conversation.siteId,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: { messageId: message._id.toString() },
    });

    return message;
  }

  /**
   * FR-RPT-07 ("[the Visitors list is] usable to proactively start a
   * chat") — an Agent reaching out to a Visitor who is currently on the
   * Site but has never opened the widget's chat window, so there is no
   * Conversation yet at all (distinct from `addAgentProactiveMessage`
   * above, which requires one to already exist). Creates the Conversation
   * with the same department-pick/referenceNumber logic `create()` (the
   * Visitor-initiated path) uses, but self-assigns it to the initiating
   * Agent rather than running `pickAgentForRouting` — an Agent who just
   * deliberately reached out to a specific Visitor IS the obvious assignee;
   * routing it to someone else (or leaving it pending) would be a strange
   * outcome for an action the Agent just took on purpose. The message
   * itself is then persisted via `addAgentProactiveMessage`'s identical
   * path, so the Visitor's widget renders the same proactive bubble either
   * way, regardless of which of the two flows produced it.
   */
  async startProactiveConversation(
    actor: AuthenticatedUser,
    siteId: string,
    visitorId: string,
    body: string,
  ): Promise<{ conversation: ConversationDocument; message: MessageDocument }> {
    const site = await this.assertSite(actor, siteId);

    const visitorDoc = await this.visitorModel
      .findOne({ _id: visitorId, siteId: site._id })
      .exec();
    if (!visitorDoc) {
      throw new NotFoundException('Visitor not found on this Site.');
    }
    if (visitorDoc.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from receiving messages on this Site.',
      );
    }

    // Defends against a race (the Visitor started their own chat, or
    // another Agent already reached out, between the Visitor appearing on
    // VisitorsPanel and this Agent clicking "Start conversation") — send
    // into whatever's already open instead of creating a duplicate.
    const existing = await this.conversationModel
      .findOne({
        siteId: site._id,
        visitorId: visitorDoc._id,
        status: { $ne: 'closed' },
      })
      .exec();
    if (existing) {
      const message = await this.addAgentProactiveMessage(
        actor,
        siteId,
        existing._id.toString(),
        body,
      );
      return { conversation: existing, message };
    }

    const department = await this.departmentModel
      .findOne({ siteId: site._id })
      .sort({ createdAt: 1 })
      .exec();
    if (!department) {
      throw new BadRequestException(
        'This Site has no Department to route the Conversation to.',
      );
    }

    const referenceNumber = await this.referenceNumberService.next();
    const conversation = await this.conversationModel.create({
      siteId: site._id,
      departmentId: department._id,
      visitorId: visitorDoc._id,
      assignedAgentId: new Types.ObjectId(actor.userId),
      // An Agent-initiated proactive conversation is definitionally
      // 'online' — the Agent is right there starting it — no computation
      // needed, unlike the Visitor-initiated create() path.
      submissionChannel: 'online',
      status: 'open',
      startedAt: new Date(),
      referenceNumber,
    });

    // Same FR-VIS-05/FR-VIS-08 bookkeeping create() does for a
    // Visitor-initiated Conversation — this is still "a chat started," just
    // Agent-initiated.
    visitorDoc.pastChatsCount += 1;
    await visitorDoc.save();
    const lead = await this.leadsService.syncLeadForVisitor(visitorDoc);
    if (
      lead &&
      !lead.conversationIds.some((id) => id.equals(conversation._id))
    ) {
      lead.conversationIds.push(conversation._id);
      await lead.save();
    }

    // FR-RPT-01 (this session) — still "a Conversation was created," just
    // Agent-initiated rather than Visitor-initiated; the chart's "chats"
    // metric should count both, same as pastChatsCount/Lead sync above
    // already treat this identically to the Visitor-initiated create().
    await this.analyticsEvents.record({
      siteId: site._id,
      type: 'chatStarted',
      visitorId: visitorDoc._id,
    });

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.created',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: {
        referenceNumber,
        departmentId: department._id.toString(),
        proactive: true,
      },
    });

    this.realtimeEvents.emit({
      kind: 'conversation.created',
      siteId: site._id.toString(),
      departmentId: department._id.toString(),
      conversationId: conversation._id.toString(),
      referenceNumber,
      status: conversation.status,
      assignedAgentId: actor.userId,
      visitorId: visitorDoc._id.toString(),
    });

    const message = await this.addAgentProactiveMessage(
      actor,
      siteId,
      conversation._id.toString(),
      body,
    );

    return { conversation, message };
  }

  /**
   * Visitor-side send (FR-MSG-01/02) — the WebSocket counterpart to
   * `create()`'s `initialMessage`, for every message after the first.
   * Ownership is checked directly against the Conversation document (siteId
   * + visitorId must match the caller's verified visitor session token) —
   * there is no RBAC/PermissionGuard concept for a Visitor (they're
   * anonymous by design, SRS §1.3), so "is this the Visitor's own
   * Conversation" IS the entire access check, same as
   * `ConversationsService.create`'s `visitor.siteId !== siteId` guard.
   */
  async addVisitorMessage(
    visitor: AuthenticatedVisitor,
    conversationId: string,
    body: string | null | undefined,
    attachments?: AttachmentRefInput[],
  ): Promise<MessageDocument> {
    const conversation = await this.assertVisitorConversationAccess(
      visitor,
      conversationId,
    );
    const resolvedAttachments = this.resolveAttachmentRefs(
      visitor.siteId,
      conversationId,
      attachments,
    );
    this.assertHasContent(body, resolvedAttachments);

    const visitorDoc = await this.visitorModel
      .findById(visitor.visitorId)
      .exec();
    if (visitorDoc?.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from sending messages on this Site.',
      );
    }

    // FR-CONV-02: "closed conversations may be reopened if the Visitor
    // sends a new message."
    await this.reopenIfClosed(conversation, {
      actorType: 'visitor',
      actorId: visitor.visitorId,
    });

    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'visitor',
      senderId: null,
      body: body?.trim() ? body : null,
      attachments: resolvedAttachments,
      sentAt: new Date(),
    });

    this.emitMessageCreated(
      conversation.siteId.toString(),
      message,
      conversation.referenceNumber,
      visitorDoc?.name,
    );
    return message;
  }

  /**
   * FR-CONV-02: a closed Conversation reopens on a new message — originally
   * only wired for the Visitor side (`addVisitorMessage`); T-08 TC-08.5
   * (Findings #2, `T-08-concurrency.md`) found the Agent side did neither
   * of the SRS-acceptable outcomes (reopen or reject) and silently left
   * `status: 'closed'` while persisting the new message anyway. Extracted
   * here, unchanged in behavior from the original Visitor-only inline
   * version, so `addAgentMessage` below can share the identical
   * reopen/audit/broadcast logic rather than duplicating it — a no-op when
   * the Conversation isn't currently `closed`.
   */
  private async reopenIfClosed(
    conversation: ConversationDocument,
    actor: { actorType: 'user' | 'visitor'; actorId: string },
  ): Promise<void> {
    if (conversation.status !== 'closed') return;
    conversation.status = 'open';
    conversation.closedAt = null;
    await conversation.save();
    await this.auditLog.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'conversation.reopened',
      siteId: conversation.siteId,
      targetType: 'Conversation',
      targetId: conversation._id,
    });
    this.realtimeEvents.emit({
      kind: 'conversation.updated',
      siteId: conversation.siteId.toString(),
      conversationId: conversation._id.toString(),
      changeType: 'reopened',
    });
  }

  /**
   * `referenceNumber`/`visitorName` (Session Fix-09, T-06 Findings #2/#3):
   * threaded through to RealtimeGateway's `message.created` case so its
   * `conversation:updated` nudge can give `useDesktopNotifications.ts` a
   * real title (FR-P2-ID-01's name-or-reference-number rule) even for a
   * Conversation whose window has never been opened this session, instead
   * of falling back to the raw Mongo id. `visitorName` is optional — only
   * the visitor-send call site below conveniently has a loaded Visitor doc
   * to read it from.
   */
  private emitMessageCreated(
    siteId: string,
    message: MessageDocument,
    referenceNumber: string,
    visitorName?: string | null,
  ): void {
    this.realtimeEvents.emit({
      kind: 'message.created',
      siteId,
      conversationId: message.conversationId.toString(),
      message: this.toRealtimeMessagePayload(message),
      referenceNumber,
      visitorName,
    });
  }

  /**
   * Phase 2 §3.10 (FR-P2-READ-02–06) — re-broadcasts an ALREADY-created
   * message's current `deliveredAt`/`readAt` after either advances
   * (`deliverPendingMessages`/`markDeliveredMessagesRead` below), so the
   * Agent Console's ticks update live. `visitorId` lets RealtimeGateway
   * exclude the Visitor's own socket(s) from this one — see the gateway's
   * `message.updated` doc comment for why.
   */
  private emitMessageTickUpdate(
    siteId: string,
    visitorId: string,
    message: MessageDocument,
  ): void {
    this.realtimeEvents.emit({
      kind: 'message.updated',
      siteId,
      conversationId: message.conversationId.toString(),
      visitorId,
      message: this.toRealtimeMessagePayload(message),
    });
  }

  private toRealtimeMessagePayload(
    message: MessageDocument,
  ): RealtimeMessagePayload {
    return {
      id: message._id.toString(),
      conversationId: message.conversationId.toString(),
      attachments: (message.attachments ?? []).map((a) =>
        this.toAttachmentWire(a),
      ),
      senderType: message.senderType,
      senderId: message.senderId ? message.senderId.toString() : null,
      body: message.body,
      sentAt: message.sentAt.toISOString(),
      deliveredAt: message.deliveredAt
        ? message.deliveredAt.toISOString()
        : null,
      readAt: message.readAt ? message.readAt.toISOString() : null,
    };
  }

  /**
   * Phase 2 §3.10 (FR-P2-READ-04) — the reconnect half: every Sent
   * (`deliveredAt: null`) Agent message in this Conversation becomes
   * Delivered the moment the Visitor's widget (re)joins its room — this IS
   * "successfully pushed to the Visitor's actively-connected widget
   * WebSocket session" for a backlog the Visitor missed while disconnected,
   * mirroring the FR-MSG-05 resync `getForVisitor` already performs for the
   * transcript itself. Never touches an already-Delivered/Read message
   * (FR-P2-READ-05) — the query only ever selects `deliveredAt: null` rows.
   */
  private async deliverPendingMessages(
    conversation: ConversationDocument,
    messages: MessageDocument[],
  ): Promise<void> {
    const pending = messages.filter(
      (m) => m.senderType === 'agent' && !m.deliveredAt,
    );
    if (pending.length === 0) return;
    const now = new Date();
    await this.messageModel.updateMany(
      { _id: { $in: pending.map((m) => m._id) } },
      { $set: { deliveredAt: now } },
    );
    const visitorId = conversation.visitorId.toString();
    const siteId = conversation.siteId.toString();
    for (const m of pending) {
      m.deliveredAt = now;
      this.emitMessageTickUpdate(siteId, visitorId, m);
    }
  }

  /**
   * Phase 2 §3.10 (FR-P2-READ-03) — every currently-Delivered, unread
   * Agent message in this Conversation becomes Read right now. Called from
   * `setConversationForeground` below on a `foreground: true` report. Only
   * ever selects `deliveredAt: { $ne: null }, readAt: null` rows, so a
   * still-Sent message (Visitor disconnected before this one was ever
   * delivered) is left alone rather than jumping straight to Read
   * (Delivered → Read stays a real, ordered transition, never skipped).
   */
  private async markDeliveredMessagesRead(
    conversation: ConversationDocument,
  ): Promise<void> {
    const toMark = await this.messageModel
      .find({
        conversationId: conversation._id,
        senderType: 'agent',
        deliveredAt: { $ne: null },
        readAt: null,
      })
      .exec();
    if (toMark.length === 0) return;
    const now = new Date();
    await this.messageModel.updateMany(
      { _id: { $in: toMark.map((m) => m._id) } },
      { $set: { readAt: now } },
    );
    const visitorId = conversation.visitorId.toString();
    const siteId = conversation.siteId.toString();
    for (const m of toMark) {
      m.readAt = now;
      this.emitMessageTickUpdate(siteId, visitorId, m);
    }
  }

  /**
   * Phase 2 §3.10 (FR-P2-READ-03) — entry point for RealtimeGateway's
   * `visitor:conversation_foreground` handler. Ownership-checked the same
   * way every other Visitor-initiated action is (`assertVisitorConversationAccess`).
   * Records the flag unconditionally (so the NEXT agent-sent message can
   * start already-Read, per `computeInitialTickState`), and additionally
   * sweeps existing Delivered/unread messages to Read right now on a
   * `true` report — covers a message that arrived WHILE already
   * foregrounded (the flag alone wouldn't retroactively fix an
   * already-created message).
   */
  async setConversationForeground(
    visitor: AuthenticatedVisitor,
    conversationId: string,
    foreground: boolean,
  ): Promise<void> {
    const conversation = await this.assertVisitorConversationAccess(
      visitor,
      conversationId,
    );
    this.visitorPresenceService.setForeground(
      visitor.visitorId,
      conversation._id.toString(),
      foreground,
    );
    if (!foreground) return;
    await this.markDeliveredMessagesRead(conversation);
  }

  /**
   * `join_conversation` for a Visitor (WebSocket) — "no permission check
   * needed (visitors are anonymous by design), but must be scoped strictly
   * to their own Conversation" (task requirement 1). Also doubles as the
   * initial-history payload the gateway sends back on join.
   */
  async getForVisitor(
    visitor: AuthenticatedVisitor,
    conversationId: string,
  ): Promise<ConversationWithTranscript> {
    const conversation = await this.conversationModel
      .findById(conversationId)
      .exec();
    if (
      !conversation ||
      conversation.siteId.toString() !== visitor.siteId ||
      conversation.visitorId.toString() !== visitor.visitorId
    ) {
      throw new NotFoundException(
        'Conversation not found for this visitor session.',
      );
    }
    const messages = await this.messageModel
      .find({ conversationId: conversation._id })
      .sort({ sentAt: 1 })
      .exec();
    // Phase 2 §3.10 (FR-P2-READ-04) — this is the Widget's (re)join, the
    // exact moment a reconnected Visitor's socket becomes able to actually
    // receive live events again; any Sent message queued up while they were
    // disconnected becomes Delivered right here. Mutates `messages` in
    // place before serializing, so the transcript this same call returns
    // already reflects it too.
    await this.deliverPendingMessages(conversation, messages);
    return { conversation, messages: this.toMessageWireList(messages) };
  }

  // ---------------------------------------------------------------------
  // Reconnection resync (FR-MSG-05) — REST fallback: "fetch messages since
  // last known message ID/timestamp." Gated by the exact same view scope as
  // every other Agent-facing Conversation read (getMessagesSince) or by
  // Visitor-ownership (getMessagesSinceForVisitor) — same split as
  // findOne/getForVisitor above.
  // ---------------------------------------------------------------------
  async getMessagesSince(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
    since: GetMessagesSinceQueryDto,
  ): Promise<MessageWire[]> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);
    const messages = await this.queryMessagesSince(conversation._id, since);
    const senderNames = await this.resolveSenderNames(messages);
    return this.toMessageWireList(messages, senderNames);
  }

  async getMessagesSinceForVisitor(
    visitor: AuthenticatedVisitor,
    conversationId: string,
    since: GetMessagesSinceQueryDto,
  ): Promise<MessageWire[]> {
    const conversation = await this.conversationModel
      .findById(conversationId)
      .exec();
    if (
      !conversation ||
      conversation.siteId.toString() !== visitor.siteId ||
      conversation.visitorId.toString() !== visitor.visitorId
    ) {
      throw new NotFoundException(
        'Conversation not found for this visitor session.',
      );
    }
    return this.toMessageWireList(
      await this.queryMessagesSince(conversation._id, since),
    );
  }

  private async queryMessagesSince(
    conversationId: Types.ObjectId,
    since: GetMessagesSinceQueryDto,
  ): Promise<MessageDocument[]> {
    const filter: FilterQuery<MessageDocument> = { conversationId };

    let sentAfter: Date | undefined;
    if (since.sinceMessageId) {
      const ref = await this.messageModel
        .findOne({ _id: since.sinceMessageId, conversationId })
        .select('sentAt')
        .lean()
        .exec();
      if (ref) sentAfter = ref.sentAt;
    }
    if (!sentAfter && since.sinceTimestamp) {
      sentAfter = new Date(since.sinceTimestamp);
    }
    if (sentAfter) {
      filter.sentAt = { $gt: sentAfter };
    }

    return this.messageModel.find(filter).sort({ sentAt: 1 }).exec();
  }

  // ---------------------------------------------------------------------
  // Rating (FR-WID-13, FR-CONV-07) — public, visitor-facing, no auth.
  // ---------------------------------------------------------------------
  async submitRating(
    conversationId: string,
    dto: SubmitRatingDto,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findById(conversationId)
      .exec();
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    if (conversation.status !== 'closed') {
      throw new BadRequestException(
        'Only a closed Conversation can receive a rating.',
      );
    }
    // Post-QA Fix 6 (T-05-data-integrity.md, TC-05.10c; FR-CONV-07 updated) —
    // a second rating on the SAME Conversation used to silently overwrite the
    // first. Confirmed business decision: each Conversation still gets its own
    // independent rating (a different Conversation for the same Visitor is
    // completely unaffected by this check); only re-rating one already-rated
    // Conversation is now rejected instead of silently overwritten.
    if (conversation.ratingScore != null) {
      throw new BadRequestException(
        'This conversation has already been rated.',
      );
    }

    conversation.ratingScore = dto.ratingScore;
    conversation.ratingComment = dto.ratingComment ?? null;
    await conversation.save();

    await this.auditLog.record({
      actorType: 'visitor',
      actorId: conversation.visitorId,
      action: 'conversation.rated',
      siteId: conversation.siteId,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: { ratingScore: dto.ratingScore },
    });

    return conversation;
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /** ANY of view_own/view_site — matches the ANY-of `@RequirePermission` on the routes that call this. */
  private async resolveScope(
    actor: AuthenticatedUser,
    siteId: Types.ObjectId,
  ): Promise<{ canViewSite: boolean; canViewOwn: boolean }> {
    const [canViewSite, canViewOwn] = await Promise.all([
      this.permissionsService.hasPermission(
        actor.userId,
        'conversations.view_site',
        siteId,
      ),
      this.permissionsService.hasPermission(
        actor.userId,
        'conversations.view_own',
        siteId,
      ),
    ]);
    return { canViewSite, canViewOwn };
  }

  /**
   * The core scoping rule (task requirement): a `view_site` holder may act
   * on any Conversation on the Site; a `view_own`-only holder may act only
   * on a Conversation currently assigned to them, OR (Agent-lock-fix — see
   * `Conversation.deptQueueVisible`'s own doc comment) one that was ever
   * broadcast to their whole Department via FR-RTE-02's unassigned queue,
   * whether it's since been claimed by them, by a colleague, or not at all.
   * Applied uniformly to every read/mutation on a specific Conversation
   * (get, status, assign, tag, message) — not just the list endpoint — so
   * holding e.g. `conversations.close` without `conversations.view_site`
   * can never be used to reach into a Conversation outside the caller's own
   * scope. 404 (not 403) on failure — same "don't reveal existence" stance
   * `UsersService`/`VisitorsService` already take for cross-Site access.
   *
   * NOTE — this only decides what can be READ. Whether the caller may also
   * SEND into a Conversation reached via the second branch is a completely
   * separate question, answered by `assertCanSend` (below) — the whole
   * point of this fix is that those two are no longer the same check.
   */
  private async assertVisible(
    actor: AuthenticatedUser,
    siteId: Types.ObjectId,
    conversation: ConversationDocument,
  ): Promise<void> {
    const scope = await this.resolveScope(actor, siteId);
    if (scope.canViewSite) return;
    if (scope.canViewOwn) {
      if (conversation.assignedAgentId?.toString() === actor.userId) return;
      if (conversation.deptQueueVisible) {
        const departmentId = await this.getActorDepartmentId(actor.userId);
        if (departmentId?.equals(conversation.departmentId)) return;
      }
    }
    throw new NotFoundException('Conversation not found on this Site.');
  }

  /** Agent-lock-fix — the caller's own `User.departmentId`, or `null` if unset. Small, deliberately uncached (`assertVisible`/`findAll` are not hot paths this app runs at a scale where one extra indexed `_id` lookup matters, and a fresh read here never risks serving a stale Department assignment). */
  private async getActorDepartmentId(
    userId: string,
  ): Promise<Types.ObjectId | null> {
    const user = await this.userModel
      .findById(userId)
      .select('departmentId')
      .lean()
      .exec();
    return user?.departmentId ?? null;
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

  private async findConversationOnSite(
    siteId: Types.ObjectId,
    conversationId: string,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findOne({ _id: conversationId, siteId })
      .exec();
    if (!conversation) {
      throw new NotFoundException('Conversation not found on this Site.');
    }
    return conversation;
  }

  // ---------------------------------------------------------------------
  // Phase 2 §3.9 (FR-P2-ATT-01/02/05/06/08) — Attachments. Shared by
  // AttachmentsController (upload) and this class's own message-send
  // methods below (which re-validate every referenced attachment before
  // persisting it onto a Message — see resolveAttachmentRefs).
  // ---------------------------------------------------------------------

  /** Same access check `addAgentMessage` runs — public so AttachmentsController can gate an upload identically ("the same permission as sending a message in that Conversation", SRS §5.1) without duplicating assertSite/findConversationOnSite/assertVisible. */
  async assertAgentConversationAccess(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);
    return conversation;
  }

  /** Same ownership check `addVisitorMessage` runs (minus the banned/reopen side effects, which only make sense for an actual message send) — public so AttachmentsController can gate a Visitor's upload identically. */
  async assertVisitorConversationAccess(
    visitor: AuthenticatedVisitor,
    conversationId: string,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findById(conversationId)
      .exec();
    if (
      !conversation ||
      conversation.siteId.toString() !== visitor.siteId ||
      conversation.visitorId.toString() !== visitor.visitorId
    ) {
      throw new NotFoundException(
        'Conversation not found for this visitor session.',
      );
    }
    return conversation;
  }

  /**
   * Turns the `attachments` a send-message caller references (uploaded
   * moments earlier via AttachmentsController, key/fileName/fileType/
   * fileSizeBytes only) into the subdocuments actually persisted on the
   * Message. Two checks here matter for FR-P2-ATT-08 as much as the
   * upload-time validation does:
   *   - the key's own `<siteId>/<conversationId>/` prefix must match THIS
   *     conversation — without this, an Agent (or Visitor) with legitimate
   *     access to Conversation A could reference a key they'd previously
   *     uploaded to Conversation B (or, in principle, guessed), attaching
   *     someone else's file to a message in a conversation the uploader may
   *     not even have access to — the file would then get a validly-signed
   *     URL handed to everyone who CAN view Conversation A.
   *   - the file must still exist on disk — catches a stale/already-
   *     consumed reference with a clear error instead of persisting a
   *     Message whose attachment silently 404s forever after.
   */
  private resolveAttachmentRefs(
    siteId: string,
    conversationId: string,
    refs?: AttachmentRefInput[],
  ): Array<{
    key: string;
    fileName: string;
    fileType: string;
    fileSizeBytes: number;
    isImage: boolean;
  }> {
    if (!refs || refs.length === 0) return [];
    if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BadRequestException(
        `A message can include at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`,
      );
    }
    const expectedPrefix = `${siteId}/${conversationId}/`;
    return refs.map((ref) => {
      if (!ref.key.startsWith(expectedPrefix)) {
        throw new ForbiddenException(
          'One or more attachments do not belong to this conversation.',
        );
      }
      if (!this.storage.fileExists(ref.key)) {
        throw new BadRequestException(
          'One or more attachments could not be found — please re-upload and try again.',
        );
      }
      return {
        key: ref.key,
        fileName: ref.fileName,
        fileType: ref.fileType,
        fileSizeBytes: ref.fileSizeBytes,
        isImage: isImageMimeType(ref.fileType),
      };
    });
  }

  /** FR-P2-ATT-07: a Message needs text OR at least one attachment — checked once here, used by every send-message path (REST + WebSocket alike funnel through addAgentMessage/addVisitorMessage/addAgentProactiveMessage). */
  private assertHasContent(
    body: string | null | undefined,
    attachments: unknown[],
  ): void {
    if (!(body && body.trim()) && attachments.length === 0) {
      throw new BadRequestException(
        'A message must include text or at least one attachment.',
      );
    }
  }

  private toAttachmentWire(a: {
    fileName: string;
    fileType: string;
    fileSizeBytes: number;
    isImage: boolean;
    key: string;
  }): AttachmentWire {
    const url = this.storage.getSignedUrl({
      key: a.key,
      fileName: a.fileName,
      fileType: a.fileType,
    });
    return {
      fileName: a.fileName,
      fileType: a.fileType,
      fileSizeBytes: a.fileSizeBytes,
      url,
      thumbnailUrl: a.isImage ? url : null,
    };
  }

  /**
   * Converts a persisted Message document into the JSON shape a client
   * receives, with `attachments` replaced by freshly-signed wire entries
   * (FR-P2-ATT-08 — never the stored `key`, never a stale/persisted URL).
   * `.toObject()` keeps every other field's existing JSON shape identical
   * to what was returned before this session (raw Mongoose documents,
   * serialized via their own default `toJSON`) — only `attachments` differs.
   *
   * `senderNames` (agent-facing bug fix, this session) — a per-message
   * "who actually sent this" label, resolved from EACH message's own
   * `senderId`, never from the Conversation's CURRENT `assignedAgentId`.
   * Before this fix, the Agent Console (`MessageThread.tsx`) labeled every
   * 'agent' message with the currently-assigned Agent's name — so a
   * Supervisor reassignment silently rewrote history in the UI: Agent 1's
   * earlier messages started reading as sent by Agent 2 the moment the
   * Conversation changed hands, even though `Message.senderId` (never
   * mutated by `assign()` — see its own doc comment) still correctly
   * recorded Agent 1 as the sender all along. Callers that omit this map
   * entirely (`getForVisitor`/`getMessagesSinceForVisitor` — see their own
   * call sites) get byte-identical output to before: the Widget only ever
   * distinguishes senderTYPE ("Live Support" vs. the Visitor), never a
   * specific Agent's identity, and that stays true here — deliberately NOT
   * threaded onto the Visitor-facing paths.
   */
  private toMessageWire(
    message: MessageDocument,
    senderNames?: Map<string, string>,
  ): MessageWire {
    const obj = message.toObject() as MessageWire;
    const attachments = (message.attachments ?? []).map((a) =>
      this.toAttachmentWire(a),
    );
    if (!senderNames) {
      return { ...obj, attachments };
    }
    const senderName =
      message.senderType === 'agent' && message.senderId
        ? (senderNames.get(message.senderId.toString()) ?? null)
        : null;
    return { ...obj, attachments, senderName };
  }

  private toMessageWireList(
    messages: MessageDocument[],
    senderNames?: Map<string, string>,
  ): MessageWire[] {
    return messages.map((m) => this.toMessageWire(m, senderNames));
  }

  /**
   * Batches a `senderId -> displayName` lookup for every DISTINCT Agent who
   * sent one of `messages`, for `toMessageWireList`'s `senderNames` param
   * above. One query per transcript fetch, not one per message.
   */
  private async resolveSenderNames(
    messages: MessageDocument[],
  ): Promise<Map<string, string>> {
    const agentIds = Array.from(
      new Set(
        messages
          .filter((m) => m.senderType === 'agent' && m.senderId)
          .map((m) => m.senderId!.toString()),
      ),
    );
    if (agentIds.length === 0) return new Map();
    const users = await this.userModel
      .find(
        { _id: { $in: agentIds.map((id) => new Types.ObjectId(id)) } },
        'displayName',
      )
      .lean()
      .exec();
    return new Map(users.map((u) => [u._id.toString(), u.displayName]));
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Shared by `findAll`/`findAllCombined`'s `query.search` branch — matches
   * over `Visitor.name`/`.email`, scoped by whatever `siteFilter` the caller
   * already resolved (a single Site, or `{ siteId: { $in: allSiteIds } }`
   * for combined mode).
   *
   * T-11 Test 4 fix (Session Fix-05, PROGRESS.md) — this used to be a
   * case-insensitive ('i' flag) unanchored `$or` regex straight against
   * `name`/`email`, which cannot use a standard B-tree index at all (a
   * leading wildcard AND a case-insensitive flag both defeat index range
   * bounds) — full COLLSCAN on every call, confirmed via `.explain()` in
   * `files/reports/T-11-load.md` Test 4 finding #1. Now matches against the
   * pre-lowercased `nameLower`/`emailLower` fields (see `visitor.schema.ts`)
   * with an **anchored** (`^prefix`), plain (no 'i' flag — the stored value
   * and the search term are both already lowercased) regex, which Mongo's
   * planner CAN satisfy with an index range scan.
   *
   * Behavior change, deliberately made and documented (task guardrail) —
   * search is now A PREFIX match ("starts with", case-insensitive) rather
   * than a genuine anywhere-in-the-string substring match. Every existing
   * automated case (T-05 TC-05.8a/b/c — `search-grouped-by-visitor.e2e-
   * spec.ts`) searches by a full email or by the start of a name, so this
   * change is invisible to them; re-verified after this change (see
   * PROGRESS.md). A search term matching only mid-string (e.g. an email
   * domain fragment not at the start, like searching "gmail" against
   * "john@gmail.com") will no longer match — the $text-index alternative
   * the task offered was rejected instead: MongoDB's default $text
   * semantics OR-match individual tokens post-stemming, which would have
   * matched far MORE broadly than today's substring search (e.g. every
   * Visitor sharing an "@example.com" domain would match a search for one
   * specific full email), silently breaking TC-05.8a's "exactly 1 group"
   * assertion — worse for this app's UX than the narrower prefix-match
   * trade-off made here.
   */
  private async findMatchingVisitorIds(
    siteFilter: FilterQuery<VisitorDocument>,
    search: string,
  ): Promise<Types.ObjectId[]> {
    const escaped = this.escapeRegex(search.toLowerCase());
    const pattern = new RegExp(`^${escaped}`);
    const matches = await this.visitorModel
      .find({
        ...siteFilter,
        $or: [{ nameLower: pattern }, { emailLower: pattern }],
      })
      .select('_id')
      .lean()
      .exec();
    return matches.map((v) => v._id);
  }

  /**
   * Phase 2, FR-P2-GRP-01–03 — the grouped-by-visitor counterpart to
   * `findAll`/`findAllCombined`'s normal flat query, called once `filter`
   * already narrows to the name/email-matched Visitors (plus every other
   * filter/scope condition the caller applied).
   *
   * Fetches EVERY matching Conversation (no `skip`/`limit`) rather than one
   * page's worth — a Visitor's grouped row needs its FULL Conversation
   * history to expand into (FR-P2-GRP-02), and slicing at the Conversation
   * level first could split one Visitor's history across two pages of
   * results. This is safe precisely because it only ever runs once a
   * name/email search has already narrowed `filter.visitorId` to a small,
   * specific set of matched Visitors — unlike the unfiltered flat list
   * above, this is not an unbounded table scan.
   *
   * `page`/`limit` are applied to the resulting GROUPS (one per Visitor),
   * not to the underlying Conversations — pagination here means "page
   * through matched Visitors," which is what a grouped result actually is.
   *
   * Sorting both FR-P2-GRP-02 requires ("within an expanded group, most
   * recent first") and FR-P2-GRP's implicit "across groups, most recent
   * group first" fall out of a single `{ startedAt: -1 }` query plus
   * building each group with a `Map` (which preserves insertion order): a
   * group's conversations arrive already most-recent-first, and a group's
   * own position among all groups is exactly where its first (= most
   * recent) Conversation appeared in that overall feed — no separate re-sort
   * needed for either rule.
   */
  private async findAllGroupedByVisitor(
    filter: FilterQuery<ConversationDocument>,
    page: number,
    limit: number,
  ): Promise<GroupedConversationListResult> {
    const all = await this.conversationModel
      .find(filter)
      .sort({ startedAt: -1 })
      .populate('visitorId', 'name email')
      .populate('assignedAgentId', 'displayName email')
      .exec();

    const groups = new Map<
      string,
      { visitor: PopulatedVisitorRef; conversations: ConversationDocument[] }
    >();
    for (const conversation of all) {
      const visitor = conversation.visitorId as unknown as PopulatedVisitorRef;
      const key = visitor._id.toString();
      const existing = groups.get(key);
      if (existing) {
        existing.conversations.push(conversation);
      } else {
        groups.set(key, { visitor, conversations: [conversation] });
      }
    }

    const allGroups = Array.from(groups.values());
    const total = allGroups.length;
    const pageGroups = allGroups.slice((page - 1) * limit, page * limit);

    return {
      grouped: true,
      groups: pageGroups.map((g) => ({
        visitor: {
          id: g.visitor._id.toString(),
          name: g.visitor.name,
          email: g.visitor.email,
        },
        conversations: g.conversations,
      })),
      total,
      page,
      limit,
    };
  }
}

/** The shape `Conversation.visitorId` populates into with `'name email'` — used only by `findAllGroupedByVisitor` above, which needs typed field access (unlike the flat list, which just hands the populated document straight to JSON). */
interface PopulatedVisitorRef {
  _id: Types.ObjectId;
  name: string | null;
  email: string | null;
}
