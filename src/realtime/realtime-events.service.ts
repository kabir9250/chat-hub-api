import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

import type { ConversationStatus } from '../database/schemas';

export interface RealtimeMessagePayload {
  id: string;
  conversationId: string;
  senderType: 'visitor' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  sentAt: string;
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
    }
  | {
      kind: 'conversation.updated';
      siteId: string;
      conversationId: string;
      changeType: ConversationChangeType;
      data?: Record<string, unknown>;
    }
  | {
      kind: 'message.created';
      siteId: string;
      conversationId: string;
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
      timestamp: string;
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
