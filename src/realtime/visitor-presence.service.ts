import { Injectable } from '@nestjs/common';

/**
 * VisitorPresenceService — originally added for task requirement 14
 * (Agent Console): "a way for an Agent to send a message to a Visitor whose
 * session shows as 'widget closed'."
 *
 * Deliberately a much smaller sibling of `PresenceService` (Session 8, User
 * presence) — no Online/Away/Offline states, no DB persistence (a Visitor
 * has no `status` field to persist to, unlike User), just "does this
 * Visitor currently have at least one live WebSocket connection." A
 * Visitor's widget iframe connects its socket on load (before any
 * Conversation exists — see WidgetApp.tsx) and keeps it open for as long as
 * the tab/iframe is alive, independent of whether the chat WINDOW is
 * currently expanded or minimized to the launcher bubble — so "connected"
 * here is a proxy for "the browser tab is actually open right now," not for
 * the widget's own open/minimized UI state (which the server has no
 * visibility into and doesn't need to — see PROGRESS.md for why this is the
 * right signal for an explicit "Send anyway" affordance).
 *
 * Extended this session (FR-RPT-07, "Visitors" live list) to also track
 * WHICH Site each connected Visitor belongs to, and to report online/offline
 * *transitions* rather than just current state — `RealtimeGateway` uses the
 * transition booleans to decide whether a `visitor.online`/`visitor.offline`
 * broadcast is actually new information worth sending (a Visitor's widget
 * commonly holds more than one socket briefly during a reconnect; only the
 * very first/very last connection is a real state change).
 *
 * In-memory only, same Phase-1 "no Redis" posture as PresenceService — a
 * restart drops presence, which is acceptable for the same reasons already
 * documented for PresenceService (re-established on the next heartbeat/
 * reconnect, never a source of truth for anything persisted).
 */
@Injectable()
export class VisitorPresenceService {
  private readonly connections = new Map<string, Set<string>>();
  private readonly siteByVisitor = new Map<string, string>();

  /**
   * Registers a new socket for this Visitor. Returns `true` only when this
   * is the transition from zero → one connections (i.e. the Visitor just
   * became "online" and it's worth telling any Agent watching the site's
   * live Visitors list) — `false` for a second/third tab or a reconnect
   * that overlaps the old socket's disconnect.
   */
  addConnection(visitorId: string, siteId: string, socketId: string): boolean {
    let sockets = this.connections.get(visitorId);
    const wentOnline = !sockets || sockets.size === 0;
    if (!sockets) {
      sockets = new Set();
      this.connections.set(visitorId, sockets);
    }
    sockets.add(socketId);
    this.siteByVisitor.set(visitorId, siteId);
    return wentOnline;
  }

  /**
   * Unregisters a socket. Returns the Visitor's siteId plus whether this
   * was their LAST connection (`wentOffline: true`), or `null` if this
   * visitorId/socketId pair was never tracked (defensive — shouldn't
   * happen, but a stale/duplicate disconnect must never throw).
   */
  removeConnection(
    visitorId: string,
    socketId: string,
  ): { siteId: string; wentOffline: boolean } | null {
    const sockets = this.connections.get(visitorId);
    if (!sockets) return null;
    sockets.delete(socketId);
    const siteId = this.siteByVisitor.get(visitorId) ?? null;
    const wentOffline = sockets.size === 0;
    if (wentOffline) {
      this.connections.delete(visitorId);
      this.siteByVisitor.delete(visitorId);
    }
    return siteId ? { siteId, wentOffline } : null;
  }

  isConnected(visitorId: string): boolean {
    return (this.connections.get(visitorId)?.size ?? 0) > 0;
  }

  /** Every Visitor with at least one live socket on the given Site, right now. */
  getOnlineVisitorIds(siteId: string): string[] {
    const ids: string[] = [];
    for (const [visitorId, site] of this.siteByVisitor.entries()) {
      if (site === siteId && (this.connections.get(visitorId)?.size ?? 0) > 0) {
        ids.push(visitorId);
      }
    }
    return ids;
  }
}
