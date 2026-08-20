import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** FR-USR-01/06 — enable/disable is its own endpoint (not folded into the
 * general edit) so it gets its own clear audit-log action. */
export class SetUserEnabledDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
