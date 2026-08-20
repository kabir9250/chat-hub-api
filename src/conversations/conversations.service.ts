import {
  BadRequestException,
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
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { VisitorPresenceService } from '../realtime/visitor-presence.service';
import { ReferenceNumberService } from './reference-number.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.query.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { GetMessagesSinceQueryDto } from './dto/get-messages-since.query.dto';

export interface ConversationListResult {
  items: ConversationDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface ConversationWithTranscript {
  conversation: ConversationDocument;
  messages: MessageDocument[];
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

    const department = dto.departmentId
      ? await this.departmentModel
          .findOne({ _id: dto.departmentId, siteId: site._id })
          .exec()
      : await this.departmentModel
          .findOne({ siteId: site._id })
          .sort({ createdAt: 1 })
          .exec();
    if (!department) {
      throw new BadRequestException(
        dto.departmentId
          ? 'Department not found on this Site.'
          : 'This Site has no Department to route the Conversation to.',
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

    const conversation = await this.conversationModel.create({
      siteId: site._id,
      departmentId: department._id,
      visitorId: visitorDoc._id,
      assignedAgentId,
      status: assignedAgentId ? 'open' : 'pending',
      startedAt: new Date(),
      referenceNumber,
      tags: dto.tags ?? [],
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
   */
  private async pickAgentForRouting(
    siteId: Types.ObjectId,
    departmentId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    const candidates = await this.userModel
      .find({ departmentId, enabled: true })
      .select('_id')
      .lean()
      .exec();

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
      // Ties keep the first (stable, iteration-order) candidate — simple
      // over clever, per the task's own "keep the routing strategy simple"
      // guardrail.
      if (!best || count < best.count) {
        best = { id, count };
      }
    }
    return best ? new Types.ObjectId(best.id) : null;
  }

  // ---------------------------------------------------------------------
  // List (FR-AGT-09, FR-CONV-03/06) — Agent/Admin-facing.
  // ---------------------------------------------------------------------
  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
    query: ListConversationsQueryDto,
  ): Promise<ConversationListResult> {
    const site = await this.assertSite(actor, siteId);
    const scope = await this.resolveScope(actor, site._id);

    const filter: FilterQuery<ConversationDocument> = { siteId: site._id };

    if (!scope.canViewSite) {
      // conversations.view_own only — hard-pinned to the caller, regardless
      // of any ?agentId= the caller passed in.
      filter.assignedAgentId = new Types.ObjectId(actor.userId);
    } else if (query.agentId) {
      filter.assignedAgentId = new Types.ObjectId(query.agentId);
    }

    if (query.status) filter.status = query.status;
    if (query.tag) filter.tags = query.tag;
    if (query.rating !== undefined) filter.ratingScore = query.rating;

    if (query.dateFrom || query.dateTo) {
      const startedAtRange: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) startedAtRange.$gte = new Date(query.dateFrom);
      if (query.dateTo) startedAtRange.$lte = new Date(query.dateTo);
      filter.startedAt = startedAtRange;
    }

    if (query.search) {
      const escaped = this.escapeRegex(query.search);
      const pattern = new RegExp(escaped, 'i');
      const matchingVisitors = await this.visitorModel
        .find({
          siteId: site._id,
          $or: [{ name: pattern }, { email: pattern }],
        })
        .select('_id')
        .lean()
        .exec();
      if (matchingVisitors.length === 0) {
        return {
          items: [],
          total: 0,
          page: query.page ?? 1,
          limit: query.limit ?? 20,
        };
      }
      filter.visitorId = { $in: matchingVisitors.map((v) => v._id) };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

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
  // Get one + transcript (FR-CONV-04, FR-AGT-10) — Agent/Admin-facing.
  // ---------------------------------------------------------------------
  async findOne(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationWithTranscript> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

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

    return { conversation, messages, visitorOnline };
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

    const before = conversation.assignedAgentId?.toString() ?? null;
    conversation.assignedAgentId = new Types.ObjectId(agentId);
    if (conversation.status === 'pending') {
      conversation.status = 'open';
    }
    await conversation.save();

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.assigned',
      siteId: site._id,
      targetType: 'Conversation',
      targetId: conversation._id,
      metadata: { before, after: agentId },
    });

    this.realtimeEvents.emit({
      kind: 'conversation.updated',
      siteId: site._id.toString(),
      conversationId: conversation._id.toString(),
      changeType: 'assigned',
      data: { before, after: agentId },
    });

    return conversation;
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
    body: string,
  ): Promise<MessageDocument> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'agent',
      senderId: new Types.ObjectId(actor.userId),
      body,
      sentAt: new Date(),
    });

    this.emitMessageCreated(site._id.toString(), message);
    return message;
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
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);

    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'agent',
      senderId: new Types.ObjectId(actor.userId),
      body,
      sentAt: new Date(),
    });

    this.emitMessageCreated(site._id.toString(), message);

    const messagePayload = {
      id: message._id.toString(),
      conversationId: message.conversationId.toString(),
      senderType: message.senderType,
      senderId: message.senderId ? message.senderId.toString() : null,
      body: message.body,
      sentAt: message.sentAt.toISOString(),
    };
    this.realtimeEvents.emit({
      kind: 'agent.proactiveMessage',
      siteId: site._id.toString(),
      conversationId: conversation._id.toString(),
      visitorId: conversation.visitorId.toString(),
      message: messagePayload,
    });

    await this.auditLog.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'conversation.proactive_message_sent',
      siteId: site._id,
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
    body: string,
  ): Promise<MessageDocument> {
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
    if (conversation.status === 'closed') {
      conversation.status = 'open';
      conversation.closedAt = null;
      await conversation.save();
      await this.auditLog.record({
        actorType: 'visitor',
        actorId: visitor.visitorId,
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

    const message = await this.messageModel.create({
      conversationId: conversation._id,
      senderType: 'visitor',
      senderId: null,
      body,
      sentAt: new Date(),
    });

    this.emitMessageCreated(conversation.siteId.toString(), message);
    return message;
  }

  private emitMessageCreated(siteId: string, message: MessageDocument): void {
    this.realtimeEvents.emit({
      kind: 'message.created',
      siteId,
      conversationId: message.conversationId.toString(),
      message: {
        id: message._id.toString(),
        conversationId: message.conversationId.toString(),
        senderType: message.senderType,
        senderId: message.senderId ? message.senderId.toString() : null,
        body: message.body,
        sentAt: message.sentAt.toISOString(),
      },
    });
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
    return { conversation, messages };
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
  ): Promise<MessageDocument[]> {
    const site = await this.assertSite(actor, siteId);
    const conversation = await this.findConversationOnSite(
      site._id,
      conversationId,
    );
    await this.assertVisible(actor, site._id, conversation);
    return this.queryMessagesSince(conversation._id, since);
  }

  async getMessagesSinceForVisitor(
    visitor: AuthenticatedVisitor,
    conversationId: string,
    since: GetMessagesSinceQueryDto,
  ): Promise<MessageDocument[]> {
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
    return this.queryMessagesSince(conversation._id, since);
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
   * on a Conversation currently assigned to them. Applied uniformly to
   * every read/mutation on a specific Conversation (get, status, assign,
   * tag, message) — not just the list endpoint — so holding e.g.
   * `conversations.close` without `conversations.view_site` can never be
   * used to reach into a Conversation outside the caller's own scope.
   * 404 (not 403) on failure — same "don't reveal existence" stance
   * `UsersService`/`VisitorsService` already take for cross-Site access.
   */
  private async assertVisible(
    actor: AuthenticatedUser,
    siteId: Types.ObjectId,
    conversation: ConversationDocument,
  ): Promise<void> {
    const scope = await this.resolveScope(actor, siteId);
    if (scope.canViewSite) return;
    if (
      scope.canViewOwn &&
      conversation.assignedAgentId?.toString() === actor.userId
    ) {
      return;
    }
    throw new NotFoundException('Conversation not found on this Site.');
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

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
