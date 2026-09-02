import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { SHORTCUT_SCOPE_LEVELS } from '../../database/schemas/shortcut.schema';
import type { ShortcutScopeLevel } from '../../database/schemas/shortcut.schema';

/**
 * FR-P2-SHORT-01–04. `scopeLevel` decides which `shortcuts.manage_*`
 * permission `ShortcutsService.assertCanManageScope` checks for — the
 * client may send any value here, but the server rejects one the caller
 * doesn't actually hold (FR-P2-SHORT-04's "computed from the current
 * user's own Shortcuts permissions" is enforced here, not just in a
 * future Level picker's UI). `siteId` is required if and only if
 * `scopeLevel === 'SITE'` — validated in the service (a conditional
 * requirement class-validator's decorators alone don't express cleanly),
 * same pattern `CreateTriggerDto`'s neighbors use for cross-field rules.
 */
export class CreateShortcutDto {
  @ApiProperty({ enum: SHORTCUT_SCOPE_LEVELS, example: 'PERSONAL' })
  @IsIn(SHORTCUT_SCOPE_LEVELS)
  scopeLevel!: ShortcutScopeLevel;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    description: 'Required only when scopeLevel is SITE.',
  })
  @IsOptional()
  @IsMongoId()
  siteId?: string;

  @ApiProperty({ example: 'thanks' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  shortcutKeyword!: string;

  @ApiProperty({ example: 'Thank the visitor for waiting' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  purpose!: string;

  @ApiProperty({ example: 'Thanks so much for your patience!' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}
