import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Lead,
  LeadDocument,
  LeadStatus,
  Visitor,
  VisitorDocument,
  Site,
  SiteDocument,
} from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

export interface LeadListItem {
  leadId: string;
  status: LeadStatus;
  leadCreatedAt: Date;
  leadUpdatedAt: Date;
  visitor: VisitorDocument;
}

/**
 * LeadsService — FR-VIS-08 / §5.11 FR-RPT-05.
 *
 * "Lead" is NOT a duplicate of Visitor — it's a thin status-tracking record
 * (SRS §4.9: "a tracked view of Visitor+Conversation") layered on top of the
 * existing Visitor collection (Session 1's `Lead` schema, unused until now
 * — see PROGRESS.md "reuse, don't duplicate" note). A Visitor becomes a
 * Lead purely by having a `name` or `email` captured; this service's job is
 * to keep exactly one Lead document per qualifying Visitor in sync with
 * that fact, and to own the one thing Visitor itself doesn't model: a
 * manually-managed `status` (new/contacted/converted/lost, FR-VIS-08) that
 * must never be silently reset just because a Visitor's profile changed.
 *
 * Phase 3 SRS §3.1's "Lead Creation Settings" (automatic/manual creation,
 * transcript visibility, last/first-agent assignment) were built, then
 * scrapped in favor of a simpler Tickets screen (see `tickets/`) — this
 * service is back to its original, always-automatic shape.
 */
@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Visitor.name)
    private readonly visitorModel: Model<VisitorDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Qualification rule, FR-VIS-08: "at least a Name or Email captured." */
  static qualifies(visitor: Pick<Visitor, 'name' | 'email'>): boolean {
    return !!(visitor.name || visitor.email);
  }

  /**
   * Ensures a qualifying Visitor has exactly one Lead document, creating it
   * with status `new` if missing. Never touches `status` on an existing
   * Lead — that field belongs to whoever's managing the lead (leads.manage),
   * not to whatever caused the Visitor's profile to be re-saved. A no-op
   * (and does not delete any existing Lead) if the Visitor no longer
   * qualifies — SRS doesn't ask for de-listing a Lead once created, and a
   * Visitor whose name/email an Agent clears out is an edge case not worth
   * silently discarding lead-tracking history for.
   */
  async syncLeadForVisitor(
    visitor: VisitorDocument,
  ): Promise<LeadDocument | null> {
    if (!LeadsService.qualifies(visitor)) {
      return null;
    }

    const existing = await this.leadModel
      .findOne({ visitorId: visitor._id })
      .exec();
    if (existing) {
      return existing;
    }

    return this.leadModel.create({
      siteId: visitor.siteId,
      visitorId: visitor._id,
      status: 'new',
    });
  }

  /**
   * FR-VIS-08's read model: every qualifying Visitor on the Site, with its
   * Lead status attached. Self-healing — if a qualifying Visitor somehow
   * has no Lead doc yet (e.g. qualified via a future write path that
   * doesn't call `syncLeadForVisitor`), one is created on the fly here
   * rather than the endpoint silently omitting them.
   */
  async findAllForSite(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<LeadListItem[]> {
    const site = await this.assertSite(actor, siteId);

    const qualifyingVisitors = await this.visitorModel
      .find({
        siteId: site._id,
        $or: [{ name: { $ne: null } }, { email: { $ne: null } }],
      })
      .sort({ lastSeenAt: -1 })
      .exec();

    const items: LeadListItem[] = [];
    for (const visitor of qualifyingVisitors) {
      const lead = await this.syncLeadForVisitor(visitor);
      if (!lead) continue; // defensive — qualifyingVisitors are already filtered
      items.push({
        leadId: lead._id.toString(),
        status: lead.status,
        leadCreatedAt: lead.createdAt,
        leadUpdatedAt: lead.updatedAt,
        visitor,
      });
    }
    return items;
  }

  async updateStatus(
    actor: AuthenticatedUser,
    siteId: string,
    leadId: string,
    status: LeadStatus,
  ): Promise<LeadDocument> {
    const site = await this.assertSite(actor, siteId);

    const lead = await this.leadModel
      .findOne({ _id: leadId, siteId: site._id })
      .exec();
    if (!lead) {
      throw new NotFoundException('Lead not found on this Site.');
    }

    const before = lead.status;
    lead.status = status;
    await lead.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'lead.status_updated',
      siteId: site._id,
      targetType: 'Lead',
      targetId: lead._id,
      metadata: { before, after: status, visitorId: lead.visitorId.toString() },
    });

    return lead;
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
