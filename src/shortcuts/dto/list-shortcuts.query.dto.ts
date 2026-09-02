import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional } from 'class-validator';

import { SHORTCUT_SCOPE_LEVELS } from '../../database/schemas/shortcut.schema';
import type { ShortcutScopeLevel } from '../../database/schemas/shortcut.schema';

/**
 * `GET /shortcuts` — the management-screen listing (FR-P2-SHORT-07/08:
 * "My Shortcuts" scoped to PERSONAL, the Admin Panel's Shortcuts screen
 * scoped to SITE/ORGANIZATION), NOT the merged "available to use" set —
 * that's `GET /shortcuts/available` (AvailableShortcutsQueryDto). One
 * `scopeLevel` per call, same as one Level tab per screen; `siteId` is
 * required only when `scopeLevel=SITE`.
 */
export class ListShortcutsQueryDto {
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
}
