import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

// -----------------------------------------------------------------------
// FR-CFG-04/05 — this session (Feature-2b-engine,
// `12-zendesk-feature-parity-srs.md` §2.2) expands the condition type list
// from the earlier "practical expanded set" (9 types) to the FULL
// Zendesk-parity categorized list §2.2 specifies, backed by the fields/
// utilities Session Feature-2b-schema added (`Visitor.tags`/`wasTriggered`/
// `department`, `referrer-search.util.ts`, `account-status.util.ts`) plus
// data this app already tracked. The 9 pre-existing condition types are
// UNCHANGED (same `type` string, same operator/value shape) — kept for
// backward compatibility with Triggers already saved under them; this is
// purely additive. `actions`/`TRIGGER_ACTION_TYPES` are NOT touched here —
// the SRS's expanded action list (Set triggered/Wait/Block visitor/Add-
// Remove tag/Set visitor department/Replace-Append note) is explicitly a
// separate, later session's scope.
//
// Field naming note: the task brief for this session describes the target
// shape as `firesOncePerVisitor`, but the live field is (and stays)
// `fireOncePerVisitor` — already wired end-to-end (DTOs, TriggersService,
// WidgetBootstrapService, and the chat-hub-web `WidgetTrigger` type this
// session does not touch). Renaming would be pure churn across a frontend
// this task doesn't otherwise touch, for no behavior change; not done.
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

// The original 9 condition types (unchanged semantics) plus the SRS §2.2
// full categorized set. Each paired with the "operator"/"value" it expects,
// enforced by TriggersService.assertValidConditions, not by Mongoose itself.
export const TRIGGER_CONDITION_TYPES = [
  // --- Original 9 (Session <undated>, kept as-is) ---
  'url', // operator: one of TRIGGER_URL_OPERATORS, value: URL pattern — SRS "Visitor page URL"
  'timeOnPage', // operator: 'gte', value: seconds — SRS "Still on page"
  'pageViews', // operator: 'gte', value: count (this session's page-view count) — SRS "Visitor page count"
  'pastVisits', // operator: 'gte', value: Visitor.pastVisitsCount — SRS "Visitor previous visits"
  'pastChats', // operator: 'gte', value: Visitor.pastChatsCount — SRS "Visitor previous chats"
  'referrer', // operator: 'contains', value: string
  'utmSource', // operator: 'equals', value: string
  'deviceType', // operator: 'equals', value: 'desktop' | 'mobile' | 'tablet'
  'onlineStatus', // operator: 'equals', value: 'online' | 'offline'

  // --- SRS §2.2 "Time/Date" (new) ---
  'hourOfDay', // operator: 'equals', value: '0'-'23', evaluated against Site.timezone
  'dayOfWeek', // operator: 'equals', value: 'sun'|'mon'|'tue'|'wed'|'thu'|'fri'|'sat', evaluated against Site.timezone
  'stillOnSite', // operator: 'gte', value: seconds — total time this Visitor session has been open, across all pages

  // --- SRS §2.2 "Location of visitor" (new) ---
  'visitorIp', // operator: 'equals', value: IP string
  'visitorHostName', // operator: 'contains', value: string — SRS flags this "lower priority/optional" (no reverse-DNS lookup exists); always evaluates false, see engine comment
  'visitorCity', // operator: 'equals', value: string
  'visitorRegion', // operator: 'equals', value: string
  'visitorCountryCode', // operator: 'equals', value: ISO country code
  'visitorCountryName', // operator: 'equals', value: country name

  // --- SRS §2.2 "Page information" (new) ---
  'pageTitle', // operator: 'contains'|'equals', value: string
  'previousPage', // operator: one of TRIGGER_URL_OPERATORS, value: URL pattern — matched against the page BEFORE the current one

  // --- SRS §2.2 "Visitor information" (new) ---
  'visitorName', // operator: 'equals'|'contains', value: string
  'visitorEmail', // operator: 'equals'|'contains', value: string
  'visitorDepartment', // operator: 'equals', value: departmentId
  'visitorTag', // operator: 'equals', value: tag string (Visitor.tags membership)
  'visitorTriggered', // operator: 'equals', value: 'true'|'false' — Visitor.wasTriggered
  'userAgent', // operator: 'contains', value: string
  'browser', // operator: 'equals', value: string
  'platform', // operator: 'equals', value: string (Visitor.os)
  'searchEngine', // operator: 'equals', value: string — parseReferrerSearch(Visitor.referrer).engine
  'searchTerms', // operator: 'contains', value: string — parseReferrerSearch(Visitor.referrer).terms
  'visitorIsChatting', // operator: 'equals', value: 'true'|'false' — has an open Conversation (status 'open')
  'visitorRequestingChat', // operator: 'equals', value: 'true'|'false' — has a 'pending' Conversation
  'visitorServed', // operator: 'equals', value: 'true'|'false' — has a Conversation with assignedAgentId set
  'accountStatus', // operator: 'equals', value: 'online'|'away'|'offline' — aggregateAccountStatus() over this Site's Agents
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

  // Free-form operator string — which values are valid depends on `type`.
  // Validated by TriggersService.assertValidConditions, not here.
  @Prop({ required: true })
  operator!: string;

  @Prop({ required: true })
  value!: string;
}
export const TriggerConditionSchema =
  SchemaFactory.createForClass(TriggerCondition);

export const TRIGGER_ACTION_TYPES = [
  'autoOpenWidget',
  'showProactiveMessage', // value: message text; fromName: sender name shown alongside it (Session Feature-2c-complex-actions)
  'sendConciergeMessage', // value: message text, inserted once the chat view is reached
  'setDepartment', // value: departmentId — client-side-only, stashes onto the NEXT Conversation this session creates (WidgetApp.tsx's pendingDepartmentIdRef). Distinct from setVisitorDepartment below.
  'addTag', // value: tag string — Visitor.tags

  // --- Session Feature-2c-simple-actions (SRS §2.2 Actions table) ---
  // Direct field writes to Visitor. No sequencing/delay, no side effects
  // beyond the one field — kept deliberately simple, matching the SRS's own
  // "New, simple" framing for `setVisitorName`. Executed by
  // `TriggerActionExecutorService`.
  'setVisitorName', // value: new Visitor.name
  'removeTag', // value: tag string — Visitor.tags
  'replaceNote', // value: new Visitor.notes (overwrites)
  'appendNote', // value: text appended to Visitor.notes

  // --- Session Feature-2c-complex-actions (SRS §2.2 Actions table) ---
  // The 5 remaining actions — real side effects (persisted Visitor.wasTriggered
  // flag, a genuine BannedEntry row, a Department write that FR-RTE-01
  // routing now reads) and one with sequencing (Wait). All executed
  // server-side by TriggerActionExecutorService, invoked from
  // RealtimeGateway.handleVisitorTriggerActivated — see that method's own
  // doc comment for why this is the first session to give the server engine
  // a real caller.
  'setTriggered', // no value — sets Visitor.wasTriggered = true
  'wait', // value: whole seconds to delay before the REMAINING actions in this same Trigger's action list run
  'blockVisitor', // value: optional ban reason — creates a BannedEntry via VisitorsService.ban(), Feature 2a's exact mechanism
  'setVisitorDepartment', // value: departmentId — writes Visitor.department (persists across pages/visits), distinct from the client-side, one-conversation-only `setDepartment` above
] as const;
export type TriggerActionType = (typeof TRIGGER_ACTION_TYPES)[number];

@Schema({ _id: false })
export class TriggerActionConfig {
  @Prop({ type: String, required: true, enum: TRIGGER_ACTION_TYPES })
  type!: TriggerActionType;

  @Prop({ type: String, default: null })
  value!: string | null;

  // Session Feature-2c-complex-actions — SRS §2.2's reference row reads
  // "Send message to visitor | Customer Service | <text>": a THIRD field
  // alongside `value` (the message text), not a second value packed into
  // one string, so it validates/edits independently of the message body.
  // Only `showProactiveMessage` uses this; every other action type ignores it.
  @Prop({ type: String, default: null })
  fromName!: string | null;
}
export const TriggerActionConfigSchema =
  SchemaFactory.createForClass(TriggerActionConfig);

/**
 * Trigger — SRS §4.8 / Feature 2 §2.2. Site-scoped condition/action rule.
 * `priority` (desc = higher priority) remains the sole evaluation-order
 * concept — this session's engine (`trigger-evaluation.service.ts`)
 * preserves it unchanged, iterating `TriggersService.findAll`'s existing
 * priority-then-createdAt sort and returning the first match(es), same as
 * the widget's pre-existing `findFirstMatch`.
 */
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

  // Zendesk's "Each visitor will receive this message only once". See file
  // header comment for why this field keeps its existing name rather than
  // the task brief's `firesOncePerVisitor` spelling.
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
