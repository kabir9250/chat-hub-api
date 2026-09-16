import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
