import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TeamRosterService } from './team-roster.service';

/**
 * SRS Feature 4 (Team Panel) — the REST roster endpoint Feature-4a-realtime
 * flagged as "left to the frontend-facing follow-up session" (its own
 * `TeamRosterService` note). Just `JwtAuthGuard`, no `PermissionGuard` — same
 * scope decision as the `internal:*` WebSocket handlers (SRS's own "any
 * authenticated User can see every other User in the Organization" design;
 * this is a personal-collaboration surface, not a Site-permission-gated
 * resource).
 */
@ApiTags('Internal Conversations')
@ApiBearerAuth('access-token')
@Controller('internal-conversations')
@UseGuards(JwtAuthGuard)
export class InternalConversationsController {
  constructor(private readonly teamRosterService: TeamRosterService) {}

  @ApiOperation({
    summary: 'Get the Organization-wide Team roster (Feature 4 — Team Panel)',
    description:
      "Every enabled User in the caller's own Organization, grouped by " +
      'Department, with live presence/admin/chat-count columns — backs the ' +
      'sidebar\'s online-colleagues list and the "Agents signed in" modal. ' +
      'No permission beyond being logged in.',
  })
  @Get('roster')
  getRoster(@CurrentUser() user: AuthenticatedUser) {
    return this.teamRosterService.getRoster(
      new Types.ObjectId(user.organizationId),
    );
  }
}
