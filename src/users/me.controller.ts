import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UsersService } from './users.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

/**
 * Self-service "my own account" endpoints — deliberately a separate
 * controller from `UsersController` (`sites/:siteId/users`, `users.manage`-
 * gated) rather than another route on it: everything here acts on the
 * CALLER's own User document with no `:siteId`/`:userId` route params and no
 * `PermissionGuard`/`@RequirePermission` at all — just `JwtAuthGuard`,
 * mirroring `AuthController`'s own `GET /auth/me` (identity) pattern for
 * "authenticated is the only requirement" endpoints.
 *
 * Phase 2, SRS §2.1 / §3.8 FR-P2-NOTIF-05 / §5.1.
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({
    summary: "Update the caller's own desktop-notification / sound preferences",
    description:
      'Self-service — any authenticated User may update their own ' +
      'notificationPreferences, no permission beyond being logged in. Both ' +
      'fields are optional/independent (FR-P2-NOTIF-05 — toggle desktop and ' +
      'sound separately).',
  })
  @Patch('notification-preferences')
  updateNotificationPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.usersService.updateNotificationPreferences(user, dto);
  }
}
