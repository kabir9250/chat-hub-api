import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';

import { isPrivateOrLoopbackIp } from './extract-client-ip.util';

/** Everything FR-VIS-01–04 asks the system to capture/derive on widget load. */
export interface VisitorAttributionSnapshot {
  referrer: string | null;
  landingPage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  /** FR-VIS-02 — "Direct traffic" or the referring page/domain (or UTM source, if more specific). */
  visitorPath: string;
  browser: string | null;
  os: string | null;
  deviceType: string;
  userAgentRaw: string | null;
  currentIp: string | null;
  /** `country` is always an ISO 3166-1 alpha-2 code (e.g. `"US"`), never a
   * full name — both `resolveLocation` paths below now agree on this, and
   * it's what the visitor-table country-flag icon (`flag-icons`, see
   * `CountryFlag` in `chat-hub-web/src/agent/components/visitorMeta.tsx`)
   * keys its CSS class off. Render a full country name from it client-side
   * via `Intl.DisplayNames`, don't store one here. */
  location: { city?: string; region?: string; country?: string };
}

export interface BuildAttributionInput {
  /** The visitor's current page URL (widget's `window.location.href`) — used for UTM extraction + stored as `landingPage`. */
  pageUrl?: string;
  /** `document.referrer` from the widget, if any. */
  referrer?: string;
  /** Raw `User-Agent` request header. */
  userAgent?: string;
  /** Client IP, already resolved from the request (X-Forwarded-For-aware) by the caller. */
  ip?: string;
}

/**
 * AttributionService — SRS §5.2 (FR-VIS-01–04). Pure derivation logic, no DB
 * access: turns what a widget-load request can hand us (page URL, referrer,
 * User-Agent, IP) into everything the Visitor Info panel needs.
 *
 * GeoIP choice (SRS §2.5 — "IP-based geolocation service/library available,
 * e.g. MaxMind GeoIP or similar"): **`geoip-lite`**, a pure-npm package that
 * bundles its own offline MaxMind-derived (GeoLite2-equivalent) city/country
 * database — no API key, no per-request network call, no native bindings to
 * compile. Chosen for the same reason Session 2 picked `bcryptjs` over
 * native `bcrypt`: this stack explicitly avoids Docker/native-build
 * complexity (see PROGRESS.md Session 0), and a paid/rate-limited HTTP geo
 * API (ip-api.com, ipapi.co, etc.) would add an external network dependency
 * and a new failure mode to something that runs on every widget load. The
 * trade-off: `geoip-lite`'s bundled DB is coarser than a live MaxMind
 * GeoLite2/GeoIP2 subscription (city-level accuracy is best-effort, and it
 * returns nothing for private/loopback IPs — see note in `resolveLocation`)
 * — acceptable for Phase 1's "approximate city/region/country" requirement
 * (FR-VIS-03 says "approximate" explicitly). Swappable later for a real
 * MaxMind GeoIP2 subscription without touching any caller of this service.
 */
@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(private readonly configService: ConfigService) {}

  async build(
    input: BuildAttributionInput,
  ): Promise<VisitorAttributionSnapshot> {
    const referrer = this.normalizeString(input.referrer);
    const utm = this.extractUtmParams(input.pageUrl);
    const ua = this.parseUserAgent(input.userAgent);
    const ip = this.normalizeIp(input.ip);

    return {
      referrer,
      landingPage: this.normalizeString(input.pageUrl),
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      visitorPath: this.computeVisitorPath(referrer, utm),
      browser: ua.browser,
      os: ua.os,
      deviceType: ua.deviceType,
      userAgentRaw: this.normalizeString(input.userAgent),
      currentIp: ip,
      location: await this.resolveLocation(ip),
    };
  }

  /**
   * FR-VIS-02: "Direct traffic" if no referrer, otherwise the referring
   * page/domain — matching Zendesk's "Visitor path" concept. When a UTM
   * `utm_source` is present, prefer it (plus `utm_medium`, if given) over
   * the bare referrer domain: a UTM tag is a deliberate campaign-attribution
   * signal from the marketer, and `document.referrer` is frequently empty
   * or unhelpful for exactly the channels UTMs are used for (email, paid
   * social apps, QR codes) — so UTM, when present, is the more specific and
   * more trustworthy "how did they get here" answer. This priority order is
   * a design decision beyond the SRS's literal two-case wording; logged in
   * PROGRESS.md.
   */
  computeVisitorPath(
    referrer: string | null,
    utm: { utmSource: string | null; utmMedium: string | null },
  ): string {
    if (utm.utmSource) {
      return utm.utmMedium
        ? `${utm.utmSource} / ${utm.utmMedium}`
        : utm.utmSource;
    }
    if (!referrer) {
      return 'Direct traffic';
    }
    try {
      const host = new URL(referrer).hostname.replace(/^www\./, '');
      return host || referrer;
    } catch {
      // Not a parseable absolute URL — store it verbatim rather than lose
      // the signal (e.g. a malformed but non-empty document.referrer).
      return referrer;
    }
  }

  private extractUtmParams(pageUrl?: string): {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
  } {
    if (!pageUrl) {
      return { utmSource: null, utmMedium: null, utmCampaign: null };
    }
    try {
      const url = new URL(pageUrl);
      return {
        utmSource: url.searchParams.get('utm_source'),
        utmMedium: url.searchParams.get('utm_medium'),
        utmCampaign: url.searchParams.get('utm_campaign'),
      };
    } catch {
      // Not a parseable absolute URL — no UTM params to extract.
      return { utmSource: null, utmMedium: null, utmCampaign: null };
    }
  }

  private parseUserAgent(userAgent?: string): {
    browser: string | null;
    os: string | null;
    deviceType: string;
  } {
    if (!userAgent) {
      return { browser: null, os: null, deviceType: 'desktop' };
    }
    const result = new UAParser(userAgent).getResult();
    const browser = result.browser.name
      ? [result.browser.name, result.browser.version].filter(Boolean).join(' ')
      : null;
    const os = result.os.name
      ? [result.os.name, result.os.version].filter(Boolean).join(' ')
      : null;
    // ua-parser-js leaves device.type undefined for ordinary desktop
    // browsers (only mobile/tablet/console/smarttv/wearable/embedded are
    // ever set) — default to 'desktop' explicitly rather than store undefined.
    const deviceType = result.device.type ?? 'desktop';
    return { browser, os, deviceType };
  }

  /**
   * `geoip-lite` returns `null` for private/loopback/unroutable IPs (e.g.
   * every localhost dev request) — that's expected, not a bug; there's no
   * geo-location for an RFC1918 address, and `isPrivateOrLoopbackIp` skips
   * the online fallback below entirely for those (a lookup for "the same
   * machine" would be pointless/misleading). For a real, routable IP that
   * `geoip-lite`'s bundled offline DB happens to miss (its DB is coarse —
   * can lag behind newly-allocated ranges), this session added a
   * best-effort online fallback (`app.attribution.geoFallbackEnabled`,
   * default on) — one free, no-API-key HTTP lookup, short timeout, and the
   * exact same "never throw, just return {}" behavior on any failure so a
   * slow/unreachable network never blocks visitor-session creation. To see
   * real location data on a local dev machine without relying on the
   * fallback, pass a public IP (e.g. via `X-Forwarded-For` when testing
   * with curl).
   */
  private async resolveLocation(ip: string | null): Promise<{
    city?: string;
    region?: string;
    country?: string;
  }> {
    if (!ip) {
      return {};
    }
    try {
      const result = geoip.lookup(ip);
      if (result) {
        return {
          city: result.city || undefined,
          region: result.region || undefined,
          country: result.country || undefined,
        };
      }
    } catch (err) {
      this.logger.warn(
        `geoip-lite lookup failed for ${ip}: ${(err as Error).message}`,
      );
    }

    if (isPrivateOrLoopbackIp(ip)) {
      return {};
    }
    if (
      this.configService.get<boolean>('app.attribution.geoFallbackEnabled') ===
      false
    ) {
      return {};
    }
    return this.resolveLocationOnline(ip);
  }

  /**
   * Free, no-API-key fallback (ip-api.com's JSON endpoint) for a real IP
   * `geoip-lite` couldn't resolve. 2s timeout via `AbortController`; any
   * failure (timeout, network error, non-2xx, malformed body) is swallowed
   * and returns `{}` — same contract as the offline lookup above.
   *
   * Country-code fix (visitor-table country-flag icon work): this used to
   * request ip-api.com's `country` field (a full name like "United
   * States") and store it straight into `location.country` — but
   * `geoip-lite`'s own lookup above (the primary, non-fallback path) writes
   * an ISO 3166-1 alpha-2 code into that same field (e.g. "US"), and so does
   * every seeded test fixture (`seed-test.ts`'s `geo` pool: `'US'`, `'GB'`,
   * `'CA'`, `'AU'`). A Visitor resolved via this fallback therefore used to
   * carry a differently-shaped `location.country` than everyone else — no
   * visible bug before now since it was only ever rendered as plain text,
   * but the new country-flag icon (`CountryFlag`, `chat-hub-web`) keys its
   * `flag-icons` CSS class directly off this field and needs it to always
   * be the 2-letter code. Requesting `countryCode` instead keeps this path
   * consistent with the other two.
   */
  private async resolveLocationOnline(ip: string): Promise<{
    city?: string;
    region?: string;
    country?: string;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,countryCode`,
        { signal: controller.signal },
      );
      if (!res.ok) return {};
      const body = (await res.json()) as {
        status?: string;
        city?: string;
        regionName?: string;
        countryCode?: string;
      };
      if (body.status !== 'success') return {};
      return {
        city: body.city || undefined,
        region: body.regionName || undefined,
        country: body.countryCode || undefined,
      };
    } catch (err) {
      this.logger.warn(
        `Online geolocation fallback failed for ${ip}: ${(err as Error).message}`,
      );
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeIp(ip?: string): string | null {
    if (!ip) return null;
    // Strip the IPv6-mapped-IPv4 prefix Node sometimes reports for IPv4
    // clients on a dual-stack socket (e.g. "::ffff:203.0.113.5").
    return ip.replace(/^::ffff:/, '').trim() || null;
  }

  private normalizeString(value?: string): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
