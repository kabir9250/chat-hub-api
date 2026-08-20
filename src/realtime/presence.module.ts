import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../database/schemas';
import { PresenceService } from './presence.service';

/**
 * A small, dependency-free (beyond the User model) module on purpose — both
 * `ConversationsModule` (auto-routing needs to know who's online) and
 * `RealtimeModule` (the Gateway updates/reads presence on connect/disconnect/
 * presence.set) import this directly. Keeping it a leaf module (it imports
 * nothing from either of them) avoids a circular
 * ConversationsModule <-> RealtimeModule dependency.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
