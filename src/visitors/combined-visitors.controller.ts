import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { VisitorsService } from './visitors.service';
import { ListVisitorsCombinedQueryDto } from './dto/list-visitors-combined.query.dto';

/**
 * CombinedVisitorsController — Phase 2, FR-P2-SITE-01–04. Same split as
 * Conversations' `CombinedConversationsController` (see that file's doc
 * comment for the full reasoning): its own top-level controller
 * (`visitors`, no `:siteId`) because there is no single Site for a route
 * param to carry, gated by `{ siteSource: 'any' }` (passes if the caller
 * holds `visitors.view` on at least one Site — never errors for a
 * one-Site holder, per this task's guardrail), with the actual Site set
 * re-resolved inside `VisitorsService.findAllCombined` via
 * `PermissionsService.getAuthorizedSites`.
 */
@ApiTags('Visitors (combined)')
@ApiBearerAuth('access-token')
@Controller('visitors')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CombinedVisitorsController {
  constructor(private readonly visitorsService: VisitorsService) {}

  @ApiOperation({
    summary:
      'List Visitors across every authorized Site — "All Sites" mode (FR-P2-SITE-01–04, visitors.view)',
    description:
      "Resolves the authorized Site set server-side from the caller's effective " +
      'visitors.view permission (Phase 1 Session 3) — never from a client-supplied ' +
      'Site list. Merged and sorted by most-recent activity (lastSeenAt) across every ' +
      'authorized Site; each item still carries its own siteId for the frontend to badge.',
  })
  @Get()
  @RequirePermission('visitors.view', { siteSource: 'any' })
  findAllCombined(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVisitorsCombinedQueryDto,
  ) {
    if (query.combined === 'false') {
      throw new BadRequestException(
        'This endpoint is combined-mode-only (omit ?combined= or pass "true"). ' +
          'Use GET /sites/:siteId/visitors for a single Site.',
      );
    }
    return this.visitorsService.findAllCombined(user, query);
  }
}
