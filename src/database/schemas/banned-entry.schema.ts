import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

/**
 * BannedEntry — Feature-2a-backend. Replaces the old boolean-flag ban
 * mechanism (`Visitor.isBanned` + `Site.bannedIps[]`) with a real, listable
 * record per ban, so the dedicated Banned Visitors screen (Settings →
 * Banned) can search/filter/paginate actual ban rows instead of the
 * `VisitorsService.findBanned` merge-on-read workaround it used before this
 * session (a still-`isBanned` Visitor scan + a best-effort audit-log lookup
 * for date/reason, since neither the boolean nor `bannedIps[]` carried a
 * timestamp or reason of its own).
 *
 * One document per ban action:
 *  - Banning a known Visitor (History → "Ban visitor", `VisitorsService.ban`)
 *    writes one entry with both `visitorId` and `ipAddress` populated (their
 *    `currentIp`, or an explicit override).
 *  - Banning a bare IP with no Visitor behind it (Banned Visitors screen's
 *    "Add visitor" → "Add banned IP address", `VisitorsService.banIp`)
 *    writes one entry with `visitorId: null`.
 *
 * `Visitor.isBanned`/`Site.bannedIps` are left in place on their own schemas
 * (existing seeded/historical data keeps whatever value it has — no
 * destructive migration was asked for) but are no longer read or written by
 * any ban path as of this session; see PROGRESS.md.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'banned_entries',
})
export class BannedEntry {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Site',
    required: true,
    index: true,
  })
  siteId!: Types.ObjectId;

  // Nullable — an IP-only ban (Banned Visitors screen's "Add visitor" flow)
  // has no known Visitor behind it at all.
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Visitor',
    default: null,
    index: true,
  })
  visitorId!: Types.ObjectId | null;

  // Nullable — a Visitor-id ban (`VisitorsService.ban`) with no `currentIp`
  // on file and no explicit override has nothing to enforce on the IP side;
  // still recorded so the ban/unban lifecycle has a row to act on. An
  // IP-only ban (`banIp`) always sets this.
  @Prop({ type: String, default: null, index: true })
  ipAddress!: string | null;

  @Prop({ type: String, default: null })
  reason!: string | null;

  // Nullable — Session Feature-2c-complex-actions' "Block visitor" Trigger
  // action creates a ban with no acting User at all (it fires off the
  // Visitor's own reported Trigger match, not an Admin/Agent click). Every
  // human-initiated ban path (`VisitorsService.ban`/`banIp`) still always
  // populates this; nothing in chat-hub-web reads/displays this field today
  // (confirmed via grep), so relaxing it is additive, not a breaking change.
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'User',
    default: null,
  })
  createdByUserId!: Types.ObjectId | null;

  createdAt!: Date;
}

export type BannedEntryDocument = BannedEntry & Document;
export const BannedEntrySchema = SchemaFactory.createForClass(BannedEntry);
// siteId/visitorId/ipAddress already indexed via `index: true` on their
// @Prop above — session-init enforcement queries by {siteId, ipAddress} and
// by {siteId, visitorId} on every single request, so both need to stay
// index-backed the same way T-11's load-testing findings called out for
// other hot-path Visitor queries.
BannedEntrySchema.index({ siteId: 1, ipAddress: 1 });
