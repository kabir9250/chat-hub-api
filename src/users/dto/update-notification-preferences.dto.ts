import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Phase 2, SRS §2.1 / §3.8 FR-P2-NOTIF-05 — `PATCH
 * /users/me/notification-preferences`. Both fields optional/independent so
 * the frontend's two settings toggles (desktop / sound) can each PATCH just
 * the one flag it owns without clobbering the other — mirrors
 * `UpdateUserDto`'s partial-update shape.
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  desktopEnabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;
}
