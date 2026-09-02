import { ShortcutScopeLevel } from '../../database/schemas/shortcut.schema';

/**
 * `GET /shortcuts/all` response shape (SRS §3.11 FR-P2-SHORT-09,
 * `shortcuts.view_all`) — the plain-object shape `ShortcutsService.findAllInOrganization`
 * returns instead of a raw `ShortcutDocument`, so the creator's name/id can
 * be carried alongside the record without changing what every OTHER
 * Shortcuts endpoint returns (those keep returning `createdByUserId` as a
 * bare id string, unpopulated, per the existing `RawShortcut` contract on
 * the frontend). `creator` is `null` only if the creating User was since
 * hard-deleted (`UsersService`'s Session 4 delete is a hard delete) — kept
 * nullable rather than throwing, since this is a read-only oversight list
 * and one dangling reference shouldn't 500 the whole screen.
 */
export interface ShortcutWithCreator {
  _id: string;
  organizationId: string;
  createdByUserId: string;
  creator: { id: string; displayName: string; fullName: string } | null;
  scopeLevel: ShortcutScopeLevel;
  siteId: string | null;
  shortcutKeyword: string;
  purpose: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
}
