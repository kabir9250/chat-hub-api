import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VisitorAuthGuard } from '../auth/guards/visitor-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentVisitor } from '../auth/decorators/current-visitor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';
import { PermissionGuard } from '../rbac/guards/permission.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CONVERSATION_VIEW_PERMISSIONS } from '../conversations/conversations.constants';
import { ConversationsService } from '../conversations/conversations.service';
import { UPLOAD_HARD_CAP_BYTES } from '../storage/attachment-validation';
import { StorageService } from '../storage/storage.service';
import { WidgetConfigService } from '../widget-config/widget-config.service';
import { AttachmentsService } from './attachments.service';

const UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: UPLOAD_HARD_CAP_BYTES },
};

/**
 * FR-P2-ATT-01/02/05/06/08, SRS §5.1. Two upload routes (Agent vs Visitor —
 * same split every other Conversation-scoped action in this codebase uses,
 * e.g. ConversationsController's messages routes), one shared file-serving
 * route.
 *
 * Multipart upload was chosen over the signed-URL-issuance alternative SRS
 * §5.1 offers (noted per that section's own instruction): with the storage
 * backend currently a local disk (this session's product decision — see
 * PROGRESS.md), there's no third-party bucket endpoint for a browser to PUT
 * to directly, so the bytes have to reach this server either way — a plain
 * multipart POST is the more direct route, with no extra round trip to
 * mint a presigned PUT first. `AttachmentsService`/`StorageService` are the
 * only things that would need to change to add direct-to-bucket signed-URL
 * uploads later; this controller's shape can stay.
 */
@ApiTags('Attachments')
@Controller()
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly conversationsService: ConversationsService,
    private readonly storage: StorageService,
    private readonly widgetConfigService: WidgetConfigService,
  ) {}

  /**
   * Phase 2 §3.9 — the Site-level on/off switch (Admin Panel, both
   * surfaces per product decision), enforced HERE, not just by hiding the
   * attach button client-side — a client-side-only toggle wouldn't actually
   * stop a direct API call. Checked on every upload, Agent and Visitor
   * alike, before any file validation/write happens.
   */
  private async assertAttachmentsEnabled(siteId: string): Promise<void> {
    const enabled =
      await this.widgetConfigService.isAttachmentsEnabledForSite(siteId);
    if (!enabled) {
      throw new ForbiddenException('Attachments are turned off for this Site.');
    }
  }

  @ApiOperation({
    summary: 'Upload an attachment as an Agent — FR-P2-ATT-01/05/06',
    description:
      'Gated by the same view scope as sending a message in this Conversation ' +
      '(conversations.view_own or .view_site — same as POST .../messages). ' +
      'Returns attachment metadata only (key/fileName/fileType/fileSizeBytes) — ' +
      'send it as a message via POST .../messages (or the agent:send_message ' +
      'WebSocket event) with that metadata in `attachments`.',
  })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'siteId', example: '507f1f77bcf86cd799439011' })
  @ApiParam({ name: 'conversationId', example: '507f1f77bcf86cd799439050' })
  // Same spirit as the message-send routes' own rate limit (§6.3) — a
  // little tighter since a file upload is heavier than a text send.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sites/:siteId/conversations/:conversationId/attachments')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission([...CONVERSATION_VIEW_PERMISSIONS])
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async uploadAsAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('siteId') siteId: string,
    @Param('conversationId') conversationId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // PermissionGuard only confirmed the caller holds a view permission on
    // this SITE — this confirms they can see THIS specific Conversation
    // (view_own vs view_site scoping), the same check addAgentMessage runs.
    await this.conversationsService.assertAgentConversationAccess(
      user,
      siteId,
      conversationId,
    );
    await this.assertAttachmentsEnabled(siteId);
    return this.attachmentsService.storeUpload({
      siteId,
      conversationId,
      file,
    });
  }

  @ApiOperation({
    summary: 'Upload an attachment as a Visitor — FR-P2-ATT-02/05/06',
    description:
      'Visitor session token required (Authorization: Bearer <token>). Ownership ' +
      'is checked the same way as sending a message (addVisitorMessage) — no RBAC ' +
      'concept applies to a Visitor.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'conversationId', example: '507f1f77bcf86cd799439050' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('conversations/:conversationId/attachments/mine')
  @UseGuards(VisitorAuthGuard)
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async uploadAsVisitor(
    @CurrentVisitor() visitor: AuthenticatedVisitor,
    @Param('conversationId') conversationId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const conversation =
      await this.conversationsService.assertVisitorConversationAccess(
        visitor,
        conversationId,
      );
    await this.assertAttachmentsEnabled(conversation.siteId.toString());
    return this.attachmentsService.storeUpload({
      siteId: conversation.siteId.toString(),
      conversationId,
      file,
    });
  }

  /**
   * FR-P2-ATT-08 — deliberately NO JwtAuthGuard/VisitorAuthGuard/permission
   * check here. The access check already happened once, at the moment this
   * exact URL was minted (StorageService.getSignedUrl is only ever called
   * from message-serialization code in ConversationsService, which by then
   * has already run assertVisible — Agent — or the Visitor-ownership check
   * — Visitor). Re-checking here would need the caller to also send a
   * Bearer token, which an `<img src>`/plain link can't do — the signature
   * itself (key + fileName + fileType + expiry, HMAC'd) IS the
   * authorization, exactly like a real S3/R2 presigned GET URL. An attacker
   * without a validly-signed link — including anyone who never had
   * permission to view this Conversation in the first place, since they
   * never received one — gets a 403 here, not the file.
   */
  @ApiOperation({
    summary: 'Fetch an attachment via a short-lived signed link — FR-P2-ATT-08',
    description:
      'Not meant to be called directly — the URL is only ever handed out, ' +
      "pre-signed and short-lived, inside a message's `attachments[].url`/" +
      '`.thumbnailUrl`.',
  })
  @Get('attachments/file')
  serveFile(
    @Query('key') key: string,
    @Query('name') name: string,
    @Query('type') type: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    if (!key || !name || !type || !exp || !sig) {
      throw new BadRequestException('Malformed attachment link.');
    }
    const expNum = Number(exp);
    if (
      !this.storage.verifySignedAccess({
        key,
        fileName: name,
        fileType: type,
        exp: expNum,
        sig,
      })
    ) {
      throw new ForbiddenException(
        'This attachment link has expired or is invalid — reload the conversation for a fresh one.',
      );
    }
    if (!this.storage.fileExists(key)) {
      throw new NotFoundException('Attachment not found.');
    }
    const absolutePath = this.storage.resolveAbsolutePath(key);
    res.setHeader('Content-Type', type);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(name, type.startsWith('image/')),
    );
    // helmet() (main.ts) sets Cross-Origin-Resource-Policy: same-origin by
    // default on every response — correct for the rest of this JSON API
    // (only ever consumed via fetch/XHR, which CORP doesn't govern), but it
    // silently blocks THIS route's whole reason for existing: the Widget
    // and Agent Console (chat-hub-web, a different origin/port) load these
    // URLs directly via `<img src>`/`<a href>`, which CORP DOES govern.
    // Found live (Chrome logged `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`
    // during this session's own browser verification) — a signed URL is
    // already this route's entire access control (see this handler's doc
    // comment), so relaxing CORP specifically here doesn't widen anything.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Short private cache — the URL itself expires in
    // ATTACHMENT_SIGNED_URL_TTL_SECONDS anyway; this just avoids re-fetching
    // the same image/file on every re-render within that window.
    res.setHeader('Cache-Control', 'private, max-age=60');
    createReadStream(absolutePath).pipe(res);
  }
}

function contentDisposition(fileName: string, inline: boolean): string {
  const safe = fileName.replace(/[\r\n"]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
