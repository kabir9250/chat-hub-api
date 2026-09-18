import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

import { MessageAttachment, MessageAttachmentSchema } from './message.schema';

/**
 * InternalMessage — SRS Feature 4. Deliberately parallel to (not merged
 * into) `Message`: this is a genuinely different domain (no Visitor, no
 * Site-scoped RBAC, no visitor-side read-receipt asymmetry — both
 * participants see symmetric delivery/read ticks on their own sent
 * messages), so keeping it separate means the existing visitor-facing
 * `Message`/`Conversation` schemas — already battle-tested through several
 * fix sessions (see PROGRESS.md) — aren't put at risk by this addition.
 * Reuses `MessageAttachmentSchema` as-is for parity with visitor chat
 * (Phase 2 §3.9) rather than redefining an identical sub-shape.
 */
@Schema({ timestamps: false, collection: 'internal_messages' })
export class InternalMessage {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'InternalConversation',
    required: true,
    index: true,
  })
  internalConversationId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  senderId!: Types.ObjectId;

  // Attachment-only messages are valid, same precedent as Message.body
  // (Phase 2 FR-P2-ATT-07) — "body OR at least one attachment" is enforced
  // at the service layer, not the schema.
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

export type InternalMessageDocument = InternalMessage & Document;
export const InternalMessageSchema =
  SchemaFactory.createForClass(InternalMessage);
// Primary access pattern: fetch an internal conversation's transcript in order.
InternalMessageSchema.index({ internalConversationId: 1, sentAt: 1 });
