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
import { SoundNotificationsService } from './sound-notifications.service';
import { UpdateSoundNotificationSettingsDto } from './dto/update-sound-notification-settings.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * Site-scoped Sound & Notification settings — shared by every Agent/Admin
 * viewing this Site (not the per-user `/users/me/notification-preferences`).
 * Editing is admin-only (`sound_notifications.manage`). The GET route's
 * gate is deliberately wider than the PATCH's — any Agent who already holds
 * ordinary inbox access to a Site (`conversations.view_own`/`.view_site`,
 * the same keys `AgentSessionContext`'s `inboxSiteIds` is derived from)
 * can also read this Site's settings, because `useDesktopNotifications`
 * needs to know what sound to actually play for events on that Site even
 * though that Agent can't change the setting. Reuses `RequirePermission`'s
 * existing ANY-of-array mechanism (already proven by the
 * `conversations.view_own`/`.view_site` pair) — no new guard needed.
 */
@ApiTags('Sound & Notifications')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/sound-notifications')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SoundNotificationsController {
  constructor(
    private readonly soundNotificationsService: SoundNotificationsService,
  ) {}

  @ApiOperation({
    summary:
      "Get a Site's Sound & Notification settings (any inbox access to the Site, or sound_notifications.view/.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission([
    'sound_notifications.view',
    'sound_notifications.manage',
    'conversations.view_own',
    'conversations.view_site',
  ])
  get(@CurrentUser() user: AuthenticatedUser, @Param('siteId') siteId: string) {
    return this.soundNotificationsService.get(user, siteId);
  }

  @ApiOperation({
    summary: "Update a Site's Sound & Notification settings (sound_notifications.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Patch()
  @RequirePermission('sound_notifications.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: UpdateSoundNotificationSettingsDto,
  ) {
    return this.soundNotificationsService.update(user, siteId, dto);
  }

  @ApiOperation({
    summary:
      "Get the caller's effective Sound & Notification settings on this Site — their own personal override if they hold sound_notifications.view/.manage, else the Site default",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('effective')
  @RequirePermission([
    'sound_notifications.view',
    'sound_notifications.manage',
    'conversations.view_own',
    'conversations.view_site',
  ])
  getEffective(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.soundNotificationsService.getEffective(user, siteId);
  }
}
