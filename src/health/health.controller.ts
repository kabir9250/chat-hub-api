import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';

/**
 * Uptime/health-check endpoint (SRS §6.7). No auth — this is what a load
 * balancer / uptime monitor / container orchestrator polls, and it must
 * never be blocked by RBAC (there's no "caller" to authenticate against in
 * that context).
 *
 * Hardening session addition: originally "deliberately dumb" (liveness
 * only, no dependency checks — see PROGRESS.md Session 0). Now also reports
 * MongoDB connection state, since a load balancer that only ever sees
 * "200 OK, DB unreachable" would keep routing real traffic at a backend
 * that can't actually serve it. Still cheap and synchronous — reads
 * Mongoose's already-open connection's `readyState`, does not issue a new
 * DB round-trip/ping on every health check.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
  ) {}

  @ApiOperation({
    summary: 'Liveness + dependency check (no auth required)',
    description:
      '200 with { status: "ok" } when the process is up and Mongo is connected. ' +
      '503 with { status: "degraded" } if Mongo is not currently connected — the ' +
      'process itself is still alive, but should not be considered ready to serve traffic.',
  })
  @Get()
  @HttpCode(HttpStatus.OK)
  check() {
    const dbConnected =
      this.mongoConnection.readyState === ConnectionStates.connected;
    const body = {
      status: dbConnected ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: {
        mongodb: dbConnected ? 'connected' : 'unavailable',
      },
    };
    if (!dbConnected) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
