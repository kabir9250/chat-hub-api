import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../storage/attachment-validation';

/**
 * Phase 2 §3.9 (FR-P2-ATT-01/02/06/07) — what a client sends back to
 * reference a file it already uploaded via
 * POST .../attachments(/mine) a moment earlier. NOT the file itself (this
 * is JSON, not multipart) — key/fileName/fileType/fileSizeBytes only, all
 * of which `ConversationsService.resolveAttachmentRefs` re-validates
 * (ownership prefix + existence) before persisting.
 */
export class AttachmentRefDto {
  @ApiProperty({ example: '68f1.../68f2.../3c9e...-a1b2.png' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ example: 'screenshot.png' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'image/png' })
  @IsString()
  @IsNotEmpty()
  fileType!: string;

  @ApiProperty({ example: 48213 })
  @IsInt()
  @Min(1)
  fileSizeBytes!: number;
}

/**
 * Agent-side message send, REST-only for now. Real-time delivery
 * (FR-MSG-01–06) is Session 8 — this exists purely so a Conversation's
 * transcript can be populated/tested via REST, per that session's own
 * scope note. `senderId` is never a body field — always the calling Agent
 * (`CurrentUser`), so a caller can't post a message "as" someone else.
 *
 * Phase 2 §3.9 (FR-P2-ATT-07): `body` is now optional — an attachment-only
 * message is valid. "At least one of body/attachments" is enforced in
 * `ConversationsService` (shared with the WebSocket send path), not here —
 * a DTO-level cross-field check would only cover this REST route, and the
 * WebSocket gateway's `agent:send_message`/`visitor:send_message` handlers
 * take a raw payload, never this DTO.
 */
export class CreateMessageDto {
  @ApiPropertyOptional({ example: 'Thanks for reaching out — how can I help?' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body?: string;

  @ApiPropertyOptional({ type: [AttachmentRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS_PER_MESSAGE)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];
}
