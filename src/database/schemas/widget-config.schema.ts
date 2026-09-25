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

export const LAUNCHER_STYLES = [
  'round',
  'badge',
  'box',
  'face',
  'chat',
  'card',
] as const;
export type LauncherStyle = (typeof LAUNCHER_STYLES)[number];

/**
 * "LIVE / CHAT"-style badge launcher (this session's addition) — an
 * alternative to the plain round bubble (`launcherStyle: 'badge'`),
 * rendered by `LauncherBadgeIcon` (chat-hub-web) from a fixed SVG shape
 * (speech-bubble icon + two-tone text badge) supplied by the client. Only
 * the 4 colors below plus the two words are configurable — the badge's
 * light top-plate stays fixed white by design (the contrast backdrop for
 * `topText`), matching the reference image exactly.
 */
@Schema({ _id: false })
export class WidgetLauncherBadge {
  @Prop({ default: 'LIVE' })
  topText!: string;

  @Prop({ default: 'CHAT' })
  bottomText!: string;

  @Prop({ default: '#f01e3c' })
  iconColor!: string;

  @Prop({ default: '#0a0a0a' })
  backgroundColor!: string;

  @Prop({ default: '#f01e3c' })
  topTextColor!: string;

  @Prop({ default: '#ffffff' })
  bottomTextColor!: string;

  /** Base icon height in pixels (width follows via the icon's fixed
   *  aspect ratio). Clamped 32-160 by `UpdateWidgetLauncher*Dto`. */
  @Prop({ default: 64 })
  iconSize!: number;
}
export const WidgetLauncherBadgeSchema =
  SchemaFactory.createForClass(WidgetLauncherBadge);

/**
 * "LIVE / CHAT" box launcher (`launcherStyle: 'box'`) — a rounded box with a
 * typing-dots speech bubble rising from its top, rendered by
 * `LauncherBoxIcon` (chat-hub-web) from a fixed client-supplied SVG shape.
 * Kept separate from `WidgetLauncherBadge` so each style remembers its own
 * words/colors when an admin switches between them. Every painted part of
 * the shape has its own color.
 */
@Schema({ _id: false })
export class WidgetLauncherBox {
  @Prop({ default: 'LIVE' })
  topText!: string;

  @Prop({ default: 'CHAT' })
  bottomText!: string;

  /** The box body and the speech bubble's outline. */
  @Prop({ default: '#24c5da' })
  bodyColor!: string;

  /** Thin shading band along the box's bottom-right inner edge. */
  @Prop({ default: '#2ad0dd' })
  edgeColor!: string;

  /** Inside of the speech bubble (behind the dots). */
  @Prop({ default: '#ffffff' })
  bubbleColor!: string;

  /** The three typing dots inside the bubble. */
  @Prop({ default: '#0a0a0a' })
  dotsColor!: string;

  @Prop({ default: '#ffffff' })
  topTextColor!: string;

  @Prop({ default: '#242424' })
  bottomTextColor!: string;

  /** Base icon height in pixels (width follows via the icon's fixed
   *  aspect ratio). Clamped 32-160 by `UpdateWidgetLauncher*Dto`. */
  @Prop({ default: 80 })
  iconSize!: number;
}
export const WidgetLauncherBoxSchema =
  SchemaFactory.createForClass(WidgetLauncherBox);

/**
 * "LIVE / CHAT" face launcher (`launcherStyle: 'face'`) — a round 3-eyed
 * speech-bubble "face" sitting on top of a wide message card, rendered by
 * `LauncherFaceIcon` (chat-hub-web) from a fixed client-supplied SVG shape.
 * Kept separate from the other launcher styles so each remembers its own
 * words/colors when an admin switches between them.
 */
@Schema({ _id: false })
export class WidgetLauncherFace {
  @Prop({ default: 'LIVE' })
  topText!: string;

  @Prop({ default: 'CHAT' })
  bottomText!: string;

  /** The message card's outline. */
  @Prop({ default: '#0a0a0a' })
  cardColor!: string;

  /** The message card's inner fill, behind the text. */
  @Prop({ default: '#24c5da' })
  cardFillColor!: string;

  /** The round face bubble sitting above the card. */
  @Prop({ default: '#0a0a0a' })
  bubbleColor!: string;

  /** The 3 eye dots, showing through holes in the bubble. */
  @Prop({ default: '#24c5da' })
  eyeColor!: string;

  @Prop({ default: '#ffffff' })
  topTextColor!: string;

  @Prop({ default: '#0a0a0a' })
  bottomTextColor!: string;

  /** Base icon height in pixels (width follows via the icon's fixed
   *  aspect ratio). Clamped 32-160 by `UpdateWidgetLauncher*Dto`. */
  @Prop({ default: 80 })
  iconSize!: number;
}
export const WidgetLauncherFaceSchema =
  SchemaFactory.createForClass(WidgetLauncherFace);

/**
 * "LIVE / CHAT" chat launcher (`launcherStyle: 'chat'`) — a two-bubble
 * speech mascot beside plain "LIVE" / "CHAT" text (no badge/card
 * background), rendered by `LauncherChatIcon` (chat-hub-web) from a fixed
 * client-supplied SVG shape. Kept separate from the other launcher styles
 * so each remembers its own words/colors when an admin switches between
 * them.
 */
@Schema({ _id: false })
export class WidgetLauncherChat {
  @Prop({ default: 'LIVE' })
  topText!: string;

  @Prop({ default: 'CHAT' })
  bottomText!: string;

  /** The larger, front speech bubble. */
  @Prop({ default: '#24c5da' })
  frontBubbleColor!: string;

  /** The smaller bubble overlapping its lower-left corner. */
  @Prop({ default: '#0a0a0a' })
  backBubbleColor!: string;

  /** The 3 accent dots on the front bubble's face. */
  @Prop({ default: '#0a0a0a' })
  dotsColor!: string;

  @Prop({ default: '#24c5da' })
  topTextColor!: string;

  @Prop({ default: '#0a0a0a' })
  bottomTextColor!: string;

  /** Base icon height in pixels (width follows via the icon's fixed
   *  aspect ratio). Clamped 32-160 by `UpdateWidgetLauncher*Dto`. */
  @Prop({ default: 56 })
  iconSize!: number;
}
export const WidgetLauncherChatSchema =
  SchemaFactory.createForClass(WidgetLauncherChat);

/**
 * "LIVE / CHAT" card launcher (`launcherStyle: 'card'`) — a two-bubble
 * speech mascot beside a card holding the "LIVE"/"CHAT" text (mirrored
 * layout of `chat`, with a card like `badge`), rendered by
 * `LauncherCardIcon` (chat-hub-web) from a fixed client-supplied SVG shape.
 * Kept separate from the other launcher styles so each remembers its own
 * words/colors when an admin switches between them.
 */
@Schema({ _id: false })
export class WidgetLauncherCard {
  @Prop({ default: 'LIVE' })
  topText!: string;

  @Prop({ default: 'CHAT' })
  bottomText!: string;

  /** The larger, front speech bubble. */
  @Prop({ default: '#24c5da' })
  frontBubbleColor!: string;

  /** The smaller bubble overlapping its lower-right corner. */
  @Prop({ default: '#0a0a0a' })
  backBubbleColor!: string;

  /** The 6 chat-line holes cut into the front bubble. */
  @Prop({ default: '#ffffff' })
  linesColor!: string;

  /** The text card's background. */
  @Prop({ default: '#0a0a0a' })
  cardColor!: string;

  @Prop({ default: '#24c5da' })
  topTextColor!: string;

  @Prop({ default: '#ffffff' })
  bottomTextColor!: string;

  /** Base icon height in pixels (width follows via the icon's fixed
   *  aspect ratio). Clamped 32-160 by `UpdateWidgetLauncher*Dto`. */
  @Prop({ default: 64 })
  iconSize!: number;
}
export const WidgetLauncherCardSchema =
  SchemaFactory.createForClass(WidgetLauncherCard);

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

  /** Round launcher bubble's base height in pixels (it's a circle, so this
   *  is also its width). Clamped 32-160 by `UpdateWidgetConfigDto`. */
  @Prop({ default: 56 })
  launcherIconSize!: number;

  @Prop({ type: String, default: 'round', enum: LAUNCHER_STYLES })
  launcherStyle!: LauncherStyle;

  @Prop({ type: WidgetLauncherBadgeSchema, default: () => ({}) })
  launcherBadge!: WidgetLauncherBadge;

  @Prop({ type: WidgetLauncherBoxSchema, default: () => ({}) })
  launcherBox!: WidgetLauncherBox;

  @Prop({ type: WidgetLauncherFaceSchema, default: () => ({}) })
  launcherFace!: WidgetLauncherFace;

  @Prop({ type: WidgetLauncherChatSchema, default: () => ({}) })
  launcherChat!: WidgetLauncherChat;

  @Prop({ type: WidgetLauncherCardSchema, default: () => ({}) })
  launcherCard!: WidgetLauncherCard;

  @Prop({ default: 'modern' })
  messageStyle!: string;

  @Prop({ required: true, default: true })
  notificationSoundEnabled!: boolean;

  @Prop({ required: true, default: true })
  satisfactionRatingsEnabled!: boolean;

  @Prop({ required: true, default: true })
  offlineFormEnabled!: boolean;

  // Phase 2 §3.9 (FR-P2-ATT-01/02) — Site-level on/off switch for chat
  // attachments, covering BOTH surfaces (Widget attach control AND Agent
  // Console attach control for this Site) per direct product decision.
  // Enforced server-side on the upload endpoints themselves
  // (AttachmentsController), not just hidden client-side — see
  // WidgetConfigService.isAttachmentsEnabledForSite.
  @Prop({ required: true, default: true })
  attachmentsEnabled!: boolean;

  // Phase 2 §2.5/§3.12 (FR-P2-FORM-01–04) — whole-form on/off switch, one
  // level above the per-field `preChatFormFields` builder just below: when
  // `false`, the pre-chat form isn't shown at all (the Visitor can message
  // immediately, and the resulting Visitor record is created with
  // name/email/phone all null — already valid per the Phase 1 Visitor
  // schema, no schema change needed there). Default `true` matches Phase 1's
  // original mandatory-form behavior (FR-WID-05) exactly, so existing Sites
  // are unaffected until an admin opts out.
  @Prop({ required: true, default: true })
  preChatFormEnabled!: boolean;

  // FR-CFG-01/02 "Forms" builder (this session's addition) — independently
  // configurable per Site, per form. See FormFieldConfig's doc comment for
  // the builtin-vs-custom distinction.
  @Prop({ type: [FormFieldConfigSchema], default: defaultPreChatFormFields })
  preChatFormFields!: FormFieldConfig[];

  @Prop({ type: [FormFieldConfigSchema], default: defaultOfflineFormFields })
  offlineFormFields!: FormFieldConfig[];

  // "Web Widget security" tab's Blocked countries feature — matches
  // Zendesk's own behavior (per direct user request/reference screenshot):
  // restricts the WIDGET'S CHAT functionality (not the widget's visibility
  // itself — the launcher/branding still loads) for a visitor whose
  // GeoIP-resolved country is in this list, while `blockedCountriesEnabled`
  // is on. `blockedCountries` holds ISO 3166-1 alpha-2 codes (e.g. "PK"),
  // the same shape `AttributionService`'s `location.country` already
  // produces — enforced in `VisitorSessionService.init` (the "start a
  // chat" entry point), same place/pattern as the existing banned-IP/
  // banned-visitor checks. See WidgetConfigScreen's Security tab and
  // PROGRESS.md for the full feature writeup.
  @Prop({ required: true, default: false })
  blockedCountriesEnabled!: boolean;

  @Prop({ type: [String], default: [] })
  blockedCountries!: string[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type WidgetConfigDocument = WidgetConfig & Document;
export const WidgetConfigSchema = SchemaFactory.createForClass(WidgetConfig);
