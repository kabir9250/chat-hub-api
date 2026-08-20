import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * Department — SRS §4.2. A team within a Site (e.g. "Team A"). Every
 * Department is Site-scoped; Site-scoped collections must always carry a
 * `siteId` (the multi-tenant boundary), which this does.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'departments',
})
export class Department {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  createdAt!: Date;
}

export type DepartmentDocument = Department & Document;
export const DepartmentSchema = SchemaFactory.createForClass(Department);
// siteId already indexed via `index: true` on the @Prop above.
