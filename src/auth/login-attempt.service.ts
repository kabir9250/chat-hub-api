import { Injectable } from '@nestjs/common';

interface AttemptRecord {
  count: number;
  windowStart: number;
}

/**
 * SRS §6.3 "Rate limiting on ... login attempts" — brute-force protection
 * for `POST /auth/login`, keyed by IP, counting only FAILED attempts
 * (Session Fix-04, PROGRESS.md — replaces the old `@Throttle` on that
 * route, which counted every attempt, correct or not, and so could lock
 * out a legitimate user who simply mistyped their password a few times).
 *
 * Semantics: 5 failed logins from the same IP within a 60s window lock
 * that IP out (`AuthController` returns 429 with a friendly retry-after
 * message) until the window clears — a real credential-stuffing/
 * brute-force pattern still gets shut out entirely, same as before. A
 * SUCCESSFUL login at any point clears that IP's slate completely; it is
 * never counted or throttled, no matter how many logins in a row.
 *
 * In-memory, single-instance store — same architectural tradeoff the
 * app-wide `ThrottlerModule.forRoot` (AppModule) already makes; not
 * multi-instance-safe, but this app doesn't run multi-instance today (see
 * DEPLOYMENT.md). Stale per-IP records are cleaned up lazily (on next
 * access past their window) rather than via a background timer, to avoid
 * an extra interval to manage/leak in tests.
 */
@Injectable()
export class LoginAttemptService {
  static readonly MAX_FAILED_ATTEMPTS = 5;
  static readonly WINDOW_MS = 60_000;

  private readonly attemptsByIp = new Map<string, AttemptRecord>();

  /**
   * Returns how many whole seconds the caller must still wait, or `null`
   * if this IP isn't currently locked out. Read-only — does not itself
   * count as an attempt (a locked-out caller doesn't get to "use up" part
   * of their next window just by being blocked).
   */
  getLockoutSecondsRemaining(ip: string): number | null {
    const record = this.attemptsByIp.get(ip);
    if (!record) return null;

    const elapsedMs = Date.now() - record.windowStart;
    if (elapsedMs >= LoginAttemptService.WINDOW_MS) {
      // Window expired — stale, clean it up lazily.
      this.attemptsByIp.delete(ip);
      return null;
    }
    if (record.count < LoginAttemptService.MAX_FAILED_ATTEMPTS) return null;

    return Math.ceil((LoginAttemptService.WINDOW_MS - elapsedMs) / 1000);
  }

  /** Call once per genuinely failed login attempt (wrong password, unknown email, disabled account). */
  recordFailure(ip: string): void {
    const now = Date.now();
    const record = this.attemptsByIp.get(ip);
    if (!record || now - record.windowStart >= LoginAttemptService.WINDOW_MS) {
      this.attemptsByIp.set(ip, { count: 1, windowStart: now });
      return;
    }
    record.count += 1;
  }

  /** Call once per successful login — clears this IP's slate; a real user is never penalized for earlier typos. */
  recordSuccess(ip: string): void {
    this.attemptsByIp.delete(ip);
  }
}
