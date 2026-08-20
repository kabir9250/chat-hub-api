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

import { CONVERSATION_STATUSES } from '../../database/schemas/conversation.schema';
import type { ConversationStatus } from '../../database/schemas/conversation.schema';

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
    description: "Substring search over the Visitor's name/email.",
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
