import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

import { RealtimeSocketData } from '../../realtime/realtime.types';

/**
 * WsJwtGuard — the WebSocket counterpart to `JwtAuthGuard`, flagged as
 * missing by Sessions 2/3/7 ("no WsJwtGuard exists yet ... a prerequisite
 * for using PermissionGuard on a Gateway handler").
 *
 * Unlike the HTTP guard, this does NOT re-verify a JWT on every call — a
 * Socket.IO connection is long-lived, so the token is verified exactly ONCE,
 * in `RealtimeGateway.handleConnection` (the same checks `JwtStrategy.validate`
 * does: signature/expiry via `JwtService.verify`, `type === 'user'`, the
 * User still exists/`enabled`), and the result cached on `client.data.user`.
 * This guard just asserts that already happened before letting a
 * `@SubscribeMessage` handler — and, after this, `PermissionGuard` — run.
 * Same "identity guard before PermissionGuard" ordering HTTP routes use
 * (`@UseGuards(JwtAuthGuard, PermissionGuard)`), just adapted to a
 * connection-scoped rather than a per-request identity check.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const data = client.data as RealtimeSocketData | undefined;
    if (!data?.user) {
      throw new WsException(
        'Not authenticated as a User on this connection — connect with a valid User JWT (Authorization: Bearer <token> in the handshake).',
      );
    }
    return true;
  }
}
