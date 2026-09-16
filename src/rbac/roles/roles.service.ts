import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Role, RoleDocument } from '../../database/schemas/role.schema';
import { User, UserDocument } from '../../database/schemas/user.schema';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ALL_PERMISSION_KEYS, isPermissionKey } from '../permission.catalog';
import { PermissionsService } from '../permissions.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

/**
 * RolesService — FR-RBAC-03/04.
 *
 * Reachability (does the caller have `roles.manage` at all) is enforced by
 * `PermissionGuard` on the controller. The FR-RBAC-09(a) privilege-
 * escalation guard that used to live here — a `roles.manage` holder could
 * not put a permission into a Role's `permissions` array that they didn't
 * themselves currently hold — was removed by direct user request (a
 * pre-existing Owner account whose stored Role document predated new
 * catalog keys, e.g. `sound_notifications.*`, could not grant those keys
 * to itself). Any `roles.manage` holder can now grant any catalog
 * permission to any Role, including ones they don't hold themselves.
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string): Promise<RoleDocument[]> {
    return this.roleModel.find({ organizationId }).sort({ name: 1 }).exec();
  }

  async findOne(organizationId: string, roleId: string): Promise<RoleDocument> {
    const role = await this.roleModel
      .findOne({ _id: roleId, organizationId })
      .exec();
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    return role;
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateRoleDto,
  ): Promise<RoleDocument> {
    this.validateCatalogKeys(dto.permissions);

    const role = await this.roleModel.create({
      organizationId: actor.organizationId,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? '',
      isSystemDefault: false,
      permissions: [...new Set(dto.permissions)],
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'role.created',
      targetType: 'Role',
      targetId: role._id,
      metadata: { name: role.name, permissions: role.permissions },
    });

    return role;
  }

  async update(
    actor: AuthenticatedUser,
    roleId: string,
    dto: UpdateRoleDto,
  ): Promise<RoleDocument> {
    const role = await this.findOne(actor.organizationId, roleId);

    if (dto.permissions) {
      this.validateCatalogKeys(dto.permissions);

      // FR-RBAC-09(b): if this edit would remove `role_assignments.manage`
      // from a Role that currently grants it, make sure at least one
      // Organization-scoped holder of that permission would still remain.
      const removingRoleAssignmentsManage =
        role.permissions.includes('role_assignments.manage') &&
        !dto.permissions.includes('role_assignments.manage');
      if (removingRoleAssignmentsManage) {
        const wouldOrphan =
          await this.permissionsService.wouldOrphanOrganizationPermission(
            actor.organizationId,
            'role_assignments.manage',
            {
              simulateRole: {
                roleId: role._id.toString(),
                permissions: dto.permissions,
              },
            },
          );
        if (wouldOrphan) {
          throw new ForbiddenException(
            'This change would remove role_assignments.manage from the last Organization-scoped holder of it, locking the Organization out of role management.',
          );
        }
      }
    }

    const before = {
      name: role.name,
      description: role.description,
      permissions: role.permissions,
    };

    if (dto.name !== undefined) role.name = dto.name.trim();
    if (dto.description !== undefined)
      role.description = dto.description.trim();
    if (dto.permissions !== undefined)
      role.permissions = [...new Set(dto.permissions)];
    await role.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'role.updated',
      targetType: 'Role',
      targetId: role._id,
      metadata: {
        before,
        after: {
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        },
      },
    });

    return role;
  }

  async remove(actor: AuthenticatedUser, roleId: string): Promise<void> {
    const role = await this.findOne(actor.organizationId, roleId);

    const assigneeCount = await this.userModel.countDocuments({
      organizationId: actor.organizationId,
      'roleAssignments.roleId': role._id,
    });
    if (assigneeCount > 0) {
      throw new ConflictException(
        `Cannot delete Role "${role.name}": it is still assigned to ${assigneeCount} user(s). Revoke those Role Assignments first.`,
      );
    }

    await role.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: role._id,
      metadata: { name: role.name },
    });
  }

  private validateCatalogKeys(permissions: string[]): void {
    const invalid = permissions.filter((p) => !isPermissionKey(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown permission key(s): ${invalid.join(', ')}. Valid keys: ${ALL_PERMISSION_KEYS.join(', ')}`,
      );
    }
  }
}
