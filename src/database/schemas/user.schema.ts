import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

export const ROLE_ASSIGNMENT_SCOPE_TYPES = ['ORGANIZATION', 'SITE'] as const;
export type RoleAssignmentScopeType =
  (typeof ROLE_ASSIGNMENT_SCOPE_TYPES)[number];

/**
 * RoleAssignment — SRS §4.3 / §4.3d.
 *
 * Embedded (NOT a separate `userRoleAssignments` collection) on the User
 * document, per the SRS: "assignments are always read together with the
 * user." A User may hold zero, one, or multiple assignments.
 *
 * scopeType 'ORGANIZATION' grants the Role's permissions across every Site
 * in the Organization; scopeType 'SITE' scopes it to exactly one Site
 * (siteId required in that case). See FR-RBAC-06 for how these combine
 * into a User's effective permissions on a given Site.
 */
// NOTE (Session 3): `_id: false` was removed from this subdocument schema.
// Session 1 embedded RoleAssignments without their own `_id`; Session 3's
// Role Assignment API (create/**revoke**) needs a stable way to address one
// specific assignment within a User's `roleAssignments` array, so each
// element now gets Mongoose's default auto-generated ObjectId `_id`. This
// is a schema amendment, not a new collection — existing seeded documents
// don't retroactively gain an `_id` on their array elements, so re-run
// `npm run seed` after pulling this change (the seed script recreates all
// Users from scratch, so this is a non-issue for Phase 1 data).
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class RoleAssignment {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Role', required: true })
  roleId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ROLE_ASSIGNMENT_SCOPE_TYPES })
  scopeType!: RoleAssignmentScopeType;

  // Required only when scopeType === 'SITE'; enforced in the pre-validate
  // hook below rather than a plain `required: true` since it's conditional.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Site', required: false })
  siteId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: false })
  createdByUserId?: Types.ObjectId;

  createdAt!: Date;
}
export const RoleAssignmentSchema =
  SchemaFactory.createForClass(RoleAssignment);
RoleAssignmentSchema.pre('validate', function (next) {
  if (this.scopeType === 'SITE' && !this.siteId) {
    next(new Error('RoleAssignment.siteId is required when scopeType is SITE'));
    return;
  }
  next();
});

/**
 * User — SRS §4.3.
 *
 * Deliberately has NO hardcoded `role` field. Access comes entirely from
 * the embedded `roleAssignments` array — never add a shortcut role string
 * here, it would defeat the point of the RBAC design (SRS §4.3 note).
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'users',
})
export class User {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  })
  organizationId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  displayName!: string;

  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    unique: true,
    index: true,
  })
  email!: string;

  @Prop({ trim: true, lowercase: true })
  supportEmail?: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Department',
    required: false,
    default: null,
  })
  departmentId?: Types.ObjectId | null;

  @Prop({ required: true, default: true })
  enabled!: boolean;

  @Prop({
    type: String,
    required: true,
    enum: ['online', 'offline', 'away'],
    default: 'offline',
  })
  status!: 'online' | 'offline' | 'away';

  @Prop()
  avatarUrl?: string;

  @Prop({ type: [RoleAssignmentSchema], default: [] })
  roleAssignments!: RoleAssignment[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type UserDocument = User & Document;
export const UserSchema = SchemaFactory.createForClass(User);
// organizationId already indexed via `index: true` on the @Prop above.
UserSchema.index({ departmentId: 1 });
