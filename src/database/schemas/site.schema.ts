import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

import { SOUND_IDS } from './user.schema';
import type { SoundId } from './user.schema';

/** Business-hours config embedded on a Site — SRS §4.1. */
@Schema({ _id: false })
export class BusinessHoursConfig {
  @Prop({ default: false })
  enabled!: boolean;

  // NOTE (Session 4): was `@Prop({ type: [String], default: [] })` — a
  // pre-existing bug (declared array-of-string type on a field typed
  // `string` in TS). Never read/written before this session's Business
  // Hours CRUD; fixed here since it's now load-bearing. See PROGRESS.md.
  @Prop({ type: String, default: 'UTC' })
  timezone!: string;

  // Free-form per-weekday ranges, e.g. { mon: ["09:00-17:00"], ... }.
  // Kept loose (Mixed) here — Section 5.9 defines the exact shape when
  // business-hours enforcement is implemented; not needed for this session.
  @Prop({ type: Object, default: {} })
  weeklySchedule!: Record<string, string[]>;
}
export const BusinessHoursConfigSchema =
  SchemaFactory.createForClass(BusinessHoursConfig);

/**
 * Site-scoped sound settings — one `{soundId, volume}` pair per event,
 * shared by every Agent/Admin viewing this Site (not a per-user
 * preference — see `NotificationSounds` on `User` for that). Field shape
 * mirrors `NotificationSounds`/`SoundSetting`/`ChatRequestSoundSetting`
 * (`user.schema.ts`) verbatim; `soundId`/`volume`/`repeatCount` validated
 * the same way. Deliberately does NOT include the 4 desktop-notification
 * toggle booleans or idle-timeout settings from the per-user schema —
 * those remain individual-agent preferences with no coherent site-level
 * meaning; only the sound identity/volume/repeat-count — the part that
 * must sound the same for whoever is logged in — is site-scoped.
 */
@Schema({ _id: false })
export class SiteSoundSetting {
  @Prop({ type: String, required: true, enum: SOUND_IDS })
  soundId!: SoundId;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  volume!: number;
}
export const SiteSoundSettingSchema =
  SchemaFactory.createForClass(SiteSoundSetting);

@Schema({ _id: false })
export class SiteChatRequestSoundSetting {
  @Prop({ type: String, required: true, enum: SOUND_IDS })
  soundId!: SoundId;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  volume!: number;

  @Prop({ type: Number, required: true, min: 1, max: 10, default: 1 })
  repeatCount!: number;
}
export const SiteChatRequestSoundSettingSchema = SchemaFactory.createForClass(
  SiteChatRequestSoundSetting,
);

@Schema({ _id: false })
export class SoundNotificationSettings {
  @Prop({
    type: SiteSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'bright-ping', volume: 70 }),
  })
  incomingVisitor!: SiteSoundSetting;

  @Prop({
    type: SiteChatRequestSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'door-knock', volume: 70, repeatCount: 1 }),
  })
  chatRequest!: SiteChatRequestSoundSetting;

  @Prop({
    type: SiteSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'dot-dot', volume: 70 }),
  })
  incomingMessage!: SiteSoundSetting;

  @Prop({
    type: SiteSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'single-dong', volume: 70 }),
  })
  automaticStatusChange!: SiteSoundSetting;

  @Prop({
    type: SiteSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'whistle-tone', volume: 70 }),
  })
  triggerActivated!: SiteSoundSetting;

  @Prop({
    type: SiteSoundSettingSchema,
    required: true,
    default: () => ({ soundId: 'flute-note', volume: 70 }),
  })
  operatingHoursStartEnd!: SiteSoundSetting;
}
export const SoundNotificationSettingsSchema = SchemaFactory.createForClass(
  SoundNotificationSettings,
);

/**
 * Site — SRS §4.1. One of the 4 brand websites; the primary Site-scoped
 * multi-tenant boundary beneath Organization.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'sites',
})
export class Site {
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

  @Prop({ type: [String], required: true, default: [] })
  domains!: string[];

  @Prop({ required: true, default: 'UTC' })
  timezone!: string;

  @Prop({ type: BusinessHoursConfigSchema, default: () => ({}) })
  businessHoursConfig!: BusinessHoursConfig;

  @Prop({ type: SoundNotificationSettingsSchema, default: () => ({}) })
  soundNotificationSettings!: SoundNotificationSettings;

  @Prop({
    type: String,
    required: true,
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status!: 'active' | 'inactive';

  // This session's addition — the check requested alongside Site
  // create/edit: a Site can only serve live chat once it actually has
  // somewhere to be embedded. Defaults false (including on brand-new Sites
  // created via `SitesService.create`, regardless of `domains` at create
  // time) so an admin must come back and flip it on explicitly.
  // `SitesService.update` is the ONLY place this is allowed to flip to
  // `true`, and it rejects doing so (400) unless `domains` is non-empty at
  // that point — see its doc comment. `WidgetBootstrapService` also refuses
  // to serve `widget-bootstrap/:siteId` while this is `false`, so the
  // toggle actually gates the embed, not just the Admin Panel's UI.
  @Prop({ type: Boolean, required: true, default: false })
  chatEnabled!: boolean;

  // FR-VIS-07: IP-level ban list, Site-scoped. Populated by VisitorsService
  // when an Agent/Admin bans a Visitor (their `currentIp`, or an explicit
  // IP override, is added here) so a banned person is blocked at
  // visitor-session-init time even if they clear cookies/localStorage and
  // would otherwise come back as a brand-new, unbanned Visitor document.
  @Prop({ type: [String], default: [] })
  bannedIps!: string[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type SiteDocument = Site & Document;
export const SiteSchema = SchemaFactory.createForClass(Site);
// organizationId already indexed via `index: true` on the @Prop above.
