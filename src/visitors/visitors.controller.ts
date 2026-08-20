import {
  Body,
  Controller,
  Delete,
  Get,
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
import { BanVisitorDto } from './dto/ban-visitor.dto';

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
      'banned IP cannot start a new chat session on this Site.',
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
    return this.visitorsService.ban(user, siteId, visitorId, dto.ip);
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
