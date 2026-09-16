import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  ConversationSubmissionChannel,
  Message,
  MessageDocument,
  Site,
  SiteDocument,
  Visitor,
  VisitorDocument,
} from '../database/schemas';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { LeadsService } from '../leads/leads.service';
import { ListTicketsQueryDto } from './dto/list-tickets.query.dto';

export interface TicketListItem {
  conversationId: string;
  channel: ConversationSubmissionChannel;
  status: ConversationDocument['status'];
  startedAt: Date;
  visitor: VisitorDocument;
}

/**
 * Tickets screen (Phase 3) — replaces the scrapped Lead Creation Settings
 * concept. Two tabs: every 'online' Conversation whose Visitor qualifies as
 * a Lead (FR-VIS-08, `LeadsService.qualifies` — name or email captured),
 * and every 'offline' Conversation (an Offline Contact Form submission,
 * FR-WID-10) regardless of qualification — the submission itself is the
 * record, per the SRS reimagining's own "can also see the offline lead
 * form filled by visitors" ask.
 *
 * `Conversation.submissionChannel` is the real, persisted signal this
 * relies on (see conversation.schema.ts's own doc comment) — set once at
 * creation time in `ConversationsService.create()`/`startProactiveConversation`,
 * not inferred at read time the way the scrapped LeadsService.
 * resolveApplicableSettings used to guess it.
 */
@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
  ) {}

  async findAllForSite(
    actor: AuthenticatedUser,
    siteId: string,
    query: ListTicketsQueryDto,
  ): Promise<TicketListItem[]> {
    const site = await this.assertSite(actor, siteId);

    const match: FilterQuery<ConversationDocument> = { siteId: site._id };
    if (query.channel) {
      match.submissionChannel = query.channel;
    }
    this.applyDateRange(match, 'startedAt', query.dateFrom, query.dateTo);

    const conversations = await this.conversationModel
      .find(match)
      .sort({ startedAt: -1 })
      .exec();
    if (conversations.length === 0) return [];

    const visitors = await this.visitorModel
      .find({ _id: { $in: conversations.map((c) => c.visitorId) } })
      .exec();
    const visitorById = new Map(
      visitors.map((v) => [v._id.toString(), v] as const),
    );

    const items: TicketListItem[] = [];
    for (const conversation of conversations) {
      const visitor = visitorById.get(conversation.visitorId.toString());
      if (!visitor) continue; // defensive — Visitor should always exist

      // Online tab is scoped to qualifying Visitors only (today's existing
      // Lead concept); Offline tab shows every submission regardless.
      if (
        conversation.submissionChannel === 'online' &&
        !LeadsService.qualifies(visitor)
      ) {
        continue;
      }

      items.push({
        conversationId: conversation._id.toString(),
        channel: conversation.submissionChannel,
        status: conversation.status,
        startedAt: conversation.startedAt,
        visitor,
      });
    }
    return items;
  }

  /**
   * Transcript built live from Message, not a one-time snapshot — the
   * scrapped Lead.transcriptText concept snapshotted once at Lead-creation
   * time; a Ticket's transcript should always reflect the Conversation's
   * current, full message history, including Conversations that never
   * qualified as a Lead at all (an offline submission with no name/email).
   */
  async getTranscript(
    actor: AuthenticatedUser,
    siteId: string,
    conversationId: string,
  ): Promise<string | null> {
    const site = await this.assertSite(actor, siteId);

    const conversation = await this.conversationModel
      .findOne({ _id: conversationId, siteId: site._id })
      .exec();
    if (!conversation) {
      throw new NotFoundException('Conversation not found on this Site.');
    }

    const messages = await this.messageModel
      .find({ conversationId: conversation._id })
      .sort({ sentAt: 1 })
      .exec();
    if (messages.length === 0) return null;

    return messages
      .map((m) => `[${m.senderType}] ${m.body ?? '(attachment)'}`)
      .join('\n');
  }

  /** Same convention `AnalyticsService.applyDateRange`/`endOfDayIfBareDate`
   * already established (FR-RPT-02/03/04/05) — copied rather than shared
   * since those are `private` on AnalyticsService and this is the only
   * other consumer. */
  private applyDateRange(
    match: Record<string, unknown>,
    field: string,
    dateFrom?: string,
    dateTo?: string,
  ): void {
    if (!dateFrom && !dateTo) return;
    const range: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = this.endOfDayIfBareDate(dateTo);
    match[field] = range;
  }

  private endOfDayIfBareDate(dateTo: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      const d = new Date(dateTo);
      d.setUTCHours(23, 59, 59, 999);
      return d;
    }
    return new Date(dateTo);
  }

  private async assertSite(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteDocument> {
    const site = await this.siteModel
      .findOne({ _id: siteId, organizationId: actor.organizationId })
      .exec();
    if (!site) {
      throw new NotFoundException('Site not found in this Organization.');
    }
    return site;
  }
}
