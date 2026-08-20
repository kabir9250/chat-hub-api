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
import { WidgetConfigService } from './widget-config.service';
import { UpdateWidgetConfigDto } from './dto/update-widget-config.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };

/**
 * FR-CFG-01/02. Admin-only, `PermissionGuard`-protected — for the widget's
 * OWN public read of this data, see `WidgetBootstrapController`
 * (`GET /widget-bootstrap/:siteId`, no auth, deliberately not this
 * controller — see that module's header comment for why).
 */
@ApiTags('Widget Config')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/widget-config')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WidgetConfigController {
  constructor(private readonly widgetConfigService: WidgetConfigService) {}

  @ApiOperation({
    summary: "Get a Site's Widget Config (widget_config.view)",
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('widget_config.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('siteId') siteId: string) {
    return this.widgetConfigService.get(user, siteId);
  }

  @ApiOperation({
    summary: "Update a Site's Widget Config (widget_config.manage)",
    description:
      'Partial update — branding fields (FR-CFG-01) and boolean toggles ' +
      '(FR-CFG-02) share this one endpoint/permission.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Patch()
  @RequirePermission('widget_config.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: UpdateWidgetConfigDto,
  ) {
    return this.widgetConfigService.update(user, siteId, dto);
  }
}
