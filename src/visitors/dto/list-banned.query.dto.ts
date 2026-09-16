import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `GET /sites/:siteId/visitors/banned` (Feature-2a-backend) — the Banned
 * Visitors screen's list, now backed by `BannedEntry` rows directly instead
 * of the old merge-on-read (`Visitor.isBanned` scan + audit-log lookup).
 * `dateFrom`/`dateTo` reuse the same shared date-range shape
 * `DateRangeQueryDto` already defines for FR-RPT filters, inlined here
 * (rather than extending that class) since this endpoint also needs
 * `search` and Nest DTOs don't compose cleanly via multiple inheritance.
 */
export class ListBannedQueryDto {
  @ApiPropertyOptional({
    example: '203.0.113.5',
    description:
      'Free-text search over IP address, Visitor name/email, and reason ' +
      '(case-insensitive substring match).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
