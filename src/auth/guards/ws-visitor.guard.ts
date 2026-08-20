import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

import { RealtimeSocketData } from '../../realtime/realtime.types';

/**
 * WsVisitorGuard — the WebSocket counterpart to `VisitorAuthGuard`, same
 * connection-time-verification design as `WsJwtGuard` (see its doc comment).
 * Visitor identity is intentionally never gated by `PermissionGuard` —
 * visitors are anonymous by design (SRS §1.3/§4.4) and have no RBAC
 * permissions at all; the only thing that must be enforced for a visitor is
 * that they can never reach a Conversation/Site that isn't their own, which
 * `ConversationsService.getForVisitor`/`addVisitorMessage` check directly
 * (mirrors how `VisitorAuthGuard` + `ConversationsService.create` work for
 * the REST "start a Conversation" endpoint in Session 7).
 */
@Injectable()
export class WsVisitorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const data = client.data as RealtimeSocketData | undefined;
    if (!data?.visitor) {
      throw new WsException(
        'Not authenticated as a Visitor on this connection — connect with a valid visitor session token (Authorization: Bearer <token> in the handshake).',
      );
    }
    return true;
  }
}
