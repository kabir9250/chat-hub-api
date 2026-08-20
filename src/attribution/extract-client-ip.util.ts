import { Request } from 'express';

/**
 * Resolves the visitor's real client IP from an incoming request.
 *
 * Prefers `X-Forwarded-For` (the first, left-most entry — the original
 * client, per the standard convention — since a reverse proxy/load
 * balancer appends its own hop) over `req.ip`/the raw socket address,
 * which behind any proxy would otherwise just report the proxy's own IP.
 * This app doesn't set Express's `trust proxy` setting (no proxy exists in
 * front of local dev), so this header is read directly rather than relying
 * on `req.ip` to already reflect it.
 *
 * Also doubles as this session's dev-testing hook: `geoip-lite` returns no
 * location for private/loopback IPs (every local request), so pass e.g.
 * `curl -H "X-Forwarded-For: 8.8.8.8"` to see real location data locally.
 *
 * Falls back to `X-Real-IP` (nginx's own convention, used by some
 * reverse-proxy/hosting setups that don't set X-Forwarded-For) before the
 * raw socket address — widens which real-world deployments this correctly
 * captures the true client IP behind, which matters beyond display: it's
 * also what `VisitorsService`'s Ban feature bans (`BanVisitorDto`).
 */
export function extractClientIp(req: Request): string | undefined {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  const firstForwarded = forwardedValue?.split(',')[0]?.trim();
  if (firstForwarded) {
    return firstForwarded;
  }

  const realIp = req.headers['x-real-ip'];
  const realIpValue = Array.isArray(realIp) ? realIp[0] : realIp;
  if (realIpValue?.trim()) {
    return realIpValue.trim();
  }

  return req.ip ?? req.socket?.remoteAddress ?? undefined;
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
