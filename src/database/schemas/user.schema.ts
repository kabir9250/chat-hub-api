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
 * Sound library — Session Feature-1b-backend (SRS "12-zendesk-feature-
 * parity" §1.2). A small set of short, distinct, non-jarring chimes an
 * Agent can assign independently per sound-only event, replacing the
 * single hardcoded `agent-notification-chime.wav` (Phase 2 P2-8). Per the
 * task guardrail, these are NOT copies of Zendesk's own named sound assets
 * ("Oh oh," "Triplet," "Dong," "Bonk," "Door knock," "Alert") — `id`/`label`
 * here are chat-hub's own descriptive names, independent of whatever the
 * underlying audio file happens to be called on disk. The actual files
 * ship in `chat-hub-web/public/assets/voices/` (a pre-existing asset
 * folder on the frontend repo — see PROGRESS.md for the full file list and
 * provenance note); this backend only needs a stable `id` to validate
 * against and store, never the audio bytes themselves.
 */
export const SOUND_LIBRARY = [
  { id: 'soft-alert', label: 'Soft Alert', file: 'alert.mp3' },
  { id: 'bonk-tap', label: 'Bonk Tap', file: 'bonk.mp3' },
  { id: 'bright-ping', label: 'Bright Ping', file: 'bright.mp3' },
  { id: 'sms-buzz', label: 'SMS Buzz', file: 'cellsms.mp3' },
  { id: 'crunch-tap', label: 'Crunch Tap', file: 'crunch.mp3' },
  { id: 'single-dong', label: 'Single Dong', file: 'dong.mp3' },
  { id: 'dot-dot', label: 'Dot Dot', file: 'dotdot.mp3' },
  { id: 'flip-tone', label: 'Flip Tone', file: 'flipped.mp3' },
  { id: 'flute-note', label: 'Flute Note', file: 'flute.mp3' },
  { id: 'classic-uh-oh', label: 'Classic Uh-Oh', file: 'icq.mp3' },
  { id: 'incoming-im', label: 'Incoming IM', file: 'incomingim.mp3' },
  { id: 'sitar-chime', label: 'Sitar Chime', file: 'indian.mp3' },
  { id: 'door-knock', label: 'Door Knock', file: 'knockknock.mp3' },
  { id: 'moo-tone', label: 'Moo Tone', file: 'moo.mp3' },
  { id: 'uh-oh-chime', label: 'Uh-Oh Chime', file: 'ohoh.mp3' },
  { id: 'outgoing-im', label: 'Outgoing IM', file: 'ougoingim.mp3' },
  { id: 'rubber-duckie', label: 'Rubber Duckie', file: 'rubberduckie.mp3' },
  { id: 'space-tone', label: 'Space Tone', file: 'space.mp3' },
  { id: 'triplet-chime', label: 'Triplet Chime', file: 'triplet.mp3' },
  { id: 'tzer-buzz', label: 'Tzer Buzz', file: 'tzer.mp3' },
  { id: 'whip-crack', label: 'Whip Crack', file: 'whip.mp3' },
  { id: 'whistle-tone', label: 'Whistle Tone', file: 'whistle.mp3' },
  { id: 'whizz-tone', label: 'Whizz Tone', file: 'whizz.mp3' },
] as const;
export type SoundId = (typeof SOUND_LIBRARY)[number]['id'];
export const SOUND_IDS: SoundId[] = SOUND_LIBRARY.map((s) => s.id);

/** One event's default `{soundId, volume}` — used only to seed schema
 * defaults/migration below; not read at request time. */
const DEFAULT_SOUND_VOLUME = 70;
const SOUND_EVENT_DEFAULTS: Record<string, SoundId> = {
  incomingVisitor: 'bright-ping',
  chatRequest: 'door-knock',
  incomingMessage: 'dot-dot',
  automaticStatusChange: 'single-dong',
  triggerActivated: 'whistle-tone',
  operatingHoursStartEnd: 'flute-note',
};

/** `{soundId, volume}` — used by every sound-only event except Chat request
 * (which additionally carries `repeatCount`, see `ChatRequestSoundSetting`
 * below). Embedded, `_id: false` (fixed-shape value object, not a list). */
@Schema({ _id: false })
export class SoundSetting {
  @Prop({ type: String, required: true, enum: SOUND_IDS })
  soundId!: SoundId;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  volume!: number;
}
export const SoundSettingSchema = SchemaFactory.createForClass(SoundSetting);

/**
 * Chat request's sound pair additionally carries `repeatCount` (1–10) — SRS
 * §1.2: "repeats the chosen sound that many times when a new conversation
 * arrives." A separate class rather than `SoundSetting` + an optional field
 * so every other event's shape stays exactly `{soundId, volume}`, matching
 * the SRS table 1:1.
 */
@Schema({ _id: false })
export class ChatRequestSoundSetting {
  @Prop({ type: String, required: true, enum: SOUND_IDS })
  soundId!: SoundId;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  volume!: number;

  @Prop({ type: Number, required: true, min: 1, max: 10, default: 1 })
  repeatCount!: number;
}
export const ChatRequestSoundSettingSchema = SchemaFactory.createForClass(
  ChatRequestSoundSetting,
);

/**
 * Sound-only events (SRS §1.2's "Sounds" section) — one independent
 * `{soundId, volume}` pair per event, no matching desktop-notification
 * toggle for any of them (task guardrail — `incomingVisitor`,
 * `triggerActivated` and `operatingHoursStartEnd` are genuinely sound-only,
 * same as Zendesk's own reference screen).
 */
@Schema({ _id: false })
export class NotificationSounds {
  @Prop({
    type: SoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.incomingVisitor,
      volume: DEFAULT_SOUND_VOLUME,
    }),
  })
  incomingVisitor!: SoundSetting;

  @Prop({
    type: ChatRequestSoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.chatRequest,
      volume: DEFAULT_SOUND_VOLUME,
      repeatCount: 1,
    }),
  })
  chatRequest!: ChatRequestSoundSetting;

  @Prop({
    type: SoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.incomingMessage,
      volume: DEFAULT_SOUND_VOLUME,
    }),
  })
  incomingMessage!: SoundSetting;

  @Prop({
    type: SoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.automaticStatusChange,
      volume: DEFAULT_SOUND_VOLUME,
    }),
  })
  automaticStatusChange!: SoundSetting;

  @Prop({
    type: SoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.triggerActivated,
      volume: DEFAULT_SOUND_VOLUME,
    }),
  })
  triggerActivated!: SoundSetting;

  @Prop({
    type: SoundSettingSchema,
    required: true,
    default: () => ({
      soundId: SOUND_EVENT_DEFAULTS.operatingHoursStartEnd,
      volume: DEFAULT_SOUND_VOLUME,
    }),
  })
  operatingHoursStartEnd!: SoundSetting;
}
export const NotificationSoundsSchema =
  SchemaFactory.createForClass(NotificationSounds);

/**
 * NotificationPreferences — Phase 2 SRS §2.1 / §3.8 FR-P2-NOTIF-05,
 * restructured this session (SRS "12-zendesk-feature-parity" §1.2) from the
 * original coarse `{desktopEnabled, soundEnabled}` pair into genuine
 * per-event granularity, matching Zendesk's own Sounds & Notifications tab:
 * a `notifications` section (4 independent desktop-notification booleans)
 * and a `sounds` section (6 independent `{soundId, volume}` pairs, one of
 * them — `chatRequest` — also carrying `repeatCount`). Nested under two
 * sub-keys (rather than 10 flat fields) specifically because `chatRequest`
 * needs to exist as BOTH a `notifications` boolean (Zendesk's "Chat
 * request" checkbox) and a `sounds` entry (Zendesk's "Chat request" sound
 * picker) — flat naming would collide.
 *
 * Embedded (not a separate collection — a per-User settings blob, always
 * read/written together with the User), `_id: false`.
 *
 * **Migration from the old `{desktopEnabled, soundEnabled}` pair:** no
 * script/reseed needed — Mongoose applies subdocument defaults at
 * hydration time, not just on `create()`, so any already-seeded User
 * whose stored `notificationPreferences` still has the OLD flat shape
 * (`{desktopEnabled, soundEnabled}`, no `notifications`/`sounds` keys) is
 * migrated lazily, in `UsersService.normalizeNotificationPreferences`
 * (called from every read path — see that method's doc comment), which
 * seeds each of the 4 new `notifications.*` booleans from the old
 * `desktopEnabled` and each `sounds.*` pair's volume from the old
 * `soundEnabled` (0 when it was off, the schema default otherwise) —
 * sensible per-field defaults derived from the two old values, not a
 * silent discard. A fresh User (no legacy fields at all) just gets the
 * schema defaults below directly.
 */
@Schema({ _id: false })
export class NotificationPreferences {
  @Prop({ type: Boolean, required: true, default: true })
  chatRequest!: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  newMessages!: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  statusChanges!: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  sessionExpiry!: boolean;

  @Prop({ type: NotificationSoundsSchema, required: true, default: () => ({}) })
  sounds!: NotificationSounds;
}
export const NotificationPreferencesSchema = SchemaFactory.createForClass(
  NotificationPreferences,
);

/**
 * IdleTimeoutSettings — Session Feature-1c-backend (SRS "12-zendesk-feature-
 * parity" §1.3). Self-service, editable only by the User themself via
 * `PATCH /users/me/idle-timeout-settings` (same no-permission/self-service/
 * not-audit-logged precedent as `NotificationPreferences` above).
 *
 * `idleStatus` intentionally allows `'invisible'` per the SRS's literal
 * design even though `PresenceService`'s `PresenceStatus` union doesn't
 * have an `'invisible'` value yet (that's introduced by the separate,
 * not-yet-built Feature 5 "Presence Dropdown" rework) — so the setting is
 * always storable/round-trippable from the Idle Timeout Tab UI regardless
 * of build order, but `PresenceService.setIdleStatus` (the only thing that
 * ever actually applies it) clamps to `'away'` today; see that method's
 * doc comment for what happens when `'invisible'` is configured.
 *
 * Embedded (not a separate collection), `_id: false`, same rationale as
 * `NotificationPreferences`.
 */
@Schema({ _id: false })
export class IdleTimeoutSettings {
  @Prop({ type: Boolean, required: true, default: false })
  enabled!: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  ignoreIfChatting!: boolean;

  @Prop({ type: Number, required: true, default: 5, min: 1, max: 480 })
  inactivityMinutes!: number;

  @Prop({
    type: String,
    required: true,
    enum: ['away', 'invisible'],
    default: 'away',
  })
  idleStatus!: 'away' | 'invisible';
}
export const IdleTimeoutSettingsSchema =
  SchemaFactory.createForClass(IdleTimeoutSettings);

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

  // Phase 2, SRS §2.1 / FR-P2-NOTIF-05 — self-service, editable by the User
  // themself via `PATCH /users/me/notification-preferences` (no special
  // permission required beyond being logged in as that user).
  @Prop({ type: NotificationPreferencesSchema, default: () => ({}) })
  notificationPreferences!: NotificationPreferences;

  // Session Feature-1c-backend, SRS "12-zendesk-feature-parity" §1.3 —
  // self-service, editable by the User themself via `PATCH
  // /users/me/idle-timeout-settings`. `enabled: false` by default so
  // nothing auto-changes status until an Agent explicitly opts in.
  @Prop({ type: IdleTimeoutSettingsSchema, default: () => ({}) })
  idleTimeoutSettings!: IdleTimeoutSettings;

  // Personal Settings → Profile (this session, SRS "12-zendesk-feature-
  // parity" §1.1). All five fields below are self-service, editable only by
  // the User themself via `PATCH /users/me/profile` — no RBAC implication,
  // purely display/preference/routing-input data, never a permission or
  // Role Assignment.
  @Prop({ trim: true })
  tagline?: string;

  @Prop({ type: String, required: true, default: 'en' })
  preferredLanguage!: string;

  // Chat Limit (routing input, point 3 of this session's task). `null`/
  // unset means "no limit" — matches the reference Zendesk screen's "Chat
  // limit is not enabled" state — and MUST stay that way: `pickAgentForRouting`
  // treats null as no limit, never as a limit of zero.
  @Prop({ type: Number, required: false, default: null })
  chatLimit!: number | null;

  // Data-only for this pass — no skill-based routing/matching logic reads
  // this yet (explicit scope cut, see this session's task guardrails).
  @Prop({ type: [String], default: [] })
  skills!: string[];

  @Prop({ type: Boolean, required: true, default: true })
  keyboardShortcutsEnabled!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export type UserDocument = User & Document;
export const UserSchema = SchemaFactory.createForClass(User);
// organizationId already indexed via `index: true` on the @Prop above.
UserSchema.index({ departmentId: 1 });
