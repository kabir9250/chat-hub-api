import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Agent-side message send, REST-only for now. Real-time delivery
 * (FR-MSG-01–06) is explicitly Session 8 — this exists purely so a
 * Conversation's transcript can be populated/tested via REST this session,
 * per the task's own scope note. `senderId` is never a body field — always
 * the calling Agent (`CurrentUser`), so a caller can't post a message
 * "as" someone else.
 */
export class CreateMessageDto {
  @ApiProperty({ example: 'Thanks for reaching out — how can I help?' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
