import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly permissionsService: PermissionsService,
  ) {}

  // FR-AUTH-01: email + password login, returns a JWT access token.
  @ApiOperation({
    summary: 'Log in with email + password',
    description:
      'Start here. Copy `accessToken` from the response, then click the "Authorize" ' +
      'button (top right) and paste it in to unlock every other endpoint in this doc.',
  })
  // §6.3 "Rate limiting on ... login attempts" — 5 attempts per IP per
  // minute. Deliberately tighter than the app-wide default (120/min,
  // AppModule) since credential-stuffing/brute-force is the specific risk
  // here, not casual API traffic. Keyed by IP (ThrottlerGuard's default),
  // not by the attempted email — an attacker enumerating many emails from
  // one IP is still capped; per-account lockout is a separate, not-yet-built
  // concern (see SECURITY.md).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // FR-AUTH-06: returns the authenticated User's identity plus their
  // effective permission set per Site they have any access to (Session 3
  // — see PermissionsService.getEffectivePermissionsSummary). This is a UX
  // convenience for the frontend to render/hide features — §6.3 is explicit
  // that it is NOT the actual security boundary; every real check still
  // goes through PermissionGuard server-side on the endpoint itself.
  @ApiOperation({
    summary: 'Get my identity + effective permissions',
    description:
      'Also a quick way to find real Site ids to use elsewhere: the keys of ' +
      '`sitePermissions` in the response are Site _ids this account can reach.',
  })
  @ApiBearerAuth('access-token')
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    const { organizationPermissions, sitePermissions, siteNames } =
      await this.permissionsService.getEffectivePermissionsSummary(user.userId);
    return { ...user, organizationPermissions, sitePermissions, siteNames };
  }
}
