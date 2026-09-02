import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Shortcut,
  ShortcutDocument,
  ShortcutScopeLevel,
  Site,
  SiteDocument,
} from '../database/schemas';
import type { ShortcutWithCreator } from './interfaces/shortcut-with-creator.interface';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import { CreateShortcutDto } from './dto/create-shortcut.dto';
import { UpdateShortcutDto } from './dto/update-shortcut.dto';

/**
 * ShortcutsService — SRS §2.4 / §3.11 (FR-P2-SHORT-01–08).
 *
 * `ShortcutsController` gates every route with the coarse
 * `SHORTCUT_MANAGE_PERMISSIONS` / `shortcuts.view` `PermissionGuard` check
 * (siteSource 'any'/'query') — "can this caller reach the route at all."
 * This service is where the PRECISE, per-record rule actually lives:
 * `assertCanManageScope` maps a Shortcut's `scopeLevel` (+ `siteId` for
 * SITE) onto the one matching `shortcuts.manage_*` permission and checks
 * the caller holds it, via the exact same `PermissionsService` every other
 * module already uses — never a parallel/hand-rolled check. This is what
 * makes FR-P2-SHORT-04 ("reject a scopeLevel the caller doesn't hold the
 * permission for") real server-side enforcement, not just a UI affordance:
 * called on create AND on update (both the record's current scope and, if
 * the request is moving it, the new target scope).
 *
 * `shortcuts.manage_own`/`shortcuts.manage_organization` are checked via
 * `PermissionsService.getAuthorizedSites` (held on ANY Site or org-wide) —
 * PERSONAL and ORGANIZATION shortcuts aren't tied to one specific Site, so
 * there's no single `siteId` to key a plain `hasPermission` check off of;
 * this is the same "any" resolution `CombinedConversationsController`/
 * `CombinedVisitorsController` already use for their own Site-less routes.
 * `shortcuts.manage_site` is checked with a plain, precise `hasPermission`
 * against the ONE Site actually in play (FR-P2-SHORT-02's "on a given
 * Site").
 */
@Injectable()
export class ShortcutsService {
  constructor(
    @InjectModel(Shortcut.name)
    private readonly shortcutModel: Model<ShortcutDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAvailable(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<ShortcutDocument[]> {
    const site = await this.assertSite(actor, siteId);
    return this.shortcutModel
      .find({
        organizationId: actor.organizationId,
        $or: [
          { scopeLevel: 'PERSONAL', createdByUserId: actor.userId },
          { scopeLevel: 'SITE', siteId: site._id },
          { scopeLevel: 'ORGANIZATION' },
        ],
      })
      .sort({ scopeLevel: 1, shortcutKeyword: 1 })
      .exec();
  }

  /** FR-P2-SHORT-07/08's management listings — one scopeLevel per call. */
  async listManaged(
    actor: AuthenticatedUser,
    scopeLevel: ShortcutScopeLevel,
    siteId?: string,
  ): Promise<ShortcutDocument[]> {
    if (scopeLevel === 'SITE' && !siteId) {
      throw new BadRequestException(
        'siteId is required when scopeLevel is SITE.',
      );
    }
    if (scopeLevel !== 'SITE' && siteId) {
      throw new BadRequestException(
        `siteId must not be set when scopeLevel is ${scopeLevel}.`,
      );
    }
    let site: SiteDocument | undefined;
    if (siteId) {
      site = await this.assertSite(actor, siteId);
    }
    await this.assertCanManageScope(actor, scopeLevel, site?._id.toString());

    const filter: Record<string, unknown> = {
      organizationId: actor.organizationId,
      scopeLevel,
    };
    if (scopeLevel === 'PERSONAL') {
      filter.createdByUserId = actor.userId;
    } else if (scopeLevel === 'SITE') {
      filter.siteId = site!._id;
    }
    return this.shortcutModel.find(filter).sort({ shortcutKeyword: 1 }).exec();
  }

  /**
   * `GET /shortcuts/all` (SRS §3.11 FR-P2-SHORT-09, `shortcuts.view_all`) —
   * EVERY Shortcut in `actor`'s Organization, across all three scopeLevels,
   * including every other User's Personal ones. Deliberately does NOT call
   * `assertCanManageScope`/`assertOwnershipIfPersonal` anywhere in this
   * method — those are the CRUD-mutation gates (create/update/remove/
   * findOne-for-manage); this is a separate, purely additive read path.
   * `ShortcutsController` is what actually enforces `shortcuts.view_all` via
   * `PermissionGuard` before this method is ever called — see that route's
   * own doc comment. Read-only: this method has no caller that mutates
   * anything, by construction (no `update`/`remove` variant exists for it).
   */
  async findAllInOrganization(
    actor: AuthenticatedUser,
  ): Promise<ShortcutWithCreator[]> {
    const rows = await this.shortcutModel
      .find({ organizationId: actor.organizationId })
      .sort({ scopeLevel: 1, shortcutKeyword: 1 })
      .populate<{
        createdByUserId: {
          _id: Types.ObjectId;
          displayName: string;
          fullName: string;
        } | null;
      }>('createdByUserId', 'displayName fullName')
      .lean()
      .exec();

    return rows.map((row) => {
      // `createdByUserId` comes back populated (an object) here — narrow it
      // back to a bare id string for the field of that name (matching every
      // other Shortcuts endpoint's contract) and surface the populated data
      // separately via `creator`, per this method's own interface doc.
      const populatedCreator = row.createdByUserId as unknown as {
        _id: Types.ObjectId;
        displayName: string;
        fullName: string;
      } | null;
      return {
        _id: row._id.toString(),
        organizationId: row.organizationId.toString(),
        createdByUserId: populatedCreator
          ? populatedCreator._id.toString()
          : String(row.createdByUserId),
        creator: populatedCreator
          ? {
              id: populatedCreator._id.toString(),
              displayName: populatedCreator.displayName,
              fullName: populatedCreator.fullName,
            }
          : null,
        scopeLevel: row.scopeLevel,
        siteId: row.siteId ? row.siteId.toString() : null,
        shortcutKeyword: row.shortcutKeyword,
        purpose: row.purpose,
        message: row.message,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async findOne(
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ShortcutDocument> {
    const shortcut = await this.loadShortcut(actor, id);
    await this.assertCanManageScope(
      actor,
      shortcut.scopeLevel,
      shortcut.siteId?.toString(),
    );
    this.assertOwnershipIfPersonal(actor, shortcut);
    return shortcut;
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateShortcutDto,
  ): Promise<ShortcutDocument> {
    const siteObjectId = await this.resolveSiteForScope(
      actor,
      dto.scopeLevel,
      dto.siteId,
    );

    // FR-P2-SHORT-04: reject a scopeLevel the caller doesn't hold the
    // matching permission for, even though the client picked it.
    await this.assertCanManageScope(actor, dto.scopeLevel, dto.siteId);

    const shortcut = await this.shortcutModel.create({
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      scopeLevel: dto.scopeLevel,
      siteId: siteObjectId,
      shortcutKeyword: dto.shortcutKeyword.trim(),
      purpose: dto.purpose.trim(),
      message: dto.message,
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'shortcut.created',
      siteId: siteObjectId ?? undefined,
      targetType: 'Shortcut',
      targetId: shortcut._id,
      metadata: {
        scopeLevel: shortcut.scopeLevel,
        shortcutKeyword: shortcut.shortcutKeyword,
      },
    });

    return shortcut;
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateShortcutDto,
  ): Promise<ShortcutDocument> {
    const shortcut = await this.loadShortcut(actor, id);

    // Must be able to manage the shortcut's CURRENT scope to touch it at all.
    await this.assertCanManageScope(
      actor,
      shortcut.scopeLevel,
      shortcut.siteId?.toString(),
    );
    this.assertOwnershipIfPersonal(actor, shortcut);

    const nextScopeLevel = dto.scopeLevel ?? shortcut.scopeLevel;
    const scopeChanging =
      dto.scopeLevel !== undefined && dto.scopeLevel !== shortcut.scopeLevel;
    const siteChanging =
      dto.siteId !== undefined && dto.siteId !== shortcut.siteId?.toString();

    let nextSiteObjectId = shortcut.siteId;
    if (scopeChanging || siteChanging) {
      nextSiteObjectId = await this.resolveSiteForScope(
        actor,
        nextScopeLevel,
        dto.siteId ?? shortcut.siteId?.toString(),
      );
      // FR-P2-SHORT-04: also reject moving a Shortcut into a scope the
      // caller doesn't hold the matching permission for.
      await this.assertCanManageScope(
        actor,
        nextScopeLevel,
        nextSiteObjectId?.toString(),
      );
    }

    const before = {
      scopeLevel: shortcut.scopeLevel,
      siteId: shortcut.siteId,
      shortcutKeyword: shortcut.shortcutKeyword,
      purpose: shortcut.purpose,
      message: shortcut.message,
    };

    shortcut.scopeLevel = nextScopeLevel;
    shortcut.siteId = nextSiteObjectId;
    if (dto.shortcutKeyword !== undefined)
      shortcut.shortcutKeyword = dto.shortcutKeyword.trim();
    if (dto.purpose !== undefined) shortcut.purpose = dto.purpose.trim();
    if (dto.message !== undefined) shortcut.message = dto.message;

    await shortcut.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'shortcut.updated',
      siteId: shortcut.siteId ?? undefined,
      targetType: 'Shortcut',
      targetId: shortcut._id,
      metadata: {
        before,
        after: {
          scopeLevel: shortcut.scopeLevel,
          siteId: shortcut.siteId,
          shortcutKeyword: shortcut.shortcutKeyword,
          purpose: shortcut.purpose,
          message: shortcut.message,
        },
      },
    });

    return shortcut;
  }

  async remove(actor: AuthenticatedUser, id: string): Promise<void> {
    const shortcut = await this.loadShortcut(actor, id);
    await this.assertCanManageScope(
      actor,
      shortcut.scopeLevel,
      shortcut.siteId?.toString(),
    );
    this.assertOwnershipIfPersonal(actor, shortcut);

    await shortcut.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'shortcut.deleted',
      siteId: shortcut.siteId ?? undefined,
      targetType: 'Shortcut',
      targetId: shortcut._id,
      metadata: {
        scopeLevel: shortcut.scopeLevel,
        shortcutKeyword: shortcut.shortcutKeyword,
      },
    });
  }

  /**
   * The FR-P2-SHORT-04 enforcement point. Throws `ForbiddenException`
   * unless `actor` holds the ONE `shortcuts.manage_*` permission that
   * matches `scopeLevel` — `manage_site` checked precisely against
   * `siteId` (required for SITE), `manage_own`/`manage_organization`
   * checked via "held on any Site or org-wide" since neither scope is
   * pinned to one Site.
   */
  private async assertCanManageScope(
    actor: AuthenticatedUser,
    scopeLevel: ShortcutScopeLevel,
    siteId?: string,
  ): Promise<void> {
    if (scopeLevel === 'SITE') {
      if (!siteId) {
        throw new BadRequestException(
          'siteId is required for a SITE-level shortcut.',
        );
      }
      const has = await this.permissionsService.hasPermission(
        actor.userId,
        'shortcuts.manage_site',
        siteId,
      );
      if (!has) {
        throw new ForbiddenException(
          `Missing required permission "shortcuts.manage_site" on site ${siteId}.`,
        );
      }
      return;
    }

    const permission =
      scopeLevel === 'PERSONAL'
        ? 'shortcuts.manage_own'
        : 'shortcuts.manage_organization';
    const authorizedSites = await this.permissionsService.getAuthorizedSites(
      actor.userId,
      [permission],
    );
    if (authorizedSites.length === 0) {
      throw new ForbiddenException(
        `Missing required permission "${permission}" for a ${scopeLevel}-level shortcut.`,
      );
    }
  }

  /** PERSONAL shortcuts are manageable only by the User who created them. */
  private assertOwnershipIfPersonal(
    actor: AuthenticatedUser,
    shortcut: ShortcutDocument,
  ): void {
    if (
      shortcut.scopeLevel === 'PERSONAL' &&
      shortcut.createdByUserId.toString() !== actor.userId
    ) {
      throw new ForbiddenException(
        'You can only manage your own Personal shortcuts.',
      );
    }
  }

  /** Validates the scopeLevel/siteId combination and resolves siteId -> a real Site in this Organization. */
  private async resolveSiteForScope(
    actor: AuthenticatedUser,
    scopeLevel: ShortcutScopeLevel,
    siteId?: string,
  ): Promise<Types.ObjectId | null> {
    if (scopeLevel === 'SITE') {
      if (!siteId) {
        throw new BadRequestException(
          'siteId is required for a SITE-level shortcut.',
        );
      }
      const site = await this.assertSite(actor, siteId);
      return site._id;
    }
    if (siteId) {
      throw new BadRequestException(
        `siteId must not be set for a ${scopeLevel}-level shortcut.`,
      );
    }
    return null;
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

  private async loadShortcut(
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ShortcutDocument> {
    const shortcut = await this.shortcutModel
      .findOne({ _id: id, organizationId: actor.organizationId })
      .exec();
    if (!shortcut) {
      throw new NotFoundException('Shortcut not found in this Organization.');
    }
    return shortcut;
  }
}
