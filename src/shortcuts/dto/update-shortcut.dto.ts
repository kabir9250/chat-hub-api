import { ApiPropertyOptional } from '@nestjs/swagger';
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
 * FR-P2-SHORT-01–04. Partial update — same fields as CreateShortcutDto,
 * all optional. Omitting `scopeLevel`/`siteId` leaves the Shortcut's
 * current scope unchanged; supplying either re-runs the full
 * `assertCanManageScope` check against the NEW target scope (in addition
 * to the existing one), per `ShortcutsService.update`'s doc comment —
 * moving a Shortcut into a scope you don't hold the matching
 * `shortcuts.manage_*` permission for is rejected exactly like a create
 * would be (FR-P2-SHORT-04, server-side).
 */
export class UpdateShortcutDto {
  @ApiPropertyOptional({ enum: SHORTCUT_SCOPE_LEVELS, example: 'SITE' })
  @IsOptional()
  @IsIn(SHORTCUT_SCOPE_LEVELS)
  scopeLevel?: ShortcutScopeLevel;

  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011' })
  @IsOptional()
  @IsMongoId()
  siteId?: string;

  @ApiPropertyOptional({ example: 'thanks' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  shortcutKeyword?: string;

  @ApiPropertyOptional({ example: 'Thank the visitor for waiting' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  purpose?: string;

  @ApiPropertyOptional({ example: 'Thanks so much for your patience!' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message?: string;
}
