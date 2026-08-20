import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { TriggersService } from './triggers.service';
import { CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const TRIGGER_ID_PARAM = {
  name: 'triggerId',
  example: '507f1f77bcf86cd799439031',
};

/**
 * FR-CFG-04/05. Admin-only, `PermissionGuard`-protected CRUD. Evaluation
 * logic (which Trigger fires on a given page load) is NOT here — that's
 * frontend/widget-runtime work for later; this module's job is only to
 * store the rules and always return them ordered by priority (see
 * `TriggersService.findAll`) so that future code can evaluate them. The
 * widget's own read path is `GET /widget-bootstrap/:siteId` (public, no
 * auth), not this controller.
 */
@ApiTags('Triggers')
@ApiBearerAuth('access-token')
@Controller('sites/:siteId/triggers')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TriggersController {
  constructor(private readonly triggersService: TriggersService) {}

  @ApiOperation({
    summary: 'List Triggers on a Site, ordered by priority (triggers.view)',
    description:
      'Sorted highest-priority first (FR-CFG-05) — includes both enabled and disabled Triggers.',
  })
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @RequirePermission('triggers.view')
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
  ) {
    return this.triggersService.findAll(user, siteId);
  }

  @ApiOperation({ summary: 'Get a single Trigger (triggers.view)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(TRIGGER_ID_PARAM)
  @Get(':triggerId')
  @RequirePermission('triggers.view')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('triggerId') triggerId: string,
  ) {
    return this.triggersService.findOne(user, siteId, triggerId);
  }

  @ApiOperation({ summary: 'Create a Trigger on a Site (triggers.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @Post()
  @RequirePermission('triggers.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: CreateTriggerDto,
  ) {
    return this.triggersService.create(user, siteId, dto);
  }

  @ApiOperation({ summary: 'Edit a Trigger (triggers.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(TRIGGER_ID_PARAM)
  @Patch(':triggerId')
  @RequirePermission('triggers.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('triggerId') triggerId: string,
    @Body() dto: UpdateTriggerDto,
  ) {
    return this.triggersService.update(user, siteId, triggerId, dto);
  }

  @ApiOperation({ summary: 'Delete a Trigger (triggers.manage)' })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(TRIGGER_ID_PARAM)
  @Delete(':triggerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('triggers.manage')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('triggerId') triggerId: string,
  ) {
    await this.triggersService.remove(user, siteId, triggerId);
  }
}
