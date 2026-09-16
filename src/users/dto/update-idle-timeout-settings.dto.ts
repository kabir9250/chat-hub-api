import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Session Feature-1c-backend (SRS "12-zendesk-feature-parity" §1.3) —
 * `PATCH /users/me/idle-timeout-settings`. Every field optional/
 * independently patchable, same "each level of a self-service settings
 * blob can be updated alone" contract `UpdateNotificationPreferencesDto`
 * already established.
 */
export class UpdateIdleTimeoutSettingsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  ignoreIfChatting?: boolean;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 480 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480)
  inactivityMinutes?: number;

  @ApiPropertyOptional({ enum: ['away', 'invisible'] })
  @IsOptional()
  @IsIn(['away', 'invisible'])
  idleStatus?: 'away' | 'invisible';
}
