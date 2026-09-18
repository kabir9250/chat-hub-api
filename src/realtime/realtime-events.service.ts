import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

import type { ConversationStatus } from '../database/schemas';

/** Phase 2 §2.3/§3.9 (FR-P2-ATT-03/04/07/08) — `body` is nullable (an attachment-only message is valid) and `attachments` carries freshly-signed, short-lived URLs (never a stored/permanent one — see StorageService.getSignedUrl). */
export interface RealtimeAttachmentPayload {
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  url: string;
  thumbnailUrl: string | null;
}

export interface RealtimeMessagePayload {
  id: string;
  conversationId: string;
  senderType: 'visitor' | 'agent' | 'system';
  senderId: string | null;
  body: string | null;
  sentAt: string;
  attachments: RealtimeAttachmentPayload[];
  // Phase 2 §3.10 (FR-P2-READ-01/06) — the tick state an Agent-sent message
  // is in, carried on EVERY message payload (not just the initial
  // message:new) so a later delivered/read transition can be pushed to the
  // Agent Console by re-emitting the same shape (see 'message.updated'
  // below) — no new WebSocket event type, per SRS §5.2's own instruction.
  deliveredAt: string | null;
  readAt: string | null;
}

export type ConversationChangeType =
  'status' | 'assigned' | 'tag_added' | 'tag_removed' | 'reopened';

/**
 * Discriminated union of everything ConversationsService (and, this
 * session, PageVisitsService/VisitorSessionService/VisitorsService) can
 * announce. Every new event added this session follows the same
 * "conversation:<id> room, gated by whoever legitimately joined it" pattern
 * as the three original ones — see RealtimeGateway's onModuleInit switch,
 * the one place a `kind` here becomes an actual Socket.IO broadcast.
 */
export type RealtimeDomainEvent =
  | {
      kind: 'conversation.created';
      siteId: string;
      departmentId: string;
      conversationId: string;
      referenceNumber: string;
      status: ConversationStatus;
      assignedAgentId: string | null;
      visitorId: string;
      initialMessage?: string;
      /**
       * Agent-lock-fix — the `conversations.view_own`-only Users of this
       * Department who otherwise never join `siteRoom` (see
       * `siteAlertRoom`'s doc comment in `realtime.types.ts` for why that
       * stays true for everything else). Only ever populated when this
       * Conversation was created unassigned (`assignedAgentId: null` here)
       * — RealtimeGateway additionally pushes `conversation:new` to each
       * one's own `agentRoom`, which is what actually completes FR-RTE-02's
       * "visible to all Agents of that Department" for that role. Omitted
       * (not just empty) when the Conversation was auto-routed to someone
       * at creation — that case was never Department-broadcast and stays
       * exactly as private as it already was.
       */
      departmentQueueMemberIds?: string[];
    }
  | {
      kind: 'conversation.updated';
      siteId: string;
      conversationId: string;
      changeType: ConversationChangeType;
      data?: Record<string, unknown>;
      /** Agent-lock-fix — same purpose/condition as `conversation.created`'s
       * own field above, for a later change (e.g. the auto-claim/take-over
       * assigning it) to a Conversation that WAS created via that queue
       * (`Conversation.deptQueueVisible`). */
      departmentQueueMemberIds?: string[];
    }
  | {
      kind: 'message.created';
      siteId: string;
      conversationId: string;
      message: RealtimeMessagePayload;
      // Session Fix-09 (T-06 Findings #2/#3) — carried here (rather than
      // looked up again inside RealtimeGateway) since every caller of
      // ConversationsService's private `emitMessageCreated` already has the
      // Conversation document in hand. `referenceNumber` is always set
      // (cheap — already on the loaded Conversation doc); `visitorName` is
      // only populated by the visitor-send path (`addVisitorMessage`, which
      // already loads the Visitor doc for the banned check) — the two
      // agent-send paths omit it deliberately (not cheaply available there,
      // and functionally moot: the desktop-notification consumer of this
      // event, `useDesktopNotifications.ts`'s `handleUpdated`, only acts on
      // `data.senderType === 'visitor'` nudges in the first place).
      referenceNumber: string;
      visitorName?: string | null;
    }
  | {
      // Phase 2 §3.10 (FR-P2-READ-02–06) — a previously-created message's
      // `deliveredAt`/`readAt` just advanced (Visitor reconnected and picked
      // up a pending Sent message, or the Visitor's widget reported
      // conversation-foreground and one or more Delivered messages became
      // Read). Deliberately reuses `RealtimeMessagePayload` — the SAME shape
      // `message.created` broadcasts — and RealtimeGateway re-emits it on
      // the exact same `message:new` Socket.IO event (see its own doc
      // comment) rather than a new event name, so the Agent Console's
      // existing `message:new` listener just needs to upsert-by-id instead
      // of only-append. `visitorId` is carried so the gateway can exclude
      // the Visitor's OWN socket from this broadcast (`.except(visitorRoom(...))`)
      // — a tick-only update is never useful to the Widget (FR-P2-READ-07:
      // Agent-side only) and re-delivering it there would wrongly re-trigger
      // the Widget's own message:new side effects (unread badge/notification
      // sound) for a message it already has.
      kind: 'message.updated';
      siteId: string;
      conversationId: string;
      visitorId: string;
      message: RealtimeMessagePayload;
    }
  | {
      // FR-VIS-09/10-ish (this session): a Visitor navigated to a new
      // page/route. Only ever emitted when a conversationId is known (see
      // PageVisitsService.recordPageChange) — no conversation, nobody could
      // be viewing it, so nothing to broadcast.
      kind: 'visitor.pageChanged';
      siteId: string;
      conversationId: string;
      visitorId: string;
      newPage: string;
      previousPage: string | null;
      timestamp: string;
    }
  | {
      // FR-MSG-08-ish (this session): the pre-chat form was submitted, or
      // an Agent/Admin edited the Visitor record — the Visitor Info panel
      // should update without a manual refresh. `visitor` is the full raw
      // Visitor document (same shape ConversationsService.findOne's
      // populate('visitorId') already sends), so the Agent Console can
      // reuse its existing Visitor-mapping code unchanged.
      kind: 'visitor.profileUpdated';
      siteId: string;
      conversationId: string;
      visitor: Record<string, unknown>;
    }
  | {
      // FR-MSG-07-ish (this session): an Agent explicitly sent a message to
      // a Visitor whose widget session isn't currently connected ("Send
      // anyway"). Persisted via the same Message logic as a normal reply
      // (ConversationsService.addAgentMessage) — this is an ADDITIONAL,
      // separate broadcast so the Widget can distinguish "render as a
      // proactive bubble" from an ordinary message:new. A plain reply
      // inside an open chat never emits this.
      kind: 'agent.proactiveMessage';
      siteId: string;
      conversationId: string;
      // Added alongside FR-RPT-07 — RealtimeGateway broadcasts this to the
      // Visitor's personal room (`visitorRoom`), not the Conversation room,
      // since `agent:start_proactive_conversation` creates a Conversation
      // the Visitor's widget has never joined a room for. See
      // `visitorRoom`'s doc comment (realtime.types.ts).
      visitorId: string;
      message: RealtimeMessagePayload;
    }
  | {
      // FR-RPT-07 (this session) — the live Visitors list. Emitted on
      // EVERY PageVisitsService.recordPageChange call, regardless of
      // whether a conversationId is known (unlike visitor.pageChanged
      // above, which stays conversation-scoped-only) — this is what lets
      // an Agent see "Visitor X is currently on /pricing" for someone who
      // hasn't started a chat yet.
      kind: 'visitor.siteActivity';
      siteId: string;
      visitorId: string;
      conversationId: string | null;
      pageUrl: string;
      pageCategory: string | null;
      /** Visitors "Group by Page title" (this session) — see
       * `PageVisit.pageTitle`'s doc comment. */
      pageTitle: string | null;
      timestamp: string;
    }
  | {
      // Session Feature-1b-backend (SRS "12-zendesk-feature-parity" §1.2,
      // "Incoming visitor," sound-only) — fires on Visitor session init
      // (FR-VIS-01), before any Conversation exists, so an Agent watching
      // this Site can hear a chime the moment a new browser tab lands, not
      // only once a chat starts. Broadcast to `siteAlertRoom`, same
      // ambient-site-presence scoping as `visitor.siteActivity`/
      // `visitor.online` — no `conversations.view_site` permission gate,
      // every Agent/Supervisor/Owner already auto-joins that room.
      kind: 'visitor.incoming';
      siteId: string;
      visitorId: string;
      isReturningVisitor: boolean;
      timestamp: string;
    }
  | {
      // Session Feature-1b-backend — SRS §1.2 "Trigger activated"
      // (sound-only). A Trigger's condition/action evaluation happens
      // client-side in the Widget (see `chat-hub-web/src/widget/
      // triggers.ts`) — the server has no independent way to observe a
      // match — so this is relayed from a Visitor-originated WS event
      // (`visitor:trigger_activated`, RealtimeGateway) rather than raised
      // from server-side trigger logic the way every other event here is.
      // Re-validated against the real Trigger document (siteId + isEnabled)
      // before broadcast — see that handler's doc comment — so a
      // malicious/buggy Visitor client can't spam an arbitrary sound event.
      kind: 'trigger.activated';
      siteId: string;
      visitorId: string;
      triggerId: string;
      triggerName: string;
      timestamp: string;
    }
  | {
      // Session Feature-1b-backend — SRS §1.2 "Operating hours start/end"
      // (sound-only). Emitted when `RealtimeGateway`'s periodic sweep (the
      // SAME interval `sweepStaleVisitors` already runs on, per this
      // session's guardrail — no new scheduler) sees a Site's
      // `isWithinBusinessHours` result flip since its last tick, reusing
      // FR-HRS-01's own boundary computation (`business-hours.util.ts`)
      // rather than duplicating it.
      kind: 'businessHours.boundaryCrossed';
      siteId: string;
      nowOpen: boolean;
      timestamp: string;
    }
  | {
      // Session Feature-1c-backend — SRS §1.3 (Idle Timeout) triggers this
      // the moment a User's status auto-changes from inactivity; SRS §1.2's
      // "Status changes" desktop toggle (`User.notificationPreferences
      // .statusChanges`) and "Automatic status change" sound
      // (`.sounds.automaticStatusChange`) both listen for exactly this event
      // — see PresenceService.setIdleStatus, the only place this is ever
      // emitted. Personal, not Site-wide (broadcast to the User's own
      // `agentRoom`, same scoping `conversation.created`'s
      // `assignedAgentId` branch uses) — nobody but the affected Agent
      // themself should hear their own idle chime.
      kind: 'presence.autoStatusChanged';
      userId: string;
      status: 'away';
      previousStatus: 'online' | 'away' | 'offline';
      timestamp: string;
    }
  | {
      // SRS Feature 4 — a new InternalMessage was persisted. Deliberately
      // its own `kind` (not folded into `message.created` above) — an
      // InternalMessage has no `siteId`/Visitor at all, so it can't be
      // routed through any of the Site-scoped rooms every other case here
      // targets; RealtimeGateway instead broadcasts this to
      // `internalConversationRoom(participantIdA, participantIdB)` AND each
      // participant's own `agentRoom` (so the recipient's sidebar/unread
      // badge updates even if they don't have the conversation window open
      // — mirrors `conversation.created`'s `assignedAgentId` branch).
      kind: 'internalMessage.created';
      internalConversationId: string;
      participantIds: [string, string];
      message: {
        id: string;
        internalConversationId: string;
        senderId: string;
        body: string | null;
        attachments: RealtimeAttachmentPayload[];
        sentAt: string;
        deliveredAt: string | null;
        readAt: string | null;
      };
    }
  | {
      // SRS Feature 4 — symmetric read-receipt advance (deliveredAt/readAt)
      // on an existing InternalMessage. Reuses the SAME client event
      // `internalMessage.created` above already broadcasts (RealtimeGateway
      // re-emits it under the identical Socket.IO event name, same
      // "no new event type, client upserts by id" precedent
      // `message.updated` already established for visitor Conversations)
      // rather than inventing a second one.
      kind: 'internalMessage.updated';
      internalConversationId: string;
      participantIds: [string, string];
      message: {
        id: string;
        internalConversationId: string;
        senderId: string;
        body: string | null;
        attachments: RealtimeAttachmentPayload[];
        sentAt: string;
        deliveredAt: string | null;
        readAt: string | null;
      };
    };

/**
 * RealtimeEventsService — an in-process pub/sub bridge, nothing more than a
 * thin, typed wrapper around Node's built-in `EventEmitter`.
 *
 * Why this exists: `ConversationsService` (REST layer, Session 7) is where
 * Conversations/Messages actually get created/mutated — including the new
 * auto-routing logic and the WebSocket-originated message sends this
 * session adds (the gateway calls the SAME service methods REST does, per
 * the task's "reuse the Session 7 Message logic" instruction). Those
 * mutations need to reach `RealtimeGateway` so it can broadcast to the
 * right Socket.IO rooms. Having `ConversationsModule` import
 * `RealtimeModule` directly (to inject the gateway) would create a circular
 * module dependency, since `RealtimeModule` needs `ConversationsService` for
 * its own `join_conversation`/`send_message` handlers. Routing both
 * directions through this tiny, dependency-free event bus avoids the cycle
 * entirely — `ConversationsModule` and `RealtimeModule` both depend on this,
 * neither depends on the other.
 *
 * Deliberately NOT `@nestjs/event-emitter` (a new dependency) — Node's
 * built-in `EventEmitter` does everything needed here for one process, and
 * this stack already avoids adding infrastructure it doesn't strictly need
 * (§1.4/§6.2 — no Redis in Phase 1). If a real cross-process pub/sub layer
 * is ever introduced (Redis, Mongo Change Streams), THIS is the class that
 * would grow a network-backed implementation — every caller on both sides
 * already goes through this one seam.
 */
@Injectable()
export class RealtimeEventsService {
  private readonly emitter = new EventEmitter();
  private static readonly CHANNEL = 'realtime:domain-event';

  emit(event: RealtimeDomainEvent): void {
    this.emitter.emit(RealtimeEventsService.CHANNEL, event);
  }

  subscribe(handler: (event: RealtimeDomainEvent) => void): void {
    this.emitter.on(RealtimeEventsService.CHANNEL, handler);
  }
}
