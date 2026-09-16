import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Personal Settings → Profile → "Edit profile" (this session) —
 * `PATCH /users/me/account`. Separate endpoint from `UpdateMyProfileDto`
 * (see that file's doc comment for why) and separate from the Admin's
 * `UpdateUserDto`/`users.manage` flow (task guardrail — this one only ever
 * touches the CALLER's own record, no `:userId` route param, no
 * `PermissionGuard`). Never carries a Role Assignment or any other RBAC
 * field — this is identity/security only (displayName/email/password).
 *
 * `currentPassword` is required by `UsersService.updateAccount` whenever
 * `newPassword` is present (task requirement: "current-password confirmation
 * required for a password change") — enforced in the service, not here,
 * since it's a cross-field rule `class-validator` would need a custom
 * decorator for.
 */
export class UpdateMyAccountDto {
  @ApiPropertyOptional({ example: 'Jane D.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ example: 'jane.doe@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'NewPassw0rd!', minLength: 8 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword?: string;

  @ApiPropertyOptional({
    example: 'CurrentPassw0rd!',
    description: 'Required when newPassword is set — proves the caller actually knows the current password.',
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
