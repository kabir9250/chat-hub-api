import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Department,
  DepartmentDocument,
} from '../database/schemas/department.schema';
import { Site, SiteDocument } from '../database/schemas/site.schema';
import { User, UserDocument } from '../database/schemas/user.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

export interface DepartmentWithCounts {
  _id: unknown;
  siteId: unknown;
  name: string;
  createdAt: Date;
  agentCounts: { total: number; enabled: number };
}

/**
 * DepartmentsService — FR-USR-04. `PermissionGuard` (via
 * `departments.view`/`departments.manage`, checked against the route's
 * `:siteId`) decides reachability; this service enforces that every
 * Department it touches actually belongs to that Site (multi-tenant
 * boundary, SRS §4.2), and blocks deleting a Department that still has
 * Agents assigned (mirrors RolesService's assignment-count delete guard
 * from Session 3 — no cascading delete/reassignment).
 */
@Injectable()
export class DepartmentsService {
  constructor(
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<DepartmentWithCounts[]> {
    const site = await this.assertSite(actor, siteId);
    const departments = await this.departmentModel
      .find({ siteId: site._id })
      .sort({ name: 1 })
      .exec();

    const counts = await this.userModel.aggregate<{
      _id: unknown;
      total: number;
      enabled: number;
    }>([
      { $match: { departmentId: { $in: departments.map((d) => d._id) } } },
      {
        $group: {
          _id: '$departmentId',
          total: { $sum: 1 },
          enabled: { $sum: { $cond: ['$enabled', 1, 0] } },
        },
      },
    ]);
    const countsByDept = new Map(counts.map((c) => [c._id?.toString(), c]));

    return departments.map((d) => {
      const c = countsByDept.get(d._id.toString());
      return {
        _id: d._id,
        siteId: d.siteId,
        name: d.name,
        createdAt: d.createdAt,
        agentCounts: { total: c?.total ?? 0, enabled: c?.enabled ?? 0 },
      };
    });
  }

  async create(
    actor: AuthenticatedUser,
    siteId: string,
    dto: CreateDepartmentDto,
  ): Promise<DepartmentDocument> {
    const site = await this.assertSite(actor, siteId);
    const department = await this.departmentModel.create({
      siteId: site._id,
      name: dto.name.trim(),
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'department.created',
      siteId: site._id,
      targetType: 'Department',
      targetId: department._id,
      metadata: { name: department.name },
    });

    return department;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId: string,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentDocument> {
    const site = await this.assertSite(actor, siteId);
    const department = await this.findDepartmentOnSite(site, departmentId);

    const before = department.name;
    department.name = dto.name.trim();
    await department.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'department.updated',
      siteId: site._id,
      targetType: 'Department',
      targetId: department._id,
      metadata: { before, after: department.name },
    });

    return department;
  }

  async remove(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId: string,
  ): Promise<void> {
    const site = await this.assertSite(actor, siteId);
    const department = await this.findDepartmentOnSite(site, departmentId);

    const assigneeCount = await this.userModel.countDocuments({
      departmentId: department._id,
    });
    if (assigneeCount > 0) {
      throw new ConflictException(
        `Cannot delete Department "${department.name}": ${assigneeCount} user(s) still assigned. Reassign them first.`,
      );
    }

    await department.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'department.deleted',
      siteId: site._id,
      targetType: 'Department',
      targetId: department._id,
      metadata: { name: department.name },
    });
  }

  /** FR-USR-04's "assign Agents to a Department" half. */
  async assignAgent(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId: string,
    userId: string,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const department = await this.findDepartmentOnSite(site, departmentId);

    const user = await this.userModel
      .findOne({ _id: userId, organizationId: actor.organizationId })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    const belongsToSite = (user.roleAssignments ?? []).some(
      (a) =>
        a.scopeType === 'ORGANIZATION' ||
        (a.scopeType === 'SITE' &&
          a.siteId?.toString() === site._id.toString()),
    );
    if (!belongsToSite) {
      throw new BadRequestException(
        'User has no Role Assignment on this Site — cannot assign them to one of its Departments.',
      );
    }

    user.departmentId = department._id;
    await user.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'department.agent_assigned',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: { departmentId: department._id.toString() },
    });

    return user;
  }

  async unassignAgent(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId: string,
    userId: string,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const department = await this.findDepartmentOnSite(site, departmentId);

    const user = await this.userModel
      .findOne({
        _id: userId,
        organizationId: actor.organizationId,
        departmentId: department._id,
      })
      .exec();
    if (!user) {
      throw new NotFoundException('User not found in this Department.');
    }

    user.departmentId = null;
    await user.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'department.agent_unassigned',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: { departmentId: department._id.toString() },
    });

    return user;
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

  private async findDepartmentOnSite(
    site: SiteDocument,
    departmentId: string,
  ): Promise<DepartmentDocument> {
    const department = await this.departmentModel
      .findOne({ _id: departmentId, siteId: site._id })
      .exec();
    if (!department) {
      throw new NotFoundException('Department not found on this Site.');
    }
    return department;
  }
}
