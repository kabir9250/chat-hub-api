import * as path from 'path';

/**
 * Typed shape of app config, built from process.env once at startup.
 * Registered as a namespaced ConfigModule factory ("app") so it's
 * consumed as `configService.get('app.port')` etc.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  mongodb: {
    uri: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  cors: {
    origin: string;
  };
  attribution: {
    /**
     * Whether `AttributionService` tries the 3 online geolocation tiers
     * (ipgeolocation.io, ipapi.co, ip-api.com) before falling back to the
     * self-hosted MaxMind `.mmdb`. Defaults ON; set to `false` for a fully
     * offline/sandboxed environment with no outbound internet access — each
     * tier already fails silently on its own, but this skips even
     * attempting the calls and goes straight to the local DB.
     */
    geoFallbackEnabled: boolean;
    /** API key for ipgeolocation.io (tier 1) — free at ipgeolocation.io/signup. Tier 1 is skipped (falls through to tier 2) when unset. */
    ipgeolocationIoApiKey: string | undefined;
    /** Per-tier timeout (ms) for the 3 online geolocation lookups. Default 2000. */
    geoLookupTimeoutMs: number;
  };
  /**
   * Phase 2 §3.9 (FR-P2-ATT-06/08) — object storage. `provider` is
   * documentation-only right now (`StorageService` is the only
   * implementation, local-disk — see its own doc comment and PROGRESS.md's
   * "Object storage" entry for why); it's here so a future S3-compatible
   * provider swap has an obvious place to read "which one" from.
   */
  storage: {
    provider: 'local-disk';
    uploadsDir: string;
    publicBaseUrl: string;
    signingSecret: string;
    signedUrlTtlSeconds: number;
  };
  /**
   * Session Fix-11 (§6.3 business decision — see PROGRESS.md) — the per-IP
   * multi-session abuse guard (`IpVisitorIdentityGuardService`), a SEPARATE,
   * independent limiter from `WsRateLimiterService`'s per-Visitor-identity
   * message-volume cap. Deliberately env-configurable (not a hardcoded
   * magic number in the service itself) because these are a starting point
   * based on reasoned judgment, not a verified industry-standard figure —
   * see PROGRESS.md for the full rationale — and will likely need tuning
   * once real launch traffic is observed.
   */
  rateLimit: {
    ipVisitorIdentity: {
      /**
       * How many DISTINCT Visitor identities one IP may have active within
       * the rolling window below before the next new one is throttled.
       * Default 3 — deliberately generous (see PROGRESS.md) so a genuine
       * shared office/school/cafe network with a handful of simultaneous
       * visitors is never meaningfully affected; this is what actually
       * targets "several incognito windows from one machine," not normal
       * shared-IP traffic.
       */
      maxDistinctIdentities: number;
      /** Rolling window, in ms, over which distinct identities are counted. Default 5 minutes. */
      windowMs: number;
    };
  };
}

export default (): { app: AppConfig } => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3001', 10),
    mongodb: {
      uri: process.env.MONGODB_URI ?? '',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? '',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    },
    cors: {
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    },
    attribution: {
      geoFallbackEnabled: process.env.GEO_FALLBACK_ENABLED !== 'false',
      ipgeolocationIoApiKey: process.env.IPGEOLOCATION_API_KEY || undefined,
      geoLookupTimeoutMs: parseInt(
        process.env.GEO_LOOKUP_TIMEOUT_MS ?? '2000',
        10,
      ),
    },
    storage: {
      provider: 'local-disk',
      uploadsDir:
        process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'),
      publicBaseUrl: process.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
      signingSecret:
        process.env.ATTACHMENTS_SIGNING_SECRET ??
        'dev-attachments-secret-change-me',
      signedUrlTtlSeconds: parseInt(
        process.env.ATTACHMENT_SIGNED_URL_TTL_SECONDS ?? '300',
        10,
      ),
    },
    rateLimit: {
      ipVisitorIdentity: {
        maxDistinctIdentities: parseInt(
          process.env.IP_VISITOR_IDENTITY_MAX ?? '3',
          10,
        ),
        windowMs: parseInt(
          process.env.IP_VISITOR_IDENTITY_WINDOW_MS ?? String(5 * 60_000),
          10,
        ),
      },
    },
  },
});
