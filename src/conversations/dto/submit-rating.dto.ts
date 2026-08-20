import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * FR-WID-13 / FR-CONV-07. Fully public (no `Authorization` at all needed —
 * see the controller) — a Visitor submitting a satisfaction rating after
 * their chat closes has no User/Visitor-token identity requirement of its
 * own beyond "knows the Conversation's id," matching FR-WID-13's widget
 * flow. `ConversationsService.submitRating` is what does the real
 * validation: the id must resolve to a real, `closed` Conversation.
 */
export class SubmitRatingDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  ratingScore!: number;

  @ApiPropertyOptional({ example: 'Agent was fast and helpful, thanks!' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ratingComment?: string;
}
