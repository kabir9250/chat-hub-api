import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

/** FR-AGT-06, gated by `conversations.assign`. */
export class AssignConversationDto {
  @ApiProperty({
    example: '507f1f77bcf86cd799439040',
    description:
      "A User id — must have access to this Conversation's Site (an " +
      'Organization-scoped or matching Site-scoped Role Assignment).',
  })
  @IsMongoId()
  agentId!: string;
}
