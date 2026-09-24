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
 *
 * Phase 2 §3.10 (FR-P2-READ-03) addition — `foregroundConversation` tracks,
 * per Visitor, WHICH Conversation (if any) their widget currently reports as
 * "open + tab in the foreground" (the Page Visibility API signal the widget
 * emits over its existing socket — see RealtimeGateway's
 * `visitor:conversation_foreground` handler). Same in-memory, no-DB posture
 * as the connection-tracking above: this is live "is anyone looking at this
 * right now" state, never a source of truth for anything persisted (`readAt`
 * itself IS the persisted fact, written once via ConversationsService when
 * this flips true).
 */
@Injectable()
export class VisitorPresenceService {
  private readonly connections = new Map<string, Set<string>>();
  private readonly siteByVisitor = new Map<string, string>();
  private readonly foregroundConversation = new Map<string, string>();
  // Heartbeat/TTL reconciliation (Zendesk-style self-healing presence) — see
  // RealtimeGateway's `visitor:heartbeat` handler + sweep interval for why
  // this exists: `removeConnection` below only clears an entry when a real
  // Socket.IO `disconnect` event fires for every one of a Visitor's sockets,
  // but a live-server case (id ending 737d6595, found investigating a user
  // report) showed that event can simply never arrive — the socket dies
  // without a clean close/FIN and the process never learns about it — which
  // left that Visitor "online" in this Map indefinitely, forever, with no
  // way to self-correct. The widget now pings this over its existing socket
  // every ~20s (see WidgetApp.tsx); the sweep in RealtimeGateway force-
  // expires anyone whose last heartbeat is older than its threshold, closing
  // the same gap `disconnect` was supposed to but sometimes doesn't.
  private readonly lastHeartbeatAt = new Map<string, number>();
  // "Online" column fix (Agent Console Visitors list) — the live list used
  // to display `Visitor.firstSeenAt` (the Visitor document's one-time
  // creation timestamp, set once ever and never updated again) as if it
  // were "how long has this session been open," so a returning visitor who
  // reconnected seconds ago still showed hours/days of "Online" time.
  // Tracked here instead, alongside the rest of in-memory presence: set on
  // the zero→one (`wentOnline`) transition in `addConnection`, cleared
  // whenever the Visitor goes fully offline (`removeConnection`/
  // `forceExpire`) so the NEXT reconnect gets a fresh "online since now."
  private readonly connectedAt = new Map<string, number>();

  /**
   * Visit-end grace timer (direct user feedback — "agent still typing into
   * the previous visit's chat after the visitor comes back"). A raw
   * zero-connections transition is deliberately NOT treated as "the visit is
   * over" — see `VisitorSessionService.closeChatsForEndedVisit`'s own
   * doc comment on why a bare disconnect isn't proof (flaky connection,
   * laptop lid, a frozen background tab all disconnect too, then reconnect
   * moments later on their own). One timer per Visitor: started on the
   * transition to zero connections, cancelled by the next `addConnection`
   * for that same Visitor (ordinary reconnect, or a genuine second tab —
   * either way the visit is still live), and only actually reported to
   * `visitEndedHandlers` if it fires uninterrupted. This replaces the old
   * approach of guessing at `init()` time (`isConnected` + a 1.5s recheck)
   * with an authoritative fact the presence layer itself now owns.
   */
  private readonly visitEndTimers = new Map<string, NodeJS.Timeout>();

  /** How long a Visitor may have zero live sockets before the visit is
   * considered actually over. Comfortably longer than the gateway's own
   * `pingInterval`+`pingTimeout` (10s+5s) plus reconnect jitter, so an
   * ordinary blip never fires this — see this field's use in
   * `removeConnection`/`forceExpire`. */
  static readonly VISIT_END_GRACE_MS = 20_000;

  /** Registered by `VisitorSessionService` (which already depends on this
   * service) at construction time — see that class's constructor. Deliberately
   * a plain callback list, not `RealtimeEventsService`: this is a purely
   * internal "the visit is actually over" fact with exactly one consumer,
   * not a Socket.IO-bound broadcast, and routing it through the domain-event
   * bus would need a `kind` no client ever listens for. Keeping
   * `VisitorPresenceModule` a dependency-free leaf (as it is today) also
   * avoids introducing a cycle with `VisitorSessionModule`, which already
   * imports this module. */
  private readonly visitEndedHandlers: ((
    visitorId: string,
    siteId: string,
  ) => void)[] = [];

  onVisitEnded(handler: (visitorId: string, siteId: string) => void): void {
    this.visitEndedHandlers.push(handler);
  }

  private cancelVisitEndTimer(visitorId: string): void {
    const timer = this.visitEndTimers.get(visitorId);
    if (timer) {
      clearTimeout(timer);
      this.visitEndTimers.delete(visitorId);
    }
  }

  private scheduleVisitEndCheck(visitorId: string, siteId: string): void {
    this.cancelVisitEndTimer(visitorId);
    const timer = setTimeout(() => {
      this.visitEndTimers.delete(visitorId);
      // Only fire if the Visitor is STILL at zero connections — a reconnect
      // that raced this timer already cancelled it via `addConnection`, but
      // this re-check costs nothing and guards against any future caller of
      // this method that doesn't go through that path.
      if (!this.isConnected(visitorId)) {
        for (const handler of this.visitEndedHandlers) {
          handler(visitorId, siteId);
        }
      }
    }, VisitorPresenceService.VISIT_END_GRACE_MS);
    // Doesn't hold the process open — same posture as every other timer in
    // this codebase (see the gateway's stale sweep interval).
    timer.unref?.();
    this.visitEndTimers.set(visitorId, timer);
  }

  /** Records/refreshes "this Visitor is still really there" — called both
   * on connect (see `addConnection`) and on every `visitor:heartbeat`. */
  touchHeartbeat(visitorId: string): void {
    this.lastHeartbeatAt.set(visitorId, Date.now());
  }

  /** ISO timestamp of when this Visitor's CURRENT online streak began, or
   * `null` if they're not currently tracked as online at all. */
  getConnectedAt(visitorId: string): string | null {
    const ts = this.connectedAt.get(visitorId);
    return ts ? new Date(ts).toISOString() : null;
  }

  /** Every currently-tracked Visitor whose last heartbeat is older than
   * `maxAgeMs` — candidates for `forceExpire` below. A Visitor with no
   * heartbeat on record at all (shouldn't happen, `addConnection` always
   * sets one) is treated as stale too, defensively. */
  getStaleVisitorIds(
    maxAgeMs: number,
  ): { visitorId: string; siteId: string }[] {
    const now = Date.now();
    const stale: { visitorId: string; siteId: string }[] = [];
    for (const [visitorId, siteId] of this.siteByVisitor.entries()) {
      const last = this.lastHeartbeatAt.get(visitorId) ?? 0;
      if (now - last > maxAgeMs) {
        stale.push({ visitorId, siteId });
      }
    }
    return stale;
  }

  /** Unconditionally clears a Visitor's presence — used by the sweep to
   * expire a stale entry regardless of how many (dead) sockets it thinks
   * are still open, unlike `removeConnection`'s one-socket-at-a-time
   * bookkeeping for the normal disconnect path. Returns the Visitor's
   * siteId, or `null` if they weren't tracked (already cleaned up). */
  forceExpire(visitorId: string): { siteId: string } | null {
    const siteId = this.siteByVisitor.get(visitorId) ?? null;
    this.connections.delete(visitorId);
    this.siteByVisitor.delete(visitorId);
    this.foregroundConversation.delete(visitorId);
    this.lastHeartbeatAt.delete(visitorId);
    this.connectedAt.delete(visitorId);
    // Already well past the ordinary grace window (this is only called by
    // the 60s-threshold stale sweep, vs. the 20s grace above) — no need to
    // wait further, and no pending timer to worry about (a stale Visitor by
    // definition has had no `addConnection` recently enough to have
    // cancelled one anyway, but clear it defensively).
    this.cancelVisitEndTimer(visitorId);
    if (siteId) {
      for (const handler of this.visitEndedHandlers) {
        handler(visitorId, siteId);
      }
    }
    return siteId ? { siteId } : null;
  }

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
    this.touchHeartbeat(visitorId);
    if (wentOnline) {
      this.connectedAt.set(visitorId, Date.now());
    }
    // Any pending "visit might be over" check from a previous disconnect no
    // longer applies — a live socket (reconnect, or a genuine second tab)
    // means the visit is still going. See `scheduleVisitEndCheck`'s doc
    // comment.
    this.cancelVisitEndTimer(visitorId);
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
      // FR-P2-READ-05 note: dropping the foreground flag here does NOT
      // regress any already-Delivered/Read message — it only stops a FUTURE
      // message from being auto-marked-read on arrival until the widget
      // explicitly reports foreground again after reconnecting (matches the
      // "gone from site" posture of the connection map itself, just for the
      // narrower foreground signal).
      this.foregroundConversation.delete(visitorId);
      this.lastHeartbeatAt.delete(visitorId);
      this.connectedAt.delete(visitorId);
      // Don't declare the visit over yet — start the grace window instead
      // (see `scheduleVisitEndCheck`'s doc comment). `siteId` is read above
      // before `siteByVisitor` is cleared.
      if (siteId) this.scheduleVisitEndCheck(visitorId, siteId);
    }
    return siteId ? { siteId, wentOffline } : null;
  }

  isConnected(visitorId: string): boolean {
    return (this.connections.get(visitorId)?.size ?? 0) > 0;
  }

  /**
   * Records the widget's own foreground/backgrounded report for ONE
   * Conversation (a Visitor only ever has one active Conversation open in
   * their widget at a time). `foreground: false` clears the flag ONLY if it
   * was set for this exact conversationId — a stale "left" for a
   * conversation the Visitor already navigated away from must never clobber
   * a newer "entered" for a different one.
   */
  setForeground(
    visitorId: string,
    conversationId: string,
    foreground: boolean,
  ): void {
    if (foreground) {
      this.foregroundConversation.set(visitorId, conversationId);
    } else if (this.foregroundConversation.get(visitorId) === conversationId) {
      this.foregroundConversation.delete(visitorId);
    }
  }

  isForeground(visitorId: string, conversationId: string): boolean {
    return this.foregroundConversation.get(visitorId) === conversationId;
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
