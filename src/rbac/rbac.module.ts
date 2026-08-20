import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../database/schemas/user.schema';
import { Role, RoleSchema } from '../database/schemas/role.schema';
import { Site, SiteSchema } from '../database/schemas/site.schema';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PermissionsService } from './permissions.service';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionsCatalogController } from './permissions-catalog.controller';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { RoleAssignmentsController } from './role-assignments/role-assignments.controller';
import { RoleAssignmentsService } from './role-assignments/role-assignments.service';
import { LiveActivityAccessController } from './role-assignments/live-activity-access.controller';
// RbacSmokeTestController (Session 3's throwaway PermissionGuard usage
// example) removed this hardening session — every real Site-scoped module
// it was standing in for now exists (Conversations, Analytics, etc.), so it
// was pure unused surface area. See PROGRESS.md.

/**
 * RbacModule — Session 3 (FR-RBAC-01..09, FR-AUTH-04/06, §6.3).
 *
 * Exports `PermissionsService` and `PermissionGuard` so ANY later feature
 * module (Sites/Departments/Agents, Conversations, Widget Config,
 * Triggers, Analytics, …) can do:
 *
 *   imports: [RbacModule]
 *   ...
 *   @UseGuards(JwtAuthGuard, PermissionGuard)
 *   @RequirePermission('conversations.assign')
 *
 * without redefining any permission logic. See PROGRESS.md ("Session 3")
 * for the full guard/decorator contract.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
  ],
  controllers: [
    PermissionsCatalogController,
    RolesController,
    RoleAssignmentsController,
    LiveActivityAccessController,
  ],
  providers: [
    PermissionsService,
    PermissionGuard,
    RolesService,
    RoleAssignmentsService,
  ],
  exports: [PermissionsService, PermissionGuard],
})
export class RbacModule {}
