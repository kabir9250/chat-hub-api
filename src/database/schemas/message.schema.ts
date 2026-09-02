import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const MESSAGE_SENDER_TYPES = ['visitor', 'agent', 'system'] as const;
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];

/**
 * Phase 2 §2.3/§3.9 (FR-P2-ATT-01–08) — one uploaded file on a Message.
 * Deliberately stores `key` (the object-storage key — see StorageService),
 * NOT a `url` — a permanent URL would be exactly the "guessable/public
 * link" FR-P2-ATT-08 rules out. The wire-format `url`/`thumbnailUrl` a
 * client actually receives (SRS §2.3's field names) are generated FRESH,
 * short-lived, on every read (ConversationsService's message-serialization
 * helpers) — never persisted.
 */
@Schema({ _id: false })
export class MessageAttachment {
  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  fileName!: string;

  @Prop({ type: String, required: true })
  fileType!: string;

  @Prop({ type: Number, required: true })
  fileSizeBytes!: number;

  // Cached at upload time (from the validated MIME type) purely so
  // serialization doesn't need to re-derive it from an allow-list constant
  // on every read — see attachment-validation.ts's `isImageMimeType`.
  @Prop({ type: Boolean, required: true, default: false })
  isImage!: boolean;
}
export const MessageAttachmentSchema =
  SchemaFactory.createForClass(MessageAttachment);

/**
 * Message — SRS §4.6, extended Phase 2 §2.3 (v1.1) with `attachments`. Kept
 * as its OWN collection, NOT embedded in Conversation — a long-running
 * conversation's message list would otherwise grow the parent document
 * unboundedly and risk MongoDB's 16MB document size limit. Indexed on
 * `conversationId` for fast transcript retrieval.
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

  // Phase 2 (FR-P2-ATT-07): an attachment-only message is valid, so `body`
  // is no longer required — ConversationsService enforces "body OR at least
  // one attachment" at the point a message is created (both the REST and
  // WebSocket send paths funnel through the same service methods), rather
  // than at the schema level, so the rejection carries a clear message
  // instead of a raw Mongoose ValidationError.
  @Prop({ type: String, default: null })
  body!: string | null;

  @Prop({ type: [MessageAttachmentSchema], default: [] })
  attachments!: MessageAttachment[];

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
