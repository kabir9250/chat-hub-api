import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Counter — NOT in the SRS §4 collection list. Added this session (Session
 * 7, Conversations) and logged here per the SRS's "log any additions in
 * PROGRESS.md" convention (same precedent as `AuditLog` in Session 2).
 *
 * A tiny, generic atomic-sequence collection: one document per named
 * counter (`_id` = the counter's name), incremented via an atomic
 * `findOneAndUpdate({ $inc: { seq: 1 } }, { upsert: true })`. Used by
 * `ReferenceNumberService` to mint Conversation reference numbers
 * (FR-CONV-01) that are guaranteed unique and strictly incrementing even
 * under concurrent requests — a random/UUID-based id would be unique but
 * not "human-readable ticket-style" per the SRS's own "#12345678" example,
 * and a naive `Conversation.countDocuments() + 1` is not safe against a
 * race between two concurrent creates.
 */
@Schema({ collection: 'counters', timestamps: false })
export class Counter {
  // Counter name, e.g. 'conversationReferenceNumber'. Explicitly typed
  // String (NOT the schema-level `_id: false` option, which would remove
  // the `_id` path entirely and break `findOneAndUpdate({ _id: ... })`
  // upserts with a Mongoose strict-mode cast error) — declaring `_id` as a
  // normal `@Prop` here overrides Mongoose's default auto-ObjectId `_id`
  // with a plain string, which is what a human-readable counter name needs.
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: Number, required: true, default: 0 })
  seq!: number;
}

export type CounterDocument = Counter & Document;
export const CounterSchema = SchemaFactory.createForClass(Counter);
