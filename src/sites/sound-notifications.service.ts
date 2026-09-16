import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Site,
  SiteDocument,
  SoundNotificationSettings,
} from '../database/schemas/site.schema';
import { User, UserDocument } from '../database/schemas/user.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import {
  UpdateSiteChatRequestSoundSettingDto,
  UpdateSiteSoundSettingDto,
  UpdateSoundNotificationSettingsDto,
} from './dto/update-sound-notification-settings.dto';

type SoundEventKey = keyof SoundNotificationSettings;
const SOUND_EVENT_KEYS: SoundEventKey[] = [
  'incomingVisitor',
  'chatRequest',
  'incomingMessage',
  'automaticStatusChange',
  'triggerActivated',
  'operatingHoursStartEnd',
];

/**
 * SoundNotificationsService — site-scoped Sound & Notification settings.
 * `soundNotificationSettings` is embedded on `Site` (not its own collection,
 * same precedent as `businessHoursConfig`), shared by every Agent/Admin who
 * views this Site. Read is gated by a wider ANY-of permission set (agents
 * need to know what to play even though they can't edit it); write stays
 * `sound_notifications.manage`-only — see `SoundNotificationsController`.
 */
@Injectable()
export class SoundNotificationsService {
  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async get(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SoundNotificationSettings> {
    const site = await this.assertSite(actor, siteId);
    return site.soundNotificationSettings;
  }

  /**
   * The sound & notification settings actually in effect for `actor` on
   * this Site: their own personal override
   * (`User.notificationPreferences`) if they hold
   * `sound_notifications.view`/`.manage` on this Site (Personal screen's
   * Sound & Notifications tab), else the Site default. Holding
   * `.view`/`.manage` at all is treated as "has an override" — the per-user
   * schema is always populated with schema defaults, so there's no separate
   * "never touched" state to distinguish.
   *
   * Returned in the SITE schema's shape (`{notifications: {...4 booleans},
   * ...6 sound events}`) regardless of which source it came from — the
   * per-user schema splits the same data across two sibling fields
   * (`NotificationPreferences`'s own 4 top-level booleans, and its `.sounds`
   * for the 6 events), so this always re-assembles into one consistent
   * shape for callers rather than exposing that per-user split.
   */
  async getEffective(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SoundNotificationSettings> {
    const site = await this.assertSite(actor, siteId);
    const permissions = await this.permissionsService.getEffectivePermissions(
      actor.userId,
      siteId,
    );
    const hasOverride =
      permissions.includes('sound_notifications.view') ||
      permissions.includes('sound_notifications.manage');
    if (!hasOverride) {
      return site.soundNotificationSettings;
    }
    const user = await this.userModel.findById(actor.userId).lean().exec();
    const prefs = user?.notificationPreferences;
    if (!prefs) {
      return site.soundNotificationSettings;
    }
    return {
      notifications: {
        chatRequest: prefs.chatRequest,
        newMessages: prefs.newMessages,
        statusChanges: prefs.statusChanges,
        sessionExpiry: prefs.sessionExpiry,
      },
      ...prefs.sounds,
    };
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateSoundNotificationSettingsDto,
  ): Promise<SoundNotificationSettings> {
    const site = await this.assertSite(actor, siteId);
    const before = { ...site.soundNotificationSettings };

    if (dto.notifications) {
      Object.assign(site.soundNotificationSettings.notifications, dto.notifications);
    }

    for (const key of SOUND_EVENT_KEYS) {
      const patch = dto[key] as
        | UpdateSiteSoundSettingDto
        | UpdateSiteChatRequestSoundSettingDto
        | undefined;
      if (patch === undefined) continue;
      Object.assign(site.soundNotificationSettings[key], patch);
    }
    await site.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'sound_notifications.updated',
      siteId: site._id,
      targetType: 'Site',
      targetId: site._id,
      metadata: { before, after: site.soundNotificationSettings },
    });

    return site.soundNotificationSettings;
  }

  private async assertSite(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteDocument> {
    const site = await this.siteModel
      .findOne({ _id: siteId, organizationId: actor.organizationId })
      .exec();
    if (!site) {
      throw new NotFoundException('Site not found in this Organization.');
    }
    return site;
  }
}
