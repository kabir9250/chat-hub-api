import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { open, Reader, CityResponse } from 'maxmind';
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
 * e.g. MaxMind GeoIP or similar"): a 4-tier cascade (see `ip_geo_plan.md`),
 * tried in order until one returns a result — `resolveLocation` below:
 *
 *   1. ipgeolocation.io — live API, 30k req/month free, needs
 *      `IPGEOLOCATION_API_KEY`.
 *   2. ipapi.co         — live API, 30k req/month free, no key needed.
 *   3. ip-api.com       — live API, 45 req/min free, no key, HTTP only
 *      (fine server-side — no browser mixed-content restriction applies).
 *   4. Self-hosted MaxMind GeoLite2-City `.mmdb`
 *      (`geo-data/GeoLite2-City.mmdb`, read via the `maxmind` npm package)
 *      — always available, no network call, no rate limit. Final fallback
 *      for when every online tier is down/rate-limited/misconfigured.
 *
 * Tiers 1–3 are live lookups, so they're always current by construction —
 * no staleness concern. Tier 4 replaced the `geoip-lite` npm package
 * (formerly the *primary* source here): `geoip-lite` bundles its own
 * offline DB snapshot frozen at `npm install` time with no supported way to
 * refresh without republishing the whole package — it silently drifted
 * stale enough to misattribute a real US IP to Poland. The self-hosted
 * `.mmdb` file is instead fetched/refreshed independently via
 * `npm run geoip:update` (`src/database/update-geoip-db.ts`), scheduled to
 * run periodically (weekly — MaxMind republishes GeoLite2 about that
 * often), so it stays current even as the last-resort tier. If the file is
 * missing (e.g. the script has never been run) or every tier fails,
 * `location` is just `{}` — this never blocks visitor-session creation.
 *
 * Each online tier gets a short timeout (`GEO_LOOKUP_TIMEOUT_MS`, default
 * 2s) and any failure — timeout, network error, non-2xx, quota/429,
 * malformed body — falls through to the next tier immediately.
 */
@Injectable()
export class AttributionService implements OnModuleInit {
  private readonly logger = new Logger(AttributionService.name);
  private maxmindReader: Reader<CityResponse> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const mmdbPath = path.join(process.cwd(), 'geo-data', 'GeoLite2-City.mmdb');
    try {
      this.maxmindReader = await open<CityResponse>(mmdbPath);
      this.logger.log(`Loaded MaxMind GeoLite2-City DB from ${mmdbPath}`);
    } catch (err) {
      this.logger.warn(
        `MaxMind local DB unavailable at ${mmdbPath} (${(err as Error).message}). ` +
          `Run "npm run geoip:update" to fetch it. Falling back to the online ` +
          `geolocation lookup for every real IP until then.`,
      );
    }
  }

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
   * `isPrivateOrLoopbackIp` short-circuits the whole cascade — there's no
   * real-world geo-location for an RFC1918/loopback/link-local address (a
   * lookup for "the same machine"/"the local network" would be pointless/
   * misleading), so none of the 4 tiers below are worth trying for one. For
   * a real, routable IP, tries each tier in order (see the class doc
   * comment) until one returns a result; any tier failing — timeout,
   * network error, quota, malformed body — falls through to the next. If
   * every tier fails (or `app.attribution.geoFallbackEnabled` is `false`,
   * which skips tiers 1–3 entirely), returns `{}` — this never throws and
   * never blocks visitor-session creation. To see real location data on a
   * local dev machine, pass a public IP (e.g. via `X-Forwarded-For` when
   * testing with curl) — private/loopback IPs always short-circuit above.
   */
  private async resolveLocation(ip: string | null): Promise<{
    city?: string;
    region?: string;
    country?: string;
  }> {
    if (!ip || isPrivateOrLoopbackIp(ip)) {
      return {};
    }

    if (
      this.configService.get<boolean>('app.attribution.geoFallbackEnabled') !==
      false
    ) {
      const online =
        (await this.resolveViaIpGeolocationIo(ip)) ??
        (await this.resolveViaIpApiCo(ip)) ??
        (await this.resolveViaIpApiCom(ip));
      if (online) {
        return online;
      }
    }

    return this.resolveViaMaxmindLocal(ip);
  }

  private geoLookupTimeoutMs(): number {
    return (
      this.configService.get<number>('app.attribution.geoLookupTimeoutMs') ??
      2000
    );
  }

  /**
   * Tier 1 — ipgeolocation.io. Free tier: 30,000 req/month, needs
   * `IPGEOLOCATION_API_KEY`. Returns `undefined` (not `{}`) on any
   * failure/missing key so the caller's `??` chain correctly falls through
   * to the next tier instead of treating "no data" as "confirmed empty
   * location" — same convention for every tier below.
   */
  private async resolveViaIpGeolocationIo(
    ip: string,
  ): Promise<{ city?: string; region?: string; country?: string } | undefined> {
    const apiKey = this.configService.get<string>(
      'app.attribution.ipgeolocationIoApiKey',
    );
    if (!apiKey) {
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.geoLookupTimeoutMs());
    try {
      const res = await fetch(
        `https://api.ipgeolocation.io/v2/ipgeo?apiKey=${encodeURIComponent(apiKey)}&ip=${encodeURIComponent(ip)}&fields=location`,
        { signal: controller.signal },
      );
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        location?: {
          city?: string;
          state_prov?: string;
          country_code2?: string;
        };
      };
      const country = body.location?.country_code2;
      if (!country) return undefined;
      return {
        city: body.location?.city || undefined,
        region: body.location?.state_prov || undefined,
        country,
      };
    } catch (err) {
      this.logger.warn(
        `ipgeolocation.io lookup failed for ${ip}: ${(err as Error).message}`,
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Tier 2 — ipapi.co. Free tier: 30,000 req/month, no API key needed. */
  private async resolveViaIpApiCo(
    ip: string,
  ): Promise<{ city?: string; region?: string; country?: string } | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.geoLookupTimeoutMs());
    try {
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        error?: boolean;
        city?: string;
        region_code?: string;
        country_code?: string;
      };
      if (body.error || !body.country_code) return undefined;
      return {
        city: body.city || undefined,
        region: body.region_code || undefined,
        country: body.country_code,
      };
    } catch (err) {
      this.logger.warn(
        `ipapi.co lookup failed for ${ip}: ${(err as Error).message}`,
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Tier 3 — ip-api.com. Free tier: 45 req/min (~1.9M/month), no API key.
   * HTTP-only on the free tier, which is fine here — this call happens
   * server-side (Node → ip-api.com), so the browser mixed-content
   * restriction that would block an HTTPS *page* from calling an HTTP
   * endpoint directly never applies.
   *
   * Country-code note (visitor-table country-flag icon work, carried over
   * from when this was the only online tier): requests `countryCode`
   * specifically (not the full-name `country` field) so this stays
   * consistent with every other tier and with the seeded test fixtures
   * (`seed-test.ts`'s `geo` pool) — `location.country` must always be an
   * ISO 3166-1 alpha-2 code, since `CountryFlag` (chat-hub-web) keys its
   * `flag-icons` CSS class directly off it.
   */
  private async resolveViaIpApiCom(
    ip: string,
  ): Promise<{ city?: string; region?: string; country?: string } | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.geoLookupTimeoutMs());
    try {
      const res = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,countryCode`,
        { signal: controller.signal },
      );
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        status?: string;
        city?: string;
        regionName?: string;
        countryCode?: string;
      };
      if (body.status !== 'success' || !body.countryCode) return undefined;
      return {
        city: body.city || undefined,
        region: body.regionName || undefined,
        country: body.countryCode,
      };
    } catch (err) {
      this.logger.warn(
        `ip-api.com lookup failed for ${ip}: ${(err as Error).message}`,
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Tier 4 (final fallback) — the self-hosted MaxMind GeoLite2-City
   * `.mmdb`, loaded once in `onModuleInit`. No network call, no rate
   * limit — always tried when every online tier above failed or was
   * skipped (`geoFallbackEnabled: false`).
   */
  private resolveViaMaxmindLocal(ip: string): {
    city?: string;
    region?: string;
    country?: string;
  } {
    if (!this.maxmindReader) {
      return {};
    }
    try {
      const result = this.maxmindReader.get(ip);
      if (!result) return {};
      return {
        city: result.city?.names?.en || undefined,
        region: result.subdivisions?.[0]?.iso_code || undefined,
        country: result.country?.iso_code || undefined,
      };
    } catch (err) {
      this.logger.warn(
        `MaxMind local lookup failed for ${ip}: ${(err as Error).message}`,
      );
      return {};
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
