import { setServers } from 'dns';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { JsonLoggerService } from './common/logging/json-logger.service';

// Workaround for local Windows dev machines with stale/unreachable DNS
// entries on virtual/VPN network adapters (fec0:0:0:ffff::1/2/3). Node's
// resolver tries those before a working one and fails SRV lookups for
// mongodb+srv:// URIs with ECONNREFUSED. Force known-good public resolvers.
setServers(['1.1.1.1', '8.8.8.8']);

async function bootstrap() {
  // SRS §6.7 — structured (JSON) application logs. See JsonLoggerService's
  // doc comment: this one line turns every existing `new Logger(...)` call
  // already used throughout the app (auth, RBAC, presence, WebSocket
  // connect/disconnect, etc.) into structured log lines, no other file
  // needs to change.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLoggerService(),
  });
  const configService = app.get(ConfigService);

  // HTTPS/WSS readiness (§6.3 "All traffic over HTTPS/WSS"): this app does
  // not terminate TLS itself in any environment (local dev, or production —
  // see DEPLOYMENT.md) — a reverse proxy / platform load balancer in front
  // of it does, and forwards the original client IP via `X-Forwarded-For`.
  // `trust proxy` makes Express (and therefore ThrottlerGuard's per-IP
  // buckets, and AttributionService's IP-geolocation) read the REAL client
  // IP from that header instead of the proxy's own address. Safe to leave
  // on in local dev too (no proxy present, `req.ip` is just the direct
  // connection either way).
  app.set('trust proxy', 1);

  // helmet: standard security response headers (X-Content-Type-Options,
  // X-Frame-Options, etc.). HSTS is only meaningful once traffic is
  // actually served over HTTPS (true for any real deployment behind the
  // TLS-terminating proxy above, never true for plain-HTTP local dev) — so
  // it's gated on NODE_ENV rather than always-on, to avoid a confusing
  // "Strict-Transport-Security" header on a local http://localhost API.
  const isProduction =
    configService.get<string>('app.nodeEnv') === 'production';
  app.use(
    helmet({
      hsts: isProduction
        ? { maxAge: 15552000, includeSubDomains: true }
        : false,
      // CSP is left to each frontend app (Widget/Agent Console/Admin Panel,
      // separate Next.js deployments) to set for itself — this is a JSON
      // API with a Swagger UI, not a page-serving app, so a restrictive
      // default CSP here would only risk breaking /api-docs for no real
      // security benefit.
      contentSecurityPolicy: false,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors({
    origin: configService.get<string>('app.cors.origin'),
    credentials: true,
  });

  // Swagger / OpenAPI docs — interactive "try it out" UI at /api-docs, no
  // Postman needed. `addBearerAuth` registers the "Authorize" padlock: log
  // in via POST /auth/login below, paste the returned `accessToken` into
  // the padlock (no "Bearer " prefix needed, Swagger adds it), and every
  // subsequent "Try it out" call on a protected route sends it automatically.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Chat Hub API')
    .setDescription(
      'Chat Hub backend (see apps/files/02-srs-document.md). ' +
        'To authenticate: run POST /auth/login with one of the seeded accounts ' +
        '(e.g. owner@chat-hub.local / ChangeMe123!), copy the `accessToken` from ' +
        'the response, then click "Authorize" and paste it in (just the token, ' +
        'no "Bearer " prefix — Swagger adds that for you).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, swaggerDocument, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = configService.get<number>('app.port') ?? 3001;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`chat-hub-api listening on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/api-docs`);
}
void bootstrap();
