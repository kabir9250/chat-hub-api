import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetLiveActivityAccessDto {
  @ApiProperty({
    example: true,
    description:
      "Whether this User should see a Visitor's live typing preview (before it is sent) on this Site.",
  })
  @IsBoolean()
  enabled!: boolean;
}
