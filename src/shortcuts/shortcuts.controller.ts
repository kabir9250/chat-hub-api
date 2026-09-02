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
  Query,
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
import { ShortcutsService } from './shortcuts.service';
import { CreateShortcutDto } from './dto/create-shortcut.dto';
import { UpdateShortcutDto } from './dto/update-shortcut.dto';
import { ListShortcutsQueryDto } from './dto/list-shortcuts.query.dto';
import { AvailableShortcutsQueryDto } from './dto/available-shortcuts.query.dto';
import { SHORTCUT_MANAGE_PERMISSIONS } from './shortcuts.constants';

const SHORTCUT_ID_PARAM = {
  name: 'id',
  example: '507f1f77bcf86cd799439041',
};

/**
 * ShortcutsController — SRS §2.4 / §3.11 (FR-P2-SHORT-01–08).
 *
 * Not nested under `sites/:siteId` (unlike Triggers/WidgetConfig) — a
 * Shortcut's scope can be PERSONAL or ORGANIZATION, neither of which has a
 * single Site to key a route param off of. Every CRUD route is gated by
 * the coarse `{ siteSource: 'any' }` check ("does the caller hold ANY of
 * the three manage_* keys anywhere at all") — `ShortcutsService` re-checks
 * the PRECISE permission for the scopeLevel/siteId actually in play on
 * every call, per that method's own doc comment. This mirrors exactly the
 * "guard says yes/no, service decides scope" split
 * `CombinedConversationsController`/`CombinedVisitorsController` already
 * established (Phase 2, FR-P2-SITE-01–04) — same PermissionGuard/
 * PermissionsService, no parallel check.
 *
 * `GET /shortcuts/available` and `GET /shortcuts/all` MUST both be declared
 * before `GET /shortcuts/:id` so Nest/Express doesn't swallow either literal
 * segment as an `:id` value.
 */
@ApiTags('Shortcuts')
@ApiBearerAuth('access-token')
@Controller('shortcuts')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ShortcutsController {
  constructor(private readonly shortcutsService: ShortcutsService) {}

  @ApiOperation({
    summary:
      "Resolved 'available to me' Shortcuts for a Site — Personal + that Site's Site-level + all Organization-level (shortcuts.view)",
    description:
      'Backs the `:`-triggered dropdown (FR-P2-SHORT-05/06). Distinct from ' +
      'GET /shortcuts, which lists what the caller can MANAGE, not what they ' +
      'can USE.',
  })
  @Get('available')
  @RequirePermission('shortcuts.view', { siteSource: 'query' })
  available(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AvailableShortcutsQueryDto,
  ) {
    return this.shortcutsService.findAvailable(user, query.siteId);
  }

  @ApiOperation({
    summary:
      'List Shortcuts the caller can manage, for one scopeLevel (FR-P2-SHORT-07/08)',
    description:
      "PERSONAL -> the caller's own (shortcuts.manage_own); SITE -> that " +
      "Site's Site-level shortcuts (shortcuts.manage_site on siteId); " +
      'ORGANIZATION -> every Organization-level shortcut (shortcuts.manage_organization).',
  })
  @Get()
  @RequirePermission(SHORTCUT_MANAGE_PERMISSIONS, { siteSource: 'any' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListShortcutsQueryDto,
  ) {
    return this.shortcutsService.listManaged(
      user,
      query.scopeLevel,
      query.siteId,
    );
  }

  @ApiOperation({
    summary:
      'Every Shortcut in the Organization, all scopeLevels, with creator info (shortcuts.view_all)',
    description:
      'SRS §3.11 FR-P2-SHORT-09 — Owner/oversight-only read visibility ' +
      "across the whole Organization's Shortcuts, including every " +
      "individual's Personal ones. Read-only: does not grant edit/delete " +
      'rights (see FR-P2-SHORT-09 / ShortcutsService.findAllInOrganization\'s ' +
      'own doc comment) — a PATCH/DELETE against a Shortcut listed here ' +
      'still goes through the exact same `assertCanManageScope`/' +
      '`assertOwnershipIfPersonal` checks as every other Shortcuts mutation.',
  })
  @Get('all')
  @RequirePermission('shortcuts.view_all', { siteSource: 'none' })
  findAllInOrganization(@CurrentUser() user: AuthenticatedUser) {
    return this.shortcutsService.findAllInOrganization(user);
  }

  @ApiOperation({ summary: 'Get a single Shortcut the caller can manage' })
  @ApiParam(SHORTCUT_ID_PARAM)
  @Get(':id')
  @RequirePermission(SHORTCUT_MANAGE_PERMISSIONS, { siteSource: 'any' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.shortcutsService.findOne(user, id);
  }

  @ApiOperation({
    summary: 'Create a Shortcut (FR-P2-SHORT-01–04)',
    description:
      'scopeLevel decides which shortcuts.manage_* permission is required — ' +
      'enforced server-side (FR-P2-SHORT-04), rejected even if the client sends a scopeLevel it does not hold.',
  })
  @Post()
  @RequirePermission(SHORTCUT_MANAGE_PERMISSIONS, { siteSource: 'any' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShortcutDto,
  ) {
    return this.shortcutsService.create(user, dto);
  }

  @ApiOperation({ summary: 'Edit a Shortcut (FR-P2-SHORT-01–04)' })
  @ApiParam(SHORTCUT_ID_PARAM)
  @Patch(':id')
  @RequirePermission(SHORTCUT_MANAGE_PERMISSIONS, { siteSource: 'any' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateShortcutDto,
  ) {
    return this.shortcutsService.update(user, id, dto);
  }

  @ApiOperation({ summary: 'Delete a Shortcut (FR-P2-SHORT-01–04)' })
  @ApiParam(SHORTCUT_ID_PARAM)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(SHORTCUT_MANAGE_PERMISSIONS, { siteSource: 'any' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.shortcutsService.remove(user, id);
  }
}
