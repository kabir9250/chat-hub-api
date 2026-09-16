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
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  FORM_FIELD_TYPES,
  LAUNCHER_STYLES,
} from '../../database/schemas/widget-config.schema';

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
 * "LIVE / CHAT"-style badge launcher's editable sub-fields (this session's
 * addition), embedded on WidgetConfig (`widget-config.schema.ts`'s
 * `WidgetLauncherBadge`). Partial-update, same as the parent DTO. Only
 * applied when `launcherStyle` is (or is being set to) `'badge'`, but
 * accepted regardless so an admin can pre-configure the badge's colors
 * before switching the style over.
 */
export class UpdateWidgetLauncherBadgeDto {
  @ApiPropertyOptional({ example: 'LIVE' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  topText?: string;

  @ApiPropertyOptional({ example: 'CHAT' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  bottomText?: string;

  @ApiPropertyOptional({ example: '#f01e3c' })
  @IsOptional()
  @IsHexColor()
  iconColor?: string;

  @ApiPropertyOptional({ example: '#0a0a0a' })
  @IsOptional()
  @IsHexColor()
  backgroundColor?: string;

  @ApiPropertyOptional({ example: '#f01e3c' })
  @IsOptional()
  @IsHexColor()
  topTextColor?: string;

  @ApiPropertyOptional({ example: '#ffffff' })
  @IsOptional()
  @IsHexColor()
  bottomTextColor?: string;
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

  @ApiPropertyOptional({ example: 'round', enum: LAUNCHER_STYLES })
  @IsOptional()
  @IsIn(LAUNCHER_STYLES)
  launcherStyle?: (typeof LAUNCHER_STYLES)[number];

  @ApiPropertyOptional({ type: UpdateWidgetLauncherBadgeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateWidgetLauncherBadgeDto)
  launcherBadge?: UpdateWidgetLauncherBadgeDto;

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

  @ApiPropertyOptional({
    example: true,
    description:
      'Phase 2 §3.9 — on/off for both the Widget and Agent Console attach controls on this Site.',
  })
  @IsOptional()
  @IsBoolean()
  attachmentsEnabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Phase 2 §3.12 (FR-P2-FORM-01) — when false, the Widget skips the pre-chat form entirely and lets the Visitor message immediately.',
  })
  @IsOptional()
  @IsBoolean()
  preChatFormEnabled?: boolean;

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

  @ApiPropertyOptional({
    example: false,
    description:
      '"Web Widget security" tab — Blocked countries whole-feature on/off switch.',
  })
  @IsOptional()
  @IsBoolean()
  blockedCountriesEnabled?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['PK', 'IN'],
    description:
      'ISO 3166-1 alpha-2 country codes chat is blocked from, while blockedCountriesEnabled is true.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  @Matches(/^[A-Za-z]{2}$/, {
    each: true,
    message: 'Each blocked country must be a 2-letter ISO 3166-1 alpha-2 code.',
  })
  blockedCountries?: string[];
}
