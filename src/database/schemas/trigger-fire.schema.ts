import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * TriggerFire — Feature 2.2 (`12-zendesk-feature-parity-srs.md` §2.2),
 * Session Feature-2b-engine. One row per (Trigger, Visitor) pair that has
 * already fired, backing the server-side half of `Trigger.
 * fireOncePerVisitor` ("Fire only once per visitor" — §2.2's own text is
 * explicit this must be a dedupe chat-hub tracks internally, not a
 * client-only concern). Distinct from the widget's PRE-EXISTING client-side
 * `firedIds` session-Set (`triggers.ts`/`WidgetApp.tsx`) — that one only
 * survives one browser tab's lifetime and can't see conditions this
 * session's engine now evaluates server-side (tags, department, account
 * status, etc.), so it can't be the source of truth on its own. This
 * collection is: it persists across sessions/reloads/devices for the same
 * Visitor, matching Zendesk's own "only once per visitor" (not "once per
 * browser tab") semantics.
 *
 * Deliberately its own tiny collection rather than an array field on
 * Trigger or Visitor — either host would grow unboundedly (every Visitor
 * who ever triggered it, or every Trigger a Visitor ever fired), same "own
 * collection over an unbounded embedded array" reasoning `message.schema.ts`/
 * `page-visit.schema.ts` already establish elsewhere in this codebase.
 *
 * No `siteId` — a (triggerId, visitorId) pair is already unique without it
 * (Trigger and Visitor are each already Site-scoped, and the compound
 * unique index below is what the engine actually queries by), so it would
 * be a pure denormalization with nothing to gate on.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'triggerFires',
})
export class TriggerFire {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Trigger',
    required: true,
  })
  triggerId!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Visitor',
    required: true,
  })
  visitorId!: Types.ObjectId;

  createdAt!: Date;
}

export type TriggerFireDocument = TriggerFire & Document;
export const TriggerFireSchema = SchemaFactory.createForClass(TriggerFire);
// The engine's ONLY two access patterns: "has (triggerId, visitorId)
// already fired" (a read, pre-evaluation) and "record that it just did" (a
// write, post-match) — this single compound unique index serves both, and
// the uniqueness constraint itself is what makes a racing double-fire (two
// concurrent evaluations for the same Visitor) safe: the loser's insert
// just fails a duplicate-key check rather than double-recording.
TriggerFireSchema.index({ triggerId: 1, visitorId: 1 }, { unique: true });
