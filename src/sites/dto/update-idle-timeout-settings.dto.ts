import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Site-scoped Idle Timeout default (`Site.idleTimeoutSettings`). Same
 * per-field-optional contract as the per-user
 * `UpdateIdleTimeoutSettingsDto` (`users/dto/update-idle-timeout-settings.dto.ts`)
 * — mirrored here rather than imported since it's a distinct resource
 * (Site, not User).
 */
export class UpdateSiteIdleTimeoutSettingsDto {
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
