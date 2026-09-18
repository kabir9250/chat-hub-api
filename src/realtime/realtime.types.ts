import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';

/**
 * Shape attached to `client.data` once a connection has been authenticated
 * in `RealtimeGateway.handleConnection` — exactly one of `user`/`visitor` is
 * ever set for a given socket, mirroring the two mutually-exclusive JWT
 * "kinds" (`type: 'user'` vs `type: 'visitor'`) from Session 2. This is the
 * WebSocket equivalent of `req.user` (JwtAuthGuard) / `req.visitor`
 * (VisitorAuthGuard) for HTTP.
 */
export interface RealtimeSocketData {
  user?: AuthenticatedUser;
  visitor?: AuthenticatedVisitor;
  /** Stashed by PermissionGuard on success — see permission.guard.ts. */
  effectivePermissions?: string[];
  /**
   * Session Fix-11 — the Visitor's resolved client IP (see
   * `extractSocketIp`), captured once in `handleConnection` (a Socket.IO
   * connection is long-lived, unlike an HTTP request with its own `req` per
   * call) and read by `visitor:send_message` for
   * `IpVisitorIdentityGuardService`'s per-IP distinct-identity check. Only
   * ever set on a Visitor socket — Agents/Users are authenticated staff,
   * not the anonymous-identity-impersonation concern this guard targets.
   */
  clientIp?: string;
  /**
   * This session's addition — the set of `conversation:<id>` rooms (bare
   * conversationId, not the room-name string) THIS socket currently holds
   * `visitors.view_live_activity` on, cached at `agent:join_conversation`
   * time (and pruned on `agent:leave_conversation`) so `visitor:typing_draft`
   * can filter recipients per-socket without a PermissionsService round trip
   * on every keystroke. Only ever set on a User socket.
   */
  liveActivityConversations?: Set<string>;
}

export const siteRoom = (siteId: string): string => `site:${siteId}`;
/**
 * This session's addition (business decision — "on by default for all
 * Agent/Supervisor/Owner, not permission-bounded") — a separate, WIDER room
 * than `siteRoom` above. `siteRoom` membership is deliberately gated on
 * `conversations.view_site` (see `RealtimeGateway.connectAsUser`'s doc
 * comment) because it carries full Site-wide Conversation content (visitor
 * identity, message previews) that a `view_own`-only Agent must not see
 * beyond their own assigned Conversations — that scoping is intentional and
 * stays unchanged.
 *
 * `siteAlertRoom` is for the strictly-smaller set of "ambient awareness"
 * broadcasts that were never meant to be Site-tier-gated in the first
 * place — "a Visitor is on the site" (`visitor.online`/`.offline`/
 * `.siteActivity`) and "a Visitor sent a message somewhere on the site"
 * (the sound-only half of the `message.created` nudge) — every User with
 * ANY Site-scoped Conversation-view permission (`view_own` OR `view_site`)
 * joins it, so the live "visitor arrived"/"new message" alert sounds work
 * for every Agent/Supervisor/Owner by default, matching how
 * `visitors.view`-gated REST (`GET .../visitors/live`) already works for
 * all of them today. Every `siteRoom` member is necessarily also a
 * `siteAlertRoom` member (view_site implies "any permission"), so a
 * broadcast can safely target `siteAlertRoom` alone without a separate
 * `.to(siteRoom(...))` — see `RealtimeGateway`'s use sites.
 */
export const siteAlertRoom = (siteId: string): string => `site-alert:${siteId}`;
export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;
export const agentRoom = (userId: string): string => `agent:${userId}`;
/**
 * A Visitor's personal room — added alongside FR-RPT-07's
 * `agent:start_proactive_conversation` (a brand-new Conversation the
 * Visitor's widget has never joined a room for, unlike the "Send anyway"
 * case where the Visitor had already joined it at some point). Every
 * Visitor socket auto-joins its own room on connect (mirrors `agentRoom`
 * for Users), so `agent.proactiveMessage` can reach the Visitor regardless
 * of whether they happen to be a member of that specific Conversation's
 * room yet.
 */
export const visitorRoom = (visitorId: string): string =>
  `visitor:${visitorId}`;

/**
 * SRS Feature 4 (Team Panel, `internal-conversations` module) — one room per
 * 1:1 `InternalConversation`, keyed by the SAME sorted-pair id the
 * collection's own unique index already enforces
 * (`InternalConversationsService.findOrCreate` always writes
 * `participantIds` sorted), not the document's Mongo `_id`. Sorting the pair
 * before building the room name means both participants independently
 * compute the identical room string from nothing but the two user ids —
 * `agent:<userId>` (this file's `agentRoom`) already gives each of them a
 * personal room to receive the "you have a new internal conversation"
 * nudge; this room is for the conversation's own live traffic (messages,
 * read receipts) once a window is open, mirroring `conversationRoom` above
 * for visitor Conversations.
 */
export const internalConversationRoom = (
  userIdA: string,
  userIdB: string,
): string => {
  const [first, second] = [userIdA, userIdB].sort();
  return `internal-conversation:${first}:${second}`;
};
