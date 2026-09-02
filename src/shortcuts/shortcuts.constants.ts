import { PermissionKey } from '../rbac/permission.catalog';

/**
 * The three `shortcuts.manage_*` keys, one per `ShortcutScopeLevel` a
 * Shortcut can be created/edited/deleted at. Shared between
 * `ShortcutsController` (the coarse "can this caller reach the CRUD routes
 * at all" gate, `{ siteSource: 'any' }`) and `ShortcutsService`
 * (`assertCanManageScope`, the precise per-scopeLevel/per-Site check) —
 * same "guard says yes/no, service decides scope" split
 * `CONVERSATION_VIEW_PERMISSIONS` already established for the Combined
 * Conversations/Visitors routes (Phase 2, FR-P2-SITE-01–04).
 */
export const SHORTCUT_MANAGE_PERMISSIONS: PermissionKey[] = [
  'shortcuts.manage_own',
  'shortcuts.manage_site',
  'shortcuts.manage_organization',
];
