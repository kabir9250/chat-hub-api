import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

export const CHART_GRANULARITIES = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
] as const;
export type ChartGranularity = (typeof CHART_GRANULARITIES)[number];

/**
 * FR-RPT-01 — the Home dashboard chart. `metrics` (page views/total
 * visits/unique visitors/chats) are deliberately NOT filterable server-side
 * — the backend always returns all 4 series per bucket, and "each metric
 * independently show/hide-able" (the SRS's own wording) is a client-side
 * checkbox-legend concern, per the task's "keep chart implementation
 * simple" guardrail.
 */
export class AnalyticsChartQueryDto {
  @ApiPropertyOptional({ enum: CHART_GRANULARITIES, default: 'daily' })
  @IsOptional()
  @IsIn(CHART_GRANULARITIES)
  granularity?: ChartGranularity;

  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Inclusive lower bound on occurredAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Inclusive upper bound on occurredAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
