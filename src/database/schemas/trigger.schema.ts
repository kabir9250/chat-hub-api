import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

// -----------------------------------------------------------------------
// FR-CFG-04/05 — rebuilt this session into a real condition/action builder
// (matching the shape of Zendesk's own trigger builder), backed only by
// data this app already tracks. See PROGRESS.md / the Widget Config
// overhaul plan for the "practical expanded set" scope decision — some
// Zendesk conditions (search engine/terms, city-level geo-IP precision,
// etc.) are deliberately NOT reproduced since nothing in this app tracks
// them.
// -----------------------------------------------------------------------

/** When the widget (re-)evaluates this Trigger's conditions. */
export const TRIGGER_RUN_EVENTS = [
  'widgetLoaded',
  'widgetOpened',
  'pageChanged',
] as const;
export type TriggerRunEvent = (typeof TRIGGER_RUN_EVENTS)[number];

export const TRIGGER_CONDITION_LOGICS = ['all', 'any'] as const;
export type TriggerConditionLogic = (typeof TRIGGER_CONDITION_LOGICS)[number];

// The original 4 URL-match types (unchanged semantics) plus the expanded
// set — each paired with the "operator"/"value" it expects, enforced by
// the DTO layer (create/update-trigger.dto.ts), not by Mongoose itself.
export const TRIGGER_CONDITION_TYPES = [
  'url', // operator: one of TRIGGER_URL_OPERATORS, value: URL pattern
  'timeOnPage', // operator: 'gte', value: seconds
  'pageViews', // operator: 'gte', value: count (this session's page-view count)
  'pastVisits', // operator: 'gte', value: Visitor.pastVisitsCount
  'pastChats', // operator: 'gte', value: Visitor.pastChatsCount
  'referrer', // operator: 'contains', value: string
  'utmSource', // operator: 'equals', value: string
  'deviceType', // operator: 'equals', value: 'desktop' | 'mobile' | 'tablet'
  'onlineStatus', // operator: 'equals', value: 'online' | 'offline'
] as const;
export type TriggerConditionType = (typeof TRIGGER_CONDITION_TYPES)[number];

export const TRIGGER_URL_OPERATORS = [
  'exact path',
  'path prefix',
  'contains',
  'regex',
] as const;
export type TriggerUrlOperator = (typeof TRIGGER_URL_OPERATORS)[number];

@Schema({ _id: false })
export class TriggerCondition {
  @Prop({ type: String, required: true, enum: TRIGGER_CONDITION_TYPES })
  type!: TriggerConditionType;

  // Free-form operator string — which values are valid depends on `type`
  // (a TRIGGER_URL_OPERATORS member for 'url', 'gte' for the count-based
  // types, 'contains'/'equals' otherwise). Validated by the DTO, not here.
  @Prop({ required: true })
  operator!: string;

  @Prop({ required: true })
  value!: string;
}
export const TriggerConditionSchema =
  SchemaFactory.createForClass(TriggerCondition);

export const TRIGGER_ACTION_TYPES = [
  'autoOpenWidget',
  'showProactiveMessage', // value: message text
  'sendConciergeMessage', // value: message text, inserted once the chat view is reached
  'setDepartment', // value: departmentId
  'addTag', // value: tag string
] as const;
export type TriggerActionType = (typeof TRIGGER_ACTION_TYPES)[number];

@Schema({ _id: false })
export class TriggerActionConfig {
  @Prop({ type: String, required: true, enum: TRIGGER_ACTION_TYPES })
  type!: TriggerActionType;

  @Prop({ type: String, default: null })
  value!: string | null;
}
export const TriggerActionConfigSchema =
  SchemaFactory.createForClass(TriggerActionConfig);

/** Trigger — SRS §4.8. URL-rule-based page trigger, Site-scoped. */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'triggers',
})
export class Trigger {
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

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({
    type: String,
    required: true,
    enum: TRIGGER_RUN_EVENTS,
    default: 'widgetLoaded',
  })
  runEvent!: TriggerRunEvent;

  @Prop({
    type: String,
    required: true,
    enum: TRIGGER_CONDITION_LOGICS,
    default: 'all',
  })
  conditionLogic!: TriggerConditionLogic;

  @Prop({ type: [TriggerConditionSchema], default: [] })
  conditions!: TriggerCondition[];

  @Prop({ type: [TriggerActionConfigSchema], default: [] })
  actions!: TriggerActionConfig[];

  // Zendesk's "Each visitor will receive this message only once".
  @Prop({ required: true, default: false })
  fireOncePerVisitor!: boolean;

  @Prop({ required: true, default: true })
  isEnabled!: boolean;

  // Order of evaluation when multiple Triggers could match the same page.
  @Prop({ required: true, default: 0 })
  priority!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type TriggerDocument = Trigger & Document;
export const TriggerSchema = SchemaFactory.createForClass(Trigger);
TriggerSchema.index({ siteId: 1, isEnabled: 1, priority: 1 });
