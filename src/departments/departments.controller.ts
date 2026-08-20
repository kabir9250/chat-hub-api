import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const DEPARTMENT_ID_PARAM = {
  name: 'departmentId',
  example: '507f1f77bcf86cd799439021',
};
const USER_ID_PARAM = { name: 'userId', example: '507f1f77bcf86cd799439012' };

/** FR-USR-04. `:siteId` drives PermissionGuard's Site-scoped check. */
@ApiTags('Departments')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/departments')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @ApiOperation({
    summary: 'List Departments on a Site (departments.view)',
    description: 'Each Department includes agentCounts: { total, enabled }.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('departments.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.departmentsService.findAll(user, siteId);
  }

  @ApiOperation({
    summary: 'Create a Department on a Site (departments.manage)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Post()
  @RequirePermission('departments.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: CreateDepartmentDto,
  ) {
    return this.departmentsService.create(user, siteId, dto);
  }

  @ApiOperation({ summary: 'Rename a Department (departments.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(DEPARTMENT_ID_PARAM)
  @Patch(':departmentId')
  @RequirePermission('departments.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('departmentId') departmentId: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departmentsService.update(user, siteId, departmentId, dto);
  }

  @ApiOperation({
    summary: 'Delete a Department (departments.manage)',
    description:
      '409 if any User is still assigned to it — reassign them first.',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(DEPARTMENT_ID_PARAM)
  @Delete(':departmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('departments.manage')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('departmentId') departmentId: string,
  ) {
    await this.departmentsService.remove(user, siteId, departmentId);
  }

  @ApiOperation({
    summary: 'Assign a User into this Department (departments.manage)',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(DEPARTMENT_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Post(':departmentId/agents/:userId')
  @RequirePermission('departments.manage')
  assignAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('departmentId') departmentId: string,
    @Param('userId') userId: string,
  ) {
    return this.departmentsService.assignAgent(
      user,
      siteId,
      departmentId,
      userId,
    );
  }

  @ApiOperation({
    summary: 'Unassign a User from this Department (departments.manage)',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(DEPARTMENT_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Delete(':departmentId/agents/:userId')
  @RequirePermission('departments.manage')
  unassignAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('departmentId') departmentId: string,
    @Param('userId') userId: string,
  ) {
    return this.departmentsService.unassignAgent(
      user,
      siteId,
      departmentId,
      userId,
    );
  }
}
