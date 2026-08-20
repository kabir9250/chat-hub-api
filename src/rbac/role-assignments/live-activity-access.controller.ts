import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../guards/permission.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { RoleAssignmentsService } from './role-assignments.service';
import { SetLiveActivityAccessDto } from './dto/set-live-activity-access.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const USER_ID_PARAM = { name: 'userId', example: '507f1f77bcf86cd799439012' };

/**
 * A small, purpose-built shortcut so an Owner/Manager can grant or revoke
 * `visitors.view_live_activity` for one User on one Site directly from the
 * same User edit form used for everything else — without first needing a
 * general Roles-management screen (Session 12, still unbuilt) to hand-craft
 * a Role that carries exactly this one permission.
 *
 * Reachability is gated by `users.manage` on this Site — the same
 * permission that unlocks the User edit form this toggle lives on.
 * `RoleAssignmentsService.setLiveActivityAccess` separately re-enforces the
 * actual FR-RBAC-09(a) escalation rule (the caller must already hold
 * `visitors.view_live_activity` themselves before granting it to someone
 * else) — `users.manage` alone says nothing about that more sensitive
 * permission, so PermissionGuard here is reachability only, not the real
 * security boundary.
 */
@ApiTags('Role Assignments')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/users/:userId/live-activity-access')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LiveActivityAccessController {
  constructor(
    private readonly roleAssignmentsService: RoleAssignmentsService,
  ) {}

  @ApiOperation({
    summary:
      "Does this User currently see a Visitor's live typing preview on this Site? (users.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Get()
  @RequirePermission('users.manage')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
  ) {
    return this.roleAssignmentsService.getLiveActivityAccess(
      user,
      siteId,
      userId,
    );
  }

  @ApiOperation({
    summary:
      "Grant/revoke this User's ability to see a Visitor's live typing preview on this Site",
    description:
      'Requires users.manage (reachability) AND that the caller already holds ' +
      'visitors.view_live_activity themselves on this Site (403 otherwise) — ' +
      'you cannot hand out a permission you do not hold.',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Patch()
  @RequirePermission('users.manage')
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
    @Body() dto: SetLiveActivityAccessDto,
  ) {
    return this.roleAssignmentsService.setLiveActivityAccess(
      user,
      siteId,
      userId,
      dto.enabled,
    );
  }
}
