import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../permissions.service';
import {
  PERMISSION_METADATA_KEY,
  RequirePermissionMetadata,
} from '../decorators/require-permission.decorator';

/** HTTP request as seen after JwtAuthGuard (`user`) and this guard (`effectivePermissions`) have run. */
interface RbacRequest extends Request {
  user?: AuthenticatedUser;
  effectivePermissions?: string[];
}

/** Minimal shape this guard needs from a WebSocket client — a future WsJwtGuard is expected to populate `data.user`. */
interface RbacSocketClient {
  data?: {
    user?: AuthenticatedUser;
    effectivePermissions?: string[];
  };
}

/**
 * PermissionGuard — FR-RBAC-07 / FR-AUTH-04 / §6.3.
 *
 * The one generic guard every protected route or WebSocket handler in this
 * codebase uses to enforce RBAC. Written once, reused everywhere — no
 * module should ever hand-roll its own "does this user have X" check.
 *
 * Reads the `@RequirePermission(...)` metadata off the handler, resolves
 * the caller (from `req.user` for HTTP, `client.data.user` for WS — either
 * one must already be populated by an identity guard that runs *before*
 * this one, e.g. `JwtAuthGuard`), resolves the target Site id per the
 * decorator's `siteSource`/`siteField`, asks `PermissionsService` for the
 * caller's effective permissions there, and allows the request through
 * only if the required key is in that set. Otherwise: 403.
 *
 * Usage: `@UseGuards(JwtAuthGuard, PermissionGuard)` + `@RequirePermission('conversations.assign')`
 * — order matters, PermissionGuard must run after the identity guard.
 *
 * A handler with no `@RequirePermission` decorator is passed through
 * unchanged (this guard has nothing to enforce) — that is a code-review
 * concern, not something this guard can detect at runtime.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<
      RequirePermissionMetadata | undefined
    >(PERMISSION_METADATA_KEY, [context.getHandler(), context.getClass()]);

    if (!metadata) {
      return true;
    }

    const user = this.extractUser(context);
    if (!user) {
      throw new UnauthorizedException(
        'No authenticated user on the request — PermissionGuard must be used after an identity guard (e.g. JwtAuthGuard).',
      );
    }

    const siteId = this.extractSiteId(context, metadata);
    const effectivePermissions =
      await this.permissionsService.getEffectivePermissions(
        user.userId,
        siteId ?? null,
      );

    const hasAny = metadata.permission.some((key) =>
      effectivePermissions.includes(key),
    );
    if (!hasAny) {
      const keysDescription =
        metadata.permission.length === 1
          ? `"${metadata.permission[0]}"`
          : `one of [${metadata.permission.map((k) => `"${k}"`).join(', ')}]`;
      throw new ForbiddenException(
        `Missing required permission ${keysDescription}${siteId ? ` for site ${siteId}` : ' (organization-wide)'}.`,
      );
    }

    // Handlers that also need the caller's full effective set (e.g. to echo
    // it back) can read this instead of recomputing via PermissionsService.
    this.attachEffectivePermissions(context, effectivePermissions);
    return true;
  }

  private extractUser(
    context: ExecutionContext,
  ): AuthenticatedUser | undefined {
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient<RbacSocketClient>();
      return client.data?.user;
    }
    const request = context.switchToHttp().getRequest<RbacRequest>();
    return request.user;
  }

  private extractSiteId(
    context: ExecutionContext,
    metadata: RequirePermissionMetadata,
  ): string | undefined {
    if (metadata.siteSource === 'none') {
      return undefined;
    }

    if (context.getType() === 'ws') {
      const data =
        context.switchToWs().getData<Record<string, string | undefined>>() ??
        {};
      return data[metadata.siteField];
    }

    const request = context.switchToHttp().getRequest<RbacRequest>();
    const source: Record<string, unknown> =
      metadata.siteSource === 'body'
        ? (request.body as Record<string, unknown>)
        : metadata.siteSource === 'query'
          ? request.query
          : request.params;
    const value = source?.[metadata.siteField];
    return typeof value === 'string' ? value : undefined;
  }

  private attachEffectivePermissions(
    context: ExecutionContext,
    permissions: string[],
  ): void {
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient<RbacSocketClient>();
      if (client.data) {
        client.data.effectivePermissions = permissions;
      }
      return;
    }
    const request = context.switchToHttp().getRequest<RbacRequest>();
    request.effectivePermissions = permissions;
  }
}
