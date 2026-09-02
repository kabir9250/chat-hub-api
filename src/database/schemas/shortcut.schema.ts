import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';

// -----------------------------------------------------------------------
// Phase 2, SRS §2.4 / §3.11 (FR-P2-SHORT-01–08) — Shortcuts (Canned
// Responses). A Shortcut belongs to exactly one of three visibility
// scopes; `siteId` is required (and only meaningful) at `SITE` scope —
// see ShortcutsService.assertCanManageScope for how each scopeLevel maps
// to the matching `shortcuts.manage_*` permission (RBAC design, Phase 1
// §5.13), enforced server-side, not just by the Agent Console's Level
// picker (FR-P2-SHORT-04).
// -----------------------------------------------------------------------

export const SHORTCUT_SCOPE_LEVELS = [
  'PERSONAL',
  'SITE',
  'ORGANIZATION',
] as const;
export type ShortcutScopeLevel = (typeof SHORTCUT_SCOPE_LEVELS)[number];

/** Shortcut (Canned Response) — SRS §2.4. */
@Schema({
  timestamps: { createdAt: true, updatedAt: true },
  collection: 'shortcuts',
})
export class Shortcut {
  _id!: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  })
  organizationId!: Types.ObjectId;

  // Indexed via the explicit `ShortcutSchema.index({ createdByUserId: 1 })`
  // below, not `index: true` here — avoids Mongoose's duplicate-index
  // warning when both forms target the same field.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  createdByUserId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: SHORTCUT_SCOPE_LEVELS })
  scopeLevel!: ShortcutScopeLevel;

  // Required only when scopeLevel === 'SITE' — enforced in ShortcutsService,
  // not at the Mongoose level (a conditional-required field per sibling
  // value doesn't map cleanly onto @Prop's own `required`), same approach
  // TriggersService/WidgetConfigService use for their own cross-field rules.
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Site', default: null })
  siteId!: Types.ObjectId | null;

  // The trigger text typed after `:` in the Agent Console's chat input (FR-P2-SHORT-05).
  @Prop({ required: true, trim: true })
  shortcutKeyword!: string;

  // Description shown in the `:` dropdown alongside the keyword.
  @Prop({ required: true, trim: true })
  purpose!: string;

  // The actual text inserted into the chat box on selection (FR-P2-SHORT-06).
  @Prop({ required: true })
  message!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ShortcutDocument = Shortcut & Document;
export const ShortcutSchema = SchemaFactory.createForClass(Shortcut);

// Backs the visibility-resolution query in SRS §3.11/§2.4 (a Site's
// "available to me" set: own Personal + that Site's Site-level + every
// Organization-level) and the management-screen listings (FR-P2-SHORT-
// 07/08), which filter by exactly these fields.
ShortcutSchema.index({ organizationId: 1, scopeLevel: 1, siteId: 1 });
ShortcutSchema.index({ createdByUserId: 1 });
