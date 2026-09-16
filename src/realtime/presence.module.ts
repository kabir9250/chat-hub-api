import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../database/schemas';
import { PresenceService } from './presence.service';
import { RealtimeEventsModule } from './realtime-events.module';

/**
 * A small, dependency-free (beyond the User model) module on purpose — both
 * `ConversationsModule` (auto-routing needs to know who's online) and
 * `RealtimeModule` (the Gateway updates/reads presence on connect/disconnect/
 * presence.set) import this directly. Keeping it a leaf module (it imports
 * nothing from either of them) avoids a circular
 * ConversationsModule <-> RealtimeModule dependency.
 *
 * Session Feature-1c-backend addition: also imports `RealtimeEventsModule`
 * (for `PresenceService.setIdleStatus` to emit `presence.autoStatusChanged`)
 * — still safe, that module is itself a leaf with no imports of its own
 * (see its own doc comment), so this doesn't reintroduce a cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    RealtimeEventsModule,
  ],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
