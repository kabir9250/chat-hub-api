import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { SitesService } from './sites.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * Site create/list/edit — catalog's `sites.view`/`sites.manage` ("Owner-
 * level in Phase 1"). Sites ARE the top-level Site-scoped boundary
 * (SRS §4.1/§4.2), so — unlike every `sites/:siteId/...` controller
 * elsewhere in this codebase — `findAll`/`create` have no parent Site to
 * scope against and are Organization-wide (`{ siteSource: 'none' }`), same
 * pattern `RolesController` uses. Previously this class only ever served
 * `business-hours` (see PROGRESS.md); that half now lives in its own
 * `BusinessHoursController` (`business-hours.controller.ts`, unchanged
 * behavior) since it's gated by a different permission key entirely.
 */
@ApiTags('Sites')
@ApiBearerAuth('access-token')
@Controller('sites')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @ApiOperation({ summary: "List this Organization's Sites (sites.view)" })
  @Get()
  @RequirePermission('sites.view', { siteSource: 'none' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.sitesService.findAll(user);
  }

  @ApiOperation({ summary: 'Create a Site (sites.manage)' })
  @Post()
  @RequirePermission('sites.manage', { siteSource: 'none' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSiteDto) {
    return this.sitesService.create(user, dto);
  }

  @ApiOperation({
    summary: 'Edit a Site (sites.manage)',
    description:
      'Partial update — name/URL(s)/timezone/status, plus `chatEnabled`: ' +
      'turning chat ON (or leaving it on while clearing every URL) is ' +
      'rejected with 400 unless the Site already has at least one URL in ' +
      '`domains`.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Patch(':siteId')
  @RequirePermission('sites.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: UpdateSiteDto,
  ) {
    return this.sitesService.update(user, siteId, dto);
  }
}
