import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Site,
  SiteDocument,
  WidgetConfig,
  WidgetConfigDocument,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  UpdateFormFieldDto,
  UpdateWidgetConfigDto,
} from './dto/update-widget-config.dto';

/**
 * WidgetConfigService — FR-CFG-01/02. `PermissionGuard` (via
 * `widget_config.view`/`widget_config.manage`, checked against the route's
 * `:siteId`) decides reachability; this service enforces the WidgetConfig
 * it reads/writes actually belongs to a Site in the caller's Organization
 * (multi-tenant boundary, SRS §4.2), same pattern as
 * `BusinessHoursService`/`DepartmentsService` (Session 4).
 *
 * `WidgetConfig` is 1:1 with Site (unique `siteId` index, Session 1) and
 * the seed script always creates one per Site — but `get`/`update` here
 * lazily create a default document if one is somehow missing, rather than
 * 404, so a Site can never be left without a widget config to serve.
 */
@Injectable()
export class WidgetConfigService {
  constructor(
    @InjectModel(WidgetConfig.name)
    private readonly widgetConfigModel: Model<WidgetConfigDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<WidgetConfigDocument> {
    const site = await this.assertSite(actor, siteId);
    return this.findOrCreate(site._id);
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateWidgetConfigDto,
  ): Promise<WidgetConfigDocument> {
    const site = await this.assertSite(actor, siteId);
    const config = await this.findOrCreate(site._id);

    const before = {
      topTitle: config.topTitle,
      concierge: { ...config.concierge },
      iconUrl: config.iconUrl,
      primaryColor: config.primaryColor,
      messageStyle: config.messageStyle,
      notificationSoundEnabled: config.notificationSoundEnabled,
      satisfactionRatingsEnabled: config.satisfactionRatingsEnabled,
      offlineFormEnabled: config.offlineFormEnabled,
      preChatFormFields: config.preChatFormFields.map((f) => ({ ...f })),
      offlineFormFields: config.offlineFormFields.map((f) => ({ ...f })),
    };

    if (dto.topTitle !== undefined) config.topTitle = dto.topTitle.trim();
    if (dto.concierge !== undefined) {
      if (dto.concierge.displayName !== undefined)
        config.concierge.displayName = dto.concierge.displayName.trim();
      if (dto.concierge.byline !== undefined)
        config.concierge.byline = dto.concierge.byline.trim();
      if (dto.concierge.avatarUrl !== undefined)
        config.concierge.avatarUrl = dto.concierge.avatarUrl;
    }
    if (dto.iconUrl !== undefined) config.iconUrl = dto.iconUrl;
    if (dto.primaryColor !== undefined) config.primaryColor = dto.primaryColor;
    if (dto.messageStyle !== undefined)
      config.messageStyle = dto.messageStyle.trim();
    if (dto.notificationSoundEnabled !== undefined)
      config.notificationSoundEnabled = dto.notificationSoundEnabled;
    if (dto.satisfactionRatingsEnabled !== undefined)
      config.satisfactionRatingsEnabled = dto.satisfactionRatingsEnabled;
    if (dto.offlineFormEnabled !== undefined)
      config.offlineFormEnabled = dto.offlineFormEnabled;

    if (dto.preChatFormFields !== undefined) {
      this.assertValidFormFields(dto.preChatFormFields, {
        formName: 'pre-chat form',
        // At least one of email/phone must stay enabled so an Agent has
        // some way to follow up — name alone isn't a contact method.
        requireEnabledOneOf: ['email', 'phone'],
      });
      config.preChatFormFields = dto.preChatFormFields;
    }
    if (dto.offlineFormFields !== undefined) {
      this.assertValidFormFields(dto.offlineFormFields, {
        formName: 'offline form',
        requireEnabledOneOf: ['message'],
      });
      config.offlineFormFields = dto.offlineFormFields;
    }

    await config.save();

    // FR-CFG-06: no embed-script change needed — the public bootstrap
    // endpoint reads this same document live on every new visitor session.
    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'widget_config.updated',
      siteId: site._id,
      targetType: 'WidgetConfig',
      targetId: config._id,
      metadata: {
        before,
        after: {
          topTitle: config.topTitle,
          concierge: { ...config.concierge },
          iconUrl: config.iconUrl,
          primaryColor: config.primaryColor,
          messageStyle: config.messageStyle,
          notificationSoundEnabled: config.notificationSoundEnabled,
          satisfactionRatingsEnabled: config.satisfactionRatingsEnabled,
          offlineFormEnabled: config.offlineFormEnabled,
          preChatFormFields: config.preChatFormFields.map((f) => ({ ...f })),
          offlineFormFields: config.offlineFormFields.map((f) => ({ ...f })),
        },
      },
    });

    return config;
  }

  /**
   * Forms builder guard (this session's addition) — a builtin field (e.g.
   * `email`/`message`) can be hidden/optional, but the ENTIRE field set
   * can't leave a form with no working way to reach the Visitor back, or
   * missing the field a hardcoded downstream flow depends on
   * (`SubmitVisitorProfileDto`'s name/email, `OfflineForm`'s message-
   * becomes-first-Message flow). Also rejects a `builtin` flag flipped by
   * the client (only the server's own defaults may mark a field builtin) —
   * an admin-added custom field pretending to be builtin would otherwise
   * become undeletable.
   */
  private assertValidFormFields(
    fields: UpdateFormFieldDto[],
    opts: { formName: string; requireEnabledOneOf: string[] },
  ): void {
    const seenIds = new Set<string>();
    for (const field of fields) {
      if (seenIds.has(field.id)) {
        throw new BadRequestException(
          `Duplicate field id "${field.id}" on the ${opts.formName}.`,
        );
      }
      seenIds.add(field.id);
      // A field claiming builtin status must be one this form actually
      // ships as a default — otherwise a custom field could mark itself
      // builtin just to become undeletable in the admin UI.
      if (
        field.builtin &&
        !['name', 'email', 'phone', 'message'].includes(field.id)
      ) {
        throw new BadRequestException(
          `"${field.id}" on the ${opts.formName} can't be marked builtin.`,
        );
      }
    }

    const anyEnabled = opts.requireEnabledOneOf.some((id) =>
      fields.some((f) => f.id === id && f.enabled),
    );
    if (!anyEnabled) {
      throw new BadRequestException(
        `The ${opts.formName} must keep at least one of ` +
          `${opts.requireEnabledOneOf.join('/')} enabled.`,
      );
    }
  }

  private async findOrCreate(
    siteId: SiteDocument['_id'],
  ): Promise<WidgetConfigDocument> {
    let config = await this.widgetConfigModel.findOne({ siteId }).exec();
    if (!config) {
      config = await this.widgetConfigModel.create({ siteId });
    }
    return config;
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
