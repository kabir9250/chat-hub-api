import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * FR-P2-SITE-01–04 — `GET /visitors` (Phase 2's combined/"All Sites" mode).
 * `banned` mirrors `VisitorsController.findAll`'s existing manual
 * true/false query-string handling (no boolean-query-coercion convention
 * exists elsewhere in this codebase — see that controller). `page`/`limit`
 * are new here (the single-Site `GET /sites/:siteId/visitors` has no
 * pagination at all — see `VisitorsService.findAllCombined`'s doc comment
 * for why the merged/combined case needs it and the single-Site one, out of
 * this task's scope, is left as-is).
 */
export class ListVisitorsCombinedQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  banned?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'true',
    description:
      'Must be omitted or "true" — this endpoint is combined-mode-only. ' +
      'Use GET /sites/:siteId/visitors for a single Site.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  combined?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
