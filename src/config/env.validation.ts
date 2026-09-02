import * as Joi from 'joi';

/**
 * Validates process.env at startup so the app fails fast with a clear
 * error instead of limping along with undefined config values.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3001),

  // MongoDB Atlas SRV URI.
  MONGODB_URI: Joi.string().required(),

  // Hardening session: in production, a short/default/dev-placeholder
  // secret is a real risk (anyone who can guess/leak it can forge a valid
  // JWT for any userId/type — see SECURITY.md). Development/test keep the
  // looser "just be present" check so the committed `dev-secret-change-me`
  // placeholder (.env.example) keeps working locally without every
  // contributor generating their own.
  JWT_SECRET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required().invalid('dev-secret-change-me'),
    otherwise: Joi.string().required(),
  }),
  JWT_EXPIRES_IN: Joi.string().default('1d'),

  CORS_ORIGIN: Joi.string().default('http://localhost:3000'),

  // Online geolocation fallback (AttributionService) — see configuration.ts.
  GEO_FALLBACK_ENABLED: Joi.string().valid('true', 'false').default('true'),

  // Phase 2 §3.9 object storage (FR-P2-ATT-06/08) — see StorageService's
  // doc comment. UPLOADS_DIR defaults to `<cwd>/uploads` if unset.
  UPLOADS_DIR: Joi.string().optional(),
  // The origin this API is actually reachable at — used to build absolute
  // signed attachment URLs (a relative path wouldn't work: the Widget/Agent
  // Console load images/files straight from this origin, cross-origin from
  // their own).
  PUBLIC_API_BASE_URL: Joi.string().uri().default('http://localhost:3001'),
  // Same "don't ship the dev placeholder to production" rule JWT_SECRET
  // gets above — a leaked/guessable signing secret would let anyone mint
  // their own valid attachment links regardless of Conversation permission.
  ATTACHMENTS_SIGNING_SECRET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string()
      .min(32)
      .required()
      .invalid('dev-attachments-secret-change-me'),
    otherwise: Joi.string().required(),
  }),
  ATTACHMENT_SIGNED_URL_TTL_SECONDS: Joi.number().default(300),

  // Session Fix-11 (§6.3 business decision, PROGRESS.md) — per-IP
  // multi-session abuse guard (IpVisitorIdentityGuardService). Defaults are
  // a deliberately generous starting point (see PROGRESS.md's rationale),
  // not a hardcoded magic number in the service — tune via env once real
  // launch traffic is observed, no code change needed.
  IP_VISITOR_IDENTITY_MAX: Joi.number().integer().min(1).default(3),
  IP_VISITOR_IDENTITY_WINDOW_MS: Joi.number()
    .integer()
    .min(1000)
    .default(5 * 60_000),
});
