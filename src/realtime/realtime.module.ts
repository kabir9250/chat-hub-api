import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../database/schemas';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { PageVisitsModule } from '../page-visits/page-visits.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { PresenceModule } from './presence.module';
import { RealtimeEventsModule } from './realtime-events.module';
import { VisitorPresenceModule } from './visitor-presence.module';
import { RealtimeGateway } from './realtime.gateway';
import { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';
import { IpVisitorIdentityGuardModule } from '../common/rate-limit/ip-visitor-identity-guard.module';

/**
 * RealtimeModule — Session 8 (FR-MSG-01–06, FR-RTE-01–03, FR-AGT-02/03/04).
 *
 * Imports `ConversationsModule` directly to reuse `ConversationsService` for
 * every message-send/join/resync operation (task instruction: "new message
 * persisted via the Session 7 Message logic, then broadcast"). This does
 * NOT create a cycle: `ConversationsModule` depends on `PresenceModule` and
 * `RealtimeEventsModule` (both leaf modules with no further imports), never
 * on this module — see `RealtimeEventsService`'s doc comment for the full
 * reasoning.
 *
 * `AuthModule` is imported for `JwtService` (verifying the handshake token
 * once per connection — see `RealtimeGateway.handleConnection`) and
 * `RbacModule` for `PermissionsService`/`PermissionGuard` (identical RBAC
 * enforcement to the REST layer, per the task's guardrail).
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    AuthModule,
    RbacModule,
    PresenceModule,
    RealtimeEventsModule,
    ConversationsModule,
    // This session's additions — both leaf modules, no cycle. PageVisitsModule
    // backs the `visitor:page_changed` handler; VisitorPresenceModule backs
    // visitor connect/disconnect tracking used by ConversationsService's
    // `visitorOnline` field.
    PageVisitsModule,
    VisitorPresenceModule,
    // Perf fix — `RealtimeGateway.handleConnection` uses `VisitorsService
    // .getLiveVisitor` to attach a full row to `visitor.online` (see that
    // method's doc comment). Not a cycle: VisitorsModule imports only
    // MongooseModule/AuditLogModule/RbacModule/LeadsModule/
    // RealtimeEventsModule/VisitorPresenceModule, none of which import this
    // module.
    VisitorsModule,
    // Session Fix-11 — per-IP multi-session abuse guard (§6.3 business
    // decision), shared with VisitorSessionModule via this same leaf module
    // so both resolve one singleton (see its own doc comment).
    IpVisitorIdentityGuardModule,
  ],
  providers: [RealtimeGateway, WsRateLimiterService],
})
export class RealtimeModule {}
