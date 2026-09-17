import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import { LoginAttemptService } from './login-attempt.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly permissionsService: PermissionsService,
    private readonly loginAttemptService: LoginAttemptService,
  ) {}

  // FR-AUTH-01: email + password login, returns a JWT access token.
  @ApiOperation({
    summary: 'Log in with email + password',
    description:
      'Start here. Copy `accessToken` from the response, then click the "Authorize" ' +
      'button (top right) and paste it in to unlock every other endpoint in this doc.',
  })
  // §6.3 "Rate limiting on ... login attempts" — brute-force protection,
  // keyed by IP (not by the attempted email — an attacker enumerating many
  // emails from one IP is still capped; per-account lockout is a separate,
  // not-yet-built concern, see SECURITY.md), counting only FAILED attempts
  // (Session Fix-04, PROGRESS.md — `LoginAttemptService`). 5 wrong
  // passwords/unknown emails from the same IP within 60s locks that IP out
  // (429, friendly retry-after message) until the window clears; a
  // legitimate user who mistypes a password a couple of times before
  // getting it right is never penalized — a correct login is never
  // throttled and clears that IP's failure count entirely. This replaces
  // the old `@Throttle` here, which counted every attempt (right or
  // wrong) toward the same 5/60s cap. The app-wide default throttle
  // (AppModule, 120/min/IP) still applies underneath as a generic flood
  // guard, independent of this.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

    const lockoutSecondsRemaining =
      this.loginAttemptService.getLockoutSecondsRemaining(ip);
    if (lockoutSecondsRemaining !== null) {
      throw new HttpException(
        `Too many failed login attempts. Please try again in ${lockoutSecondsRemaining}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const result = await this.authService.login(dto.email, dto.password);
      this.loginAttemptService.recordSuccess(ip);
      return result;
    } catch (err) {
      this.loginAttemptService.recordFailure(ip);
      throw err;
    }
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
    const {
      organizationPermissions,
      sitePermissions,
      siteNames,
      siteDomains,
      siteStatuses,
    } = await this.permissionsService.getEffectivePermissionsSummary(
      user.userId,
    );
    return {
      ...user,
      organizationPermissions,
      sitePermissions,
      siteNames,
      siteDomains,
      siteStatuses,
    };
  }
}
