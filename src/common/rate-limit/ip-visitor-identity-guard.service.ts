import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared verbatim by every call site that rejects on this guard (the
 * `visitor:send_message` WS handler, `POST /visitor-session/init`,
 * `PATCH /visitor-session/profile`) so a Visitor sees the identical, clear
 * explanation no matter which touchpoint caught them — never a silent drop.
 */
export const TOO_MANY_ACTIVE_SESSIONS_MESSAGE =
  'Too many active sessions from this network, please try again shortly.';

/**
 * IpVisitorIdentityGuardService — §6.3 business decision (PROGRESS.md,
 * Session Fix-11): the per-IP multi-session abuse guard.
 *
 * This is a SEPARATE, genuinely independent limiter from
 * `WsRateLimiterService`'s per-Visitor-identity message-volume cap — it does
 * not care how many messages any one Visitor identity sends (that's
 * `WsRateLimiterService`'s job, unchanged by this service). It only cares
 * how many DIFFERENT Visitor identities have been active from one IP
 * address within a rolling window. This is what targets someone opening
 * several browser instances/incognito windows from one machine to
 * impersonate multiple visitors and spam the widget — each such window has
 * no shared cookie/token, so it always looks like a brand-new Visitor
 * identity to the rest of the app.
 *
 * In-memory only, per the existing "no Redis in Phase 1, single instance"
 * architecture — same `Map`-on-this-one-process pattern `PresenceService`/
 * `WsRateLimiterService` already use (see either's doc comment). A `Map`
 * keyed by IP, each value a `Map<visitorId, lastSeenAt>` — pruned to the
 * rolling window on every access to that IP (no background timer; a
 * completely dead IP's entry just sits unpruned but harmless until the
 * process restarts, the same trade-off `WsRateLimiterService`'s own buckets
 * already make).
 *
 * **Threshold rationale — why 3, not 1 or 2 (see PROGRESS.md for the full
 * writeup):** the business requirement is explicit that a genuine shared
 * office/school/cafe network with a handful of simultaneous visitors must
 * never be meaningfully affected. 1 or 2 would trip on totally ordinary
 * shared-IP traffic (two coworkers chatting with support at the same time).
 * 3 is deliberately generous — chosen by reasoned judgment as a starting
 * point, NOT a verified industry-standard number copied from any specific
 * competitor's implementation — and is expected to need tuning once real
 * launch traffic is observed, which is exactly why both thresholds are
 * env-configurable (see `configuration.ts`/`env.validation.ts`,
 * `IP_VISITOR_IDENTITY_MAX`/`IP_VISITOR_IDENTITY_WINDOW_MS`) rather than
 * hardcoded here.
 *
 * **Semantics:** `checkAndRegister` treats "new or returning" the same way
 * on purpose (no special-casing) — an identity already tracked for this IP
 * within the window always passes AND has its timestamp refreshed (a still-
 * active, genuine conversation never ages out of its own slot mid-chat);
 * an identity not yet tracked consumes one of the up-to-N slots if one is
 * free, or is rejected if not. One documented edge case this accepts: a
 * Visitor who goes fully silent from a given IP for longer than the window
 * and then returns, while 3 *other* identities have since become active
 * from that same IP, is indistinguishable from a genuinely new identity and
 * can be throttled — an inherent consequence of "rolling window of recent
 * activity" (the business decision's own framing), not a bug, and expected
 * to be rare in practice.
 */
@Injectable()
export class IpVisitorIdentityGuardService {
  private readonly logger = new Logger(IpVisitorIdentityGuardService.name);
  private readonly identitiesByIp = new Map<string, Map<string, number>>();

  constructor(private readonly configService: ConfigService) {}

  private get maxDistinctIdentities(): number {
    return this.configService.get<number>(
      'app.rateLimit.ipVisitorIdentity.maxDistinctIdentities',
      3,
    );
  }

  private get windowMs(): number {
    return this.configService.get<number>(
      'app.rateLimit.ipVisitorIdentity.windowMs',
      5 * 60_000,
    );
  }

  /**
   * Call whenever a Visitor identity is confirmed active from a given IP:
   * `visitor:send_message` (WS), `POST /visitor-session/init`, and
   * `PATCH /visitor-session/profile` (task requirement 5 — these two REST
   * endpoints are where "5 browsers from one laptop" would actually first
   * manifest, not just at message-send time). Returns `true` if `visitorId`
   * is (or is now) one of this IP's up-to-`maxDistinctIdentities` active
   * identities within the rolling window — `false` means this would be the
   * (N+1)th distinct identity and the caller must reject the request with a
   * clear error, never a silent drop.
   *
   * No `ip` (should not normally happen — every call site resolves one via
   * `extractClientIp`/`extractSocketIp`) fails OPEN (returns `true`) rather
   * than incorrectly blocking real traffic on a missing signal — the
   * guardrail here is "don't false-positive on genuine visitors," and an
   * unknown IP can't be attributed to an abuse pattern anyway.
   */
  checkAndRegister(ip: string | undefined, visitorId: string): boolean {
    if (!ip) return true;

    const now = Date.now();
    const windowMs = this.windowMs;
    let identities = this.identitiesByIp.get(ip);

    if (identities) {
      // Pruned on access (task's own wording) — no separate cleanup timer.
      for (const [id, lastSeenAt] of identities) {
        if (now - lastSeenAt >= windowMs) {
          identities.delete(id);
        }
      }
      if (identities.size === 0) {
        this.identitiesByIp.delete(ip);
        identities = undefined;
      }
    }

    if (identities?.has(visitorId)) {
      // Already one of this IP's established identities within the window
      // — refresh and allow unconditionally. Per this project's own §6.3
      // "must never be blocked" bar (Session Fix-11 business decision),
      // this is what guarantees a single visitor's OWN continued activity
      // is never throttled by this guard, no matter how long they chat.
      identities.set(visitorId, now);
      return true;
    }

    const distinctCount = identities?.size ?? 0;
    if (distinctCount >= this.maxDistinctIdentities) {
      this.logger.warn(
        `IP ${ip} already has ${distinctCount} distinct active Visitor identities in the last ${windowMs}ms — rejecting new identity ${visitorId}.`,
      );
      return false;
    }

    if (!identities) {
      identities = new Map<string, number>();
      this.identitiesByIp.set(ip, identities);
    }
    identities.set(visitorId, now);
    return true;
  }
}
