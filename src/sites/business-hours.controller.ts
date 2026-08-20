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
import { BusinessHoursService } from './business-hours.service';
import { UpdateBusinessHoursDto } from './dto/update-business-hours.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * FR-CFG-03. Split out from `SitesController` (this session) once that name
 * started meaning "Site create/list/edit" (`sites.manage` — the catalog's
 * "Owner-level in Phase 1" note) — Business Hours is gated by its own
 * `business_hours.manage` key entirely, so it gets its own controller
 * rather than being folded into that one.
 */
@ApiTags('Business Hours')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/business-hours')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BusinessHoursController {
  constructor(private readonly businessHoursService: BusinessHoursService) {}

  @ApiOperation({
    summary: "Get a Site's Business Hours config (business_hours.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('business_hours.manage')
  get(@CurrentUser() user: AuthenticatedUser, @Param('siteId') siteId: string) {
    return this.businessHoursService.get(user, siteId);
  }

  @ApiOperation({
    summary: "Update a Site's Business Hours config (business_hours.manage)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Patch()
  @RequirePermission('business_hours.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: UpdateBusinessHoursDto,
  ) {
    return this.businessHoursService.update(user, siteId, dto);
  }
}
