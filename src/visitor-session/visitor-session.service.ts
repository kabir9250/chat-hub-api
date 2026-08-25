import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  Site,
  SiteDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  AppJwtPayload,
  VisitorJwtPayload,
} from '../auth/interfaces/jwt-payload.interface';
import { AuthenticatedVisitor } from '../auth/guards/visitor-auth.guard';
import { AnalyticsEventsService } from '../analytics/analytics-events.service';
import {
  AttributionService,
  BuildAttributionInput,
} from '../attribution/attribution.service';
import { LeadsService } from '../leads/leads.service';
import { PageVisitsService } from '../page-visits/page-visits.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { SubmitVisitorProfileDto } from './dto/submit-visitor-profile.dto';

export interface VisitorSessionResult {
  token: string;
  visitorId: string;
  siteId: string;
  isReturningVisitor: boolean;
  pastVisitsCount: number;
  pastChatsCount: number;
}

export interface InitVisitorSessionInput {
  siteId: string;
  /** Legacy fallback — see DTO doc comment. Ignored if `sessionToken` resolves. */
  visitorId?: string;
  /** Raw bearer token from a prior `init` call's response, if the caller has one. */
  sessionToken?: string;
  pageUrl?: string;
  referrer?: string;
  userAgent?: string;
  ip?: string;
}

/**
 * FR-AUTH-02: anonymous Visitor session, no password — issued on first
 * widget load (or reused on return, per FR-WID-11) and used by the widget
 * to authenticate its own REST/WebSocket calls (e.g. sending messages),
 * without ever touching the User/password login flow.
 *
 * This is intentionally a *separate* token kind from the User JWT
 * (`type: 'visitor'` vs `type: 'user'`) — JwtStrategy rejects a Visitor
 * token on any User-protected route. A Visitor-specific guard (if/when a
 * protected widget route needs one) is not built this session; Session 3
 * and the widget-facing sessions can add it reusing the same pattern.
 *
 * **Returning-visitor resolution, session-token-based (this session):**
 * a return visit is recognized by verifying the Visitor JWT the widget
 * already has (sent as `Authorization: Bearer <token>`), NOT by trusting a
 * bare `visitorId` in the request body. A raw id is guessable/copyable by
 * anyone and proves nothing — accepting it at face value would let any
 * caller inflate another Visitor's `pastVisitsCount`, or worse, silently
 * mint themselves a fresh token for an identity they don't actually hold.
 * Verifying the previously-issued JWT (signature + expiry, same as any
 * other token in this app) is real proof of "this is the same browser
 * session Session 2 already gave a token to". The legacy `visitorId` body
 * field from Session 2 is still accepted as a fallback *only* when no
 * verifiable token is presented, for backward compatibility with existing
 * non-browser test flows — flagged in PROGRESS.md as a known gap to close
 * once the widget frontend always sends the bearer token.
 */
@Injectable()
export class VisitorSessionService {
  private readonly logger = new Logger(VisitorSessionService.name);

  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly attributionService: AttributionService,
    private readonly leadsService: LeadsService,
    private readonly pageVisitsService: PageVisitsService,
    private readonly realtimeEvents: RealtimeEventsService,
    private readonly analyticsEvents: AnalyticsEventsService,
  ) {}

  /**
   * FR-WID-05: the widget's pre-chat form. Visitor-facing (VisitorAuthGuard
   * only — no RBAC concept applies to a Visitor), distinct from
   * `VisitorsService.update` (Session 6, Agent/Admin-facing, gated by
   * `visitors.edit`). Also re-syncs the Visitor's Lead (FR-VIS-08) since
   * submitting name/email is exactly the qualifying event.
   */
  async submitProfile(
    visitor: AuthenticatedVisitor,
    dto: SubmitVisitorProfileDto,
  ): Promise<{
    visitorId: string;
    name: string;
    email: string;
    phone: string | null;
  }> {
    const visitorDoc = await this.visitorModel
      .findOne({ _id: visitor.visitorId, siteId: visitor.siteId })
      .exec();
    if (!visitorDoc) {
      throw new NotFoundException('Visitor not found on this Site.');
    }
    if (visitorDoc.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from starting new chats on this Site.',
      );
    }

    visitorDoc.name = dto.name.trim();
    visitorDoc.email = dto.email.trim().toLowerCase();
    if (dto.phone !== undefined) {
      visitorDoc.phone = dto.phone.trim();
    }
    if (dto.customFields !== undefined) {
      visitorDoc.customFields = {
        ...visitorDoc.customFields,
        ...dto.customFields,
      };
    }
    await visitorDoc.save();

    await this.leadsService.syncLeadForVisitor(visitorDoc);

    await this.auditLogService.record({
      actorType: 'visitor',
      actorId: visitorDoc._id,
      action: 'visitor_session.profile_submitted',
      siteId: visitorDoc.siteId,
      targetType: 'Visitor',
      targetId: visitorDoc._id,
    });

    await this.emitProfileUpdated(visitorDoc);

    return {
      visitorId: visitorDoc._id.toString(),
      name: visitorDoc.name,
      email: visitorDoc.email,
      phone: visitorDoc.phone,
    };
  }

  async init(input: InitVisitorSessionInput): Promise<VisitorSessionResult> {
    const site = await this.siteModel.findById(input.siteId).exec();
    if (!site) {
      throw new NotFoundException('Unknown siteId.');
    }

    const attributionInput: BuildAttributionInput = {
      pageUrl: input.pageUrl,
      referrer: input.referrer,
      userAgent: input.userAgent,
      ip: input.ip,
    };
    const attribution = await this.attributionService.build(attributionInput);

    // FR-VIS-07 / §6.3: enforce the ban list before anything else — a
    // banned IP is blocked from opening a new chat on this Site even if
    // they show up with no visitorId/token at all (cleared cookies).
    if (
      attribution.currentIp &&
      site.bannedIps.includes(attribution.currentIp)
    ) {
      throw new ForbiddenException(
        'This IP address has been banned from starting new chats on this Site.',
      );
    }

    let visitor = await this.resolveReturningVisitor(
      input.sessionToken,
      input.visitorId,
      site,
    );

    if (visitor?.isBanned) {
      throw new ForbiddenException(
        'This visitor has been banned from starting new chats on this Site.',
      );
    }

    const attributionFields = this.toVisitorFields(attribution);
    const isReturningVisitor = !!visitor;
    if (visitor) {
      // Returning visitor — bump the counters SRS §4.4/FR-VIS-05 asks for,
      // and refresh attribution/technical fields to reflect *this* widget
      // load (the "current page URL"/"current" wording in FR-VIS-01) —
      // see PROGRESS.md for why this session chose "refresh every visit"
      // over "freeze at first visit" for these singular (non-array) fields.
      //
      // Session P2-5 redesign (direct user feedback) — BUG FIX:
      // `pastVisitsCount` used to increment unconditionally here, once per
      // `init()` call. Since `init()` fires on every widget boot — every
      // full page load, for a traditional multi-page site — a Visitor
      // browsing 5 pages in one sitting inflated this counter by 5, not the
      // 1 genuine visit it actually was. Now only bumped when
      // `PageVisitsService.isNewVisit()` says this page load starts a
      // genuinely new visit (the same 30-minute gap rule "current visit"
      // grouping already uses elsewhere) — see that method's own doc
      // comment. This also directly satisfies the user's separate ask that
      // a chatless visit ("open the home page and close the website") still
      // increments the count: `init()` (and this check) run regardless of
      // whether a Conversation ever exists.
      visitor.lastSeenAt = new Date();
      if (await this.pageVisitsService.isNewVisit(visitor._id)) {
        visitor.pastVisitsCount += 1;
      }
      Object.assign(visitor, attributionFields);
      await visitor.save();
    } else {
      visitor = await this.visitorModel.create({
        siteId: site._id,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        pastVisitsCount: 1,
        pastChatsCount: 0,
        ...attributionFields,
      });
    }

    // FR-RPT-01 (this session) — every `init()` call is one "visit" (a
    // widget load/session bootstrap, whether resuming or brand-new), so
    // `totalVisit` fires unconditionally; `uniqueVisitor` only fires in the
    // `else` branch above (a genuinely new Visitor document was just
    // created) — this is what gives "Unique visitors" its standard meaning
    // (distinct people) as distinct from "Total visits" (every session,
    // including repeat visits from the same Visitor).
    await this.analyticsEvents.record({
      siteId: site._id,
      type: 'totalVisit',
      visitorId: visitor._id,
      pageUrl: input.pageUrl,
    });
    if (!isReturningVisitor) {
      await this.analyticsEvents.record({
        siteId: site._id,
        type: 'uniqueVisitor',
        visitorId: visitor._id,
        pageUrl: input.pageUrl,
      });
    }

    // This session's addition (task requirements 2/8, PageVisit §4.4a) — a
    // fresh `init` call is, for a traditional multi-page site, ALSO "a page
    // navigation": a new full page load means a new iframe/widget mount,
    // which calls `init` again with the new page's URL. Wiring the close-
    // previous/open-new PageVisit logic in here (rather than only behind
    // the WS `visitor:page_changed` handler) means standard multi-page nav
    // is tracked with zero extra widget-side wiring — see
    // PageVisitsService's doc comment. Best-effort: never let a page-visit
    // write failure break session init itself.
    //
    // BUG FIX (found via manual testing after this session's own
    // protocol-level smoke test missed it): the very first version of this
    // call never passed `conversationId`, so a real Visitor navigating
    // between actual pages of a multi-page site (full reload each time —
    // exactly `test-page/index.html` <-> `pricing.html`) never produced a
    // live `visitor.pageChanged` broadcast, even with an active
    // Conversation already open — `PageVisitsService.recordPageChange`
    // only emits when a conversationId is known (see its doc comment). The
    // WS `visitor:page_changed` path (SPA route changes) always had this
    // right because the Widget already tracks its own `conversationId`
    // client-side; `init()` has no such client-supplied value, so it looks
    // its own up here.
    if (input.pageUrl) {
      try {
        const conversationId = await this.findLatestConversationId(visitor._id);
        await this.pageVisitsService.recordPageChange({
          siteId: site._id,
          visitorId: visitor._id,
          conversationId,
          pageUrl: input.pageUrl,
          // Session P2-5 redesign — snapshot THIS call's own attribution
          // onto the PageVisit row itself (see that schema's doc comment on
          // why `Visitor.referrer`/`visitorPath` alone isn't enough for a
          // per-past-visit "where did they land from" chip).
          attribution: {
            referrer: attribution.referrer,
            landingPage: attribution.landingPage,
            utmSource: attribution.utmSource,
            utmMedium: attribution.utmMedium,
            utmCampaign: attribution.utmCampaign,
            visitorPathLabel: attribution.visitorPath,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to record PageVisit during visitor-session init: ${(err as Error).message}`,
        );
      }
    }

    const payload: VisitorJwtPayload = {
      sub: visitor._id.toString(),
      siteId: site._id.toString(),
      type: 'visitor',
    };
    const token = this.jwtService.sign(payload);

    await this.auditLogService.record({
      actorType: 'visitor',
      actorId: visitor._id,
      action: isReturningVisitor
        ? 'visitor_session.resumed'
        : 'visitor_session.init',
      siteId: site._id,
      metadata: {
        visitorPath: visitor.visitorPath,
        pastVisitsCount: visitor.pastVisitsCount,
      },
    });

    return {
      token,
      visitorId: visitor._id.toString(),
      siteId: site._id.toString(),
      isReturningVisitor,
      pastVisitsCount: visitor.pastVisitsCount,
      pastChatsCount: visitor.pastChatsCount,
    };
  }

  private async resolveReturningVisitor(
    sessionToken: string | undefined,
    legacyVisitorId: string | undefined,
    site: SiteDocument,
  ): Promise<VisitorDocument | null> {
    if (sessionToken) {
      const payload = this.verifyVisitorToken(sessionToken);
      if (payload && payload.siteId === site._id.toString()) {
        const visitor = await this.visitorModel
          .findOne({ _id: payload.sub, siteId: site._id })
          .exec();
        if (visitor) {
          return visitor;
        }
      }
      // A present-but-invalid/expired/cross-Site token falls through to the
      // legacy id (if any) or a brand-new session — never hard-fails the
      // request just because an old token expired.
    }

    if (legacyVisitorId) {
      return this.visitorModel
        .findOne({ _id: legacyVisitorId, siteId: site._id })
        .exec();
    }

    return null;
  }

  /**
   * This session's addition (task requirement 4) — broadcasts
   * `visitor.profileUpdated` to whichever `conversation:<id>` room the
   * Visitor's most recent Conversation lives in (there is no dedicated
   * "per-Visitor" room, per the task guardrail — reuse Session 8's
   * conversation-room pattern), so the Agent Console's Visitor Info panel
   * updates live when the pre-chat form is submitted. Sends the full raw
   * Visitor document — the same shape `ConversationsService.findOne`'s
   * `populate('visitorId')` already sends, so the frontend's existing
   * Visitor-mapping code needs no new parsing logic. If the Visitor has no
   * Conversation yet, there is nothing to broadcast to (no Agent Console
   * could possibly have this Visitor open) — a silent no-op, not an error.
   */
  private async emitProfileUpdated(visitor: VisitorDocument): Promise<void> {
    const conversationId = await this.findLatestConversationId(visitor._id);
    if (!conversationId) return;

    this.realtimeEvents.emit({
      kind: 'visitor.profileUpdated',
      siteId: visitor.siteId.toString(),
      conversationId,
      visitor: visitor.toObject() as Record<string, unknown>,
    });
  }

  /**
   * Shared by `emitProfileUpdated` above and `init()`'s PageVisit tracking
   * — "which `conversation:<id>` room (if any) should this Visitor's live
   * events go to." Returns `null` if the Visitor has no Conversation yet
   * (nothing to broadcast to — not an error).
   */
  private async findLatestConversationId(
    visitorId: Types.ObjectId,
  ): Promise<string | null> {
    const conversation = await this.conversationModel
      .findOne({ visitorId })
      .sort({ startedAt: -1 })
      .select('_id')
      .lean()
      .exec();
    return conversation ? conversation._id.toString() : null;
  }

  private verifyVisitorToken(token: string): VisitorJwtPayload | null {
    try {
      const payload = this.jwtService.verify<AppJwtPayload>(token);
      if (payload.type !== 'visitor') {
        return null;
      }
      return payload;
    } catch (err) {
      this.logger.debug(
        `Ignoring unverifiable visitor session token: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Maps AttributionService's `string | null` shape onto the Visitor
   * schema's `string | undefined` optional fields (Mongoose treats both as
   * "not set", but the TS field types on the schema class are `?: string`,
   * not `| null`) — one place both the create and update paths share so
   * they can never drift into mapping a field differently.
   */
  private toVisitorFields(
    attribution: Awaited<ReturnType<AttributionService['build']>>,
  ) {
    return {
      currentIp: attribution.currentIp ?? undefined,
      location: {
        city: attribution.location.city,
        region: attribution.location.region,
        country: attribution.location.country,
      },
      browser: attribution.browser ?? undefined,
      os: attribution.os ?? undefined,
      deviceType: attribution.deviceType,
      userAgentRaw: attribution.userAgentRaw ?? undefined,
      referrer: attribution.referrer ?? undefined,
      landingPage: attribution.landingPage ?? undefined,
      utmSource: attribution.utmSource ?? undefined,
      utmMedium: attribution.utmMedium ?? undefined,
      utmCampaign: attribution.utmCampaign ?? undefined,
      visitorPath: attribution.visitorPath,
    };
  }
}
