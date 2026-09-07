import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

/**
 * Agent-lock-fix — closes a gap flagged (not fixed) in PROGRESS.md Session
 * 8's Key Decision 6: "A plain `HttpException` (e.g. `ForbiddenException`
 * from `PermissionGuard`) thrown inside a Gateway handler surfaces to the
 * client as a generic `{status:'error', message:'Internal server error',
 * cause:{...}}` `exception` event ... Nest's default WS exceptions layer
 * only special-cases `WsException`."
 *
 * That was cosmetic when the only affected messages were PermissionGuard's
 * own — but Requirement 3 of this fix needs its rejection message ("This
 * conversation is already assigned to <name>...") to actually reach an
 * Agent Console composer over `agent:send_message`, the real send path
 * (Inbox/ConversationView always sends over the socket, never the REST
 * fallback) — a generic "Internal server error" would fail the guardrail's
 * "reject ... with a clear error identifying the current assignee."
 *
 * Applied gateway-wide (`@UseFilters` on the class, in `RealtimeGateway`),
 * not just to the send handlers — any `HttpException` any handler throws
 * (existing `ForbiddenException`s from `PermissionGuard` included) now
 * reaches the client with its real message, a strict improvement with no
 * behavior change for anything that already worked.
 */
@Catch()
export class WsHttpExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const rawMessage =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            exception.message);
      const message = Array.isArray(rawMessage) ? rawMessage[0] : rawMessage;
      super.catch(new WsException(message), host);
      return;
    }
    super.catch(exception, host);
  }
}
