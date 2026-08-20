import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const AUDIT_ACTOR_TYPES = ['user', 'visitor', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * AuditLog — SRS §5.10 FR-AUTH-05 / §6.7.
 *
 * Basic audit-log scaffolding: who (actor), what (action), when
 * (createdAt), on which Site. This session (Auth) only builds the
 * table/service — no specific mutating actions (assign, ban, config
 * change, etc.) are wired to call `AuditLogService.record()` yet; that's
 * for the sessions that build those features. The `auth.login` /
 * `visitor_session.init` calls in this session are the only entries
 * actually written so far, to prove the plumbing works end-to-end.
 *
 * Deliberately NOT in the SRS §4 collection list (added this session,
 * logged here per the SRS's "log any additions in PROGRESS.md" note) —
 * it's an infrastructure/cross-cutting collection, not a domain entity.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'auditLogs',
})
export class AuditLog {
  _id!: Types.ObjectId;

  // Who performed the action. Nullable actorId covers 'system' actions
  // (no human actor) — actorType always tells you which case you're in.
  @Prop({ type: String, required: true, enum: AUDIT_ACTOR_TYPES })
  actorType!: AuditActorType;

  @Prop({ type: SchemaTypes.ObjectId, required: false, index: true })
  actorId?: Types.ObjectId;

  // What. Free-form dotted action key (e.g. "auth.login",
  // "conversations.assign") — not an enum, since the catalog of possible
  // actions grows as later sessions add features; keep this collection
  // schema-stable while the set of actions evolves.
  @Prop({ required: true, trim: true, index: true })
  action!: string;

  // On which Site. Nullable — some actions (login, org-level role
  // changes) aren't Site-scoped.
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: false,
    index: true,
  })
  siteId?: Types.ObjectId;

  // Optional pointer to the entity the action was performed on (e.g. the
  // Conversation that was assigned, the User that was disabled).
  @Prop({ type: String, required: false })
  targetType?: string;

  @Prop({ type: SchemaTypes.ObjectId, required: false })
  targetId?: Types.ObjectId;

  // Free-form extra context (e.g. previous/new values) — kept loose on
  // purpose since every action logs different details.
  @Prop({ type: Object, required: false })
  metadata?: Record<string, unknown>;

  createdAt!: Date;
}

export type AuditLogDocument = AuditLog & Document;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
