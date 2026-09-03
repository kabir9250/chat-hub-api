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

  // Session P2-5 redesign (direct user feedback) — attribution SNAPSHOT at
  // the moment this page was entered, captured only when the caller has
  // fresh attribution data (`VisitorSessionService.init()`, which re-runs
  // `AttributionService.build()` every widget boot — the WS
  // `visitor:page_changed` path, a mid-session SPA route change, has no new
  // attribution to report and leaves these null). `Visitor.referrer`/
  // `visitorPath` are a single mutable field overwritten on every visit, so
  // they can only ever describe the visitor's LATEST landing, not "where
  // they came from for THIS specific past visit" — the per-conversation
  // "Visitor path" chip needs the value as it was at the time, which means
  // it has to live on the immutable PageVisit row, not the Visitor document.
  // Nullable/best-effort: a `null` here just means "no snapshot for this
  // row" (a mid-session SPA nav, or a row written before this field
  // existed) — callers fall back to `Visitor.visitorPath` in that case.
  @Prop({ type: String, default: null })
  referrer!: string | null;

  @Prop({ type: String, default: null })
  landingPage!: string | null;

  @Prop({ type: String, default: null })
  utmSource!: string | null;

  @Prop({ type: String, default: null })
  utmMedium!: string | null;

  @Prop({ type: String, default: null })
  utmCampaign!: string | null;

  /** Precomputed "Direct traffic" / referring domain / UTM label — same
   * value `AttributionService.computeVisitorPath()` would produce, stored
   * here so a past visit's attribution chip doesn't need to be re-derived. */
  @Prop({ type: String, default: null })
  visitorPathLabel!: string | null;

  // Direct user feedback — "a new visit" means the browser tab was closed
  // and reopened, not "30+ minutes of inactivity passed" (matches Zendesk's
  // own definition). The widget generates one id per tab lifetime via
  // `sessionStorage` (`widget/storage.ts`'s `getOrCreateVisitSessionId`) and
  // sends it on every `init()`/page-change call; `current-visit.util.ts`'s
  // `groupIntoVisits` groups consecutive rows sharing this id as one visit
  // session instead of using the old 30-minute-gap heuristic. Nullable and
  // backward-compatible: `null` on every row written before this field
  // existed (and on any row from a caller that doesn't send one), which
  // `groupIntoVisits` falls back to the old gap-based grouping for.
  @Prop({ type: String, default: null })
  visitSessionId!: string | null;
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
