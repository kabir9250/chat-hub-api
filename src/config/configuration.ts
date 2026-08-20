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
     * Best-effort online geolocation fallback (`AttributionService`) for
     * when `geoip-lite`'s bundled offline DB misses on a real (non-
     * private/loopback) IP. Defaults ON; set to `false` for a fully
     * offline/sandboxed environment with no outbound internet access — the
     * fallback already fails silently on its own, but this avoids even
     * attempting the call.
     */
    geoFallbackEnabled: boolean;
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
    },
  },
});
