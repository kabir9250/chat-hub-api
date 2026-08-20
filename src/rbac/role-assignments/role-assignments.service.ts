import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  User,
  UserDocument,
  RoleAssignment,
} from '../../database/schemas/user.schema';
import { Role, RoleDocument } from '../../database/schemas/role.schema';
import { Site, SiteDocument } from '../../database/schemas/site.schema';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PermissionKey } from '../permission.catalog';
import { PermissionsService } from '../permissions.service';
import { CreateRoleAssignmentDto } from './dto/create-role-assignment.dto';

/** The one permission `setLiveActivityAccess`/`getLiveActivityAccess` deal in — see their doc comments. */
const LIVE_ACTIVITY_PERMISSION: PermissionKey = 'visitors.view_live_activity';

/**
 * RoleAssignmentsService — FR-RBAC-05, and both halves of FR-RBAC-09:
 *   (a) a User cannot grant *themselves* a Role Assignment carrying
 *       permissions they don't already hold (the assignment-side mirror of
 *       RolesService's Role-edit escalation guard — this is what stops a
 *       `role_assignments.manage`-only holder from just assigning
 *       themselves a fuller Role instead of editing one);
 *   (b) revoking the last Organization-scoped `role_assignments.manage`
 *       holder is blocked.
 *
 * `PermissionGuard` (via `role_assignments.manage`, org-wide) already
 * decides whether the caller can reach these endpoints at all.
 */
@Injectable()
export class RoleAssignmentsService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAllForUser(organizationId: string, userId: string) {
    const user = await this.userModel
      .findOne({ _id: userId, organizationId })
      .select('roleAssignments')
      .exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return user.roleAssignments;
  }

  async create(actor: AuthenticatedUser, dto: CreateRoleAssignmentDto) {
    const role = await this.roleModel
      .findOne({ _id: dto.roleId, organizationId: actor.organizationId })
      .exec();
    if (!role) {
      throw new NotFoundException('Role not found in this Organization.');
    }

    const targetUser = await this.userModel
      .findOne({ _id: dto.userId, organizationId: actor.organizationId })
      .exec();
    if (!targetUser) {
      throw new NotFoundException('User not found in this Organization.');
    }

    if (dto.scopeType === 'SITE') {
      if (!dto.siteId) {
        throw new BadRequestException(
          'siteId is required when scopeType is SITE.',
        );
      }
      const site = await this.siteModel
        .findOne({ _id: dto.siteId, organizationId: actor.organizationId })
        .exec();
      if (!site) {
        throw new NotFoundException('Site not found in this Organization.');
      }
    }

    // FR-RBAC-09(a): assigning a Role to YOURSELF can never hand you a
    // permission you don't already hold anywhere — otherwise a
    // `role_assignments.manage`-only holder (without `roles.manage`) could
    // sidestep RolesService's escalation guard entirely by just assigning
    // themselves a more powerful existing Role.
    if (dto.userId === actor.userId) {
      const actorPermissions = new Set<PermissionKey>(
        await this.permissionsService.getEffectivePermissions(
          actor.userId,
          null,
        ),
      );
      const notHeld = role.permissions.filter((p) => !actorPermissions.has(p));
      if (notHeld.length > 0) {
        throw new ForbiddenException(
          `Cannot assign yourself a Role granting permission(s) you do not already hold: ${notHeld.join(', ')}.`,
        );
      }
    }

    const newAssignment: Partial<RoleAssignment> = {
      roleId: role._id,
      scopeType: dto.scopeType,
      siteId:
        dto.scopeType === 'SITE' ? new Types.ObjectId(dto.siteId) : undefined,
      createdByUserId: new Types.ObjectId(actor.userId),
    };
    targetUser.roleAssignments.push(newAssignment as RoleAssignment);
    await targetUser.save();

    const created =
      targetUser.roleAssignments[targetUser.roleAssignments.length - 1];

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'role_assignment.created',
      siteId: dto.scopeType === 'SITE' ? dto.siteId : undefined,
      targetType: 'User',
      targetId: targetUser._id,
      metadata: {
        roleId: role._id.toString(),
        roleName: role.name,
        scopeType: dto.scopeType,
        siteId: dto.siteId,
      },
    });

    return created;
  }

  async revoke(
    actor: AuthenticatedUser,
    userId: string,
    assignmentId: string,
  ): Promise<void> {
    const targetUser = await this.userModel
      .findOne({ _id: userId, organizationId: actor.organizationId })
      .exec();
    if (!targetUser) {
      throw new NotFoundException('User not found in this Organization.');
    }

    const assignment = targetUser.roleAssignments.find(
      (a) => a._id?.toString() === assignmentId,
    );
    if (!assignment) {
      throw new NotFoundException('Role Assignment not found.');
    }

    if (assignment.scopeType === 'ORGANIZATION') {
      const role = await this.roleModel.findById(assignment.roleId).exec();
      if (role?.permissions.includes('role_assignments.manage')) {
        const wouldOrphan =
          await this.permissionsService.wouldOrphanOrganizationPermission(
            actor.organizationId,
            'role_assignments.manage',
            {
              excludeAssignment: {
                userId: targetUser._id.toString(),
                assignmentId,
              },
            },
          );
        if (wouldOrphan) {
          throw new ForbiddenException(
            'Cannot revoke this Role Assignment: it is the last Organization-scoped role_assignments.manage holder, which would lock the Organization out of role management.',
          );
        }
      }
    }

    targetUser.roleAssignments = targetUser.roleAssignments.filter(
      (a) => a._id?.toString() !== assignmentId,
    );
    await targetUser.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'role_assignment.revoked',
      siteId: assignment.scopeType === 'SITE' ? assignment.siteId : undefined,
      targetType: 'User',
      targetId: targetUser._id,
      metadata: {
        roleId: assignment.roleId.toString(),
        scopeType: assignment.scopeType,
        siteId: assignment.siteId?.toString(),
      },
    });
  }

  /**
   * Does `targetUserId` currently see a Visitor's live typing preview on
   * `siteId`? Read via actual effective permissions (`hasPermission`), not
   * by checking for the specific auto-provisioned grant Role below —
   * honest even if the User holds `visitors.view_live_activity` some other
   * way (e.g. they're the Owner).
   */
  async getLiveActivityAccess(
    actor: AuthenticatedUser,
    siteId: string,
    targetUserId: string,
  ): Promise<{ enabled: boolean }> {
    const targetUser = await this.userModel
      .findOne({ _id: targetUserId, organizationId: actor.organizationId })
      .exec();
    if (!targetUser) {
      throw new NotFoundException('User not found in this Organization.');
    }
    const enabled = await this.permissionsService.hasPermission(
      targetUserId,
      LIVE_ACTIVITY_PERMISSION,
      siteId,
    );
    return { enabled };
  }

  /**
   * Backs the Admin Panel's "let this User see a Visitor's live typing
   * preview (before it's sent)" toggle, on the same User edit form as
   * everything else. Added because there was previously NO way to grant
   * `visitors.view_live_activity` at all short of hand-crafting a Role
   * through the raw API — no seeded Role carries it (deliberate, see the
   * permission catalog entry) and there's no general Roles-management
   * screen yet (Session 12, still unbuilt). Rather than block on that
   * whole screen, this automates the "find-or-create a Role holding
   * exactly this one permission, then grant/revoke it" mechanics behind a
   * single boolean — still just a Role + a Role Assignment underneath
   * (`findOrCreateLiveActivityGrantRole` below), not a parallel
   * access-control path.
   *
   * `PermissionGuard`/the controller only proves the caller holds
   * `users.manage` on this Site (the same permission that unlocks the User
   * edit form this toggle lives on) — that says nothing about whether the
   * caller may hand out THIS specific, more sensitive permission. So this
   * method separately re-enforces FR-RBAC-09(a) itself: the actor must
   * already hold `visitors.view_live_activity` on this Site before they
   * can extend it to anyone else. This is exactly why the feature reads as
   * "must already be enabled for Owner/whoever granted it to you" — once
   * an Owner grants it to a Manager, that Manager can then grant it onward
   * too, the same chain every other Role Assignment in this system follows.
   */
  async setLiveActivityAccess(
    actor: AuthenticatedUser,
    siteId: string,
    targetUserId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    const actorHasIt = await this.permissionsService.hasPermission(
      actor.userId,
      LIVE_ACTIVITY_PERMISSION,
      siteId,
    );
    if (!actorHasIt) {
      throw new ForbiddenException(
        'You cannot grant "view live typing before it is sent" to someone else because you do not hold visitors.view_live_activity yourself on this Site.',
      );
    }

    const site = await this.siteModel
      .findOne({ _id: siteId, organizationId: actor.organizationId })
      .exec();
    if (!site) {
      throw new NotFoundException('Site not found in this Organization.');
    }
    const targetUser = await this.userModel
      .findOne({ _id: targetUserId, organizationId: actor.organizationId })
      .exec();
    if (!targetUser) {
      throw new NotFoundException('User not found in this Organization.');
    }

    const grantRole = await this.findOrCreateLiveActivityGrantRole(
      actor.organizationId,
    );

    const existingIndex = targetUser.roleAssignments.findIndex(
      (a) =>
        a.roleId.toString() === grantRole._id.toString() &&
        a.scopeType === 'SITE' &&
        a.siteId?.toString() === siteId,
    );

    if (enabled && existingIndex === -1) {
      targetUser.roleAssignments.push({
        roleId: grantRole._id,
        scopeType: 'SITE',
        siteId: site._id,
        createdByUserId: new Types.ObjectId(actor.userId),
      } as RoleAssignment);
      await targetUser.save();
      await this.auditLogService.record({
        actorType: 'user',
        actorId: actor.userId,
        action: 'role_assignment.created',
        siteId: site._id,
        targetType: 'User',
        targetId: targetUser._id,
        metadata: {
          roleId: grantRole._id.toString(),
          roleName: grantRole.name,
          scopeType: 'SITE',
          siteId,
          reason: 'live_activity_access_toggle',
        },
      });
    } else if (!enabled && existingIndex !== -1) {
      targetUser.roleAssignments.splice(existingIndex, 1);
      await targetUser.save();
      await this.auditLogService.record({
        actorType: 'user',
        actorId: actor.userId,
        action: 'role_assignment.revoked',
        siteId: site._id,
        targetType: 'User',
        targetId: targetUser._id,
        metadata: {
          roleId: grantRole._id.toString(),
          scopeType: 'SITE',
          siteId,
          reason: 'live_activity_access_toggle',
        },
      });
    }

    // Re-derive from actual effective permissions rather than echoing back
    // `enabled` verbatim — the target User could already hold this
    // permission via some OTHER Role (most notably: they're the Owner),
    // in which case toggling "off" this one grant Role doesn't actually
    // take the capability away, and the UI should be told that honestly.
    const nowEnabled = await this.permissionsService.hasPermission(
      targetUserId,
      LIVE_ACTIVITY_PERMISSION,
      siteId,
    );
    return { enabled: nowEnabled };
  }

  /**
   * Finds (or creates, once per Organization) the auto-managed Role
   * `setLiveActivityAccess` assigns/revokes — identified by the dedicated
   * `isLiveActivityGrant` marker (see `role.schema.ts`), not by name, so
   * renaming it later can't break the lookup.
   */
  private async findOrCreateLiveActivityGrantRole(
    organizationId: string,
  ): Promise<RoleDocument> {
    let role = await this.roleModel
      .findOne({ organizationId, isLiveActivityGrant: true })
      .exec();
    if (!role) {
      role = await this.roleModel.create({
        organizationId,
        name: 'Live Typing Preview Access',
        description:
          'Auto-managed by the Admin Panel\'s "view live typing before it is sent" toggle on a User\'s edit form. Grants exactly visitors.view_live_activity — do not assign this Role manually elsewhere.',
        isSystemDefault: true,
        isLiveActivityGrant: true,
        permissions: [LIVE_ACTIVITY_PERMISSION],
      });
    }
    return role;
  }
}
