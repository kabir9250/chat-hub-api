import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Site,
  SiteDocument,
  SiteIdleTimeoutSettings,
} from '../database/schemas/site.schema';
import { User, UserDocument, IdleTimeoutSettings } from '../database/schemas/user.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import { UpdateSiteIdleTimeoutSettingsDto } from './dto/update-idle-timeout-settings.dto';

/**
 * IdleTimeoutService — site-scoped Idle Timeout default. `idleTimeoutSettings`
 * is embedded on `Site` (not its own collection, same precedent as
 * `businessHoursConfig`/`soundNotificationSettings`), applied to every
 * Agent/Admin on this Site who has no personal override permission
 * (`idle_timeout.view`/`.manage`) or hasn't been granted one. Read is gated
 * by a wider ANY-of permission set (agents need to know the effective
 * default even though they can't edit it); write stays
 * `idle_timeout.manage`-only — see `IdleTimeoutController`.
 */
@Injectable()
export class IdleTimeoutService {
  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async get(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteIdleTimeoutSettings> {
    const site = await this.assertSite(actor, siteId);
    return site.idleTimeoutSettings;
  }

  /**
   * The setting actually in effect for `actor` on this Site: their own
   * personal override if they hold `idle_timeout.view`/`.manage` on this
   * Site (Personal screen's Idle Timeout tab), else the Site default.
   * Holding `.view`/`.manage` at all is treated as "has an override" —
   * `User.idleTimeoutSettings` is always populated with schema defaults, so
   * there's no separate "never touched" state to distinguish.
   */
  async getEffective(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<IdleTimeoutSettings | SiteIdleTimeoutSettings> {
    const site = await this.assertSite(actor, siteId);
    const permissions = await this.permissionsService.getEffectivePermissions(
      actor.userId,
      siteId,
    );
    const hasOverride =
      permissions.includes('idle_timeout.view') ||
      permissions.includes('idle_timeout.manage');
    if (!hasOverride) {
      return site.idleTimeoutSettings;
    }
    const user = await this.userModel.findById(actor.userId).lean().exec();
    return user?.idleTimeoutSettings ?? site.idleTimeoutSettings;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateSiteIdleTimeoutSettingsDto,
  ): Promise<SiteIdleTimeoutSettings> {
    const site = await this.assertSite(actor, siteId);
    const before = { ...site.idleTimeoutSettings };

    Object.assign(site.idleTimeoutSettings, dto);
    await site.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'idle_timeout.updated',
      siteId: site._id,
      targetType: 'Site',
      targetId: site._id,
      metadata: { before, after: site.idleTimeoutSettings },
    });

    return site.idleTimeoutSettings;
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
