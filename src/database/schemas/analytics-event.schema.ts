import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const ANALYTICS_EVENT_TYPES = [
  'pageView',
  'totalVisit',
  'uniqueVisitor',
  'chatStarted',
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * AnalyticsEvent — SRS §4.10. Raw, high-write-volume tracking data behind
 * the Home dashboard chart. Indexed on `{siteId, type, occurredAt}` for
 * the Hourly/Daily/Weekly/Monthly aggregation queries (`$group` by
 * date-truncated `occurredAt`).
 */
@Schema({ timestamps: false, collection: 'analyticsEvents' })
export class AnalyticsEvent {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Site', required: true })
  siteId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ANALYTICS_EVENT_TYPES })
  type!: AnalyticsEventType;

  @Prop({ required: true, default: () => new Date() })
  occurredAt!: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Visitor', default: null })
  visitorId!: Types.ObjectId | null;

  @Prop()
  pageUrl?: string;
}

export type AnalyticsEventDocument = AnalyticsEvent & Document;
export const AnalyticsEventSchema =
  SchemaFactory.createForClass(AnalyticsEvent);
// Required by the SRS explicitly — dashboard's core aggregation index.
AnalyticsEventSchema.index({ siteId: 1, type: 1, occurredAt: 1 });
