import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { FORM_FIELD_TYPES } from '../../database/schemas/widget-config.schema';

/**
 * FR-CFG-01's Concierge sub-fields, embedded on WidgetConfig
 * (`widget-config.schema.ts`'s `WidgetConcierge`). Partial-update, same as
 * the parent DTO — only fields present are applied.
 */
export class UpdateWidgetConciergeDto {
  @ApiPropertyOptional({ example: 'Live Support' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string;

  @ApiPropertyOptional({ example: 'Ask us anything' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  byline?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.png' })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;
}

/**
 * One field on either the pre-chat or offline form (Forms builder, this
 * session's addition). The whole array is replaced wholesale on save (not
 * a per-field patch) — same "send the full list back" contract the admin
 * UI's field editor naturally produces, simplest way to support
 * add/remove/reorder in one request.
 */
export class UpdateFormFieldDto {
  @ApiPropertyOptional({ example: 'name' })
  @IsString()
  @MaxLength(80)
  id!: string;

  @ApiPropertyOptional({ example: 'Name' })
  @IsString()
  @MaxLength(150)
  label!: string;

  @ApiPropertyOptional({ example: 'text', enum: FORM_FIELD_TYPES })
  @IsIn(FORM_FIELD_TYPES)
  type!: (typeof FORM_FIELD_TYPES)[number];

  @IsBoolean()
  required!: boolean;

  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  order!: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  options?: string[];

  @IsBoolean()
  builtin!: boolean;
}

/**
 * FR-CFG-01/02. Every field optional — a PATCH-style partial update, same
 * pattern as `UpdateBusinessHoursDto` (Session 4). `widget_config.manage`
 * gates both the branding fields (FR-CFG-01) and the boolean toggles
 * (FR-CFG-02) — the permission catalog has one `.manage` key covering both,
 * so one DTO/endpoint pair is enough.
 */
export class UpdateWidgetConfigDto {
  @ApiPropertyOptional({ example: 'support' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  topTitle?: string;

  @ApiPropertyOptional({ type: UpdateWidgetConciergeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateWidgetConciergeDto)
  concierge?: UpdateWidgetConciergeDto;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/icon.png' })
  @IsOptional()
  @IsUrl()
  iconUrl?: string;

  @ApiPropertyOptional({ example: '#1E88E5' })
  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @ApiPropertyOptional({ example: 'modern' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  messageStyle?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  notificationSoundEnabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  satisfactionRatingsEnabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  offlineFormEnabled?: boolean;

  @ApiPropertyOptional({ type: [UpdateFormFieldDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => UpdateFormFieldDto)
  preChatFormFields?: UpdateFormFieldDto[];

  @ApiPropertyOptional({ type: [UpdateFormFieldDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => UpdateFormFieldDto)
  offlineFormFields?: UpdateFormFieldDto[];
}
