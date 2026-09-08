import {
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
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
import { VisitorsService } from '../visitors/visitors.service';
import type { AttachmentRefInput } from '../storage/attachment.types';
import { PresenceService, PresenceStatus } from './presence.service';
import { RealtimeEventsService } from './realtime-events.service';
import { VisitorPresenceService } from './visitor-presence.service';
import { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';
import {
  IpVisitorIdentityGuardService,
  TOO_MANY_ACTIVE_SESSIONS_MESSAGE,
} from '../common/rate-limit/ip-visitor-identity-guard.service';
import { extractSocketIp } from '../attribution/extract-client-ip.util';
import { CONVERSATION_VIEW_PERMISSIONS } from '../conversations/conversations.constants';
import { WsHttpExceptionFilter } from './ws-http-exception.filter';
import {
  agentRoom,
  conversationRoom,
  RealtimeSocketData,
  siteAlertRoom,
  siteRoom,
  visitorRoom,
} from './realtime.types';

const VIEW_PERMISSIONS = CONVERSATION_VIEW_PERMISSIONS;

// §6.3 "Rate limiting on ... message sending" — per-identity message-volume
// cap, independent for each side of a conversation. See
// WsRateLimiterService's doc comment for why this is a small in-memory
// limiter rather than @nestjs/throttler (HTTP-only).
//
// Session Fix-11 (§6.3 business decision, PROGRESS.md) split what used to
// be one shared 30/min constant into two: the Agent cap is UNCHANGED
// (T-11-load.md Test 1 Finding #5 flagged the per-userId Agent cap as a
// separate capacity-planning question for the business, not something this
// session was asked to change). The Visitor cap was explicitly raised to
// 50/min — generous enough that a genuine single person typing quickly,
// even bursting 15-20 messages, is never blocked by it; real abuse
// protection against many DISTINCT visitor identities from one IP is now
// `IpVisitorIdentityGuardService`'s job below, a fully independent limiter.
const AGENT_MESSAGE_SEND_LIMIT = 30;
const VISITOR_MESSAGE_SEND_LIMIT = 50;
const MESSAGE_SEND_WINDOW_MS = 60_000;
const RATE_LIMIT_ERROR = {
  event: 'error',
  data: { message: 'Too many messages sent — please slow down.' },
} as const;
// Session Fix-11 — IpVisitorIdentityGuardService's rejection, surfaced as
// its own clear WS error event (never a silent drop), distinct from
// RATE_LIMIT_ERROR above since this is a different limiter for a different
// reason (too many DISTINCT identities from one IP, not one identity
// sending too fast).
const IP_IDENTITY_LIMIT_ERROR = {
  event: 'error',
  data: { message: TOO_MANY_ACTIVE_SESSIONS_MESSAGE },
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
 * Session Fix-11 addition: `visitor:send_message` additionally goes through
 * `IpVisitorIdentityGuardService` — a SECOND, fully independent limiter (not
 * a shared counter with the cap above) that only rejects the (N+1)th
 * DISTINCT Visitor identity active from one IP within a rolling window,
 * never a single identity's own message volume. See that service's doc
 * comment and PROGRESS.md (Session Fix-11) for the full design rationale.
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
 * `pingInterval`/`pingTimeout` (T-12 live-server QA fix): Socket.IO's own
 * defaults (25000ms/20000ms) leave up to ~45s before the server notices a
 * dead connection when it never gets an explicit close signal (network
 * drop, killed process/tab, a browser that skips `pagehide`) — measured
 * live on the deployed API, the real gap was even worse than that ceiling
 * suggests. Tightened here so that worst case is bounded much lower; this
 * is the SAFETY NET for disconnect detection — the primary signal for an
 * ordinary tab close is the widget's own explicit `pagehide` →
 * `socket.disconnect()` (see `WidgetApp.tsx`), which fires `handleDisconnect`
 * immediately rather than waiting on any timeout at all. Low enough to keep
 * "visitor closed the tab" latency tight, high enough (well above one full
 * interval+timeout) to tolerate a normal brief mobile-network hiccup
 * without a false "offline".
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
  // See the class doc comment ("pingInterval/pingTimeout") — was previously
  // unset (Socket.IO defaults 25000/20000, up to ~45s worst case).
  pingInterval: 10000,
  pingTimeout: 5000,
})
@UseFilters(WsHttpExceptionFilter)
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  // Heartbeat/TTL presence sweep (see VisitorPresenceService's doc comment
  // for the live-server bug this closes) — Zendesk-style self-healing: the
  // widget pings every HEARTBEAT_INTERVAL_MS-ish, and anyone whose last
  // heartbeat is older than STALE_THRESHOLD_MS gets force-expired here even
  // if their socket's own `disconnect` event never fired. Threshold is a
  // few heartbeat intervals' worth of slack — well above the ~15s
  // pingInterval/pingTimeout safety net above already covers, so this sweep
  // only ever catches the case that safety net itself missed, not ordinary
  // network hiccups.
  private static readonly STALE_VISITOR_THRESHOLD_MS = 60_000;
  private static readonly STALE_SWEEP_INTERVAL_MS = 30_000;
  private staleSweepTimer?: ReturnType<typeof setInterval>;

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
    private readonly visitorsService: VisitorsService,
    private readonly wsRateLimiter: WsRateLimiterService,
    private readonly ipVisitorIdentityGuard: IpVisitorIdentityGuardService,
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
          //
          // Agent-lock-fix — a `conversations.view_own`-only Agent never
          // joins `siteRoom` (see `siteAlertRoom`'s doc comment) and so
          // would never have learned this unassigned Conversation exists at
          // all. `departmentQueueMemberIds` (only ever populated for this
          // exact case — see ConversationsService.create) closes that gap
          // by pushing the same event straight to each such Agent's own
          // `agentRoom`, one Socket.IO room this file has always had.
          this.emitToDepartmentQueueMembers(event, 'conversation:new');
          break;

        case 'conversation.updated':
          this.server
            .to(siteRoom(event.siteId))
            .emit('conversation:updated', event);
          this.server
            .to(conversationRoom(event.conversationId))
            .emit('conversation:updated', event);
          // Agent-lock-fix — same gap as above: keeps the "Assign To" column
          // live for every Agent who was in the Department queue for this
          // Conversation, not just whoever holds `conversations.view_site`.
          this.emitToDepartmentQueueMembers(event, 'conversation:updated');
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
          //
          // Session Fix-09 (T-06 Findings #2/#3): also carries
          // `referenceNumber` + the Visitor's name (if known) — the same
          // fields `conversation:new`/`conversation:assigned` already send
          // — so `useDesktopNotifications.ts`'s `resolveTitle` can show the
          // real FR-P2-ID-01 name-or-reference-number label for a
          // message-received notification even when no floating window has
          // ever been opened for this Conversation this session, instead of
          // falling back to the raw Mongo id. `data.bodyPreview`/
          // `.hasAttachments` similarly let the notification body
          // distinguish a text message from an attachment-only one
          // (FR-P2-ATT-07). `bodyPreview` is deliberately TRUNCATED
          // (`truncateForNotification`, never the full body) — this event
          // still fans out to the whole Site room, not just whoever has
          // this Conversation open, so it stays the same "lightweight
          // nudge" it always was.
          //
          // This session's addition — targets `siteAlertRoom`, not
          // `siteRoom`: business decision, the "new message" ALERT SOUND
          // (Inbox.tsx's `onUpdated` handler below) must reach every
          // Agent/Supervisor/Owner by default, not just `view_site`
          // holders (see `siteAlertRoom`'s doc comment). Every `siteRoom`
          // member is also a `siteAlertRoom` member, so this single target
          // still reaches exactly who it always did, plus everyone new.
          this.server
            .to(siteAlertRoom(event.siteId))
            .emit('conversation:updated', {
              kind: 'conversation.updated',
              siteId: event.siteId,
              conversationId: event.conversationId,
              changeType: 'message',
              referenceNumber: event.referenceNumber,
              visitor: { name: event.visitorName ?? null },
              data: {
                messageId: event.message.id,
                senderType: event.message.senderType,
                bodyPreview: this.truncateForNotification(event.message.body),
                hasAttachments: event.message.attachments.length > 0,
              },
            });
          break;

        // Session 11.3's additions — broadcast to ONLY the
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

        // FR-P2-ID-02 (P2-6 addendum) — ALSO fanned out to the `site:<id>`
        // room, not just `conversation:<id>` any more. Session 11.3 only
        // needed this to reach an Agent already looking at that one
        // Conversation (the Visitor Info panel); FR-P2-ID-02 additionally
        // needs the Inbox list and any open floating-window title bar to
        // pick up a Visitor's newly-captured name live even when nobody has
        // that specific Conversation open (an agent scanning the Inbox
        // never joins `conversation:<id>` — only Site-room membership,
        // auto-granted on connect). Exactly the same double-broadcast shape
        // `conversation.updated` already uses just above — Socket.IO's
        // `.to(a).to(b)` unions the two rooms' sockets and emits once per
        // socket, so an Agent who happens to be in both (has the
        // Conversation open AND holds Site-wide view) still gets exactly
        // one event, not two.
        case 'visitor.profileUpdated':
          this.server
            .to(conversationRoom(event.conversationId))
            .to(siteRoom(event.siteId))
            .emit('visitor.profileUpdated', event);
          break;

        // Phase 2 §3.10 (FR-P2-READ-02–06) — a message's deliveredAt/readAt
        // just advanced. Reuses the SAME `message:new` client event
        // `message.created` above already broadcasts (SRS §5.2: "no new
        // event type") — the Agent Console's listener upserts by id, so
        // this just refreshes the tick icons on an already-rendered
        // message. `.except(visitorRoom(...))` keeps this OFF the Visitor's
        // own socket(s): the Widget shows no read-receipt UI at all
        // (FR-P2-READ-07), and re-delivering `message:new` there would
        // wrongly re-trigger ITS OWN unread-badge/notification-sound side
        // effects for a message it already has.
        case 'message.updated':
          this.server
            .to(conversationRoom(event.conversationId))
            .except(visitorRoom(event.visitorId))
            .emit('message:new', event.message);
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
        // This session's addition — retargeted from `siteRoom` to
        // `siteAlertRoom` (business decision, see that room's doc
        // comment): "currently on: /pricing" for the live Visitors list is
        // ambient site-presence info, not Conversation content, so it's
        // available to every Agent/Supervisor/Owner by default too, not
        // just `view_site` holders.
        case 'visitor.siteActivity':
          this.server
            .to(siteAlertRoom(event.siteId))
            .emit('visitor.siteActivity', event);
          break;
      }
    });

    this.staleSweepTimer = setInterval(() => {
      void this.sweepStaleVisitors();
    }, RealtimeGateway.STALE_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
  }

  /**
   * The self-healing half of the heartbeat mechanism (see the class doc
   * comment + VisitorPresenceService's doc comment for the bug this fixes).
   * Runs on its own timer, independent of any one socket's lifecycle —
   * force-expires any Visitor whose last heartbeat is stale, using the same
   * "wentOffline" side effects `handleDisconnect`'s visitor branch already
   * performs (offline broadcast + close the open PageVisit), so an agent
   * watching the live list sees exactly the same result whether the
   * Visitor's tab closed cleanly or just vanished.
   */
  private async sweepStaleVisitors(): Promise<void> {
    const stale = this.visitorPresenceService.getStaleVisitorIds(
      RealtimeGateway.STALE_VISITOR_THRESHOLD_MS,
    );
    for (const { visitorId, siteId } of stale) {
      const result = this.visitorPresenceService.forceExpire(visitorId);
      if (!result) continue;
      // Best-effort: also drop any socket(s) still registered in this
      // Visitor's room (a genuinely dead/orphaned connection that never
      // fired `disconnect`) so a later stray event from it can't resurrect
      // presence for an id we just declared offline.
      this.server.in(visitorRoom(visitorId)).disconnectSockets(true);
      this.server.to(siteAlertRoom(result.siteId)).emit('visitor.offline', {
        siteId: result.siteId,
        visitorId,
        timestamp: new Date().toISOString(),
      });
      try {
        await this.pageVisitsService.closeOpenPageVisitOnDisconnect(visitorId);
      } catch (err) {
        this.logger.warn(
          `Failed to close out PageVisit on stale-visitor expiry: ${(err as Error).message}`,
        );
      }
      this.logger.log(
        `Visitor ${visitorId} force-expired (stale heartbeat, site ${siteId})`,
      );
    }
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
      // Session Fix-11 — resolved once here (not re-derived per message;
      // see RealtimeSocketData's own doc comment) for
      // IpVisitorIdentityGuardService's per-IP distinct-identity check on
      // visitor:send_message below.
      (client.data as RealtimeSocketData).clientIp = extractSocketIp(client);
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
        // Perf fix (direct user feedback — the live Visitors table was slow
        // to show a new arrival despite this being a real-time socket
        // broadcast). The delay was never this event — it fired the instant
        // the socket connected — it was that this payload used to carry no
        // Visitor data, just a "something changed" nudge, so
        // `VisitorsPanel.tsx` had to debounce 300ms then re-fetch the WHOLE
        // live list over REST just to learn about the one new arrival.
        // Attaching the finished row here lets the frontend splice it
        // straight into state with no refetch at all. `null` (banned
        // Visitor, or a delete-between-connect-and-lookup race) tells the
        // frontend to fall back to its own refetch instead.
        const liveVisitor = await this.visitorsService
          .getLiveVisitor(visitor.visitorId, visitor.siteId)
          .catch(() => null);
        // This session's addition — retargeted from `siteRoom` to
        // `siteAlertRoom` (business decision: "visitor arrived" alert
        // sound must work by default for every Agent/Supervisor/Owner, not
        // only `conversations.view_site` holders — see that room's doc
        // comment).
        this.server.to(siteAlertRoom(visitor.siteId)).emit('visitor.online', {
          siteId: visitor.siteId,
          visitorId: visitor.visitorId,
          timestamp: new Date().toISOString(),
          visitor: liveVisitor,
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
      notificationPreferences: {
        desktopEnabled: user.notificationPreferences.desktopEnabled,
        soundEnabled: user.notificationPreferences.soundEnabled,
      },
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
      // This session's addition — EVERY Site this User has any role
      // assignment on (Agent's `view_own` included) joins the alert room,
      // unconditionally: see `siteAlertRoom`'s doc comment for why this
      // one is deliberately not gated behind `view_site` the way the room
      // above is.
      await client.join(siteAlertRoom(siteId));
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
        // Same `siteAlertRoom` retarget as the `visitor.online` emit above
        // — keep the pair symmetric.
        this.server.to(siteAlertRoom(result.siteId)).emit('visitor.offline', {
          siteId: result.siteId,
          visitorId: data.visitor.visitorId,
          timestamp: new Date().toISOString(),
        });
        // T-05 TC-05.3b fix — SRS §4.4a lists "closes the tab" as one of
        // PageVisit's three closing triggers; `wentOffline` (zero
        // connections remaining, just computed above by
        // VisitorPresenceService) is exactly that signal, already
        // available at this call site — no separate disconnect-detection
        // needed. See PageVisitsService.closeOpenPageVisitOnDisconnect's
        // own doc comment for the closing/capping logic (shared with the
        // navigate-away path) and for why this can't double-close a
        // PageVisit a racing page-change already closed. Best-effort: a
        // failure here must never block the rest of disconnect handling —
        // the presence broadcast above has already gone out regardless.
        try {
          await this.pageVisitsService.closeOpenPageVisitOnDisconnect(
            data.visitor.visitorId,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to close out PageVisit on visitor disconnect: ${(err as Error).message}`,
          );
        }
      }
      this.logger.log(
        `Visitor ${data.visitor.visitorId} disconnected (${client.id})`,
      );
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  /**
   * Agent-lock-fix — pushes `event` directly to every id in
   * `event.departmentQueueMemberIds` (`conversations.view_own`-only Agents
   * who never join `siteRoom`), one `agentRoom` at a time. A no-op when the
   * field is absent/empty (every event kind not tied to a Department-queue
   * Conversation, and the common case of a Conversation that was auto-
   * routed to someone at creation and never Department-broadcast at all).
   */
  private emitToDepartmentQueueMembers(
    event: { departmentQueueMemberIds?: string[] },
    eventName: string,
  ): void {
    for (const userId of event.departmentQueueMemberIds ?? []) {
      this.server.to(agentRoom(userId)).emit(eventName, event);
    }
  }

  private rejectConnection(client: Socket, message: string): void {
    this.logger.warn(`Connection rejected (${client.id}): ${message}`);
    // PRODUCTION BUGFIX (found live on chat-hub-api-cuwc.onrender.com — this
    // was crashing the ENTIRE process on every socket connection carrying an
    // invalid/expired token, a crash loop, not a cold-start delay).
    // `connect_error` is one of Socket.IO's RESERVED_EVENTS (connect,
    // connect_error, disconnect, disconnecting, newListener, removeListener)
    // — the server SDK throws synchronously if you `.emit()` it manually
    // (it's meant to be generated internally by the client on a genuine
    // handshake-level failure, e.g. a connection `io.use()` middleware
    // calling `next(err)`; by the time `handleConnection` runs here the
    // transport-level connection has already succeeded, so this was never
    // going to reach the client as a real `connect_error` event anyway —
    // dead, and actively fatal, code). No client anywhere in this repo ever
    // listened for a server-emitted `connect_error` payload (confirmed via
    // repo-wide search), so this was pure liability with no working
    // consumer. Renamed to a real, non-reserved event name so the original
    // intent (a client-visible rejection reason) is preserved for any
    // future listener, without the crash.
    client.emit('auth_error', { message });
    client.disconnect(true);
  }

  /**
   * Session Fix-09 (T-06 Findings #2/#3) — a short, desktop-notification-
   * sized preview of a message body for the `message.created` case's
   * `conversation:updated` nudge above. Deliberately truncated rather than
   * passing the full body through: that broadcast still fans out to the
   * whole Site room (task guardrail — keep the notification reasonably
   * short, it's an OS notification, not a transcript preview). `null`/empty
   * body (an attachment-only message, FR-P2-ATT-07) passes through as
   * `null` so the frontend can tell "no text" apart from "text that happens
   * to be short" and fall back to its own "sent an attachment" copy.
   */
  private truncateForNotification(body: string | null): string | null {
    const trimmed = body?.trim();
    if (!trimmed) return null;
    const maxLength = 80;
    return trimmed.length > maxLength
      ? `${trimmed.slice(0, maxLength)}…`
      : trimmed;
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
   * Phase 2, FR-P2-SITE-04 — "a client requesting combined/multi-site mode
   * joins rooms for every Site it's authorized on, and receives
   * new-conversation/new-message events from any of them." Resolves the
   * authorized Site set the exact same way the REST combined endpoints do
   * (`PermissionsService.getAuthorizedSites`, `CONVERSATION_VIEW_PERMISSIONS`)
   * — no separate authorization path.
   *
   * Only actually JOINS the `site:<siteId>` room for Sites where the caller
   * holds `conversations.view_site` — `connectAsUser` above already
   * auto-joins those unconditionally on connect (this handler mostly just
   * re-confirms/documents that coverage and acks it back to the client);
   * it's included here mainly for Sites the caller reaches via a
   * SITE-scoped assignment made *after* this socket connected, without
   * requiring a reconnect.
   *
   * Deliberately does NOT join the Site room for a `view_own`-only Site: the
   * `site:<siteId>` room broadcasts `conversation:new`/`conversation:updated`
   * for EVERY Conversation on that Site, including ones not assigned to the
   * caller — joining it would hand a `view_own`-only holder visibility (new
   * Visitor id, initial message, other Agents' assignments) beyond what
   * `ConversationsService.assertVisible`/`findAllCombined` ever grant them
   * over REST, a real RBAC-scope regression, not just an oversight. Nothing
   * is actually lost for those Sites: a Conversation later assigned to this
   * caller already reaches them via their personal `agent:<userId>` room
   * (`conversation:assigned`, unconditional, any Site) regardless of Site-room
   * membership, and any Conversation they explicitly open is covered by the
   * existing permission-checked `agent:join_conversation` → `conversation:<id>`
   * room — exactly the same two mechanisms the single-Site case already
   * relies on for a `view_own`-only caller. See PROGRESS.md for the full
   * write-up of this scope decision.
   */
  @SubscribeMessage('agent:join_combined')
  @UseGuards(WsJwtGuard)
  async handleAgentJoinCombined(@ConnectedSocket() client: Socket) {
    const { user } = client.data as RealtimeSocketData;
    const authorizedSites = await this.permissionsService.getAuthorizedSites(
      user!.userId,
      [...VIEW_PERMISSIONS],
    );

    const siteRoomsJoined: string[] = [];
    for (const site of authorizedSites) {
      if (site.permissions.includes('conversations.view_site')) {
        await client.join(siteRoom(site.siteId));
        siteRoomsJoined.push(site.siteId);
      }
      // Same unconditional alert-room join as `connectAsUser` — every Site
      // this call resolved at all (view_own included) gets the "visitor
      // arrived"/"new message" alert sounds by default. See
      // `siteAlertRoom`'s doc comment.
      await client.join(siteAlertRoom(site.siteId));
    }

    return {
      event: 'joined_combined',
      data: {
        authorizedSiteIds: authorizedSites.map((s) => s.siteId),
        siteRoomsJoined,
      },
    };
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
    data: {
      siteId: string;
      conversationId: string;
      body?: string;
      // Phase 2 §3.9 (FR-P2-ATT-01/06/07) — attachments already uploaded via
      // POST .../attachments a moment earlier; see AttachmentRefDto.
      attachments?: AttachmentRefInput[];
    },
  ) {
    const { user } = client.data as RealtimeSocketData;
    if (!data?.body?.trim() && !data?.attachments?.length) {
      return {
        event: 'error',
        data: {
          message: 'A message must include text or at least one attachment.',
        },
      };
    }
    if (
      !this.wsRateLimiter.consume(
        `agent:send_message:${user!.userId}`,
        AGENT_MESSAGE_SEND_LIMIT,
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
        data.attachments,
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
        AGENT_MESSAGE_SEND_LIMIT,
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
        AGENT_MESSAGE_SEND_LIMIT,
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
    @MessageBody()
    data: {
      conversationId: string;
      body?: string;
      // Phase 2 §3.9 (FR-P2-ATT-02/06/07).
      attachments?: AttachmentRefInput[];
    },
  ) {
    const { visitor } = client.data as RealtimeSocketData;
    if (!data?.body?.trim() && !data?.attachments?.length) {
      return {
        event: 'error',
        data: {
          message: 'A message must include text or at least one attachment.',
        },
      };
    }
    if (
      !this.wsRateLimiter.consume(
        `visitor:send_message:${visitor!.visitorId}`,
        VISITOR_MESSAGE_SEND_LIMIT,
        MESSAGE_SEND_WINDOW_MS,
      )
    ) {
      return RATE_LIMIT_ERROR;
    }
    // Session Fix-11 (§6.3 business decision) — SEPARATE, independent
    // limiter from the per-Visitor-identity cap just above: this one only
    // cares how many DIFFERENT Visitor identities have been active from
    // this socket's IP within the rolling window, not this identity's own
    // message volume (which the check above already governs on its own).
    // See IpVisitorIdentityGuardService's doc comment for the full design.
    const { clientIp } = client.data as RealtimeSocketData;
    if (
      !this.ipVisitorIdentityGuard.checkAndRegister(
        clientIp,
        visitor!.visitorId,
      )
    ) {
      return IP_IDENTITY_LIMIT_ERROR;
    }
    try {
      const message = await this.conversationsService.addVisitorMessage(
        visitor!,
        data.conversationId,
        data.body,
        data.attachments,
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
   * Heartbeat/TTL presence (see class + VisitorPresenceService doc comments)
   * — the widget pings this on an interval over its already-open socket for
   * as long as the tab is alive. No-op response, no permission check (same
   * posture as every other `visitor:*` handler): this only ever refreshes
   * the caller's OWN presence timestamp, nothing else.
   */
  @SubscribeMessage('visitor:heartbeat')
  @UseGuards(WsVisitorGuard)
  handleVisitorHeartbeat(@ConnectedSocket() client: Socket) {
    const { visitor } = client.data as RealtimeSocketData;
    this.visitorPresenceService.touchHeartbeat(visitor!.visitorId);
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
   * Phase 2 §3.10 (FR-P2-READ-03) — the widget's "conversation foreground"
   * signal (open + tab in the foreground, per the Page Visibility API),
   * piggybacked on this existing connection rather than a new channel (SRS
   * §5.2 leaves the exact implementation to engineering; PROGRESS.md notes
   * the choice). No PermissionGuard — same posture as every other
   * `visitor:*` handler — `assertVisitorConversationAccess` (inside
   * `setConversationForeground`) re-verifies this Conversation actually
   * belongs to the caller's own verified visitor session before touching
   * anything.
   *
   * On `foreground: true`, `ConversationsService.setConversationForeground`
   * both records the flag (for the NEXT agent-sent message to arrive
   * already-Read, per `addAgentMessage`'s own check) and immediately marks
   * every currently-delivered, unread message in this Conversation as read
   * right now — covering the "was already foregrounded when the message
   * arrived" case too, since sending a fresh foreground:true is not the only
   * moment a message can appear.
   */
  @SubscribeMessage('visitor:conversation_foreground')
  @UseGuards(WsVisitorGuard)
  async handleVisitorConversationForeground(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; foreground: boolean },
  ) {
    const { visitor } = client.data as RealtimeSocketData;
    if (!data?.conversationId) {
      return {
        event: 'error',
        data: { message: 'conversationId is required.' },
      };
    }
    try {
      await this.conversationsService.setConversationForeground(
        visitor!,
        data.conversationId,
        !!data.foreground,
      );
      return {
        event: 'conversation_foreground_ack',
        data: {
          conversationId: data.conversationId,
          foreground: !!data.foreground,
        },
      };
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
