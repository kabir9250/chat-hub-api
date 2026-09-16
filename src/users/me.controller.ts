import {
  Body,
  Controller,
  Delete,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UsersService } from './users.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { UpdateIdleTimeoutSettingsDto } from './dto/update-idle-timeout-settings.dto';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
import { UpdateMyAccountDto } from './dto/update-my-account.dto';
import { AVATAR_MAX_BYTES } from '../storage/attachment-validation';

const AVATAR_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES + 1024 }, // small buffer, same reasoning as UPLOAD_HARD_CAP_BYTES
};

/**
 * Self-service "my own account" endpoints — deliberately a separate
 * controller from `UsersController` (`sites/:siteId/users`, `users.manage`-
 * gated) rather than another route on it: everything here acts on the
 * CALLER's own User document with no `:siteId`/`:userId` route params and no
 * `PermissionGuard`/`@RequirePermission` at all — just `JwtAuthGuard`,
 * mirroring `AuthController`'s own `GET /auth/me` (identity) pattern for
 * "authenticated is the only requirement" endpoints.
 *
 * Phase 2, SRS §2.1 / §3.8 FR-P2-NOTIF-05 / §5.1. Personal Settings →
 * Profile additions this session (SRS "12-zendesk-feature-parity" §1.1) —
 * `profile`/`account`/`avatar` below — follow the exact same shape: no
 * permission beyond being logged in, never touches `roleAssignments` (task
 * guardrail: this can never self-escalate).
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

  @ApiOperation({
    summary: "Update the caller's own Idle Timeout settings",
    description:
      'Self-service — any authenticated User may update their own ' +
      'idleTimeoutSettings, no permission beyond being logged in. All ' +
      'fields optional/independent (SRS §1.3). The client-side inactivity ' +
      'timer (Agent Console) reads these to decide when to send ' +
      '`agent:presence.idle` over the socket; this REST endpoint only ' +
      'persists the settings themselves.',
  })
  @Patch('idle-timeout-settings')
  updateIdleTimeoutSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateIdleTimeoutSettingsDto,
  ) {
    return this.usersService.updateIdleTimeoutSettings(user, dto);
  }

  @ApiOperation({
    summary:
      "Update the caller's own Profile (display name, tagline, preferences)",
    description:
      'Self-service — any authenticated User may update their own displayName/' +
      'tagline/preferredLanguage/chatLimit/skills/keyboardShortcutsEnabled, no ' +
      'permission beyond being logged in. Never touches email/password (see ' +
      'PATCH .../account) or roleAssignments.',
  })
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyProfileDto,
  ) {
    return this.usersService.updateProfile(user, dto);
  }

  @ApiOperation({
    summary: "Update the caller's own login email / display name / password",
    description:
      'Self-service "Edit profile" flow — separate from the Admin\'s own ' +
      '"edit another user" endpoint (users.manage-gated); this one only ever ' +
      "touches the CALLER's own record. Changing the password requires " +
      'currentPassword to match first.',
  })
  @Patch('account')
  updateAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyAccountDto,
  ) {
    return this.usersService.updateAccount(user, dto);
  }

  @ApiOperation({
    summary: "Upload the caller's own avatar",
    description:
      'Reuses the same object-storage mechanism (StorageService) the chat-' +
      'attachment upload path uses — image only, 100KB max, matching the ' +
      "reference Zendesk screen's own helper text.",
  })
  @ApiConsumes('multipart/form-data')
  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', AVATAR_UPLOAD_OPTIONS))
  uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.usersService.uploadAvatar(user, file);
  }

  @ApiOperation({ summary: "Remove the caller's own avatar" })
  @Delete('avatar')
  removeAvatar(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.removeAvatar(user);
  }
}
