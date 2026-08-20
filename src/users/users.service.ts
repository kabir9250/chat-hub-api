import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';

import { User, UserDocument } from '../database/schemas/user.schema';
import { Role, RoleDocument } from '../database/schemas/role.schema';
import {
  Department,
  DepartmentDocument,
} from '../database/schemas/department.schema';
import { Site, SiteDocument } from '../database/schemas/site.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export interface UserListResult {
  items: UserDocument[];
  counts: { total: number; enabled: number };
  /** FR-USR-05's literal "3 enabled / 3 agents" format, pre-formatted for convenience. */
  summary: string;
}

/**
 * UsersService — FR-USR-01/02/03/05/06.
 *
 * `PermissionGuard` (via `users.manage`/`users.view`, checked against the
 * route's `:siteId`) already decides WHETHER the caller can reach these
 * endpoints for that Site. This service additionally enforces:
 *   - a created User always gets an initial Role Assignment (FR-USR-03 —
 *     no User may exist with zero access);
 *   - edit/enable-disable/delete only ever touch a User who actually has
 *     access to the target Site (an Organization-scoped Role Assignment,
 *     or a Site-scoped one for this Site) — so a Site-scoped `users.manage`
 *     holder can't (accidentally or otherwise) reach into an unrelated
 *     User who merely shares the Organization;
 *   - granting an ORGANIZATION-scoped Role Assignment on create requires
 *     the actor to hold `users.manage` Organization-wide themselves — a
 *     Site-scoped Supervisor cannot use "create a user" as a side door to
 *     grant org-wide access they don't have (mirrors the FR-RBAC-09(a)
 *     escalation guard's spirit from Session 3's Roles/RoleAssignments).
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId?: string,
  ): Promise<UserListResult> {
    const site = await this.assertSite(actor, siteId);

    const filter: FilterQuery<UserDocument> = {
      organizationId: actor.organizationId,
      $or: [
        { roleAssignments: { $elemMatch: { scopeType: 'ORGANIZATION' } } },
        {
          roleAssignments: {
            $elemMatch: { scopeType: 'SITE', siteId: site._id },
          },
        },
      ],
    };

    if (departmentId) {
      const department = await this.departmentModel
        .findOne({ _id: departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      filter.departmentId = department._id;
    }

    const items = await this.userModel
      .find(filter)
      .sort({ displayName: 1 })
      .exec();
    const total = items.length;
    const enabled = items.filter((u) => u.enabled).length;

    return {
      items,
      counts: { total, enabled },
      summary: `${enabled} enabled / ${total} agents`,
    };
  }

  async create(
    actor: AuthenticatedUser,
    siteId: string,
    dto: CreateUserDto,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);

    const role = await this.roleModel
      .findOne({
        _id: dto.initialRoleAssignment.roleId,
        organizationId: actor.organizationId,
      })
      .exec();
    if (!role) {
      throw new NotFoundException('Role not found in this Organization.');
    }

    if (dto.initialRoleAssignment.scopeType === 'ORGANIZATION') {
      const actorHasOrgWide = await this.permissionsService.hasPermission(
        actor.userId,
        'users.manage',
        null,
      );
      if (!actorHasOrgWide) {
        throw new ForbiddenException(
          'Only a User holding users.manage Organization-wide can grant an Organization-scoped Role Assignment.',
        );
      }
    }

    let departmentId: Types.ObjectId | undefined;
    if (dto.departmentId) {
      const department = await this.departmentModel
        .findOne({ _id: dto.departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      departmentId = department._id;
    }

    let user: UserDocument;
    try {
      user = await this.userModel.create({
        organizationId: actor.organizationId,
        displayName: dto.displayName.trim(),
        fullName: dto.fullName.trim(),
        email: dto.email.trim().toLowerCase(),
        supportEmail: dto.supportEmail?.trim().toLowerCase(),
        // Hardening session: bumped bcrypt cost 10 -> 12 (OWASP's current
        // recommended floor is 10; 12 costs a few hundred extra ms per
        // login/create on bcryptjs's pure-JS implementation, negligible at
        // this app's scale). Existing hashes at cost 10 remain valid —
        // bcrypt encodes its own cost in the hash, `bcrypt.compare` reads it
        // back out, so no migration is needed for already-seeded accounts.
        passwordHash: bcrypt.hashSync(dto.password, 12),
        departmentId: departmentId ?? null,
        enabled: dto.enabled ?? true,
        roleAssignments: [
          {
            roleId: role._id,
            scopeType: dto.initialRoleAssignment.scopeType,
            siteId:
              dto.initialRoleAssignment.scopeType === 'SITE'
                ? site._id
                : undefined,
            createdByUserId: new Types.ObjectId(actor.userId),
          },
        ],
      });
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw err;
    }

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.created',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: {
        email: user.email,
        roleId: role._id.toString(),
        roleName: role.name,
        scopeType: dto.initialRoleAssignment.scopeType,
        departmentId: departmentId?.toString(),
      },
    });

    return user;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
    dto: UpdateUserDto,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    const before = {
      displayName: user.displayName,
      fullName: user.fullName,
      email: user.email,
      supportEmail: user.supportEmail,
      departmentId: user.departmentId?.toString() ?? null,
    };

    if (dto.displayName !== undefined)
      user.displayName = dto.displayName.trim();
    if (dto.fullName !== undefined) user.fullName = dto.fullName.trim();
    if (dto.email !== undefined) user.email = dto.email.trim().toLowerCase();
    if (dto.supportEmail !== undefined)
      user.supportEmail = dto.supportEmail.trim().toLowerCase();
    if (dto.departmentId !== undefined) {
      const department = await this.departmentModel
        .findOne({ _id: dto.departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      user.departmentId = department._id;
    }

    try {
      await user.save();
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw err;
    }

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.updated',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: {
        before,
        after: {
          displayName: user.displayName,
          fullName: user.fullName,
          email: user.email,
          supportEmail: user.supportEmail,
          departmentId: user.departmentId?.toString() ?? null,
        },
      },
    });

    return user;
  }

  async setEnabled(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
    enabled: boolean,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    user.enabled = enabled;
    await user.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: enabled ? 'user.enabled' : 'user.disabled',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
    });

    return user;
  }

  async remove(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
  ): Promise<void> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    await user.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.deleted',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: { email: user.email },
    });
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

  /**
   * Fetches `userId` and confirms they actually have access to `site` (an
   * ORGANIZATION-scoped assignment, or a SITE-scoped one for this Site) —
   * the same boundary `PermissionsService` uses to compute effective
   * permissions. Without this, a Site-scoped `users.manage` holder could
   * edit/disable/delete any User in the Organization just by knowing their
   * id, regardless of Site.
   */
  private async findUserOnSite(
    actor: AuthenticatedUser,
    site: SiteDocument,
    userId: string,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({ _id: userId, organizationId: actor.organizationId })
      .exec();
    if (!user || !this.userBelongsToSite(user, site._id.toString())) {
      throw new NotFoundException('User not found on this Site.');
    }
    return user;
  }

  private userBelongsToSite(user: UserDocument, siteId: string): boolean {
    return (user.roleAssignments ?? []).some(
      (a) =>
        a.scopeType === 'ORGANIZATION' ||
        (a.scopeType === 'SITE' && a.siteId?.toString() === siteId),
    );
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    );
  }
}
