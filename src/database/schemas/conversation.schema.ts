import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Conversation — SRS §4.5. Site-scoped. Messages are deliberately NOT
 * embedded here (see message.schema.ts) — only the transcript's own
 * collection scales past MongoDB's 16MB document cap for long chats.
 */
@Schema({
  timestamps: { createdAt: false, updatedAt: false },
  collection: 'conversations',
})
export class Conversation {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Department', required: true })
  departmentId!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Visitor',
    required: true,
    index: true,
  })
  visitorId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  assignedAgentId!: Types.ObjectId | null;

  @Prop({
    type: String,
    required: true,
    enum: CONVERSATION_STATUSES,
    default: 'open',
  })
  status!: ConversationStatus;

  @Prop({ required: true, default: () => new Date() })
  startedAt!: Date;

  @Prop({ type: Date, default: null })
  closedAt!: Date | null;

  // Fixed value in Phase 1 — chat only (SRS §4.5).
  @Prop({ required: true, default: 'chat' })
  channel!: string;

  @Prop({ type: Number, default: null, min: 1, max: 5 })
  ratingScore!: number | null;

  @Prop({ type: String, default: null })
  ratingComment!: string | null;

  @Prop({ type: [String], default: [] })
  tags!: string[];

  @Prop({ required: true, unique: true, index: true })
  referenceNumber!: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Trigger', default: null })
  triggeredByRuleId!: Types.ObjectId | null;
}

export type ConversationDocument = Conversation & Document;
export const ConversationSchema = SchemaFactory.createForClass(Conversation);
ConversationSchema.index({ siteId: 1, status: 1 });
ConversationSchema.index({ assignedAgentId: 1 });
// T-11 Test 4 fix (Session Fix-05, PROGRESS.md) — every Inbox/History list
// (single-Site `findAll` and combined-mode `findAllCombined`) filters by
// `siteId` (or `siteId: {$in:[...]}`) and sorts by `startedAt` descending
// before paginating. Without this, the `{siteId,status}` index above only
// serves the `siteId` prefix — Mongo still has to FETCH every matching
// Conversation and SORT in memory to find the top page. This compound index
// lets that become a true index-ordered top-N scan instead. See
// `files/reports/T-11-load.md` Test 4 finding #3.
ConversationSchema.index({ siteId: 1, startedAt: -1 });
