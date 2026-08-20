import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { AppJwtPayload } from '../interfaces/jwt-payload.interface';

/** Shape attached to `req.visitor` once VisitorAuthGuard has verified the token. */
export interface AuthenticatedVisitor {
  visitorId: string;
  siteId: string;
}

interface VisitorRequest extends Request {
  visitor?: AuthenticatedVisitor;
}

/**
 * VisitorAuthGuard — the Visitor-token counterpart to `JwtAuthGuard`.
 *
 * Session 2/3 both noted this doesn't exist yet ("A Visitor-specific guard
 * ... wasn't built this session — out of scope — but would follow the
 * identical pattern"/"no WsJwtGuard exists yet"). Session 7 (Conversations)
 * is the first feature that actually needs one: starting a Conversation is
 * inherently a Visitor action (FR-RTE-01 — the widget/visitor starts the
 * chat), so it can't be gated by `JwtAuthGuard`+`PermissionGuard` (those are
 * for `type: 'user'` tokens only) or left fully public (unlike
 * `visitor-session/init` or `widget-bootstrap`, which have no identity to
 * check yet — creating a Conversation needs to know WHICH Visitor).
 *
 * Deliberately a plain `CanActivate`, not a second Passport strategy — the
 * verification is a two-line `jwtService.verify` + a `type` discriminator
 * check, identical in spirit to `JwtStrategy.validate()` but for the other
 * token kind. Attaches `req.visitor = { visitorId, siteId }` (mirrors
 * `req.user` from `JwtAuthGuard`) for a `@CurrentVisitor()` param decorator
 * to read.
 */
@Injectable()
export class VisitorAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<VisitorRequest>();
    const authHeader = request.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'A visitor session token is required (Authorization: Bearer <token> from POST /visitor-session/init).',
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();
    let payload: AppJwtPayload;
    try {
      payload = this.jwtService.verify<AppJwtPayload>(token);
    } catch {
      throw new UnauthorizedException(
        'Visitor session token is invalid or expired — call POST /visitor-session/init again.',
      );
    }

    if (payload.type !== 'visitor') {
      throw new UnauthorizedException(
        'This token is not a valid visitor session (a User login token cannot be used here).',
      );
    }

    request.visitor = { visitorId: payload.sub, siteId: payload.siteId };
    return true;
  }
}
