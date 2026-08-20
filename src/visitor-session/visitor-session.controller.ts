import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { VisitorSessionService } from './visitor-session.service';
import { InitVisitorSessionDto } from './dto/init-visitor-session.dto';
import { SubmitVisitorProfileDto } from './dto/submit-visitor-profile.dto';
import { extractClientIp } from '../attribution/extract-client-ip.util';
import { VisitorAuthGuard } from '../auth/guards/visitor-auth.guard';
import { CurrentVisitor } from '../auth/decorators/current-visitor.decorator';
import type { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';

@ApiTags('Visitor Session')
@Controller('visitor-session')
export class VisitorSessionController {
  constructor(private readonly visitorSessionService: VisitorSessionService) {}

  // FR-AUTH-02: issues (or resumes) an anonymous Visitor session token
  // for the given siteId. No password, no User account involved.
  // FR-VIS-01–05: also captures referrer/landing page/UTM/IP-geo/UA
  // attribution and increments the returning visitor's pastVisitsCount.
  @ApiOperation({
    summary: 'Start (or resume) an anonymous visitor session',
    description:
      'No login required — this is for the public chat widget, not Agents/Admins. ' +
      'Returns a separate visitor-only token that will NOT work on any /auth or admin endpoint. ' +
      "To resume a prior session (FR-WID-11), send that session's token back as " +
      '`Authorization: Bearer <token>` — this is also what proves the request is ' +
      'genuinely that returning visitor, so pastVisitsCount only increments for real.',
  })
  @ApiHeader({
    name: 'Authorization',
    required: false,
    description:
      'Bearer <prior visitor session token>, to resume that session instead of starting a new one.',
  })
  // §6.3 — this is the only fully public, unauthenticated write endpoint a
  // visitor can call before any session token exists at all, so it gets its
  // own (generous but real) cap: 20 session-inits per IP per minute.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('init')
  @HttpCode(HttpStatus.OK)
  init(@Body() dto: InitVisitorSessionDto, @Req() req: Request) {
    const authHeader = req.headers['authorization'];
    const sessionToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;

    return this.visitorSessionService.init({
      siteId: dto.siteId,
      visitorId: dto.visitorId,
      sessionToken,
      pageUrl: dto.pageUrl,
      referrer: dto.referrer,
      userAgent: req.headers['user-agent'],
      ip: extractClientIp(req),
    });
  }

  // FR-WID-05: the widget's pre-chat form — Name/Email required, Phone
  // optional — submitted by the Visitor before their first message.
  @ApiOperation({
    summary: 'Submit the pre-chat form (Name/Email required, Phone optional)',
    description:
      'Requires Authorization: Bearer <visitor session token> from POST /visitor-session/init. ' +
      "Also syncs this Visitor's Lead record (FR-VIS-08).",
  })
  // §6.3 "Rate limiting on pre-chat form submission" — this IS the pre-chat
  // form endpoint (FR-WID-05: Name/Email/Phone). 10 submissions/minute per
  // IP is generous for a human filling in a form once, tight enough to stop
  // a script hammering it.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('profile')
  @UseGuards(VisitorAuthGuard)
  submitProfile(
    @CurrentVisitor() visitor: AuthenticatedVisitor,
    @Body() dto: SubmitVisitorProfileDto,
  ) {
    return this.visitorSessionService.submitProfile(visitor, dto);
  }
}
