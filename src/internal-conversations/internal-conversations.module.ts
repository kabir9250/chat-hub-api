import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  Department,
  DepartmentSchema,
  InternalConversation,
  InternalConversationSchema,
  InternalMessage,
  InternalMessageSchema,
  User,
  UserSchema,
} from '../database/schemas';
import { PresenceModule } from '../realtime/presence.module';
import { RbacModule } from '../rbac/rbac.module';
import { InternalConversationsController } from './internal-conversations.controller';
import { InternalConversationsService } from './internal-conversations.service';
import { TeamRosterService } from './team-roster.service';

@Module({
  controllers: [InternalConversationsController],
  imports: [
    MongooseModule.forFeature([
      { name: InternalConversation.name, schema: InternalConversationSchema },
      { name: InternalMessage.name, schema: InternalMessageSchema },
      // TeamRosterService's own reads — Department/chat-count aggregation
      // (see that service's doc comment). Conversation/User schemas are
      // ALSO registered elsewhere (ConversationsModule/UsersModule), but
      // `MongooseModule.forFeature` is idempotent per-connection — Nest
      // dedupes the same {name, schema} pair across modules, so this is
      // the normal way a leaf module declares its own model needs rather
      // than importing another feature module just to reach its model.
      { name: Department.name, schema: DepartmentSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // TeamRosterService needs PresenceService (live connection status) and
    // PermissionsService (the 'roles.manage' Admin-column check). Neither
    // module imports this one back — both are leaf/near-leaf modules, no
    // cycle (same reasoning RealtimeModule's own doc comment gives for its
    // near-identical import list).
    PresenceModule,
    RbacModule,
  ],
  providers: [InternalConversationsService, TeamRosterService],
  exports: [InternalConversationsService, TeamRosterService],
})
export class InternalConversationsModule {}
