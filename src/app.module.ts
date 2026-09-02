import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DatabaseModule } from './database/database.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthController } from './health/health.controller';
import { AuditLogModule } from './audit-log/audit-log.module';
import { AuthModule } from './auth/auth.module';
import { VisitorSessionModule } from './visitor-session/visitor-session.module';
import { RbacModule } from './rbac/rbac.module';
import { UsersModule } from './users/users.module';
import { DepartmentsModule } from './departments/departments.module';
import { SitesModule } from './sites/sites.module';
import { WidgetConfigModule } from './widget-config/widget-config.module';
import { TriggersModule } from './triggers/triggers.module';
import { WidgetBootstrapModule } from './widget-bootstrap/widget-bootstrap.module';
import { VisitorsModule } from './visitors/visitors.module';
import { LeadsModule } from './leads/leads.module';
import { ConversationsModule } from './conversations/conversations.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { StorageModule } from './storage/storage.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { ShortcutsModule } from './shortcuts/shortcuts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
    // §6.3 "Rate limiting on pre-chat form submission, message sending, and
    // login attempts" — this is the DEFAULT bucket, applied globally to
    // every HTTP route via the APP_GUARD below (a generous ceiling against
    // scripted abuse/scraping). Endpoints that need a stricter, purpose-
    // specific limit (login, visitor-session init/profile, conversation
    // create/message-send, public rating submit) declare their own named
    // throttler via `@Throttle({ <name>: { limit, ttl } })` — see each
    // controller for the specific values and why. WebSocket message-sending
    // is NOT covered here (this only hooks the HTTP request lifecycle) — see
    // `WsRateLimiterService` for that half.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
    }),
    DatabaseModule,
    RealtimeModule,
    AuditLogModule,
    AuthModule,
    VisitorSessionModule,
    RbacModule,
    UsersModule,
    DepartmentsModule,
    SitesModule,
    WidgetConfigModule,
    TriggersModule,
    WidgetBootstrapModule,
    VisitorsModule,
    LeadsModule,
    ConversationsModule,
    // PageVisitsModule (this session) is a leaf provider module with no
    // controller — like PresenceModule/RealtimeEventsModule, it's imported
    // directly by whichever feature modules need it (VisitorSessionModule,
    // RealtimeModule), not registered here.
    AnalyticsModule,
    // Phase 2 §3.9 (FR-P2-ATT-01–08) — StorageModule is also imported
    // directly by ConversationsModule (message serialization needs signed
    // URLs); registered here too only because AttachmentsModule needs its
    // own instance for the upload endpoints, same as any other module.
    StorageModule,
    AttachmentsModule,
    // Phase 2 §2.4/§3.11 (FR-P2-SHORT-01–08) — Shortcuts (Canned Responses).
    ShortcutsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
