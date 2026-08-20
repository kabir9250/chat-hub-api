import { Logger, OnModuleInit, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Model } from 'mongoose';
import { Server, Socket } from 'socket.io';

import { AppJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { WsVisitorGuard } from '../auth/guards/ws-visitor.guard';
import { User, UserDocument } from '../database/schemas';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import { ConversationsService } from '../conversations/conversations.service';
import { PageVisitsService } from '../page-visits/page-visits.service';
import { PresenceService, PresenceStatus } from './presence.service';
import { RealtimeEventsService } from './realtime-events.service';
import { VisitorPresenceService } from './visitor-presence.service';
import { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';
import {
  agentRoom,
  conversationRoom,
  RealtimeSocketData,
  siteRoom,
  visitorRoom,
} from './realtime.types';

const VIEW_PERMISSIONS = [
  'conversations.view_own',
  'conversations.view_site',
] as const;

// §6.3 "Rate limiting on ... message sending" — same limit for both sides
// of a conversation (30 messages/minute is generous for a human typing, but
// stops a scripted flood). See WsRateLimiterService's doc comment for why
// this is a small in-memory limiter rather than @nestjs/throttler (HTTP-only).
const MESSAGE_SEND_LIMIT = 30;
const MESSAGE_SEND_WINDOW_MS = 60_000;
const RATE_LIMIT_ERROR = {
  event: 'error',
  data: { message: 'Too many messages sent — please slow down.' },
} as const;

/**
 * RealtimeGateway — FR-MSG-01–06, FR-RTE-01–03, FR-AGT-02/03/04, §7.1/7.2.
 *
 * Every event here is scoped through the exact same building blocks the
 * REST layer (Session 7) uses — `PermissionGuard`/`@RequirePermission` for
 * Agent/Admin access, and `ConversationsService`'s own visitor-ownership
 * checks for Visitors. A WebSocket connection is NOT a separate, looser
 * security boundary (task guardrail) — see each handler below for exactly
 * which REST-layer check it reuses.
 *
 * Identity is established ONCE, in `handleConnection` (a Socket.IO
 * connection is long-lived, unlike an HTTP request) — see `WsJwtGuard`'s
 * doc comment for why this differs from the HTTP guard's per-request model.
 *
 * Hardening session addition: every message-sending handler (`agent:send_message`,
 * `agent:send_proactive_message`, `agent:start_proactive_conversation`,
 * `visitor:send_message`) is rate-limited via `WsRateLimiterService` (§6.3) —
 * see that service's doc comment for why this is a separate, small in-memory
 * limiter rather than reusing `@nestjs/throttler` (HTTP-only).
 *
 * Rooms (see realtime.types.ts for the name-builders):
 *   - `site:<siteId>`         — every connected User holding
 *                                `conversations.view_site` on that Site
 *                                (auto-joined on connect). Doubles as the
 *                                "Department broadcast room" for FR-RTE-02
 *                                — Phase 1 is "effectively one department
 *                                per Site" (SRS glossary), so a separate
 *                                `department:<id>` room would be a Site
 *                                room with the same membership; documented
 *                                simplification, see PROGRESS.md.
 *   - `conversation:<id>`     — Visitor (their own Conversation) + any
 *                                Agent/Admin who opened it, always via a
 *                                permission-checked `join_conversation`.
 *   - `agent:<userId>`        — every connected User's personal room, for
 *                                direct notifications (e.g. "assigned to
 *                                you", FR-AGT-04) and presence.set acks.
 *
 * CORS note (Session 9 bugfix): `@WebSocketGateway(options)` is a class
 * decorator, so its argument object is evaluated once, at module-import
 * time — BEFORE `ConfigModule`/dotenv has actually loaded `.env` into
 * `process.env` (that happens later, inside Nest's own DI bootstrap in
 * `NestFactory.create()`). A plain `origin: process.env.CORS_ORIGIN ?? '...'`
 * here therefore always evaluated the fallback, silently ignoring the real
 * configured origin — this went undetected through Session 8 because a
 * Node `socket.io-client` test script (no browser) is never subject to CORS
 * enforcement at all; it only surfaced once a real browser connected (this
 * session's Playwright/browser check against the actual widget). Fixed by
 * passing a `origin` FUNCTION instead — Socket.IO/`cors` package calls this
 * per-connection, at request time, by which `process.env.CORS_ORIGIN` is
 * genuinely populated. `main.ts`'s `app.enableCors(...)` (HTTP REST CORS)
 * was never affected — it reads `ConfigService.get('app.cors.origin')`
 * inside `bootstrap()`, which runs after Nest's config loading, not at
 * import time.
 */
@WebSocketGateway({
  cors: {
    origin: (
      _origin: string | undefined,
      callback: (err: Error | null, allow?: string) => void,
    ) => callback(null, process.env.CORS_ORIGIN ?? 'http://localhost:3000'),
  },
})
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly presenceService: PresenceService,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly conversationsService: ConversationsService,
    private readonly pageVisitsService: PageVisitsService,
    private readonly visitorPresenceService: VisitorPresenceService,
    private readonly wsRateLimiter: WsRateLimiterService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket gateway initialized');
  }

  /**
   * Bridges ConversationsService's domain events (emitted from BOTH the
   * REST layer and this gateway's own send_message handlers — see
   * RealtimeEventsService's doc comment) to actual Socket.IO room
   * broadcasts. One place, so a Conversation mutation is broadcast
   * identically no matter which transport triggered it.
   */
  onModuleInit() {
    this.realtimeEvents.subscribe((event) => {
      switch (event.kind) {
        case 'conversation.created':
          this.server
            .to(siteRoom(event.siteId))
            .emit('conversation:new', event);
          if (event.assignedAgentId) {
            this.server
              .to(agentRoom(event.assignedAgentId))
              .emit('conversation:assigned', event);
          }
          // else: FR-RTE-02 — no Agent available. The site room IS the
          // Department broadcast room in Phase 1 (see class doc comment),
          // so every Agent/Supervisor with view_site already just received
          // 'conversation:new' above with assignedAgentId: null.
          break;

        case 'conversation.updated':
          this.server
            .to(siteRoom(event.siteId))
            .emit('conversation:updated', event);
          this.server
            .to(conversationRoom(event.conversationId))
            .emit('conversation:updated', event);
          break;

        case 'message.created':
          this.server
            .to(conversationRoom(event.conversationId))
            .emit('message:new', event.message);
          // Lightweight nudge for anyone with the Site room open (e.g. an
          // inbox list showing a "last message" preview) without shipping
          // the full message body twice. `senderType` (this session's
          // addition) lets a listener tell a visitor-sent message apart
          // from an agent's own outgoing one without a second round-trip —
          // needed so the Inbox's new-message alert sound doesn't fire on
          // an agent's own sends.
          this.server.to(siteRoom(event.siteId)).emit('conversation:updated', {
            kind: 'conversation.updated',
            siteId: event.siteId,
            conversationId: event.conversationId,
            changeType: 'message',
            data: {
              messageId: event.message.id,
              senderType: event.message.senderType,
            },
          });
          break;

        // This session's additions — all three broadcast to ONLY the
        // `conversation:<id>` room, per requirement 3's "any Agent
        // currently viewing that Visitor's Conversation." Room membership
        // is exclusively granted by the permission-checked
        // handleAgentJoinConversation below, so this is the exact same
        // view-permission scoping every pre-existing conversation event
        // already relies on — no separate/parallel gating mechanism.
        case 'visitor.pageChanged':
          this.server
            .to(conversationRoom(event.conversationId))
            .emit('visitor.pageChanged', event);
          break;

        case 'visitor.profileUpdated':
          this.server
            .to(conversationRoom(event.conversationId))
            .emit('visitor.profileUpdated', event);
          break;

        case 'agent.proactiveMessage':
          // FR-RPT-07 fix — broadcast to the Visitor's PERSONAL room, not
          // the Conversation room. The original "Send anyway" case (an
          // existing Conversation the Visitor's widget already knows about)
          // would have worked fine on the Conversation room alone, but
          // `agent:start_proactive_conversation` creates a Conversation the
          // Visitor has never joined a room for — see visitorRoom's doc
          // comment. Every Visitor socket is a member of its own
          // visitorRoom unconditionally, so this reaches them regardless.
          this.server
            .to(visitorRoom(event.visitorId))
            .emit('agent.proactiveMessage', event.message);
          break;

        // This session's addition (FR-RPT-07, the live Visitors list) —
        // unlike visitor.pageChanged above (conversation-room-only, needs
        // an active Conversation to have anyone to send to),
        // visitor.siteActivity fires on EVERY PageVisit write regardless of
        // whether a Conversation exists yet, broadcast to the Site room so
        // VisitorsPanel can show "currently on: /pricing" for a Visitor who
        // hasn't started a chat. Same site-room scoping as
        // conversation.created/visitor.online — no new permission, just
        // ordinary Site-room membership (conversations.view_site holders
        // already auto-joined it on connect).
        case 'visitor.siteActivity':
          this.server
            .to(siteRoom(event.siteId))
            .emit('visitor.siteActivity', event);
          break;
      }
    });
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle — identity + presence + auto Site-room membership.
  // -----------------------------------------------------------------------

  async handleConnection(client: Socket) {
    const token = this.extractToken(client);
    if (!token) {
      this.rejectConnection(client, 'Missing auth token.');
      return;
    }

    let payload: AppJwtPayload;
    try {
      payload = this.jwtService.verify<AppJwtPayload>(token);
    } catch {
      this.rejectConnection(client, 'Invalid or expired token.');
      return;
    }

    if (payload.type === 'user') {
      await this.connectAsUser(client, payload.sub);
    } else if (payload.type === 'visitor') {
      const visitor: AuthenticatedVisitor = {
        visitorId: payload.sub,
        siteId: payload.siteId,
      };
      (client.data as RealtimeSocketData).visitor = visitor;
      // FR-RPT-07 fix — every Visitor socket joins its own personal room
      // unconditionally (mirrors `agentRoom` for Users), independent of
      // which specific Conversation room(s) it later joins. Needed because
      // `agent:start_proactive_conversation` creates a Conversation the
      // Visitor's widget has never heard of — there is no `conversation:<id>`
      // room to join yet, so a Conversation-room-only broadcast could never
      // reach it. See `agent.proactiveMessage`'s handling below.
      await client.join(visitorRoom(visitor.visitorId));
      // See VisitorPresenceService's doc comment for what "connected" means
      // here and why it's the right signal for task requirement 14's
      // "widget closed" affordance.
      const wentOnline = this.visitorPresenceService.addConnection(
        visitor.visitorId,
        visitor.siteId,
        client.id,
      );
      // FR-RPT-07 (this session) — the live Visitors list. Only broadcast on
      // an actual zero→one transition (see addConnection's doc comment);
      // same site-room-membership scoping every other Agent-facing event
      // already uses (auto-joined by connectAsUser above for any User
      // holding conversations.view_site).
      if (wentOnline) {
        this.server.to(siteRoom(visitor.siteId)).emit('visitor.online', {
          siteId: visitor.siteId,
          visitorId: visitor.visitorId,
          timestamp: new Date().toISOString(),
        });
      }
      this.logger.log(
        `Visitor ${visitor.visitorId} connected (${client.id}), site ${visitor.siteId}`,
      );
      client.emit('connected', {
        kind: 'visitor',
        visitorId: visitor.visitorId,
        siteId: visitor.siteId,
      });
    } else {
      this.rejectConnection(client, 'Unrecognized token type.');
    }
  }

  private async connectAsUser(client: Socket, userId: string): Promise<void> {
    // Same checks as JwtStrategy.validate() (Session 2) — re-load from the
    // DB rather than trust the token's claims, reject a disabled/deleted
    // User immediately (FR-USR-06).
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.enabled) {
      this.rejectConnection(client, 'User no longer valid.');
      return;
    }

    const authUser: AuthenticatedUser = {
      userId: user._id.toString(),
      organizationId: user.organizationId.toString(),
      email: user.email,
      displayName: user.displayName,
      fullName: user.fullName,
      enabled: user.enabled,
      status: user.status,
    };
    (client.data as RealtimeSocketData).user = authUser;

    await client.join(agentRoom(authUser.userId));
    const status = await this.presenceService.addConnection(
      authUser.userId,
      client.id,
    );

    // Requirement 2: auto-join the Site's broadcast room for every Site
    // where this User holds conversations.view_site (view_own alone does
    // NOT get the broadcast room — they only ever see specific
    // Conversations they open, via join_conversation below).
    const summary =
      await this.permissionsService.getEffectivePermissionsSummary(
        authUser.userId,
      );
    const joinedSiteIds: string[] = [];
    for (const [siteId, perms] of Object.entries(summary.sitePermissions)) {
      if (perms.includes('conversations.view_site')) {
        await client.join(siteRoom(siteId));
        joinedSiteIds.push(siteId);
      }
    }

    this.broadcastPresence(
      authUser.userId,
      status,
      Object.keys(summary.sitePermissions),
    );

    this.logger.log(
      `User ${authUser.email} connected (${client.id}), site rooms: [${joinedSiteIds.join(', ')}], presence: ${status}`,
    );
    client.emit('connected', {
      kind: 'user',
      userId: authUser.userId,
      siteRooms: joinedSiteIds,
      presence: status,
    });
  }

  async handleDisconnect(client: Socket) {
    const data = client.data as RealtimeSocketData | undefined;
    if (data?.user) {
      const status = await this.presenceService.removeConnection(
        data.user.userId,
        client.id,
      );
      if (status) {
        const summary =
          await this.permissionsService.getEffectivePermissionsSummary(
            data.user.userId,
          );
        this.broadcastPresence(
          data.user.userId,
          status,
          Object.keys(summary.sitePermissions),
        );
      }
      this.logger.log(`User ${data.user.email} disconnected (${client.id})`);
    } else if (data?.visitor) {
      const result = this.visitorPresenceService.removeConnection(
        data.visitor.visitorId,
        client.id,
      );
      if (result?.wentOffline) {
        this.server.to(siteRoom(result.siteId)).emit('visitor.offline', {
          siteId: result.siteId,
          visitorId: data.visitor.visitorId,
          timestamp: new Date().toISOString(),
        });
      }
      this.logger.log(
        `Visitor ${data.visitor.visitorId} disconnected (${client.id})`,
      );
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  private rejectConnection(client: Socket, message: string): void {
    this.logger.warn(`Connection rejected (${client.id}): ${message}`);
    client.emit('connect_error', { message });
    client.disconnect(true);
  }

  private extractToken(client: Socket): string | undefined {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token) return auth.token;

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === 'string') return queryToken;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

    return undefined;
  }

  private broadcastPresence(
    userId: string,
    status: PresenceStatus,
    siteIds: string[],
  ): void {
    for (const siteId of siteIds) {
      this.server.to(siteRoom(siteId)).emit('presence:update', {
        userId,
        status,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Agent/Admin-side handlers — identical PermissionGuard/@RequirePermission
  // pairing the REST layer uses (Session 3/7 contract).
  // -----------------------------------------------------------------------

  @SubscribeMessage('agent:join_site')
  @UseGuards(WsJwtGuard, PermissionGuard)
  @RequirePermission('conversations.view_site')
  async handleAgentJoinSite(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { siteId: string },
  ) {
    await client.join(siteRoom(data.siteId));
    return { event: 'joined_site', data: { siteId: data.siteId } };
  }

  /**
   * Requirement 2's "gated by the same view-permission check used in
   * Session 7's REST layer": PermissionGuard proves the caller holds AT
   * LEAST ONE of the two view keys (yes/no, same as `GET .../conversations/:id`).
   * `ConversationsService.findOne` then re-derives the actual scope exactly
   * like the REST handler does — a `view_own`-only Agent can only join a
   * room for a Conversation currently assigned to them, even though the
   * guard alone already let them through.
   */
  @SubscribeMessage('agent:join_conversation')
  @UseGuards(WsJwtGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  async handleAgentJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { siteId: string; conversationId: string },
  ) {
    const socketData = client.data as RealtimeSocketData;
    const { user } = socketData;
    try {
      const { conversation, messages, visitorOnline } =
        await this.conversationsService.findOne(
          user!,
          data.siteId,
          data.conversationId,
        );
      await client.join(conversationRoom(data.conversationId));

      // This session's addition — cache whether THIS socket holds
      // visitors.view_live_activity on this Conversation's Site, so
      // handleVisitorTypingDraft can filter per-recipient without a
      // PermissionsService round trip on every keystroke (see
      // RealtimeSocketData's doc comment).
      const canViewLiveActivity = await this.permissionsService.hasPermission(
        user!.userId,
        'visitors.view_live_activity',
        data.siteId,
      );
      if (!socketData.liveActivityConversations) {
        socketData.liveActivityConversations = new Set();
      }
      if (canViewLiveActivity) {
        socketData.liveActivityConversations.add(data.conversationId);
      } else {
        socketData.liveActivityConversations.delete(data.conversationId);
      }

      return {
        event: 'joined_conversation',
        data: { conversation, messages, visitorOnline },
      };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  @SubscribeMessage('agent:leave_conversation')
  @UseGuards(WsJwtGuard)
  async handleAgentLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    await client.leave(conversationRoom(data.conversationId));
    (client.data as RealtimeSocketData).liveActivityConversations?.delete(
      data.conversationId,
    );
    return {
      event: 'left_conversation',
      data: { conversationId: data.conversationId },
    };
  }

  /** Reuses ConversationsService.addAgentMessage — identical to the REST endpoint's persistence + scoping. */
  @SubscribeMessage('agent:send_message')
  @UseGuards(WsJwtGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  async handleAgentSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { siteId: string; conversationId: string; body: string },
  ) {
    const { user } = client.data as RealtimeSocketData;
    if (!data?.body?.trim()) {
      return { event: 'error', data: { message: 'body is required.' } };
    }
    if (
      !this.wsRateLimiter.consume(
        `agent:send_message:${user!.userId}`,
        MESSAGE_SEND_LIMIT,
        MESSAGE_SEND_WINDOW_MS,
      )
    ) {
      return RATE_LIMIT_ERROR;
    }
    try {
      const message = await this.conversationsService.addAgentMessage(
        user!,
        data.siteId,
        data.conversationId,
        data.body,
      );
      return {
        event: 'message_sent',
        data: { messageId: message._id.toString() },
      };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  /**
   * This session's addition (task requirement 6/14) — the "Send anyway"
   * flow for a Visitor whose widget session shows as closed
   * (`visitorOnline: false`, from `agent:join_conversation`'s response).
   * Same guard/permission pairing as `agent:send_message` above (sending a
   * proactive message is still just "acting on a Conversation you can
   * view") — reuses `ConversationsService.addAgentProactiveMessage`, which
   * persists via the identical Session 7 Message logic and additionally
   * emits `agent.proactiveMessage` (see that method's doc comment).
   */
  @SubscribeMessage('agent:send_proactive_message')
  @UseGuards(WsJwtGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  async handleAgentSendProactiveMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { siteId: string; conversationId: string; body: string },
  ) {
    const { user } = client.data as RealtimeSocketData;
    if (!data?.body?.trim()) {
      return { event: 'error', data: { message: 'body is required.' } };
    }
    if (
      !this.wsRateLimiter.consume(
        `agent:send_message:${user!.userId}`,
        MESSAGE_SEND_LIMIT,
        MESSAGE_SEND_WINDOW_MS,
      )
    ) {
      return RATE_LIMIT_ERROR;
    }
    try {
      const message = await this.conversationsService.addAgentProactiveMessage(
        user!,
        data.siteId,
        data.conversationId,
        data.body,
      );
      return {
        event: 'message_sent',
        data: { messageId: message._id.toString() },
      };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  /**
   * This session's addition (FR-RPT-07 — "usable to proactively start a
   * chat") — the counterpart to `agent:send_proactive_message` above for a
   * Visitor with NO Conversation at all yet (spotted live on VisitorsPanel,
   * never opened the widget's chat window). Same guard/permission pairing
   * (a Site-level view check, since there's no Conversation yet to check
   * visibility against) — `ConversationsService.startProactiveConversation`
   * creates the Conversation (self-assigned to the initiating Agent) and
   * then reuses `addAgentProactiveMessage`'s exact persistence + broadcast
   * path, so the Visitor sees the same proactive bubble either way.
   */
  @SubscribeMessage('agent:start_proactive_conversation')
  @UseGuards(WsJwtGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  async handleAgentStartProactiveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { siteId: string; visitorId: string; body: string },
  ) {
    const { user } = client.data as RealtimeSocketData;
    if (!data?.body?.trim()) {
      return { event: 'error', data: { message: 'body is required.' } };
    }
    if (
      !this.wsRateLimiter.consume(
        `agent:send_message:${user!.userId}`,
        MESSAGE_SEND_LIMIT,
        MESSAGE_SEND_WINDOW_MS,
      )
    ) {
      return RATE_LIMIT_ERROR;
    }
    try {
      const { conversation, message } =
        await this.conversationsService.startProactiveConversation(
          user!,
          data.siteId,
          data.visitorId,
          data.body,
        );
      return {
        event: 'proactive_conversation_started',
        data: {
          conversationId: conversation._id.toString(),
          messageId: message._id.toString(),
        },
      };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  /**
   * Typing indicator (FR-MSG-04). No DB/PermissionsService round-trip on
   * every keystroke — relayed only if the socket is already a member of
   * that Conversation's room, and room membership is ONLY ever granted by
   * the permission-checked join_conversation handler above. That's the
   * same effective-permission logic, just checked once at join time instead
   * of on every typing event (a deliberate, documented efficiency choice,
   * not a bypass of it).
   */
  @SubscribeMessage('agent:typing')
  @UseGuards(WsJwtGuard)
  handleAgentTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean },
  ) {
    const room = conversationRoom(data.conversationId);
    if (!client.rooms.has(room)) return;
    const { user } = client.data as RealtimeSocketData;
    client.to(room).emit('typing', {
      conversationId: data.conversationId,
      senderType: 'agent',
      senderId: user!.userId,
      isTyping: !!data.isTyping,
    });
  }

  /** FR-AGT-02 — Online/Away/Offline toggle. */
  @SubscribeMessage('agent:presence.set')
  @UseGuards(WsJwtGuard)
  async handleSetPresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { status: PresenceStatus },
  ) {
    if (!['online', 'away', 'offline'].includes(data?.status)) {
      return {
        event: 'error',
        data: { message: 'status must be online, away, or offline.' },
      };
    }
    const { user } = client.data as RealtimeSocketData;
    await this.presenceService.setStatus(user!.userId, data.status);
    const summary =
      await this.permissionsService.getEffectivePermissionsSummary(
        user!.userId,
      );
    this.broadcastPresence(
      user!.userId,
      data.status,
      Object.keys(summary.sitePermissions),
    );
    return { event: 'presence_set', data: { status: data.status } };
  }

  // -----------------------------------------------------------------------
  // Visitor-side handlers — no PermissionGuard (visitors hold no RBAC
  // permissions, by design); ownership is checked by ConversationsService
  // directly against the caller's verified visitor session (requirement 1).
  // -----------------------------------------------------------------------

  @SubscribeMessage('visitor:join_conversation')
  @UseGuards(WsVisitorGuard)
  async handleVisitorJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { visitor } = client.data as RealtimeSocketData;
    try {
      const { conversation, messages } =
        await this.conversationsService.getForVisitor(
          visitor!,
          data.conversationId,
        );
      await client.join(conversationRoom(data.conversationId));
      return { event: 'joined_conversation', data: { conversation, messages } };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  @SubscribeMessage('visitor:leave_conversation')
  @UseGuards(WsVisitorGuard)
  async handleVisitorLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    await client.leave(conversationRoom(data.conversationId));
    return {
      event: 'left_conversation',
      data: { conversationId: data.conversationId },
    };
  }

  @SubscribeMessage('visitor:send_message')
  @UseGuards(WsVisitorGuard)
  async handleVisitorSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; body: string },
  ) {
    const { visitor } = client.data as RealtimeSocketData;
    if (!data?.body?.trim()) {
      return { event: 'error', data: { message: 'body is required.' } };
    }
    if (
      !this.wsRateLimiter.consume(
        `visitor:send_message:${visitor!.visitorId}`,
        MESSAGE_SEND_LIMIT,
        MESSAGE_SEND_WINDOW_MS,
      )
    ) {
      return RATE_LIMIT_ERROR;
    }
    try {
      const message = await this.conversationsService.addVisitorMessage(
        visitor!,
        data.conversationId,
        data.body,
      );
      return {
        event: 'message_sent',
        data: { messageId: message._id.toString() },
      };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  @SubscribeMessage('visitor:typing')
  @UseGuards(WsVisitorGuard)
  handleVisitorTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean },
  ) {
    const room = conversationRoom(data.conversationId);
    if (!client.rooms.has(room)) return;
    const { visitor } = client.data as RealtimeSocketData;
    client.to(room).emit('typing', {
      conversationId: data.conversationId,
      senderType: 'visitor',
      senderId: visitor!.visitorId,
      isTyping: !!data.isTyping,
    });
  }

  /**
   * This session's addition (task requirements 2/3/8) — the SPA-route-
   * change entry point to PageVisitsService.recordPageChange (the full-
   * page-load entry point is VisitorSessionService.init, see
   * PageVisitsService's doc comment for why both call the same method).
   * No PermissionGuard (visitors hold no RBAC permissions, by design, same
   * as every other visitor:* handler) — `conversationId`, if given, is
   * re-verified against the caller's own siteId/visitorId inside
   * PageVisitsService before it's ever trusted as a broadcast target.
   */
  @SubscribeMessage('visitor:page_changed')
  @UseGuards(WsVisitorGuard)
  async handleVisitorPageChanged(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pageUrl: string; conversationId?: string },
  ) {
    const { visitor } = client.data as RealtimeSocketData;
    if (!data?.pageUrl) {
      return { event: 'error', data: { message: 'pageUrl is required.' } };
    }
    try {
      await this.pageVisitsService.recordPageChange({
        siteId: visitor!.siteId,
        visitorId: visitor!.visitorId,
        conversationId: data.conversationId,
        pageUrl: data.pageUrl,
      });
      return { event: 'page_change_recorded', data: {} };
    } catch (err) {
      return { event: 'error', data: { message: (err as Error).message } };
    }
  }

  /**
   * This session's addition (task requirement 5) — Visitor -> Agent-only,
   * FR-MSG's live draft-preview. Deliberately separate from `visitor:typing`
   * above (never merged, per the task's own guardrail) — this carries the
   * actual in-progress text, so it is gated specifically behind
   * `visitors.view_live_activity`, checked PER RECIPIENT at broadcast time
   * (`liveActivityConversations`, cached at join time — see
   * `handleAgentJoinConversation`) rather than via room membership alone —
   * room membership only proves `conversations.view_own`/`.view_site`,
   * which is NOT sufficient for this event (task guardrail: this is a
   * distinct, more sensitive permission). No persistence anywhere — this is
   * a live, ephemeral preview only, never stored as a Message or on the
   * Visitor record.
   */
  @SubscribeMessage('visitor:typing_draft')
  @UseGuards(WsVisitorGuard)
  async handleVisitorTypingDraft(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; text: string },
  ) {
    const room = conversationRoom(data.conversationId);
    if (!client.rooms.has(room)) return;
    const { visitor } = client.data as RealtimeSocketData;

    const payload = {
      conversationId: data.conversationId,
      visitorId: visitor!.visitorId,
      // Lightweight cap — this is a live preview, not a stored value, but
      // still worth bounding against an unreasonably large payload.
      text: typeof data.text === 'string' ? data.text.slice(0, 2000) : '',
      timestamp: new Date().toISOString(),
    };

    const sockets = await this.server.in(room).fetchSockets();
    for (const socket of sockets) {
      const socketData = socket.data as RealtimeSocketData;
      if (socketData.liveActivityConversations?.has(data.conversationId)) {
        socket.emit('visitor.typingDraft', payload);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Kept from the original scaffolding — proves basic reachability.
  // -----------------------------------------------------------------------
  @SubscribeMessage('ping')
  handlePing(): { event: 'pong'; data: { timestamp: string } } {
    return { event: 'pong', data: { timestamp: new Date().toISOString() } };
  }
}
