import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsOptional } from 'class-validator';

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

  // T-08 Finding #1 fix (files/reports/T-08-concurrency.md) — the caller's
  // own belief about who currently holds this Conversation, used server-side
  // as a compare-and-swap's expected-previous-value (see
  // ConversationsService.assign()). Omit/`null` to mean "I believe this is
  // currently unassigned" (a first claim); pass the current Agent's id for
  // a reassignment. Deliberately NOT defaulted to "whatever the server
  // already has" — an absent value means the caller is claiming an
  // unassigned Conversation, so a stale/omitted value fails safe into a 409
  // rather than silently overwriting a real assignment.
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439041',
    nullable: true,
    description:
      'The Agent id the caller believes currently holds this Conversation, ' +
      'or omitted/null for "I believe this is unassigned." Used as an ' +
      'atomic compare-and-swap guard — a mismatch (someone else claimed or ' +
      'reassigned it first) returns 409, not a silent overwrite.',
  })
  @IsOptional()
  @IsMongoId()
  expectedCurrentAgentId?: string | null;
}
