import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/** Concierge branding embedded on a WidgetConfig — SRS §4.7. */
@Schema({ _id: false })
export class WidgetConcierge {
  @Prop({ default: 'Live Support' })
  displayName!: string;

  @Prop({ default: 'Ask us anything' })
  byline!: string;

  @Prop()
  avatarUrl?: string;
}
export const WidgetConciergeSchema =
  SchemaFactory.createForClass(WidgetConcierge);

export const FORM_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'textarea',
  'dropdown',
  'checkbox',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/**
 * FormFieldConfig — one field on either the pre-chat (online) form or the
 * offline ("we're away") form, embedded on WidgetConfig. Mirrors the shape
 * of Zendesk's Web Widget "Forms" tab: an admin can add/remove fields,
 * reorder them, and flip required <-> optional per field.
 *
 * `builtin: true` fields (name/email/phone on the pre-chat form, message on
 * the offline form) map onto columns/behavior the rest of the backend
 * already depends on (`SubmitVisitorProfileDto`'s name/email,
 * `OfflineForm`'s message-becomes-first-Message flow) — they can be hidden
 * (`enabled: false`) or have `required` flipped, but never deleted, so
 * those existing code paths can't be handed a payload missing the field
 * they expect. Everything else (`builtin: false`) is a fully custom field
 * an admin added — its answers are collected into a generic
 * `customFields` map (see SubmitVisitorProfileDto/CreateConversationDto),
 * not a schema column of its own.
 */
@Schema({ _id: false })
export class FormFieldConfig {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ type: String, required: true, enum: FORM_FIELD_TYPES })
  type!: FormFieldType;

  @Prop({ required: true, default: false })
  required!: boolean;

  @Prop({ required: true, default: true })
  enabled!: boolean;

  @Prop({ required: true, default: 0 })
  order!: number;

  // Dropdown only — the selectable choices.
  @Prop({ type: [String], default: undefined })
  options?: string[];

  @Prop({ required: true, default: false })
  builtin!: boolean;
}
export const FormFieldConfigSchema =
  SchemaFactory.createForClass(FormFieldConfig);

/** Default pre-chat (online) form fields — FR-WID-05's Name/Email required, Phone optional. */
export function defaultPreChatFormFields(): FormFieldConfig[] {
  return [
    {
      id: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      enabled: true,
      order: 0,
      builtin: true,
    },
    {
      id: 'email',
      label: 'Email',
      type: 'email',
      required: true,
      enabled: true,
      order: 1,
      builtin: true,
    },
    {
      id: 'phone',
      label: 'Phone',
      type: 'phone',
      required: false,
      enabled: true,
      order: 2,
      builtin: true,
    },
  ] as FormFieldConfig[];
}

/** Default offline ("we're away") form fields — FR-WID-10's single Message field. */
export function defaultOfflineFormFields(): FormFieldConfig[] {
  return [
    {
      id: 'message',
      label: 'Message',
      type: 'textarea',
      required: true,
      enabled: true,
      order: 0,
      builtin: true,
    },
  ] as FormFieldConfig[];
}

/**
 * WidgetConfig — SRS §4.7. One document per Site.
 *
 * Engineering choice (per the SRS's explicit either/or): kept as its own
 * collection rather than embedded on Site, since widget branding is edited
 * independently of core Site fields (name/domains/timezone) and this keeps
 * the Site document small. `siteId` is unique to enforce the 1:1.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'widgetConfigs',
})
export class WidgetConfig {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    unique: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  @Prop({ default: 'support' })
  topTitle!: string;

  @Prop({ type: WidgetConciergeSchema, default: () => ({}) })
  concierge!: WidgetConcierge;

  @Prop()
  iconUrl?: string;

  @Prop({ default: '#1E88E5' })
  primaryColor!: string;

  @Prop({ default: 'modern' })
  messageStyle!: string;

  @Prop({ required: true, default: true })
  notificationSoundEnabled!: boolean;

  @Prop({ required: true, default: true })
  satisfactionRatingsEnabled!: boolean;

  @Prop({ required: true, default: true })
  offlineFormEnabled!: boolean;

  // FR-CFG-01/02 "Forms" builder (this session's addition) — independently
  // configurable per Site, per form. See FormFieldConfig's doc comment for
  // the builtin-vs-custom distinction.
  @Prop({ type: [FormFieldConfigSchema], default: defaultPreChatFormFields })
  preChatFormFields!: FormFieldConfig[];

  @Prop({ type: [FormFieldConfigSchema], default: defaultOfflineFormFields })
  offlineFormFields!: FormFieldConfig[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type WidgetConfigDocument = WidgetConfig & Document;
export const WidgetConfigSchema = SchemaFactory.createForClass(WidgetConfig);
