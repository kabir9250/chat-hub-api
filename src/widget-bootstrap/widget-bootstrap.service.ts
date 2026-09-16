import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  BusinessHoursConfig,
  FormFieldConfig,
  Site,
  SiteDocument,
  Trigger,
  TriggerActionConfig,
  TriggerCondition,
  TriggerDocument,
  User,
  UserDocument,
  WidgetConfig,
  WidgetConfigDocument,
  WidgetLauncherBadge,
  defaultOfflineFormFields,
  defaultPreChatFormFields,
} from '../database/schemas';
import { PermissionsService } from '../rbac/permissions.service';
import { PresenceService } from '../realtime/presence.service';
import { isWithinBusinessHours } from '../sites/business-hours.util';

/** Public, visitor-safe shape of a form field — no server-only bookkeeping. */
export type PublicFormField = FormFieldConfig;

/** Public, visitor-safe shape of WidgetConfig — no `_id`/timestamps. */
export interface PublicWidgetConfig {
  topTitle: string;
  concierge: {
    displayName: string;
    byline: string;
    avatarUrl?: string;
  };
  iconUrl?: string;
  primaryColor: string;
  launcherStyle: string;
  launcherBadge: WidgetLauncherBadge;
  messageStyle: string;
  notificationSoundEnabled: boolean;
  satisfactionRatingsEnabled: boolean;
  offlineFormEnabled: boolean;
  attachmentsEnabled: boolean;
  /** Phase 2 §3.12 (FR-P2-FORM-01–04) — whole pre-chat-form on/off switch. */
  preChatFormEnabled: boolean;
  preChatFormFields: PublicFormField[];
  offlineFormFields: PublicFormField[];
}

/** Schema-default `WidgetLauncherBadge` values — used when a Site has no
 * WidgetConfig document yet (see `toPublicWidgetConfig`'s no-config branch). */
function defaultLauncherBadge(): WidgetLauncherBadge {
  return {
    topText: 'LIVE',
    bottomText: 'CHAT',
    iconColor: '#f01e3c',
    backgroundColor: '#0a0a0a',
    topTextColor: '#f01e3c',
    bottomTextColor: '#ffffff',
  };
}

/** Public, visitor-safe shape of a Trigger — no `siteId`/`isEnabled`/timestamps. */
export interface PublicTrigger {
  id: string;
  name: string;
  runEvent: Trigger['runEvent'];
  conditionLogic: Trigger['conditionLogic'];
  conditions: TriggerCondition[];
  actions: TriggerActionConfig[];
  fireOncePerVisitor: boolean;
  priority: number;
}

export interface WidgetBootstrapResult {
  siteId: string;
  widgetConfig: PublicWidgetConfig;
  triggers: PublicTrigger[];
}

/** FR-WID-09/FR-HRS-01: the widget's "We're online"/"We're away" indicator. */
export interface WidgetStatusResult {
  online: boolean;
  agentOnline: boolean;
  businessHoursEnabled: boolean;
  withinBusinessHours: boolean;
}

/**
 * WidgetBootstrapService — the public counterpart to
 * `WidgetConfigService`/`TriggersService`. Backs the ONE endpoint the
 * embed script actually calls (FR-CFG-06: config/trigger changes take
 * effect for new visitor sessions without an embed-script change) — reads
 * live from the same collections the admin CRUD writes to, no caching/
 * denormalization.
 *
 * Deliberately does not use `PermissionGuard`/`JwtAuthGuard` — the caller
 * is an anonymous browser on a client's website, not a `User`. Deliberately
 * does NOT reuse `WidgetConfigService.get`/`TriggersService.findAll` either:
 * those assert the caller's `organizationId` (an authenticated User
 * concept that doesn't exist here) and return full Mongoose documents,
 * which would leak internal fields (`_id`, `siteId` on every Trigger,
 * `isEnabled`, timestamps) to any visitor's browser dev tools. This
 * service queries the models directly and maps to the `Public*` shapes
 * above instead.
 */
@Injectable()
export class WidgetBootstrapService {
  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(WidgetConfig.name)
    private readonly widgetConfigModel: Model<WidgetConfigDocument>,
    @InjectModel(Trigger.name)
    private readonly triggerModel: Model<TriggerDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly presenceService: PresenceService,
  ) {}

  async getBootstrap(siteId: string): Promise<WidgetBootstrapResult> {
    const site = await this.siteModel.findById(siteId).exec();
    if (!site) {
      throw new NotFoundException('Unknown siteId.');
    }
    // This session's check: a Site's chat only actually goes live once an
    // admin has both set its URL(s) and explicitly flipped `chatEnabled`
    // on (`SitesService.update` is the only place that can happen, and it
    // itself refuses to enable a Site with no URL) — enforced here too, not
    // just in the Admin Panel, so an embed script pointed at a disabled/
    // not-yet-configured siteId can't pull a live config regardless.
    if (!site.chatEnabled) {
      throw new NotFoundException('Chat is not enabled for this Site.');
    }

    const [config, triggers] = await Promise.all([
      this.widgetConfigModel.findOne({ siteId: site._id }).exec(),
      // Only enabled Triggers, ordered by priority (FR-CFG-05: highest
      // priority evaluated first) so the frontend can just walk the array
      // and fire the first match — no evaluation logic lives here.
      this.triggerModel
        .find({ siteId: site._id, isEnabled: true })
        .sort({ priority: -1, createdAt: 1 })
        .exec(),
    ]);

    return {
      siteId: site._id.toString(),
      widgetConfig: this.toPublicWidgetConfig(config),
      triggers: triggers.map((t) => this.toPublicTrigger(t)),
    };
  }

  /**
   * FR-WID-09/FR-HRS-01: "online" = at least one enabled User who belongs
   * to this Site (`PermissionsService.isUserOnSite`, the same "belongs to
   * a Site" definition Sessions 4/7 already standardized on) is currently
   * connected (`PresenceService.isOnline`, in-memory/real, not a DB flag —
   * same "available" definition FR-RTE-01's auto-routing uses), AND the
   * current time is within the Site's configured Business Hours (or Business
   * Hours isn't enabled at all, in which case it doesn't restrict anything).
   * Both booleans are also returned individually so the widget can show a
   * more specific message ("outside business hours" vs "no agents online")
   * if it wants to, without a second round-trip.
   */
  async getStatus(siteId: string): Promise<WidgetStatusResult> {
    const site = await this.siteModel.findById(siteId).exec();
    if (!site) {
      throw new NotFoundException('Unknown siteId.');
    }
    if (!site.chatEnabled) {
      throw new NotFoundException('Chat is not enabled for this Site.');
    }

    const withinBusinessHours = isWithinBusinessHours(site.businessHoursConfig);

    const enabledUsers = await this.userModel
      .find({ enabled: true })
      .select('_id')
      .lean()
      .exec();
    let agentOnline = false;
    for (const u of enabledUsers) {
      const idStr = u._id.toString();
      if (!this.presenceService.isOnline(idStr)) continue;

      if (await this.permissionsService.isUserOnSite(idStr, site._id)) {
        agentOnline = true;
        break;
      }
    }

    return {
      online: agentOnline && withinBusinessHours,
      agentOnline,
      businessHoursEnabled: site.businessHoursConfig.enabled,
      withinBusinessHours,
    };
  }

  /** No Business Hours configured (`enabled: false`) means no restriction. */
  private isWithinBusinessHours(config: BusinessHoursConfig): boolean {
    if (!config.enabled) return true;

    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone || 'UTC',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
      const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
      const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
      const dayKey = weekday.toLowerCase().slice(0, 3);
      const hm = `${hour === '24' ? '00' : hour}:${minute}`;

      const ranges = config.weeklySchedule?.[dayKey];
      if (!ranges || ranges.length === 0) return false;
      return ranges.some((range) => {
        const [start, end] = range.split('-');
        return !!start && !!end && hm >= start && hm <= end;
      });
    } catch {
      // Bad/unrecognized timezone string — don't let a config error block
      // the widget's online indicator entirely.
      return true;
    }
  }

  private toPublicWidgetConfig(
    config: WidgetConfigDocument | null,
  ): PublicWidgetConfig {
    // No WidgetConfig document yet for this Site (shouldn't happen — the
    // seed script and WidgetConfigService.update both create one on
    // demand) — fall back to the schema's own defaults so the widget
    // still has something sane to render rather than a 404.
    if (!config) {
      return {
        topTitle: 'support',
        concierge: { displayName: 'Live Support', byline: 'Ask us anything' },
        primaryColor: '#1E88E5',
        launcherStyle: 'round',
        launcherBadge: defaultLauncherBadge(),
        messageStyle: 'modern',
        notificationSoundEnabled: true,
        satisfactionRatingsEnabled: true,
        offlineFormEnabled: true,
        attachmentsEnabled: true,
        preChatFormEnabled: true,
        preChatFormFields: this.toPublicFormFields(defaultPreChatFormFields()),
        offlineFormFields: this.toPublicFormFields(defaultOfflineFormFields()),
      };
    }
    return {
      topTitle: config.topTitle,
      concierge: {
        displayName: config.concierge.displayName,
        byline: config.concierge.byline,
        avatarUrl: config.concierge.avatarUrl,
      },
      iconUrl: config.iconUrl,
      primaryColor: config.primaryColor,
      launcherStyle: config.launcherStyle,
      launcherBadge: config.launcherBadge,
      messageStyle: config.messageStyle,
      notificationSoundEnabled: config.notificationSoundEnabled,
      satisfactionRatingsEnabled: config.satisfactionRatingsEnabled,
      offlineFormEnabled: config.offlineFormEnabled,
      attachmentsEnabled: config.attachmentsEnabled,
      preChatFormEnabled: config.preChatFormEnabled,
      preChatFormFields: this.toPublicFormFields(config.preChatFormFields),
      offlineFormFields: this.toPublicFormFields(config.offlineFormFields),
    };
  }

  /** Enabled-only, order-sorted — the widget renders these as-is, in order. */
  private toPublicFormFields(fields: FormFieldConfig[]): PublicFormField[] {
    return fields.filter((f) => f.enabled).sort((a, b) => a.order - b.order);
  }

  private toPublicTrigger(trigger: TriggerDocument): PublicTrigger {
    return {
      id: trigger._id.toString(),
      name: trigger.name,
      runEvent: trigger.runEvent,
      conditionLogic: trigger.conditionLogic,
      conditions: trigger.conditions,
      actions: trigger.actions,
      fireOncePerVisitor: trigger.fireOncePerVisitor,
      priority: trigger.priority,
    };
  }
}
