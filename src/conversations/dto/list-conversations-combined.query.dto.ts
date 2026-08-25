import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { ListConversationsQueryDto } from './list-conversations.query.dto';

/**
 * FR-P2-SITE-01–04 — `GET /conversations` (Phase 2's combined/"All Sites"
 * mode). Extends the exact same filter set the single-Site
 * `ListConversationsQueryDto` already supports (status/date range/agentId/
 * rating/tag/search/page/limit) — Session 10.2's own note ("the Inbox and
 * History share one type and one API call") extends naturally to combined
 * mode: one endpoint, one filter set, for both the Inbox's and History's
 * "All Sites" views.
 *
 * `combined` itself carries no information the route doesn't already imply
 * (this endpoint IS the combined-mode endpoint — there is no per-Site path
 * segment to fall back to) — it exists purely so a caller states its intent
 * explicitly in the query string, per the task's "accept an optional
 * combined query mode" wording. Omitted or `"true"` proceeds normally;
 * `"false"` is rejected (400) pointing the caller at the single-Site route
 * instead, rather than silently ignoring an explicit opt-out.
 */
export class ListConversationsCombinedQueryDto extends ListConversationsQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'true',
    description:
      'Must be omitted or "true" — this endpoint is combined-mode-only. ' +
      'Use GET /sites/:siteId/conversations for a single Site.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  combined?: string;
}
