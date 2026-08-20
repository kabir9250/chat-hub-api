import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

/**
 * FR-MSG-05 — reconnection resync: "fetch messages since last known message
 * ID/timestamp." Both fields optional and independent; `sinceMessageId` is
 * preferred when given (its own `sentAt` is looked up server-side so the
 * client never has to track timestamps itself), `sinceTimestamp` is the
 * fallback (e.g. the id was never received, or the client only persisted a
 * timestamp). Neither given returns the full transcript.
 */
export class GetMessagesSinceQueryDto {
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439099',
    description:
      'Return only messages strictly after this Message id (server resolves its sentAt).',
  })
  @IsOptional()
  @IsMongoId()
  sinceMessageId?: string;

  @ApiPropertyOptional({
    example: '2026-08-17T10:15:00.000Z',
    description:
      'Return only messages strictly after this ISO timestamp. Used when sinceMessageId is omitted or no longer resolves.',
  })
  @IsOptional()
  @IsDateString()
  sinceTimestamp?: string;
}
