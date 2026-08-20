import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * AllExceptionsFilter — SRS §6.7 ("Basic logging/monitoring of API errors").
 *
 * Catches every exception (HTTP and, defensively, WS/RPC) that reaches the
 * top of the stack, logs it in one structured line (method/path/status for
 * 4xx, plus stack trace for 5xx — 4xx is expected client-input noise, e.g.
 * a wrong password or a 403 from PermissionGuard, not worth a stack trace),
 * and returns a consistent JSON error body. Does not change the substance of
 * any existing exception's status code or message — `ValidationPipe`'s
 * `BadRequestException`, `PermissionGuard`'s `ForbiddenException`,
 * `AuthService`'s `UnauthorizedException`, etc. all keep their original
 * `message`/`error` fields; this only adds `path`/`timestamp` and ensures
 * every response (including an unexpected, uncaught 500) has the same shape.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // WS handlers in this app already catch their own errors and reply
      // with an `{ event: 'error', ... }` payload (see RealtimeGateway) —
      // this branch only exists as a defensive backstop so a genuinely
      // unexpected throw doesn't crash the process silently.
      this.logger.error(
        `Unhandled non-HTTP exception: ${(exception as Error)?.message ?? exception}`,
        (exception as Error)?.stack,
      );
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const httpBody: Record<string, unknown> =
      exception instanceof HttpException
        ? normalizeBody(exception.getResponse())
        : { message: 'Internal server error' };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl ?? request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.originalUrl ?? request.url} -> ${status}: ${JSON.stringify(httpBody.message ?? httpBody)}`,
      );
    }

    response.status(status).json({
      ...httpBody,
      statusCode: status,
      path: request.originalUrl ?? request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function normalizeBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return { message: body };
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return { message: String(body) };
}
