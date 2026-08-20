import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import { LeadsService } from './leads.service';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const LEAD_ID_PARAM = { name: 'leadId', example: '507f1f77bcf86cd799439044' };

/**
 * FR-VIS-08 / FR-RPT-05. `:siteId` drives `PermissionGuard`'s Site-scoped
 * check exactly like every other Site-scoped controller since Session 4.
 */
@ApiTags('Leads')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/leads')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @ApiOperation({
    summary:
      'List Visitors that qualify as Leads on a Site, with status (leads.view)',
    description:
      'FR-VIS-08: every Visitor with a name or email captured. Each item includes ' +
      'the full Visitor attribution data plus leadId/status.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('leads.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.leadsService.findAllForSite(user, siteId);
  }

  @ApiOperation({ summary: "Update a Lead's status (leads.manage)" })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(LEAD_ID_PARAM)
  @Patch(':leadId/status')
  @RequirePermission('leads.manage')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('leadId') leadId: string,
    @Body() dto: UpdateLeadStatusDto,
  ) {
    return this.leadsService.updateStatus(user, siteId, leadId, dto.status);
  }
}
