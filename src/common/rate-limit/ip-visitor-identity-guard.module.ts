import { Module } from '@nestjs/common';

import { IpVisitorIdentityGuardService } from './ip-visitor-identity-guard.service';

/**
 * A small, dependency-free leaf module (mirrors `PresenceModule`'s own doc
 * comment) — both `RealtimeModule` (the `visitor:send_message` handler) and
 * `VisitorSessionModule` (`POST /visitor-session/init`,
 * `PATCH /visitor-session/profile`) import this directly, so both resolve
 * the exact same `IpVisitorIdentityGuardService` singleton and therefore the
 * same per-IP in-memory state — required for the guard to actually see all
 * three of an IP's touchpoints, not three separate, blind counters.
 */
@Module({
  providers: [IpVisitorIdentityGuardService],
  exports: [IpVisitorIdentityGuardService],
})
export class IpVisitorIdentityGuardModule {}
