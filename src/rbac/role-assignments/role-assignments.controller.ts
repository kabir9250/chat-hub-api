import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../guards/permission.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { RoleAssignmentsService } from './role-assignments.service';
import { CreateRoleAssignmentDto } from './dto/create-role-assignment.dto';

/**
 * FR-RBAC-05/08/09. Role Assignments carry their own Site scope in the
 * request body/schema, but WHO may create/revoke one is itself an
 * Organization-wide capability (`role_assignments.manage`) — a User either
 * has that org-wide or they don't manage assignments at all (Phase 1 has
 * no Site-scoped delegation of this permission in the seeded data), so
 * every route here uses `{ siteSource: 'none' }`.
 */
@ApiTags('Role Assignments')
@ApiBearerAuth('access-token')
@Controller('role-assignments')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RoleAssignmentsController {
  constructor(
    private readonly roleAssignmentsService: RoleAssignmentsService,
  ) {}

  @ApiOperation({
    summary: "List a User's Role Assignments (role_assignments.manage)",
  })
  @ApiQuery({ name: 'userId', example: '507f1f77bcf86cd799439012' })
  @Get()
  @RequirePermission('role_assignments.manage', { siteSource: 'none' })
  findAllForUser(
    @CurrentUser() user: AuthenticatedUser,
    @Query('userId') userId: string,
  ) {
    return this.roleAssignmentsService.findAllForUser(
      user.organizationId,
      userId,
    );
  }

  @ApiOperation({
    summary: 'Grant a Role Assignment to a User (role_assignments.manage)',
  })
  @Post()
  @RequirePermission('role_assignments.manage', { siteSource: 'none' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRoleAssignmentDto,
  ) {
    return this.roleAssignmentsService.create(user, dto);
  }

  @ApiOperation({
    summary: 'Revoke a Role Assignment (role_assignments.manage)',
    description:
      '403 if this would remove the last Organization-scoped role_assignments.manage holder.',
  })
  @ApiParam({ name: 'userId', example: '507f1f77bcf86cd799439012' })
  @ApiParam({ name: 'assignmentId', example: '507f1f77bcf86cd799439099' })
  @Delete(':userId/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('role_assignments.manage', { siteSource: 'none' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    await this.roleAssignmentsService.revoke(user, userId, assignmentId);
  }
}
