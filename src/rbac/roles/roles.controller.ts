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

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../guards/permission.guard';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

/**
 * FR-RBAC-03/04/08/09(a). All Role mutation is Organization-wide (Roles
 * aren't Site-scoped objects themselves — Role *Assignments* are what
 * carries a Site scope) so every route here uses `{ siteSource: 'none' }`.
 */
@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @ApiOperation({ summary: "List this Organization's Roles (roles.view)" })
  @Get()
  @RequirePermission('roles.view', { siteSource: 'none' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.findAll(user.organizationId);
  }

  @ApiOperation({ summary: 'Get one Role by id (roles.view)' })
  @ApiParam({ name: 'id', example: '507f1f77bcf86cd799439013' })
  @Get(':id')
  @RequirePermission('roles.view', { siteSource: 'none' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.rolesService.findOne(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Create a Role (roles.manage)' })
  @Post()
  @RequirePermission('roles.manage', { siteSource: 'none' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoleDto) {
    return this.rolesService.create(user, dto);
  }

  @ApiOperation({ summary: 'Edit a Role (roles.manage)' })
  @ApiParam({ name: 'id', example: '507f1f77bcf86cd799439013' })
  @Patch(':id')
  @RequirePermission('roles.manage', { siteSource: 'none' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.update(user, id, dto);
  }

  @ApiOperation({
    summary: 'Delete a Role (roles.manage)',
    description:
      '409 if any User still holds this Role — revoke their Role Assignment(s) first.',
  })
  @ApiParam({ name: 'id', example: '507f1f77bcf86cd799439013' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('roles.manage', { siteSource: 'none' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.rolesService.remove(user, id);
  }
}
