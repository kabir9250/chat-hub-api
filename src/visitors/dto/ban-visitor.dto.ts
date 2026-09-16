import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIP, IsOptional, IsString, MaxLength } from 'class-validator';

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

  @ApiPropertyOptional({
    example: 'Spam / abusive language',
    description:
      "Free-text reason, shown in the Banned Visitors screen's Reason " +
      "column. The Agent Console UI (VisitorInfoPanel's Ban modal) requires " +
      'this client-side, but it stays optional here — same posture as ' +
      "BanIpDto's own `reason` — so an older caller/existing e2e test " +
      'posting an empty body keeps working unchanged.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
