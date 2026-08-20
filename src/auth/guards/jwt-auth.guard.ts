import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Proves WHO the caller is (a valid, enabled, logged-in User) — nothing
 * about WHAT they're allowed to do. Just applies the 'jwt' Passport
 * strategy registered in AuthModule (JwtStrategy). Attaches the
 * AuthenticatedUser to `req.user` on success.
 *
 * No permission/role checks live here on purpose — Session 3 builds a
 * separate PermissionGuard (FR-RBAC-07) on top of this.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
