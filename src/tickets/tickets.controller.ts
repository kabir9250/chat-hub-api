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
import { TicketsService } from './tickets.service';
import { ListTicketsQueryDto } from './dto/list-tickets.query.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const CONVERSATION_ID_PARAM = {
  name: 'conversationId',
  example: '507f1f77bcf86cd799439022',
};

/**
 * Tickets screen (Phase 3) — Owner-gated (`tickets.view`), Site-scoped like
 * every other Site-scoped controller since Session 4.
 */
@ApiTags('Tickets')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/tickets')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @ApiOperation({
    summary:
      'List online (live-chat) and offline (Offline Contact Form) ' +
      'Conversations as Tickets, filterable by channel + date range (tickets.view)',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('tickets.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: ListTicketsQueryDto,
  ) {
    return this.ticketsService.findAllForSite(user, siteId, query);
  }

  @ApiOperation({
    summary: "A Ticket's full chat transcript, built live (tickets.view)",
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/transcript')
  @RequirePermission('tickets.view')
  getTranscript(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.ticketsService.getTranscript(user, siteId, conversationId);
  }
}
