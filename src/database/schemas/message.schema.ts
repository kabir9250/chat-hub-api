import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const MESSAGE_SENDER_TYPES = ['visitor', 'agent', 'system'] as const;
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];

/**
 * Message — SRS §4.6. Kept as its OWN collection, NOT embedded in
 * Conversation — a long-running conversation's message list would
 * otherwise grow the parent document unboundedly and risk MongoDB's 16MB
 * document size limit. Indexed on `conversationId` for fast transcript
 * retrieval.
 */
@Schema({ timestamps: false, collection: 'messages' })
export class Message {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true,
  })
  conversationId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: MESSAGE_SENDER_TYPES })
  senderType!: MessageSenderType;

  // Nullable for system messages; visitor/agent messages should populate it.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  senderId!: Types.ObjectId | null;

  @Prop({ required: true })
  body!: string;

  @Prop({ required: true, default: () => new Date() })
  sentAt!: Date;

  @Prop({ type: Date, default: null })
  deliveredAt!: Date | null;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;
}

export type MessageDocument = Message & Document;
export const MessageSchema = SchemaFactory.createForClass(Message);
// Primary access pattern: fetch a conversation's transcript in order.
MessageSchema.index({ conversationId: 1, sentAt: 1 });
