import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * PageVisit — SRS §4.4a (added post-hoc, this session). Site-scoped, one
 * document per page/route the Visitor was on during their session.
 * Deliberately its OWN collection, not embedded on Visitor — a long
 * browsing session (or an SPA with lots of client-side routing) could
 * otherwise grow the parent Visitor document unboundedly, the same
 * "own collection" reasoning message.schema.ts already documents for
 * Message-vs-Conversation.
 *
 * Lifecycle: `PageVisitsService.recordPageChange()` is the only writer —
 * on every navigation it closes out whichever PageVisit is still open for
 * that Visitor (`exitedAt: null`) by setting `exitedAt`/`durationSeconds`,
 * then opens a new one for the page just entered. At most one PageVisit per
 * Visitor should ever be open (`exitedAt: null`) at a time.
 */
@Schema({
  timestamps: { createdAt: false, updatedAt: false },
  collection: 'pageVisits',
})
export class PageVisit {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Visitor',
    required: true,
    index: true,
  })
  visitorId!: Types.ObjectId;

  // Nullable — a Visitor is tracked from widget load, before any
  // Conversation necessarily exists (or after one has closed).
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Conversation', default: null })
  conversationId!: Types.ObjectId | null;

  @Prop({ type: String, required: true })
  pageUrl!: string;

  // Nullable — see PageVisitsService/page-category.util.ts for the
  // derivation rule and why it can legitimately fail to categorize a URL.
  @Prop({ type: String, default: null })
  pageCategory!: string | null;

  @Prop({ type: Date, required: true, default: () => new Date() })
  enteredAt!: Date;

  @Prop({ type: Date, default: null })
  exitedAt!: Date | null;

  @Prop({ type: Number, default: null })
  durationSeconds!: number | null;
}

export type PageVisitDocument = PageVisit & Document;
export const PageVisitSchema = SchemaFactory.createForClass(PageVisit);

// Primary access pattern #1: "does this Visitor have a PageVisit still
// open" (recordPageChange's close-out step) + a Visitor's page trail for
// the Agent Console (FR-AGT-08-ish "recent page history").
PageVisitSchema.index({ visitorId: 1, enteredAt: 1 });
// Primary access pattern #2: FR-RPT-08's time-per-page/page-category
// report — mirrors AnalyticsEvent's existing {siteId,type,occurredAt}
// pattern (Session 1) for the same "aggregate by Site + bucket + time"
// shape.
PageVisitSchema.index({ siteId: 1, pageCategory: 1, enteredAt: 1 });
// A Conversation's own page trail (Agent Console conversation view).
PageVisitSchema.index({ conversationId: 1 });
