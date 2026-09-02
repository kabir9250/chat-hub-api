import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

/**
 * `GET /shortcuts/available?siteId=...` — FR-P2-SHORT-05's resolved
 * "visible to that Agent for the active Conversation's Site" set: own
 * Personal shortcuts + that Site's Site-level shortcuts + every
 * Organization-level shortcut. Backs the `:`-dropdown.
 */
export class AvailableShortcutsQueryDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsMongoId()
  siteId!: string;
}
