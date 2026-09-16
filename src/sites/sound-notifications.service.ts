import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Site,
  SiteDocument,
  SoundNotificationSettings,
} from '../database/schemas/site.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
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
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SoundNotificationSettings> {
    const site = await this.assertSite(actor, siteId);
    return site.soundNotificationSettings;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateSoundNotificationSettingsDto,
  ): Promise<SoundNotificationSettings> {
    const site = await this.assertSite(actor, siteId);
    const before = { ...site.soundNotificationSettings };

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
