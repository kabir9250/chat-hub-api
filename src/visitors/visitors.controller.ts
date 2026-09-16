import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { VisitorsService } from './visitors.service';
import { UpdateVisitorDto } from './dto/update-visitor.dto';
import { BanIpDto } from './dto/ban-ip.dto';
import { BanVisitorDto } from './dto/ban-visitor.dto';
import { ListVisitsQueryDto } from './dto/list-visits.query.dto';
import { ListBannedQueryDto } from './dto/list-banned.query.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const VISITOR_ID_PARAM = {
  name: 'visitorId',
  example: '507f1f77bcf86cd799439033',
};

/**
 * FR-VIS-06/07 + FR-AGT-08 (Visitor Info panel). `:siteId` drives
 * `PermissionGuard`'s Site-scoped check exactly like every other
 * Site-scoped controller since Session 4.
 */
@ApiTags('Visitors')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/visitors')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class VisitorsController {
  constructor(private readonly visitorsService: VisitorsService) {}

  @ApiOperation({ summary: 'List Visitors on a Site (visitors.view)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiQuery({ name: 'banned', required: false, type: Boolean })
  @Get()
  @RequirePermission('visitors.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query('banned') banned?: string,
  ) {
    const bannedFilter = banned === undefined ? undefined : banned === 'true';
    return this.visitorsService.findAll(user, siteId, bannedFilter);
  }

  @ApiOperation({
    summary:
      'List currently-online Visitors on a Site, live-monitoring view (visitors.view)',
    description:
      'FR-RPT-07. Only Visitors with an open WebSocket connection right now — ' +
      'not a historical/date-range report (see the Analytics module for that). ' +
      "Registered before ':visitorId' so the literal 'live' segment is never " +
      'swallowed as a visitorId.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('live')
  @RequirePermission('visitors.view')
  findLive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.visitorsService.findLive(user, siteId);
  }

  @ApiOperation({
    summary:
      'List every currently-banned Visitor/IP on a Site, for the Banned ' +
      'Visitors screen (visitors.ban)',
    description:
      'Settings → Banned. Merges every Visitor with isBanned=true with any ' +
      'orphan Site.bannedIps entry (an IP banned with no still-banned ' +
      'Visitor behind it) — see VisitorsService.findBanned. Read-only: does ' +
      'not create, enforce, or lift a ban (POST/DELETE :visitorId/ban below ' +
      'are still the only way to do that). Gated on visitors.ban rather than ' +
      "visitors.view — the same permission this screen's own ban/unban " +
      "actions require, per that feature's own strictness (every seeded " +
      'Role holding visitors.ban also holds visitors.view today, so this ' +
      "is a narrowing, not a widening, of who can reach a Visitor's data). " +
      'Feature-2a-backend: supports `search` (IP/name/email/reason) and ' +
      '`dateFrom`/`dateTo` filtering, now that each row is a real ' +
      '`BannedEntry` document rather than a merge-on-read.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get('banned')
  @RequirePermission('visitors.ban')
  findBanned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: ListBannedQueryDto,
  ) {
    return this.visitorsService.findBanned(user, siteId, query);
  }

  @ApiOperation({
    summary: 'Ban a raw IP with no Visitor behind it (visitors.ban)',
    description:
      '"Add banned IP address" — the Banned Visitors screen\'s own creation ' +
      'flow (Settings → Banned → Add visitor). Distinct from ' +
      'POST :visitorId/ban below, which always starts from an already-known ' +
      'Visitor; this bans a bare IP directly, with an optional Reason shown ' +
      "in that screen's table. Same enforcement path either way — both add " +
      'to `Site.bannedIps`, the one list `VisitorSessionService.init()` ' +
      "checks. Registered before ':visitorId' for the same reason 'live'/" +
      "'banned' are above.",
  })
  @ApiParam(SITE_ID_PARAM)
  @Post('ban-ip')
  @HttpCode(204)
  @RequirePermission('visitors.ban')
  banIp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: BanIpDto,
  ) {
    return this.visitorsService.banIp(user, siteId, dto.ip, dto.reason);
  }

  @ApiOperation({
    summary: "Get one Visitor's full attribution/profile (visitors.view)",
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(VISITOR_ID_PARAM)
  @Get(':visitorId')
  @RequirePermission('visitors.view')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('visitorId') visitorId: string,
  ) {
    return this.visitorsService.findOne(user, siteId, visitorId);
  }

  @ApiOperation({
    summary:
      "This Visitor's past visit sessions, paginated, most-recent-first (visitors.view)",
    description:
      'Phase 2, FR-P2-HIST-02 (Session P2-5) — "Past visits" drill-down. Groups the ' +
      "Visitor's whole PageVisit history into distinct visit sessions (same 30-minute " +
      'gap-boundary rule the Visitor Info panel\'s live "current visit" uses, ' +
      'current-visit.util.ts) — each item carries a date, total duration, page count, ' +
      'and its own page-by-page detail (`pages`).',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(VISITOR_ID_PARAM)
  @Get(':visitorId/visits')
  @RequirePermission('visitors.view')
  findVisits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('visitorId') visitorId: string,
    @Query() query: ListVisitsQueryDto,
  ) {
    return this.visitorsService.findVisits(user, siteId, visitorId, query);
  }

  @ApiOperation({
    summary: "Edit a Visitor's name/email/phone/notes (visitors.edit)",
    description:
      'FR-VIS-06. Setting name or email also qualifies this Visitor as a Lead (FR-VIS-08).',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(VISITOR_ID_PARAM)
  @Patch(':visitorId')
  @RequirePermission('visitors.edit')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('visitorId') visitorId: string,
    @Body() dto: UpdateVisitorDto,
  ) {
    return this.visitorsService.update(user, siteId, visitorId, dto);
  }

  @ApiOperation({
    summary: 'Ban a Visitor by id, and block their IP (visitors.ban)',
    description:
      'FR-VIS-07. Enforced at POST /visitor-session/init — a banned Visitor or ' +
      'banned IP cannot start a new chat session on this Site. `reason` is ' +
      'optional here (see BanVisitorDto) but required client-side by the ' +
      "Agent Console's own Ban modal — Zendesk-UI session follow-up.",
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(VISITOR_ID_PARAM)
  @Post(':visitorId/ban')
  @RequirePermission('visitors.ban')
  ban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('visitorId') visitorId: string,
    @Body() dto: BanVisitorDto,
  ) {
    return this.visitorsService.ban(
      user,
      siteId,
      visitorId,
      dto.ip,
      dto.reason,
    );
  }

  @ApiOperation({
    summary: 'Reverse a ban on a Visitor (visitors.ban)',
    description:
      'Not required by the SRS but trivial given `ban()` above — reuses the same ' +
      'permission (reversing a ban is the same right as issuing one).',
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(VISITOR_ID_PARAM)
  @Delete(':visitorId/ban')
  @RequirePermission('visitors.ban')
  unban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('visitorId') visitorId: string,
  ) {
    return this.visitorsService.unban(user, siteId, visitorId);
  }
}
