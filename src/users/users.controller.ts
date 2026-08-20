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

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetUserEnabledDto } from './dto/set-user-enabled.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const USER_ID_PARAM = { name: 'userId', example: '507f1f77bcf86cd799439012' };

/**
 * FR-USR-01/02/03/05/06. `:siteId` drives `PermissionGuard`'s Site-scoped
 * check (default `siteSource: 'param'`, field `siteId`) — a User whose
 * `users.manage`/`users.view` is Site-scoped (e.g. Supervisor) can only
 * reach this controller for the Site(s) they hold it on; an
 * ORGANIZATION-scoped holder (e.g. Owner) can reach it for any Site.
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/users')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({
    summary: 'List Users on a Site (users.view)',
    description:
      'Returns { items, counts: { total, enabled }, summary: "N enabled / M agents" }.',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiQuery({
    name: 'departmentId',
    required: false,
    example: '507f1f77bcf86cd799439021',
  })
  @Get()
  @RequirePermission('users.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.usersService.findAll(user, siteId, departmentId);
  }

  @ApiOperation({
    summary:
      'Create a User on a Site, with their first Role Assignment (users.manage)',
    description:
      'FR-USR-03: every new User must get an initial Role Assignment in this same call — ' +
      'a User with none has zero access.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Post()
  @RequirePermission('users.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: CreateUserDto,
  ) {
    return this.usersService.create(user, siteId, dto);
  }

  @ApiOperation({ summary: "Edit a User's profile fields (users.manage)" })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Patch(':userId')
  @RequirePermission('users.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(user, siteId, userId, dto);
  }

  @ApiOperation({ summary: 'Enable or disable a User (users.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Patch(':userId/enabled')
  @RequirePermission('users.manage')
  setEnabled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
    @Body() dto: SetUserEnabledDto,
  ) {
    return this.usersService.setEnabled(user, siteId, userId, dto.enabled);
  }

  @ApiOperation({ summary: 'Delete a User (users.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(USER_ID_PARAM)
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('users.manage')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
  ) {
    await this.usersService.remove(user, siteId, userId);
  }
}
