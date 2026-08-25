import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConversationsService } from './conversations.service';
import { ListConversationsCombinedQueryDto } from './dto/list-conversations-combined.query.dto';
import { CONVERSATION_VIEW_PERMISSIONS } from './conversations.constants';

/**
 * CombinedConversationsController — Phase 2, FR-P2-SITE-01–04. Backs BOTH
 * the Inbox's and the History search's "All Sites" mode (Session 10.2 built
 * them as one shared filter set/API call for the single-Site case; this is
 * the same shared call's combined-mode counterpart — no separate "combined
 * History" endpoint).
 *
 * Deliberately its own top-level controller (`conversations`, no `:siteId`)
 * rather than a `?siteId=all` flag on `ConversationsController` — there is
 * no single Site for a route param to carry, so `PermissionGuard`'s normal
 * `siteSource: 'param'` check doesn't apply. Gated instead by the new
 * `{ siteSource: 'any' }` (see require-permission.decorator.ts) — passes if
 * the caller holds either view key on AT LEAST ONE Site, which is exactly
 * this task's guardrail ("a user with access to only one Site should simply
 * return that one Site's data, not an error"). The actual Site SET used to
 * build the query is resolved again, independently, inside
 * `ConversationsService.findAllCombined` via
 * `PermissionsService.getAuthorizedSites` — the guard only answers "can
 * they reach this route at all," same "guard says yes/no, service decides
 * scope" split Session 7 already established for the single-Site route.
 */
@ApiTags('Conversations (combined)')
@ApiBearerAuth('access-token')
@Controller('conversations')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CombinedConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @ApiOperation({
    summary:
      'List Conversations across every authorized Site — "All Sites" mode (FR-P2-SITE-01–04)',
    description:
      "Resolves the authorized Site set server-side from the caller's effective " +
      'conversations.view_own/.view_site permissions (Phase 1 Session 3) — never ' +
      'from a client-supplied Site list. Same filter set as GET /sites/:siteId/conversations ' +
      '(status/date range/agentId/rating/tag/search/page/limit), merged and sorted by ' +
      'most-recent activity across every authorized Site; each item still carries its own ' +
      'siteId for the frontend to badge.',
  })
  @Get()
  @RequirePermission([...CONVERSATION_VIEW_PERMISSIONS], { siteSource: 'any' })
  findAllCombined(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListConversationsCombinedQueryDto,
  ) {
    if (query.combined === 'false') {
      throw new BadRequestException(
        'This endpoint is combined-mode-only (omit ?combined= or pass "true"). ' +
          'Use GET /sites/:siteId/conversations for a single Site.',
      );
    }
    return this.conversationsService.findAllCombined(user, query);
  }
}
