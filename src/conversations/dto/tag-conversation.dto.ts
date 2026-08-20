import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** FR-AGT-11, gated by `conversations.tag`. Used for both add and remove. */
export class TagConversationDto {
  @ApiProperty({ example: 'billing' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  tag!: string;
}
