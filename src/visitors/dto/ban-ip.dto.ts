import { ApiProperty } from '@nestjs/swagger';
import { IsIP, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * "Add banned IP address" — the Banned Visitors screen's own creation flow
 * (Settings → Banned → Add visitor), direct user request. Distinct from
 * `BanVisitorDto` (which always starts from an already-known Visitor id):
 * this bans a raw IP with no Visitor behind it at all — the same "orphan
 * IP" row shape `VisitorsService.findBanned` already renders for a ban
 * whose IP override never matched any Visitor's own `currentIp`.
 */
export class BanIpDto {
  @ApiProperty({ example: '203.0.113.5' })
  @IsIP()
  ip!: string;

  /**
   * Mandatory — direct user follow-up request ("mark reason as mandatory
   * field on add visitor screen"). Enforced both client-side (Create ban
   * stays disabled until non-empty, `BannedVisitorsScreen.tsx`) and here —
   * unlike `BanVisitorDto.reason`, nothing pre-existing depends on this
   * endpoint accepting an empty/missing reason (it's new this app-session,
   * with no e2e coverage posting one), so there's no backward-compat reason
   * to keep it optional.
   */
  @ApiProperty({
    example: 'Abuse',
    description:
      "Required free-text reason, shown in the Banned Visitors table's Reason column.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
