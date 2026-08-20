import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Organization — SRS §4.0. The top-level multi-tenant boundary.
 *
 * Every Site, User, and Role document stores an `organizationId` back to
 * this collection. Phase 1 seeds exactly one Organization, but no query
 * anywhere may assume single-tenancy (FR-RBAC-01).
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'organizations',
})
export class Organization {
  _id!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({
    type: String,
    required: true,
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status!: 'active' | 'inactive';

  createdAt!: Date;
  updatedAt!: Date;
}

export type OrganizationDocument = Organization & Document;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
