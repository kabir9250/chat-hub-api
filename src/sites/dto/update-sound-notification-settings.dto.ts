import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { SOUND_IDS } from '../../database/schemas';
import type { SoundId } from '../../database/schemas';

/**
 * Site-wide DEFAULT for the 4 desktop-popup toggles — mirrors the per-user
 * `UpdateNotificationPreferencesDto`'s own 4 top-level booleans. Nested
 * under its own DTO (not flattened) for the same reason the schema nests
 * `SiteNotificationToggles` — `chatRequest` needs to exist as both a
 * boolean here and a distinct sound-event object on the parent DTO.
 */
export class UpdateSiteNotificationTogglesDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  chatRequest?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  newMessages?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  statusChanges?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  sessionExpiry?: boolean;
}

/**
 * FR-CFG — site-scoped Sound & Notification settings (`Site.soundNotificationSettings`).
 * Same two-level "each field independently patchable" contract as the
 * per-user `UpdateNotificationPreferencesDto`/`UpdateNotificationSoundsDto`
 * (`users/dto/update-notification-preferences.dto.ts`) — mirrored here
 * rather than imported since it's a distinct resource (Site, not User).
 */
export class UpdateSiteSoundSettingDto {
  @ApiPropertyOptional({ enum: SOUND_IDS })
  @IsOptional()
  @IsIn(SOUND_IDS)
  soundId?: SoundId;

  @ApiPropertyOptional({ example: 70, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  volume?: number;
}

export class UpdateSiteChatRequestSoundSettingDto extends UpdateSiteSoundSettingDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  repeatCount?: number;
}

export class UpdateSoundNotificationSettingsDto {
  @ApiPropertyOptional({ type: UpdateSiteNotificationTogglesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteNotificationTogglesDto)
  notifications?: UpdateSiteNotificationTogglesDto;

  @ApiPropertyOptional({ type: UpdateSiteSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteSoundSettingDto)
  incomingVisitor?: UpdateSiteSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSiteChatRequestSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteChatRequestSoundSettingDto)
  chatRequest?: UpdateSiteChatRequestSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSiteSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteSoundSettingDto)
  incomingMessage?: UpdateSiteSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSiteSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteSoundSettingDto)
  automaticStatusChange?: UpdateSiteSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSiteSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteSoundSettingDto)
  triggerActivated?: UpdateSiteSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSiteSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSiteSoundSettingDto)
  operatingHoursStartEnd?: UpdateSiteSoundSettingDto;
}
