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
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VisitorAuthGuard } from '../auth/guards/visitor-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentVisitor } from '../auth/decorators/current-visitor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.query.dto';
import { UpdateConversationStatusDto } from './dto/update-status.dto';
import { AssignConversationDto } from './dto/assign-conversation.dto';
import { AssignVisitorDto } from './dto/assign-visitor.dto';
import { TagConversationDto } from './dto/tag-conversation.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { GetMessagesSinceQueryDto } from './dto/get-messages-since.query.dto';
import { CONVERSATION_VIEW_PERMISSIONS } from './conversations.constants';

const SITE_ID_PARAM = { name: 'siteId', example: '507f1f77bcf86cd799439011' };
const CONVERSATION_ID_PARAM = {
  name: 'conversationId',
  example: '507f1f77bcf86cd799439050',
};
const VIEW_PERMISSIONS = CONVERSATION_VIEW_PERMISSIONS;

/**
 * FR-CONV-01–07, FR-AGT-06/07/09/10/11. `:siteId` drives PermissionGuard's
 * Site-scoped check exactly like every other Site-scoped controller since
 * Session 4 — except `POST .../conversations`, which is visitor-facing
 * (VisitorAuthGuard, not JwtAuthGuard/PermissionGuard — see
 * CreateConversationDto's doc comment for why), and the rating endpoint,
 * mounted separately below with no guard at all (FR-WID-13).
 */
@ApiTags('Conversations')
@Controller('sites/:siteId/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @ApiOperation({
    summary: 'Start a Conversation (visitor session token, no User login)',
    description:
      'FR-CONV-01 / FR-RTE-01. Requires Authorization: Bearer <visitor session token> ' +
      'from POST /visitor-session/init for this same Site.',
  })
  // §6.3 "Rate limiting on ... message sending" (starting a Conversation is
  // the first "message send" of a session) — 10/min per IP.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam(SITE_ID_PARAM)
  @Post()
  @UseGuards(VisitorAuthGuard)
  create(
    @CurrentVisitor() visitor: AuthenticatedVisitor,
    @Param('siteId') siteId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.create(visitor, siteId, dto);
  }

  @ApiOperation({
    summary:
      'List Conversations (conversations.view_own or .view_site — result scope differs)',
    description:
      'A view_site holder sees every Conversation on the Site (with filters). A ' +
      'view_own-only holder is always scoped to Conversations assigned to them, ' +
      'regardless of any ?agentId= passed.',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @Get()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.conversationsService.findAll(user, siteId, query);
  }

  @ApiOperation({
    summary:
      'Get one Conversation with its full transcript (conversations.view_own or .view_site)',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationsService.findOne(user, siteId, conversationId);
  }

  @ApiOperation({
    summary: "Change a Conversation's status (conversations.close)",
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Patch(':conversationId/status')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('conversations.close')
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: UpdateConversationStatusDto,
  ) {
    return this.conversationsService.updateStatus(
      user,
      siteId,
      conversationId,
      dto.status,
    );
  }

  @ApiOperation({
    summary: 'Assign a Conversation to an Agent (conversations.assign)',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Patch(':conversationId/assign')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('conversations.assign')
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: AssignConversationDto,
  ) {
    // `expectedCurrentAgentId` is intentionally passed through AS-IS
    // (undefined if the caller omitted it entirely, null if they explicitly
    // sent null) — the service treats "omitted" and "explicitly null"
    // differently. See ConversationsService.assign()'s own doc comment.
    return this.conversationsService.assign(
      user,
      siteId,
      conversationId,
      dto.agentId,
      dto.expectedCurrentAgentId,
    );
  }

  @ApiOperation({
    summary:
      'Assign a Visitor to an Agent (conversations.assign) — creates a ' +
      "Conversation if the Visitor doesn't have an open one yet",
    description:
      'Direct user request — the Visitors list "Assign To" picker also works ' +
      'for a Visitor who is only browsing, with no Conversation yet. If one is ' +
      'already open it is reassigned (identical to PATCH .../assign); ' +
      'otherwise a new Conversation is created, assigned to agentId, with no ' +
      'initial message.',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @Post('assign-visitor')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('conversations.assign')
  assignVisitor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Body() dto: AssignVisitorDto,
  ) {
    return this.conversationsService.assignVisitorToAgent(
      user,
      siteId,
      dto.visitorId,
      dto.agentId,
    );
  }

  @ApiOperation({ summary: 'Add a tag to a Conversation (conversations.tag)' })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Post(':conversationId/tags')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('conversations.tag')
  addTag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: TagConversationDto,
  ) {
    return this.conversationsService.addTag(
      user,
      siteId,
      conversationId,
      dto.tag,
    );
  }

  @ApiOperation({
    summary: 'Remove a tag from a Conversation (conversations.tag)',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Delete(':conversationId/tags/:tag')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('conversations.tag')
  removeTag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Param('tag') tag: string,
  ) {
    return this.conversationsService.removeTag(
      user,
      siteId,
      conversationId,
      tag,
    );
  }

  @ApiOperation({
    summary:
      'Post an Agent message (REST-testing only — real-time is Session 8)',
    description:
      'Gated by the same view scope as GET :conversationId (conversations.view_own or .view_site).',
  })
  @ApiBearerAuth('access-token')
  // §6.3 "Rate limiting on ... message sending" — the primary path is the
  // WebSocket gateway's `agent:send_message` (rate-limited via
  // `WsRateLimiterService`); this REST equivalent gets the same 30/min cap,
  // keyed by IP here (no per-user WS-style bucket at the HTTP layer — this
  // route is documented as "REST-testing only" anyway, see the summary
  // above).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Post(':conversationId/messages')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.conversationsService.addAgentMessage(
      user,
      siteId,
      conversationId,
      dto.body,
      dto.attachments,
    );
  }

  @ApiOperation({
    summary:
      "Recent PageVisit trail for this Conversation's Visitor (this session, task requirement 11)",
    description:
      'Same view scope as GET :conversationId (conversations.view_own or .view_site). ' +
      "Sorted most-recent-first, covers the Visitor's whole recent browsing (not just " +
      'pages visited while this specific Conversation was open).',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/page-visits')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  getPageVisits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationsService.getPageVisits(
      user,
      siteId,
      conversationId,
    );
  }

  @ApiOperation({
    summary:
      "This Conversation's own Visitor-path trail (Phase 2, FR-P2-PANEL-02/03, redesigned Session P2-5)",
    description:
      'Same view scope as GET :conversationId (conversations.view_own or ' +
      '.view_site). Returns `{ pages, attributionLabel }` — `pages` chronological ' +
      "ascending, bounded to THIS Conversation's own lead-up browsing (see " +
      'ConversationsService.computeConversationPath for the exact boundary rule; ' +
      'no longer a pure time-gap "current visit"), `attributionLabel` the ' +
      '"Direct traffic"/referring-domain/UTM chip for how the Visitor landed on ' +
      'THIS specific visit. The source the floating window Visitor Info panel ' +
      'builds both the visitor-path trail and the live Time-on-site sum from, ' +
      'client-side.',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/current-visit')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  getCurrentVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationsService.getCurrentVisitPageVisits(
      user,
      siteId,
      conversationId,
    );
  }

  @ApiOperation({
    summary:
      "This Conversation's own Visitor-path trail — identical to GET .../current-visit (Session P2-5 redesign)",
    description:
      'Same view scope as GET :conversationId (conversations.view_own or ' +
      '.view_site). As of the Session P2-5 redesign this computes exactly the ' +
      'same thing GET .../current-visit does — both endpoints kept so neither ' +
      'existing frontend call site had to change which URL it hits in the same ' +
      'pass. See ConversationsService.computeConversationPath for the boundary rule.',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/conversation-visit')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  getConversationVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversationsService.getConversationVisitPageVisits(
      user,
      siteId,
      conversationId,
    );
  }

  @ApiOperation({
    summary:
      'Reconnection resync (FR-MSG-05) — Agent side: messages since a given id/timestamp',
    description:
      'Same view scope as GET :conversationId (conversations.view_own or .view_site). ' +
      'Omit both query params to get the full transcript.',
  })
  @ApiBearerAuth('access-token')
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/messages')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...VIEW_PERMISSIONS])
  getMessagesSince(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @Query() query: GetMessagesSinceQueryDto,
  ) {
    return this.conversationsService.getMessagesSince(
      user,
      siteId,
      conversationId,
      query,
    );
  }

  @ApiOperation({
    summary:
      'Reconnection resync (FR-MSG-05) — Visitor side: messages since a given id/timestamp',
    description:
      'Requires Authorization: Bearer <visitor session token>. Only ever returns messages ' +
      "for a Conversation that belongs to the caller's own visitor session.",
  })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Get(':conversationId/messages/mine')
  @UseGuards(VisitorAuthGuard)
  getMyMessagesSince(
    @CurrentVisitor() visitor: AuthenticatedVisitor,
    @Param('conversationId') conversationId: string,
    @Query() query: GetMessagesSinceQueryDto,
  ) {
    return this.conversationsService.getMessagesSinceForVisitor(
      visitor,
      conversationId,
      query,
    );
  }

  @ApiOperation({
    summary:
      'Submit a satisfaction rating on a closed Conversation (public, no auth)',
    description:
      'FR-WID-13 / FR-CONV-07. No Authorization header of any kind required — only ' +
      'validates that :conversationId is real and already closed.',
  })
  // §6.3 — this is the one fully public, no-auth WRITE endpoint left in the
  // app (see summary above) besides visitor-session/init — rate limit it
  // for the same reason.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam(SITE_ID_PARAM)
  @ApiParam(CONVERSATION_ID_PARAM)
  @Post(':conversationId/rating')
  @HttpCode(HttpStatus.OK)
  submitRating(
    @Param('conversationId') conversationId: string,
    @Body() dto: SubmitRatingDto,
  ) {
    return this.conversationsService.submitRating(conversationId, dto);
  }
}
