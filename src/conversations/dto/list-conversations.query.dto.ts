import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  CONVERSATION_STATUSES,
  CONVERSATION_SUBMISSION_CHANNELS,
} from '../../database/schemas/conversation.schema';
import type {
  ConversationStatus,
  ConversationSubmissionChannel,
} from '../../database/schemas/conversation.schema';

/**
 * FR-AGT-09 / FR-CONV-06. All filters optional; pagination defaults to
 * page 1 / 20 per page. `agentId` is only honored when the caller's
 * effective scope is `conversations.view_site` — a `view_own`-only caller
 * is always implicitly filtered to themselves regardless of this field
 * (enforced in ConversationsService, not here — this DTO just shapes input).
 */
export class ListConversationsQueryDto {
  @ApiPropertyOptional({ enum: CONVERSATION_STATUSES })
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: ConversationStatus;

  @ApiPropertyOptional({
    enum: CONVERSATION_SUBMISSION_CHANNELS,
    description:
      "Filter by submissionChannel — 'offline' narrows to Conversations that " +
      'came in while no Agent was online/within Business Hours (the ' +
      "Admin Panel's pending-pill dropdown uses this, combined with " +
      'status=pending, to show only genuinely-missed chats — see ' +
      'PendingMenu.tsx).',
  })
  @IsOptional()
  @IsIn(CONVERSATION_SUBMISSION_CHANNELS)
  channel?: ConversationSubmissionChannel;

  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Inclusive lower bound on startedAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Inclusive upper bound on startedAt (ISO date/datetime).',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439040',
    description: 'Filter by assigned Agent (User) id.',
  })
  @IsOptional()
  @IsMongoId()
  agentId?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439033',
    description:
      "Phase 2, FR-P2-HIST-01 (Session P2-5) — filter to one Visitor's " +
      'Conversations, most-recent-first (the default sort already applied by ' +
      'this endpoint) — the "Past chats" drill-down reuses this list endpoint ' +
      'rather than a dedicated route, since the scoping (view_own/.view_site), ' +
      'pagination, and sort it needs already exist here unchanged.',
  })
  @IsOptional()
  @IsMongoId()
  visitorId?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439060',
    description:
      'Session P2-5 redesign — narrows to Conversations that started strictly ' +
      "before THIS Conversation's own startedAt (resolved server-side from its " +
      'own record). Combined with `visitorId` above, this is the "Past chats" ' +
      "drill-down's real scoping: only chats before the one currently open, " +
      'not every other chat this Visitor ever had.',
  })
  @IsOptional()
  @IsMongoId()
  beforeConversationId?: string;

  @ApiPropertyOptional({
    example: 5,
    minimum: 1,
    maximum: 5,
    description: 'Exact ratingScore match.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ example: 'billing' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tag?: string;

  @ApiPropertyOptional({
    example: 'jane',
    // T-11 Test 4 fix (Session Fix-05, PROGRESS.md) — was a substring
    // (anywhere-in-string) match pre-fix; now a "starts with" prefix match
    // so the query can use the Visitor.nameLower/emailLower indexes. See
    // ConversationsService.findMatchingVisitorIds's own doc comment.
    description:
      'Prefix ("starts with") search over the Visitor\'s name/email, case-insensitive.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

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
