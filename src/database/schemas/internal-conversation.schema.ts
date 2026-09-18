import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * InternalConversation — SRS Feature 4 (`12-zendesk-feature-parity-srs.md`
 * §"Team Panel: Internal Agent-to-Agent Chat"). Deliberately a separate
 * collection from `Conversation`, not a variant of it — every existing
 * Conversation is Agent<->Visitor (Site-scoped, has a `visitorId`); this is
 * Agent<->Agent, Organization-wide, with no Visitor and no Site scoping at
 * all. 1:1 only (matching "click the agent's name to open a chat," not a
 * group chat) — `participantIds` always holds exactly two distinct Users,
 * enforced by `InternalConversationsService.findOrCreate`, not the schema
 * (Mongoose has no clean "exactly 2, order-independent, unique pair" schema
 * validator).
 */
@Schema({ timestamps: false, collection: 'internal_conversations' })
export class InternalConversation {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  })
  organizationId!: Types.ObjectId;

  @Prop({
    type: [SchemaTypes.ObjectId],
    ref: 'User',
    required: true,
  })
  participantIds!: Types.ObjectId[];

  @Prop({ required: true, default: () => new Date() })
  createdAt!: Date;

  // Denormalized for the sidebar/"View all" list to sort by recency without
  // a join against InternalMessage — mirrors why Conversation-adjacent
  // list views generally prefer a stored sort key over a live aggregate.
  @Prop({ type: Date, default: null })
  lastMessageAt!: Date | null;
}

export type InternalConversationDocument = InternalConversation & Document;
export const InternalConversationSchema =
  SchemaFactory.createForClass(InternalConversation);
// Primary access pattern: given two User ids, find their existing 1:1
// conversation (find-or-create) or list an Organization's conversations.
InternalConversationSchema.index({ organizationId: 1, participantIds: 1 });
// Enforces "exactly one InternalConversation per unordered pair" at the DB
// level — `InternalConversationsService.findOrCreate` always writes
// `participantIds` sorted, so this compound-unique index is what actually
// makes find-or-create race-safe under concurrent calls (an upsert alone,
// without this, would still let two racing inserts both succeed).
InternalConversationSchema.index(
  { organizationId: 1, 'participantIds.0': 1, 'participantIds.1': 1 },
  { unique: true },
);
