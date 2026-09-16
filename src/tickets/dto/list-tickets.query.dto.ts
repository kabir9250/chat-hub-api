import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { CONVERSATION_SUBMISSION_CHANNELS } from '../../database/schemas';
import type { ConversationSubmissionChannel } from '../../database/schemas';
import { DateRangeQueryDto } from '../../analytics/dto/date-range.query.dto';

/** Tickets screen — Online/Offline tab + the same date-range filter shape
 * every other reportable list in this app already uses (FR-RPT-02/03/04/05). */
export class ListTicketsQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ enum: CONVERSATION_SUBMISSION_CHANNELS })
  @IsOptional()
  @IsIn(CONVERSATION_SUBMISSION_CHANNELS)
  channel?: ConversationSubmissionChannel;
}
