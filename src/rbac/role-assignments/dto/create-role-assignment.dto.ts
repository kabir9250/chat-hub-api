import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional } from 'class-validator';

import { ROLE_ASSIGNMENT_SCOPE_TYPES } from '../../../database/schemas/user.schema';
import type { RoleAssignmentScopeType } from '../../../database/schemas/user.schema';

export class CreateRoleAssignmentDto {
  @ApiProperty({
    example: '507f1f77bcf86cd799439012',
    description: 'User _id to grant the Role to.',
  })
  @IsMongoId()
  userId!: string;

  @ApiProperty({
    example: '507f1f77bcf86cd799439013',
    description: 'Role _id (see GET /roles).',
  })
  @IsMongoId()
  roleId!: string;

  @ApiProperty({
    example: 'SITE',
    enum: ROLE_ASSIGNMENT_SCOPE_TYPES,
    description:
      '"ORGANIZATION" grants the Role everywhere; "SITE" scopes it to one Site (siteId required).',
  })
  @IsIn(ROLE_ASSIGNMENT_SCOPE_TYPES)
  scopeType!: RoleAssignmentScopeType;

  // Required only when scopeType === 'SITE' — checked in the service (a
  // plain @ValidateIf would need to reach across fields; the service's
  // Mongoose-level pre-validate hook on RoleAssignment enforces this too).
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    description:
      'Required when scopeType is SITE; omit when scopeType is ORGANIZATION.',
  })
  @IsOptional()
  @IsMongoId()
  siteId?: string;
}
