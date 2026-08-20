import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { CONVERSATION_STATUSES } from '../../database/schemas/conversation.schema';
import type { ConversationStatus } from '../../database/schemas/conversation.schema';

/** FR-CONV-02 / FR-AGT-07, gated by `conversations.close`. */
export class UpdateConversationStatusDto {
  @ApiProperty({ example: 'closed', enum: CONVERSATION_STATUSES })
  @IsIn(CONVERSATION_STATUSES)
  status!: ConversationStatus;
}
