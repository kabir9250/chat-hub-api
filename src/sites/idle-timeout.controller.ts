import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import { IdleTimeoutService } from './idle-timeout.service';
import { UpdateSiteIdleTimeoutSettingsDto } from './dto/update-idle-timeout-settings.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * Site-scoped Idle Timeout default — applied to every Agent/Admin on this
 * Site who has no personal override permission (`idle_timeout.view`/
 * `.manage`) or hasn't been granted one (not the per-user
 * `/users/me/idle-timeout-settings`). Editing is admin-only
 * (`idle_timeout.manage`). The GET route's gate is deliberately wider than
 * the PATCH's — any Agent who already holds ordinary inbox access to a Site
 * can also read the effective default, same precedent as
 * `SoundNotificationsController`.
 */
@ApiTags('Idle Timeout')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/idle-timeout')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IdleTimeoutController {
  constructor(private readonly idleTimeoutService: IdleTimeoutService) {}

  @ApiOperation({
    summary:
      "Get a Site's Idle Timeout default (any inbox access to the Site, or idle_timeout.view/.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission([
    'idle_timeout.view',
    'idle_timeout.manage',
    'conversations.view_own',
    'conversations.view_site',
  ])
  get(@CurrentUser() user: AuthenticatedUser, @Param('siteId') siteId: string) {
    return this.idleTimeoutService.get(user, siteId);
  }

  @ApiOperation({
    summary: "Update a Site's Idle Timeout default (idle_timeout.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Patch()
  @RequirePermission('idle_timeout.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: UpdateSiteIdleTimeoutSettingsDto,
  ) {
    return this.idleTimeoutService.update(user, siteId, dto);
  }

  @ApiOperation({
    summary:
      "Get the caller's effective Idle Timeout setting on this Site — their own personal override if they hold idle_timeout.view/.manage, else the Site default",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('effective')
  @RequirePermission([
    'idle_timeout.view',
    'idle_timeout.manage',
    'conversations.view_own',
    'conversations.view_site',
  ])
  getEffective(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.idleTimeoutService.getEffective(user, siteId);
  }
}
