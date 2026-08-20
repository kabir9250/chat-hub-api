import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/** Geo-location snapshot embedded on a Visitor — SRS §4.4. */
@Schema({ _id: false })
export class VisitorLocation {
  @Prop()
  city?: string;

  @Prop()
  region?: string;

  @Prop()
  country?: string;
}
export const VisitorLocationSchema =
  SchemaFactory.createForClass(VisitorLocation);

/**
 * Visitor — SRS §4.4. Site-scoped (carries `siteId`, the multi-tenant
 * boundary). Holds attribution + technical metadata for the History →
 * User Info panel.
 */
@Schema({
  timestamps: { createdAt: false, updatedAt: false },
  collection: 'visitors',
})
export class Visitor {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  @Prop({ type: String, default: null })
  name!: string | null;

  @Prop({ type: String, default: null, lowercase: true, trim: true })
  email!: string | null;

  @Prop({ type: String, default: null })
  phone!: string | null;

  @Prop({ required: true, default: () => new Date() })
  firstSeenAt!: Date;

  @Prop({ required: true, default: () => new Date() })
  lastSeenAt!: Date;

  @Prop({ required: true, default: 0 })
  pastVisitsCount!: number;

  @Prop({ required: true, default: 0 })
  pastChatsCount!: number;

  @Prop()
  currentIp?: string;

  @Prop({ type: VisitorLocationSchema, default: () => ({}) })
  location!: VisitorLocation;

  @Prop()
  browser?: string;

  @Prop()
  os?: string;

  @Prop()
  deviceType?: string;

  @Prop()
  userAgentRaw?: string;

  @Prop()
  referrer?: string;

  @Prop()
  landingPage?: string;

  @Prop()
  utmSource?: string;

  @Prop()
  utmMedium?: string;

  @Prop()
  utmCampaign?: string;

  // FR-VIS-02: "Direct traffic" vs. the referring page/domain (or, when
  // present, the UTM campaign source — a more specific attribution signal
  // than a bare referrer). Computed server-side on every session init; see
  // AttributionService.computeVisitorPath(). Not user-editable.
  @Prop({ type: String, default: 'Direct traffic' })
  visitorPath!: string;

  @Prop({ default: '' })
  notes!: string;

  @Prop({ required: true, default: false })
  isBanned!: boolean;

  // FR-CFG-01/02 Forms builder (this session's addition) — answers to any
  // custom (non-builtin) field an admin added to the pre-chat or offline
  // form, keyed by that field's `FormFieldConfig.id`. Kept as a loose map
  // (not individual columns) since the field set is admin-defined per Site
  // and can change at any time — same "Mixed, kept loose" reasoning
  // `BusinessHoursConfig.weeklySchedule` already uses.
  @Prop({ type: Object, default: {} })
  customFields!: Record<string, string>;
}

export type VisitorDocument = Visitor & Document;
export const VisitorSchema = SchemaFactory.createForClass(Visitor);
// siteId already indexed via `index: true` on the @Prop above.
