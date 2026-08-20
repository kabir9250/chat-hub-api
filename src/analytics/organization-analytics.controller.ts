import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsChartQueryDto } from './dto/analytics-chart.query.dto';
import { DateRangeQueryDto } from './dto/date-range.query.dto';

/**
 * OrganizationAnalyticsController — FR-RPT-06, the "combined (all Sites)"
 * view every report in AnalyticsController also needs. A deliberately
 * separate controller (own route prefix, `analytics`, no `:siteId`) rather
 * than a `?siteId=all` query flag on the same routes — this session's
 * guardrail ("every report endpoint must go through PermissionGuard") is
 * cleanest satisfied by gating the combined view on its own distinct
 * permission (`analytics.view_organization`, `{ siteSource: 'none' }`,
 * matching the exact pattern Session 3 already established for every other
 * Organization-wide-only route such as `roles.manage`) rather than
 * threading an org-wide check through a Site-scoped route's guard.
 */
@ApiTags('Analytics (combined)')
@ApiBearerAuth('access-token')
@Controller('analytics')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @ApiOperation({
    summary:
      'Combined dashboard chart across every Site in the Organization (FR-RPT-01/06, analytics.view_organization)',
  })
  @Get('chart')
  @RequirePermission('analytics.view_organization', { siteSource: 'none' })
  getChart(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AnalyticsChartQueryDto,
  ) {
    return this.analyticsService.getChartCombined(user, query);
  }

  @ApiOperation({
    summary:
      'Combined total conversations + status breakdown, with a per-Site breakdown (FR-RPT-02/06, analytics.view_organization)',
  })
  @Get('conversations')
  @RequirePermission('analytics.view_organization', { siteSource: 'none' })
  getConversationsByStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getConversationsByStatusCombined(user, query);
  }

  @ApiOperation({
    summary:
      'Combined avg/median first-response + resolution time, overall/per-Agent/per-Site (FR-RPT-03/06, analytics.view_organization)',
  })
  @Get('response-times')
  @RequirePermission('analytics.view_organization', { siteSource: 'none' })
  getResponseTimes(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getResponseTimesCombined(user, query);
  }

  @ApiOperation({
    summary:
      'Combined Agent activity across every Site (FR-RPT-04/06, analytics.view_organization)',
  })
  @Get('agent-activity')
  @RequirePermission('analytics.view_organization', { siteSource: 'none' })
  getAgentActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getAgentActivityCombined(user, query);
  }

  @ApiOperation({
    summary:
      'Combined Lead counts + status breakdown, with a per-Site breakdown (FR-RPT-05/06, analytics.view_organization)',
  })
  @Get('leads')
  @RequirePermission('analytics.view_organization', { siteSource: 'none' })
  getLeadStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getLeadStatsCombined(user, query);
  }
}
