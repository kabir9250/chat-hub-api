import { Injectable } from '@nestjs/common';

interface Bucket {
  count: number;
  windowStartedAt: number;
}

/**
 * WsRateLimiterService — §6.3 ("Rate limiting on ... message sending").
 *
 * `@nestjs/throttler` (used for the REST layer — see `AppModule`) only
 * inspects the HTTP request lifecycle; it has no hook into Socket.IO
 * `@SubscribeMessage` handlers. Rather than pull in a second dependency for
 * one gateway, this is a deliberately small, in-memory fixed-window limiter
 * — the same "in-memory on this one NestJS process" pattern `PresenceService`
 * already uses for presence (Phase 1 has no Redis/shared store; see that
 * service's doc comment). If/when the app runs multiple instances behind a
 * load balancer, this — like presence — would need to move to a shared
 * store (Redis) at that time; not a Phase 1 concern.
 *
 * Used directly inside `RealtimeGateway`'s message-sending handlers
 * (`agent:send_message`, `visitor:send_message`, and the two proactive-
 * message variants) — a handler calls `consume(key, limit, windowMs)` and,
 * on `false`, returns an `{ event: 'error' }` ack instead of persisting
 * anything, exactly like every other validation failure those handlers
 * already return.
 */
@Injectable()
export class WsRateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  /** Returns true if this call is within the limit (and counts it), false if the caller must be rejected. */
  consume(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      this.buckets.set(key, { count: 1, windowStartedAt: now });
      return true;
    }

    if (bucket.count >= limit) {
      return false;
    }

    bucket.count += 1;
    return true;
  }
}
