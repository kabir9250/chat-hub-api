import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsChartQueryDto } from './dto/analytics-chart.query.dto';
import { DateRangeQueryDto } from './dto/date-range.query.dto';
import { PageVisitStatsQueryDto } from './dto/page-visit-stats.query.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * AnalyticsController — FR-RPT-01–05/08, single-Site view. Every route here
 * is gated by `analytics.view_site` (§5.13) via the standard
 * `PermissionGuard`/`@RequirePermission` — the same mechanism every other
 * Site-scoped controller in this codebase uses, per this session's
 * guardrail ("every report endpoint must go through the Session 3
 * PermissionGuard"). The combined-across-Sites view (FR-RPT-06) lives in
 * `OrganizationAnalyticsController` instead, gated by
 * `analytics.view_organization`.
 */
@ApiTags('Analytics')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/analytics')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @ApiOperation({
    summary:
      'Dashboard chart: page views / total visits / unique visitors / chats (FR-RPT-01, analytics.view_site)',
    description:
      'Hourly/Daily/Weekly/Monthly bucketed counts from AnalyticsEvent. All 4 ' +
      'metrics are always returned per bucket — per-metric show/hide is a ' +
      'client-side checkbox-legend concern.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('chart')
  @RequirePermission('analytics.view_site')
  getChart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: AnalyticsChartQueryDto,
  ) {
    return this.analyticsService.getChart(user, siteId, query);
  }

  @ApiOperation({
    summary:
      'Total conversations + status breakdown (FR-RPT-02, analytics.view_site)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('conversations')
  @RequirePermission('analytics.view_site')
  getConversationsByStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getConversationsByStatus(user, siteId, query);
  }

  @ApiOperation({
    summary:
      'Avg/median first-response + resolution time + avg rating, overall and per Agent (FR-RPT-03/04, analytics.view_site)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('response-times')
  @RequirePermission('analytics.view_site')
  getResponseTimes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getResponseTimes(user, siteId, query);
  }

  @ApiOperation({
    summary:
      'Agent activity: conversations handled, messages sent, avg handle time (FR-RPT-04, analytics.view_site)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('agent-activity')
  @RequirePermission('analytics.view_site')
  getAgentActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getAgentActivity(user, siteId, query);
  }

  @ApiOperation({
    summary: 'Lead counts + status breakdown (FR-RPT-05, analytics.view_site)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('leads')
  @RequirePermission('analytics.view_site')
  getLeadStats(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getLeadStats(user, siteId, query);
  }

  @ApiOperation({
    summary:
      'Time spent per page / page-category (FR-RPT-08, analytics.view_site)',
    description:
      'Aggregates PageVisit documents for this Site. groupBy=category (default) ' +
      'groups by the derived pageCategory (see page-category.util.ts); ' +
      'groupBy=page groups by the exact pageUrl.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('page-visits')
  @RequirePermission('analytics.view_site')
  getPageVisitStats(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: PageVisitStatsQueryDto,
  ) {
    return this.analyticsService.getPageVisitStats(user, siteId, query);
  }
}
