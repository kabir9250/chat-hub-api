import { LoggerService } from '@nestjs/common';

/**
 * JsonLoggerService — SRS §6.7 ("Application-level logs for: authentication
 * events, errors, WebSocket connect/disconnect, and key business events").
 *
 * A drop-in replacement for Nest's default console logger, installed once in
 * `main.ts` via `NestFactory.create(AppModule, { logger: new JsonLoggerService() })`.
 * Because Nest's built-in `Logger` class (used everywhere in this codebase —
 * `new Logger(SomeService.name)`, e.g. `PresenceService`, `RealtimeGateway`,
 * `AuditLogService`) routes every call through whatever logger the app was
 * bootstrapped with, this ONE file turns every existing `this.logger.log/warn/
 * error(...)` call already sprinkled through the app (auth login/failed
 * logging, WebSocket connect/disconnect in `RealtimeGateway`, presence
 * changes, etc.) into structured one-line JSON — no per-call-site changes
 * needed anywhere else.
 *
 * Output is one JSON object per line to stdout/stderr (errors go to stderr),
 * the standard shape log aggregators (CloudWatch, Datadog, a hosted Node
 * platform's log viewer, `journalctl`, etc.) expect — never pretty-printed,
 * since pretty output is harder to parse mechanically and this app has no
 * interactive terminal requirement in production.
 *
 * Deliberately dependency-free (no `pino`/`winston`) — SRS §6.7 asks for
 * "basic" logging, and Nest's `LoggerService` interface is already the exact
 * shape needed; pulling in a full logging framework would be more than this
 * phase needs. Revisit if log volume/retention/searchability become a real
 * operational need (see DEPLOYMENT.md's "future infra" notes).
 */
export class JsonLoggerService implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(
    level: string,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const params = [...optionalParams];
    // Nest's contextual Logger (`new Logger('SomeContext')`) always appends
    // the context string as the LAST argument to every call.
    let context: string | undefined;
    if (params.length && typeof params[params.length - 1] === 'string') {
      context = params.pop() as string;
    }
    // `Logger.error(message, stack, context)` puts the stack trace first
    // among optionalParams (before context, already popped above).
    let stack: string | undefined;
    if (level === 'error' && params.length && typeof params[0] === 'string') {
      stack = params.shift() as string;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? 'Application',
      message: typeof message === 'string' ? message : safeStringify(message),
    };
    if (stack) entry.stack = stack;
    if (params.length) entry.meta = params.map((p) => safeSerialize(p));

    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeSerialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}
