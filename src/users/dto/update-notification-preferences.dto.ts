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
 * Session Feature-1b-backend (SRS "12-zendesk-feature-parity" §1.2) —
 * restructured from the old flat `{desktopEnabled?, soundEnabled?}` into
 * the same two-section shape as `NotificationPreferences` itself
 * (`notifications`/`sounds`), so `PATCH /users/me/notification-preferences`
 * can still patch just one field deep inside either section without
 * clobbering the rest — every level is optional, mirroring the old DTO's
 * "each flag/field independently patchable" contract.
 */
export class UpdateSoundSettingDto {
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

export class UpdateChatRequestSoundSettingDto extends UpdateSoundSettingDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  repeatCount?: number;
}

export class UpdateNotificationSoundsDto {
  @ApiPropertyOptional({ type: UpdateSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSoundSettingDto)
  incomingVisitor?: UpdateSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateChatRequestSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateChatRequestSoundSettingDto)
  chatRequest?: UpdateChatRequestSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSoundSettingDto)
  incomingMessage?: UpdateSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSoundSettingDto)
  automaticStatusChange?: UpdateSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSoundSettingDto)
  triggerActivated?: UpdateSoundSettingDto;

  @ApiPropertyOptional({ type: UpdateSoundSettingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSoundSettingDto)
  operatingHoursStartEnd?: UpdateSoundSettingDto;
}

export class UpdateNotificationPreferencesDto {
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

  @ApiPropertyOptional({ type: UpdateNotificationSoundsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateNotificationSoundsDto)
  sounds?: UpdateNotificationSoundsDto;
}
