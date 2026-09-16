import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

/** Direct user request — assign a browsing Visitor (no Conversation yet) to
 * a specific Agent, gated by `conversations.assign` same as
 * `AssignConversationDto`. See `ConversationsService.assignVisitorToAgent`. */
export class AssignVisitorDto {
  @ApiProperty({
    example: '507f1f77bcf86cd799439033',
    description: 'The Visitor to assign — must be on this Site, not banned.',
  })
  @IsMongoId()
  visitorId!: string;

  @ApiProperty({
    example: '507f1f77bcf86cd799439040',
    description:
      "A User id — must have access to this Conversation's Site (an " +
      'Organization-scoped or matching Site-scoped Role Assignment).',
  })
  @IsMongoId()
  agentId!: string;
}
