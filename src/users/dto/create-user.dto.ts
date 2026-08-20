import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ROLE_ASSIGNMENT_SCOPE_TYPES } from '../../database/schemas/user.schema';
import type { RoleAssignmentScopeType } from '../../database/schemas/user.schema';

/**
 * FR-USR-03: a User with no Role Assignment has zero access. So a User
 * cannot be created without one — this is required, not optional, on the
 * create DTO. Deliberately has no `siteId` field of its own: when
 * `scopeType` is `SITE`, the Site is always the one in the route
 * (`POST /sites/:siteId/users`) that `PermissionGuard` already checked
 * `users.manage` against — letting the body name a *different* Site would
 * let the guard's check be bypassed. See UsersService for the
 * `scopeType: 'ORGANIZATION'` escalation guard.
 */
export class InitialRoleAssignmentDto {
  @ApiProperty({
    example: '507f1f77bcf86cd799439013',
    description:
      'A Role _id (see GET /roles) — e.g. the seeded "Agent" or "Supervisor" Role.',
  })
  @IsMongoId()
  roleId!: string;

  @ApiProperty({
    example: 'SITE',
    enum: ROLE_ASSIGNMENT_SCOPE_TYPES,
    description:
      '"SITE" grants access only on the route\'s :siteId. "ORGANIZATION" grants access everywhere ' +
      'and requires the caller to already hold users.manage Organization-wide.',
  })
  @IsIn(ROLE_ASSIGNMENT_SCOPE_TYPES)
  scopeType!: RoleAssignmentScopeType;
}

export class CreateUserDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;

  @ApiProperty({ example: 'Jane Elizabeth Doe' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @ApiProperty({ example: 'jane.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    example: 'support@example.com',
    description: 'Shown to visitors instead of the login email.',
  })
  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @ApiProperty({ example: 'TempPassw0rd!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  // Must belong to the route's :siteId — validated in UsersService.
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439021',
    description:
      "Must be a Department on the route's :siteId (see GET /sites/:siteId/departments).",
  })
  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ type: InitialRoleAssignmentDto })
  @ValidateNested()
  @Type(() => InitialRoleAssignmentDto)
  initialRoleAssignment!: InitialRoleAssignmentDto;
}
