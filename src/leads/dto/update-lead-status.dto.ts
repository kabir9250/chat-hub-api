import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { LEAD_STATUSES } from '../../database/schemas';
import type { LeadStatus } from '../../database/schemas';

export class UpdateLeadStatusDto {
  @ApiProperty({
    example: 'contacted',
    enum: LEAD_STATUSES,
    description: 'FR-VIS-08 — one of: new, contacted, converted, lost.',
  })
  @IsIn(LEAD_STATUSES)
  status!: LeadStatus;
}
