import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

export const PAGE_VISIT_GROUP_BY = ['category', 'page'] as const;
export type PageVisitGroupBy = (typeof PAGE_VISIT_GROUP_BY)[number];

/** FR-RPT-08 — time-per-page/page-category. All filters optional. */
export class PageVisitStatsQueryDto {
  @ApiPropertyOptional({
    enum: PAGE_VISIT_GROUP_BY,
    default: 'category',
    description:
      "'category' groups by PageVisit.pageCategory (the derived rule — see " +
      "page-category.util.ts); 'page' groups by the exact pageUrl.",
  })
  @IsOptional()
  @IsIn(PAGE_VISIT_GROUP_BY)
  groupBy?: PageVisitGroupBy;

  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Inclusive lower bound on enteredAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Inclusive upper bound on enteredAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
