import { Request } from 'express';
import type { Socket } from 'socket.io';

/**
 * Shared by `extractClientIp` (Express, below) and `extractSocketIp`
 * (Socket.IO, below) — same `X-Forwarded-For`/`X-Real-IP` preference order,
 * just fed from whichever transport's raw headers. Kept as one function so
 * the two call sites can never silently drift into different proxy-header
 * handling for what is conceptually the identical "resolve the real client
 * IP" problem.
 */
function resolveForwardedIp(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const forwardedFor = headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  const firstForwarded = forwardedValue?.split(',')[0]?.trim();
  if (firstForwarded) {
    return firstForwarded;
  }

  const realIp = headers['x-real-ip'];
  const realIpValue = Array.isArray(realIp) ? realIp[0] : realIp;
  if (realIpValue?.trim()) {
    return realIpValue.trim();
  }

  return undefined;
}

/**
 * Resolves the visitor's real client IP from an incoming HTTP request.
 *
 * Prefers `X-Forwarded-For` (the first, left-most entry — the original
 * client, per the standard convention — since a reverse proxy/load
 * balancer appends its own hop) over `req.ip`/the raw socket address,
 * which behind any proxy would otherwise just report the proxy's own IP.
 * This app doesn't set Express's `trust proxy` setting (no proxy exists in
 * front of local dev), so this header is read directly rather than relying
 * on `req.ip` to already reflect it.
 *
 * Also doubles as this session's dev-testing hook: the self-hosted MaxMind
 * DB returns no location for private/loopback IPs (every local request), so
 * pass e.g. `curl -H "X-Forwarded-For: 8.8.8.8"` to see real location data
 * locally.
 *
 * Falls back to `X-Real-IP` (nginx's own convention, used by some
 * reverse-proxy/hosting setups that don't set X-Forwarded-For) before the
 * raw socket address — widens which real-world deployments this correctly
 * captures the true client IP behind, which matters beyond display: it's
 * also what `VisitorsService`'s Ban feature bans (`BanVisitorDto`), and
 * (Session Fix-11) what `IpVisitorIdentityGuardService` keys its per-IP
 * distinct-Visitor-identity tracking on.
 */
export function extractClientIp(req: Request): string | undefined {
  return (
    resolveForwardedIp(
      req.headers as Record<string, string | string[] | undefined>,
    ) ??
    req.ip ??
    req.socket?.remoteAddress ??
    undefined
  );
}

/**
 * Socket.IO counterpart to `extractClientIp` above (Session Fix-11 —
 * `IpVisitorIdentityGuardService`'s per-IP distinct-Visitor-identity guard).
 * `visitor:send_message` has no Express `Request` to read — only the
 * Socket.IO handshake — but a WS connection can sit behind the exact same
 * reverse proxy an HTTP request does, so the same header preference order
 * applies, falling back to the raw handshake address (Socket.IO's own
 * equivalent of `req.socket.remoteAddress`) instead of Express's `req.ip`.
 */
export function extractSocketIp(client: Socket): string | undefined {
  return (
    resolveForwardedIp(
      client.handshake.headers as Record<string, string | string[] | undefined>,
    ) ??
    client.handshake.address ??
    undefined
  );
}

/**
 * Whether `ip` has no meaningful public geolocation — loopback
 * (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), or
 * private (RFC1918 `10.0.0.0/8`/`172.16.0.0/12`/`192.168.0.0/16`, RFC4193
 * `fc00::/7`). Used both to skip the online geolocation fallback (a lookup
 * for one of these would be pointless/misleading — there's no real-world
 * location for "the same machine" or "the local network") and by the Agent
 * Console to show a clearer label than a bare blank for these IPs.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  const value = ip.replace(/^::ffff:/, '').trim();
  if (!value) return true;

  if (value === '::1' || value === '::') return true;
  if (/^fe80:/i.test(value) || /^fc00:|^fd00:/i.test(value)) return true;

  const parts = value.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // Anything else IPv6-shaped and not matched above is treated as public —
  // this helper only needs to reliably catch the common private ranges.
  return false;
}
