import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Site, SiteDocument } from '../database/schemas/site.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

/**
 * SitesService — catalog's `sites.view`/`sites.manage` ("Owner-level in
 * Phase 1"). Sites ARE the top-level Site-scoped boundary themselves (SRS
 * §4.1/§4.2), unlike every other `*.service.ts` in this codebase (which
 * reads/writes something HANGING OFF a Site) — so `findAll`/`create` have no
 * parent Site to scope against and are Organization-wide, same as
 * `RolesService`. `update` (the one route with a `:siteId`) still
 * re-asserts `organizationId` the same way every other module's
 * `assertSite` does.
 *
 * This session's addition: `chatEnabled` (site.schema.ts) — a Site can only
 * have chat live if it actually has somewhere to run. `update` is the only
 * place that flag can flip, and it enforces that invariant on every save
 * that would leave it `true` (whether the flip itself, an edit that clears
 * `domains` out from under an already-enabled Site, or both in one
 * request) — not just at the moment it's turned on.
 */
@Injectable()
export class SitesService {
  constructor(
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(actor: AuthenticatedUser): Promise<SiteDocument[]> {
    return this.siteModel
      .find({ organizationId: actor.organizationId })
      .sort({ name: 1 })
      .exec();
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateSiteDto,
  ): Promise<SiteDocument> {
    const domains = this.normalizeDomains(dto.domains ?? []);
    const site = await this.siteModel.create({
      organizationId: actor.organizationId,
      name: dto.name.trim(),
      domains,
      timezone: dto.timezone?.trim() || 'UTC',
      // Always starts disabled, regardless of `domains` above — an admin
      // comes back and turns it on explicitly via `update` (which is where
      // the "must have a URL" check actually lives).
      chatEnabled: false,
      status: 'active',
    });

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'site.created',
      siteId: site._id,
      targetType: 'Site',
      targetId: site._id,
      metadata: { name: site.name, domains: site.domains },
    });

    return site;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    dto: UpdateSiteDto,
  ): Promise<SiteDocument> {
    const site = await this.assertSite(actor, siteId);

    const before = {
      name: site.name,
      domains: [...site.domains],
      timezone: site.timezone,
      chatEnabled: site.chatEnabled,
      status: site.status,
    };

    if (dto.name !== undefined) site.name = dto.name.trim();
    if (dto.domains !== undefined)
      site.domains = this.normalizeDomains(dto.domains);
    if (dto.timezone !== undefined) site.timezone = dto.timezone.trim();
    if (dto.status !== undefined) site.status = dto.status;
    if (dto.chatEnabled !== undefined) site.chatEnabled = dto.chatEnabled;

    // The check this session adds: chat can never be left ON for a Site
    // with no URL — checked against the fully-applied result above (not
    // just `dto.chatEnabled`) so it also catches "clear `domains` while
    // chat is already on" in the same request, not only the enable flip
    // itself.
    if (site.chatEnabled && site.domains.length === 0) {
      throw new BadRequestException(
        'Add at least one Site URL before enabling chat on this Site.',
      );
    }

    await site.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'site.updated',
      siteId: site._id,
      targetType: 'Site',
      targetId: site._id,
      metadata: {
        before,
        after: {
          name: site.name,
          domains: site.domains,
          timezone: site.timezone,
          chatEnabled: site.chatEnabled,
          status: site.status,
        },
      },
    });

    return site;
  }

  /** Trims, strips a leading scheme and trailing slash, lowercases, and
   * dedupes — so "https://Example.com/" and "example.com" don't end up as
   * two different entries a visitor's origin has to happen to match. */
  private normalizeDomains(domains: string[]): string[] {
    const cleaned = domains
      .map((d) =>
        d
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/\/+$/, '')
          .toLowerCase(),
      )
      .filter((d) => d.length > 0);
    return [...new Set(cleaned)];
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
