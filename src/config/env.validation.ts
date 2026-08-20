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
});
