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
  Trigger,
  TriggerDocument,
  TRIGGER_URL_OPERATORS,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ActionDto, ConditionDto } from './dto/condition-action.dto';
import { CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';

const GTE_CONDITION_TYPES = [
  'timeOnPage',
  'pageViews',
  'pastVisits',
  'pastChats',
  'stillOnSite',
];

const EQUALS_ONLY_CONDITION_TYPES = [
  'utmSource',
  'deviceType',
  'onlineStatus',
  'hourOfDay',
  'dayOfWeek',
  'visitorIp',
  'visitorCity',
  'visitorRegion',
  'visitorCountryCode',
  'visitorCountryName',
  'visitorDepartment',
  'visitorTag',
  'browser',
  'platform',
  'searchEngine',
  'accountStatus',
];

// True/false conditions — operator is always 'equals', value must be the
// literal string 'true'/'false' (TriggerEvaluationService reads it that way).
const TRUE_FALSE_CONDITION_TYPES = [
  'visitorTriggered',
  'visitorIsChatting',
  'visitorRequestingChat',
  'visitorServed',
];

// Free-text conditions accepting either 'equals' or 'contains'.
const EQUALS_OR_CONTAINS_CONDITION_TYPES = [
  'pageTitle',
  'visitorName',
  'visitorEmail',
];

// 'contains'-only free-text conditions.
const CONTAINS_ONLY_CONDITION_TYPES = [
  'visitorHostName',
  'userAgent',
  'searchTerms',
];

const DAY_OF_WEEK_VALUES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * TriggersService — FR-CFG-04/05. `PermissionGuard` (via
 * `triggers.view`/`triggers.manage`, checked against the route's `:siteId`)
 * decides reachability; this service enforces every Trigger it touches
 * actually belongs to a Site in the caller's Organization, same pattern as
 * `DepartmentsService`/`WidgetConfigService`.
 *
 * FR-CFG-05 ("highest-priority match fires") is *evaluation* logic that
 * belongs to the widget-facing runtime, not this admin CRUD — this service
 * only guarantees Triggers always come back ordered by priority (desc:
 * higher number = higher priority) so any future evaluator (frontend or
 * the public bootstrap endpoint) can pick `[0]` of the enabled/matching
 * subset without re-sorting.
 *
 * This session's rebuild (see trigger.schema.ts) replaced the single
 * matchType/matchValue/action shape with a condition/action builder — this
 * service is also where each condition/action's `type`-appropriate
 * `operator`/`value` shape is enforced (the DTO layer only checks `type` is
 * a known enum member, not that e.g. a `url` condition's operator is one of
 * the 4 valid URL operators), same "cross-field checks live in the
 * service" pattern `WidgetConfigService.assertValidFormFields` uses.
 */
@Injectable()
export class TriggersService {
  constructor(
    @InjectModel(Trigger.name)
    private readonly triggerModel: Model<TriggerDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<TriggerDocument[]> {
    const site = await this.assertSite(actor, siteId);
    return this.triggerModel
      .find({ siteId: site._id })
      .sort({ priority: -1, createdAt: 1 })
      .exec();
  }

  async findOne(
    actor: AuthenticatedUser,
    siteId: string,
    triggerId: string,
  ): Promise<TriggerDocument> {
    const site = await this.assertSite(actor, siteId);
    return this.findTriggerOnSite(site, triggerId);
  }

  async create(
    actor: AuthenticatedUser,
    siteId: string,
    dto: CreateTriggerDto,
  ): Promise<TriggerDocument> {
    const site = await this.assertSite(actor, siteId);
    this.assertValidConditions(dto.conditions);
    this.assertValidActions(dto.actions);

    const trigger = await this.triggerModel.create({
      siteId: site._id,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      runEvent: dto.runEvent ?? 'widgetLoaded',
      conditionLogic: dto.conditionLogic ?? 'all',
      conditions: dto.conditions,
      actions: this.normalizeActions(dto.actions),
      fireOncePerVisitor: dto.fireOncePerVisitor ?? false,
      isEnabled: dto.isEnabled ?? true,
      priority: dto.priority ?? 0,
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'trigger.created',
      siteId: site._id,
      targetType: 'Trigger',
      targetId: trigger._id,
      metadata: { name: trigger.name, priority: trigger.priority },
    });

    return trigger;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    triggerId: string,
    dto: UpdateTriggerDto,
  ): Promise<TriggerDocument> {
    const site = await this.assertSite(actor, siteId);
    const trigger = await this.findTriggerOnSite(site, triggerId);

    if (dto.conditions !== undefined)
      this.assertValidConditions(dto.conditions);
    if (dto.actions !== undefined) this.assertValidActions(dto.actions);

    const before = {
      name: trigger.name,
      description: trigger.description,
      runEvent: trigger.runEvent,
      conditionLogic: trigger.conditionLogic,
      conditions: trigger.conditions.map((c) => ({ ...c })),
      actions: trigger.actions.map((a) => ({ ...a })),
      fireOncePerVisitor: trigger.fireOncePerVisitor,
      isEnabled: trigger.isEnabled,
      priority: trigger.priority,
    };

    if (dto.name !== undefined) trigger.name = dto.name.trim();
    if (dto.description !== undefined)
      trigger.description = dto.description.trim() || null;
    if (dto.runEvent !== undefined) trigger.runEvent = dto.runEvent;
    if (dto.conditionLogic !== undefined)
      trigger.conditionLogic = dto.conditionLogic;
    if (dto.conditions !== undefined) trigger.conditions = dto.conditions;
    if (dto.actions !== undefined)
      trigger.actions = this.normalizeActions(dto.actions);
    if (dto.fireOncePerVisitor !== undefined)
      trigger.fireOncePerVisitor = dto.fireOncePerVisitor;
    if (dto.isEnabled !== undefined) trigger.isEnabled = dto.isEnabled;
    if (dto.priority !== undefined) trigger.priority = dto.priority;

    await trigger.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'trigger.updated',
      siteId: site._id,
      targetType: 'Trigger',
      targetId: trigger._id,
      metadata: {
        before,
        after: {
          name: trigger.name,
          description: trigger.description,
          runEvent: trigger.runEvent,
          conditionLogic: trigger.conditionLogic,
          conditions: trigger.conditions.map((c) => ({ ...c })),
          actions: trigger.actions.map((a) => ({ ...a })),
          fireOncePerVisitor: trigger.fireOncePerVisitor,
          isEnabled: trigger.isEnabled,
          priority: trigger.priority,
        },
      },
    });

    return trigger;
  }

  async remove(
    actor: AuthenticatedUser,
    siteId: string,
    triggerId: string,
  ): Promise<void> {
    const site = await this.assertSite(actor, siteId);
    const trigger = await this.findTriggerOnSite(site, triggerId);

    await trigger.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'trigger.deleted',
      siteId: site._id,
      targetType: 'Trigger',
      targetId: trigger._id,
      metadata: { name: trigger.name },
    });
  }

  private assertValidConditions(conditions: ConditionDto[]): void {
    // Defense-in-depth guard (T-01-rbac.md Follow-ups): the DTO layer
    // (`CreateTriggerDto.conditions`/`UpdateTriggerDto.conditions`, both
    // `@IsArray()`) plus the global `ValidationPipe`
    // (`whitelist`/`transform`/`forbidNonWhitelisted`, `main.ts`) already
    // reject a missing/non-array `conditions` with a 400 before this
    // service ever runs — confirmed live, not just by reading the code.
    // This guard exists purely so a future caller that reaches this method
    // WITHOUT going through that pipe (a direct service call, a bulk-import
    // path, a test) fails with a clean 400 instead of a raw
    // `TypeError: conditions is not iterable` crashing out as an
    // uncaught 500.
    if (!Array.isArray(conditions)) {
      throw new BadRequestException(
        'conditions is required and must be an array.',
      );
    }
    for (const condition of conditions) {
      switch (condition.type) {
        case 'url':
        case 'previousPage':
          if (
            !(TRIGGER_URL_OPERATORS as readonly string[]).includes(
              condition.operator,
            )
          ) {
            throw new BadRequestException(
              `A "${condition.type}" condition's operator must be one of: ${TRIGGER_URL_OPERATORS.join(', ')}.`,
            );
          }
          break;
        case 'referrer':
          if (condition.operator !== 'contains') {
            throw new BadRequestException(
              'A "referrer" condition\'s operator must be "contains".',
            );
          }
          break;
        case 'hourOfDay':
          if (condition.operator !== 'equals') {
            throw new BadRequestException(
              'An "hourOfDay" condition\'s operator must be "equals".',
            );
          }
          if (!/^([0-9]|1[0-9]|2[0-3])$/.test(condition.value)) {
            throw new BadRequestException(
              'An "hourOfDay" condition\'s value must be an integer 0-23.',
            );
          }
          break;
        case 'dayOfWeek':
          if (condition.operator !== 'equals') {
            throw new BadRequestException(
              'A "dayOfWeek" condition\'s operator must be "equals".',
            );
          }
          if (!DAY_OF_WEEK_VALUES.includes(condition.value)) {
            throw new BadRequestException(
              `A "dayOfWeek" condition's value must be one of: ${DAY_OF_WEEK_VALUES.join(', ')}.`,
            );
          }
          break;
        default:
          if (EQUALS_ONLY_CONDITION_TYPES.includes(condition.type)) {
            if (condition.operator !== 'equals') {
              throw new BadRequestException(
                `A "${condition.type}" condition's operator must be "equals".`,
              );
            }
          } else if (TRUE_FALSE_CONDITION_TYPES.includes(condition.type)) {
            if (condition.operator !== 'equals') {
              throw new BadRequestException(
                `A "${condition.type}" condition's operator must be "equals".`,
              );
            }
            if (condition.value !== 'true' && condition.value !== 'false') {
              throw new BadRequestException(
                `A "${condition.type}" condition's value must be "true" or "false".`,
              );
            }
          } else if (
            EQUALS_OR_CONTAINS_CONDITION_TYPES.includes(condition.type)
          ) {
            if (
              condition.operator !== 'equals' &&
              condition.operator !== 'contains'
            ) {
              throw new BadRequestException(
                `A "${condition.type}" condition's operator must be "equals" or "contains".`,
              );
            }
          } else if (CONTAINS_ONLY_CONDITION_TYPES.includes(condition.type)) {
            if (condition.operator !== 'contains') {
              throw new BadRequestException(
                `A "${condition.type}" condition's operator must be "contains".`,
              );
            }
          } else if (GTE_CONDITION_TYPES.includes(condition.type)) {
            if (condition.operator !== 'gte') {
              throw new BadRequestException(
                `A "${condition.type}" condition's operator must be "gte".`,
              );
            }
            if (!/^\d+$/.test(condition.value)) {
              throw new BadRequestException(
                `A "${condition.type}" condition's value must be a non-negative integer.`,
              );
            }
          }
      }
    }
  }

  private normalizeActions(actions: ActionDto[]) {
    return actions.map((a) => ({
      type: a.type,
      value: a.value ?? null,
      // Session Feature-2c-complex-actions — only showProactiveMessage uses
      // this, but it's carried through unconditionally (like `value` above)
      // rather than conditionally dropped, same "store what was sent" idiom.
      fromName: a.fromName ?? null,
    }));
  }

  private assertValidActions(actions: ActionDto[]): void {
    for (const action of actions) {
      const needsValue = [
        'showProactiveMessage',
        'sendConciergeMessage',
        'setDepartment',
        'addTag',
        // Session Feature-2c-simple-actions — all 4 are direct field
        // writes that make no sense with an empty value (an empty
        // "replace note" would just be a silent clear, which an admin
        // should express by leaving the action off, not by submitting one).
        'setVisitorName',
        'removeTag',
        'replaceNote',
        'appendNote',
        // Session Feature-2c-complex-actions
        'wait', // seconds to delay
        'setVisitorDepartment', // departmentId
      ].includes(action.type);
      if (needsValue && !action.value?.trim()) {
        throw new BadRequestException(
          `A "${action.type}" action requires a value.`,
        );
      }
      // `setTriggered`/`blockVisitor` deliberately have NO needsValue check
      // — `setTriggered` never takes one at all (see trigger.schema.ts),
      // and `blockVisitor`'s value is an OPTIONAL ban reason (empty is a
      // valid "no reason given" ban, same as VisitorsService.ban()'s own
      // `reason?` param).
      if (action.type === 'wait' && !/^[1-9][0-9]*$/.test(action.value ?? '')) {
        throw new BadRequestException(
          'A "wait" action\'s value must be a positive whole number of seconds.',
        );
      }
    }
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

  private async findTriggerOnSite(
    site: SiteDocument,
    triggerId: string,
  ): Promise<TriggerDocument> {
    const trigger = await this.triggerModel
      .findOne({ _id: triggerId, siteId: site._id })
      .exec();
    if (!trigger) {
      throw new NotFoundException('Trigger not found on this Site.');
    }
    return trigger;
  }
}
