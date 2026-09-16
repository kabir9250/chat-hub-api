import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Conversation,
  ConversationSchema,
  Message,
  MessageSchema,
  Site,
  SiteSchema,
  User,
  UserSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { RbacModule } from '../rbac/rbac.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Visitor.name, schema: VisitorSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Site.name, schema: SiteSchema },
      { name: User.name, schema: UserSchema },
    ]),
    RbacModule,
  ],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
