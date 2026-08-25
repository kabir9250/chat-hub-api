import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

/**
 * `GET /sites/:siteId/visitors/:visitorId/visits` (Phase 2, FR-P2-HIST-02,
 * Session P2-5) — "Past visits" drill-down. Same page/limit defaults as
 * every other paginated list in this codebase (`ListConversationsQueryDto`,
 * `ListVisitorsCombinedQueryDto`).
 */
export class ListVisitsQueryDto {
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439060',
    description:
      'Session P2-5 redesign — scopes this to visit sessions strictly ' +
      "before the Conversation this popover is opened from (see " +
      'VisitorsService.findVisits\'s own doc comment for the exact ' +
      'boundary), so a Conversation only ever shows the visit history ' +
      "that actually predates it, never its own \"Visitor path\" data " +
      'again.',
  })
  @IsOptional()
  @IsMongoId()
  beforeConversationId?: string;

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
