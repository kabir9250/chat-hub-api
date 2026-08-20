import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Lead — SRS §4.9. A tracked view of Visitor+Conversation; modeled here as
 * its own collection (engineering's implementation choice noted in the
 * SRS as acceptable) so it's directly reportable/filterable by status
 * without an aggregation over Visitor+Conversation on every request.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'leads',
})
export class Lead {
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

  @Prop({ type: [SchemaTypes.ObjectId], ref: 'Conversation', default: [] })
  conversationIds!: Types.ObjectId[];

  @Prop({ type: String, required: true, enum: LEAD_STATUSES, default: 'new' })
  status!: LeadStatus;

  createdAt!: Date;
  updatedAt!: Date;
}

export type LeadDocument = Lead & Document;
export const LeadSchema = SchemaFactory.createForClass(Lead);
LeadSchema.index({ siteId: 1, status: 1 });
