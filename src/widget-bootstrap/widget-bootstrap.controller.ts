import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { WidgetBootstrapService } from './widget-bootstrap.service';

/**
 * The ONE endpoint the embed script/widget frontend calls to render
 * itself (FR-CFG-06, FR-WID-04). Intentionally public: visitors are
 * anonymous and have no `User`/JWT/Permissions at all — no
 * `JwtAuthGuard`/`PermissionGuard` on this controller, by design, unlike
 * every other controller in this codebase.
 *
 * siteId is the only scoping — no session/auth required, matching
 * `POST /visitor-session/init`'s same public, siteId-scoped shape
 * (Session 2). Only fields safe for public consumption are returned; see
 * `WidgetBootstrapService` for exactly what's excluded.
 */
@ApiTags('Widget Bootstrap (Public)')
@Controller('widget-bootstrap')
export class WidgetBootstrapController {
  constructor(
    private readonly widgetBootstrapService: WidgetBootstrapService,
  ) {}

  @ApiOperation({
    summary:
      'Public, unauthenticated: fetch active Widget Config + enabled Triggers for a Site',
    description:
      'No Authorization header required — this is what the embed script calls on load. ' +
      'Triggers are enabled-only and ordered by priority (highest first, FR-CFG-05); ' +
      'evaluating which one fires for the current page is frontend logic, not done here.',
  })
  @ApiParam({ name: 'siteId', example: '507f1f77bcf86cd799439011' })
  @Get(':siteId')
  get(@Param('siteId') siteId: string) {
    return this.widgetBootstrapService.getBootstrap(siteId);
  }

  @ApiOperation({
    summary:
      'Public, unauthenticated: online/offline indicator (FR-WID-09/FR-HRS-01)',
    description:
      '"online" = at least one enabled Agent for this Site is currently connected ' +
      "AND the current time is within the Site's configured Business Hours " +
      '(or Business Hours is disabled, i.e. no restriction). Poll this on an ' +
      'interval — there is no push/WebSocket channel for it (Visitor sockets ' +
      "don't join a Site broadcast room, by design — see PROGRESS.md).",
  })
  @ApiParam({ name: 'siteId', example: '507f1f77bcf86cd799439011' })
  @Get(':siteId/status')
  getStatus(@Param('siteId') siteId: string) {
    return this.widgetBootstrapService.getStatus(siteId);
  }
}
