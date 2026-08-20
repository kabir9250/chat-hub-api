import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  BusinessHoursConfig,
  Site,
  SiteDocument,
} from '../database/schemas/site.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UpdateBusinessHoursDto } from './dto/update-business-hours.dto';

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const TIME_RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/**
 * BusinessHoursService — FR-CFG-03. `businessHoursConfig` is embedded on
 * `Site` (not its own collection — SRS §4.1), so this reads/writes that one
 * subdocument. `PermissionGuard` (via `business_hours.manage`, checked
 * against the route's `:siteId`) is the only permission key involved — the
 * catalog has no separate `business_hours.view` (§5.13's table lists only
 * `business_hours.manage`), so the GET here is gated by the same key as the
 * PATCH.
 */
@Injectable()
export class BusinessHoursService {
  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<BusinessHoursConfig> {
    const site = await this.assertSite(actor, siteId);
    return site.businessHoursConfig;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateBusinessHoursDto,
  ): Promise<BusinessHoursConfig> {
    const site = await this.assertSite(actor, siteId);

    if (dto.weeklySchedule !== undefined) {
      this.validateWeeklySchedule(dto.weeklySchedule);
    }

    const before = {
      enabled: site.businessHoursConfig.enabled,
      timezone: site.businessHoursConfig.timezone,
      weeklySchedule: site.businessHoursConfig.weeklySchedule,
    };

    if (dto.enabled !== undefined)
      site.businessHoursConfig.enabled = dto.enabled;
    if (dto.timezone !== undefined)
      site.businessHoursConfig.timezone = dto.timezone.trim();
    if (dto.weeklySchedule !== undefined)
      site.businessHoursConfig.weeklySchedule = dto.weeklySchedule;
    await site.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'business_hours.updated',
      siteId: site._id,
      targetType: 'Site',
      targetId: site._id,
      metadata: { before, after: site.businessHoursConfig },
    });

    return site.businessHoursConfig;
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

  private validateWeeklySchedule(schedule: Record<string, string[]>): void {
    for (const [day, ranges] of Object.entries(schedule)) {
      if (!(WEEKDAY_KEYS as readonly string[]).includes(day)) {
        throw new BadRequestException(
          `Invalid weekday key "${day}". Expected one of: ${WEEKDAY_KEYS.join(', ')}.`,
        );
      }
      if (
        !Array.isArray(ranges) ||
        ranges.some((r) => typeof r !== 'string' || !TIME_RANGE_RE.test(r))
      ) {
        throw new BadRequestException(
          `Invalid time range(s) for "${day}". Expected 24h "HH:MM-HH:MM", e.g. "09:00-17:00".`,
        );
      }
    }
  }
}
