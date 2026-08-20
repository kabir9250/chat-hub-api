import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * Role — SRS §4.3b.
 *
 * `permissions` is an embedded array of permission keys (strings matching
 * the fixed catalog in `src/rbac/permission.catalog.ts`) — this replaces a
 * separate RolePermission join collection. A Role with an empty array has
 * zero rights.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'roles',
})
export class Role {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  })
  organizationId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, default: '' })
  description!: string;

  // True for the 4 seeded Roles — mainly to protect "Owner" from accidental
  // deletion (FR-RBAC-04/09). Not an access-control field by itself.
  @Prop({ required: true, default: false })
  isSystemDefault!: boolean;

  @Prop({ type: [String], default: [] })
  permissions!: string[];

  /**
   * Marks the ONE auto-provisioned Role per Organization that backs the
   * Admin Panel's "let this User see a Visitor's live typing preview"
   * toggle (`RoleAssignmentsService.setLiveActivityAccess`) — carries
   * exactly `visitors.view_live_activity`. A dedicated boolean rather than
   * matching on `name` so the lookup stays correct even if an admin
   * renames it later via a future Roles UI. Not otherwise
   * access-control-relevant — a normal Role in every other respect.
   */
  @Prop({ required: true, default: false })
  isLiveActivityGrant!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RoleDocument = Role & Document;
export const RoleSchema = SchemaFactory.createForClass(Role);
// organizationId already indexed via `index: true` on the @Prop above.
