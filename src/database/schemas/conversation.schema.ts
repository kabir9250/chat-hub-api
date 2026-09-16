import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_SUBMISSION_CHANNELS = ['online', 'offline'] as const;
export type ConversationSubmissionChannel =
  (typeof CONVERSATION_SUBMISSION_CHANNELS)[number];

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

  // Tickets screen (Phase 3, replaces the scrapped Lead Creation Settings)
  // — real, persisted signal for "was this Conversation a live chat or an
  // Offline Contact Form submission (FR-WID-10)," set ONCE at creation time
  // in ConversationsService.create() from the same online/offline
  // definition WidgetBootstrapService.getStatus already uses for the
  // widget's own indicator (agent presence + business hours). Replaces the
  // prior inferred-at-read-time guess (status==='pending' && no agent) that
  // LeadsService used to make only at Lead-creation time — that guess
  // wasn't stable after the Conversation got claimed/closed and couldn't
  // distinguish "genuinely offline" from "live chat nobody's claimed yet."
  // Always 'online' for the Agent-initiated proactive-start path
  // (startProactiveConversation) — an Agent starting a chat is
  // definitionally online, no computation needed there.
  @Prop({
    type: String,
    required: true,
    enum: CONVERSATION_SUBMISSION_CHANNELS,
    default: 'online',
  })
  submissionChannel!: ConversationSubmissionChannel;

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

  /**
   * Agent-lock-fix (`files/agent-lock-fix/10-conversation-lock-and-assign-
   * column.md`) — set `true` once, the moment this Conversation is created
   * `assignedAgentId: null` (FR-RTE-02's "no Agent available" outcome,
   * `pickAgentForRouting` returning `null`). Marks this Conversation as
   * having genuinely passed through the shared, whole-Department queue —
   * as opposed to one that was assigned to a specific Agent immediately at
   * creation and never broadcast Department-wide at all.
   *
   * This is what actually completes FR-RTE-02 for a `conversations.
   * view_own`-only Agent: before this field existed, `assertVisible` only
   * ever let such an Agent reach a Conversation already
   * `assignedAgentId === self` — an unassigned Conversation 404'd for them
   * (confirmed live, and see PROGRESS.md Session 8's own smoke test:
   * "Agent reconnects and attempts `agent:join_conversation` on that still-
   * unassigned Conversation → refused"), and the real-time gateway never
   * even put a `view_own`-only socket in a room that would tell them it
   * existed. The SRS's own wording ("visible to all Agents of that
   * Department") was therefore never reachable by the default `Agent` Role.
   * `deptQueueVisible: true` is the one-bit memory `assertVisible` now
   * checks to grant that visibility — and, per the Zendesk reference
   * behavior this fix cites, it deliberately never resets back to `false`
   * once claimed: every Agent who could have raced to claim it can also
   * keep watching it get handled (grayed out, per Zendesk), same as
   * everyone who was in the room when the "Unassigned" queue card first
   * appeared. Sending remains a fully separate check (see
   * `ConversationsService.assertCanSend`) — this field only widens what can
   * be READ, never what can be SENT into.
   */
  @Prop({ type: Boolean, default: false })
  deptQueueVisible!: boolean;
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
