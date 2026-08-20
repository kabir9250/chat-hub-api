import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Identity/profile fields only (FR-USR-02). Role Assignments are edited via
 * `/role-assignments` (FR-RBAC-05, Session 3), not here — keeps "who can
 * grant access" (`role_assignments.manage`, org-wide) separate from "who can
 * edit an account's profile on a Site" (`users.manage`, Site-scoped).
 * `departmentId` must belong to the route's :siteId — validated in
 * UsersService. To *unassign* a department, use
 * `DELETE /sites/:siteId/departments/:departmentId/agents/:userId` instead.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Jane D.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ example: 'Jane Elizabeth Doe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @ApiPropertyOptional({ example: 'jane.doe@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'support@example.com' })
  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439021',
    description: "Must be a Department on the route's :siteId.",
  })
  @IsOptional()
  @IsMongoId()
  departmentId?: string;
}
