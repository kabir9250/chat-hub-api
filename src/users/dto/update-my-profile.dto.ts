import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Personal Settings → Profile (this session, SRS "12-zendesk-feature-parity"
 * §1.1) — `PATCH /users/me/profile`. Self-service, no permission beyond
 * being logged in (same precedent as `UpdateNotificationPreferencesDto`) —
 * deliberately NOT `UpdateUserDto` reused: that one is the Admin-editing-
 * ANOTHER-user flow (FR-USR-01, `users.manage`-gated) and carries fields
 * (`departmentId`, `fullName`, `supportEmail`) this self-service flow has no
 * business touching, plus this one adds fields `UpdateUserDto` doesn't have
 * at all (tagline/preferredLanguage/chatLimit/skills/keyboardShortcutsEnabled).
 * Every field optional/independent, same partial-PATCH shape as every other
 * self-service settings DTO in this file. `email`/`password`/RBAC fields are
 * deliberately absent here — those go through `UpdateMyAccountDto` instead
 * (task guardrail: this self-service edit never touches RBAC, and keeping
 * "identity/security" fields on a separate endpoint from "display/
 * preferences" fields matches how the reference Zendesk screen itself splits
 * "Edit profile" from the rest of the page).
 */
export class UpdateMyProfileDto {
  @ApiPropertyOptional({ example: 'Jane D.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ example: 'Sr. Support Agent' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tagline?: string;

  // No hardcoded language enum — task guardrail: stored-preference only,
  // never validated against/used to drive actual UI translation.
  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  preferredLanguage?: string;

  // `null` explicitly clears the limit ("Chat limit is not enabled") —
  // distinct from `undefined` (field omitted, left unchanged). See
  // UsersService.updateProfile for how the two are told apart.
  @ApiPropertyOptional({ example: 3, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  chatLimit?: number | null;

  // Data-only (task guardrail — no skill-based routing match logic reads
  // this yet). Capped at 5 to mirror the reference screen's own "Assign up
  // to 5 skills per agent" copy — not validated against any master list.
  @ApiPropertyOptional({ type: [String], example: ['Billing', 'Spanish'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  skills?: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  keyboardShortcutsEnabled?: boolean;
}
