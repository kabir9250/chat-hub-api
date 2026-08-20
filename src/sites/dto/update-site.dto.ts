import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `sites.manage`. Partial update, same PATCH-style contract as
 * `UpdateBusinessHoursDto`/`UpdateWidgetConfigDto` — only fields present
 * are applied. See `SitesService.update` for the `chatEnabled` +
 * `domains` interaction this session adds.
 */
export class UpdateSiteDto {
  @ApiPropertyOptional({ example: 'Brand Site 5' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['example.com'],
    description:
      "The Site's URL(s) — replaces the full list wholesale (not a " +
      'per-entry patch). An empty array is valid UNLESS `chatEnabled` is ' +
      '(or is already) `true`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  domains?: string[];

  @ApiPropertyOptional({ example: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Rejected with 400 when set (or left) `true` while the Site has no ' +
      'URL in `domains` — add one first.',
  })
  @IsOptional()
  @IsBoolean()
  chatEnabled?: boolean;

  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}
