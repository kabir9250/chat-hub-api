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
