import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIP, IsOptional } from 'class-validator';

export class BanVisitorDto {
  @ApiPropertyOptional({
    example: '203.0.113.5',
    description:
      "Optional IP to ban instead of the Visitor's last known `currentIp` " +
      '(e.g. an IP found via server logs that differs from what was captured).',
  })
  @IsOptional()
  @IsIP()
  ip?: string;
}
