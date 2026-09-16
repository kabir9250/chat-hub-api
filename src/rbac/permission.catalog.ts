/**
 * Fixed Permission catalog — SRS §4.3a / §5.13.
 *
 * This is deliberately a static in-code constant, NOT a Mongo collection:
 * the catalog is fixed, small, not user-editable, and read on every
 * permission check, so keeping it in-memory is both simpler (no reference
 * data to sync) and faster than a DB round-trip.
 *
 * Role documents (see role.schema.ts) store a `permissions: string[]` of
 * keys from this catalog. Engineering may add narrowly-scoped keys beyond
 * this list if a feature genuinely needs finer granularity, but must not
 * collapse multiple distinct actions into one key — log any additions in
 * PROGRESS.md (SRS §5.13 note).
 */

export const PERMISSION_MODULES = [
  'Sites',
  'Departments',
  'Users',
  'Roles',
  'Role Assignments',
  'Widget Config',
  'Triggers',
  'Business Hours',
  'Conversations',
  'Visitors',
  'Leads',
  'Analytics',
  'Shortcuts',
  'Tickets',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export interface PermissionDefinition {
  key: string;
  module: PermissionModule;
  description: string;
}

/** The full, fixed Permission catalog — SRS §5.13 table, verbatim. */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  {
    key: 'sites.view',
    module: 'Sites',
    description: "View a Site's existence/basic info",
  },
  {
    key: 'sites.manage',
    module: 'Sites',
    description: 'Create/edit/deactivate Sites (Owner-level in Phase 1)',
  },
  {
    key: 'departments.view',
    module: 'Departments',
    description: 'View departments on a Site',
  },
  {
    key: 'departments.manage',
    module: 'Departments',
    description: 'Create/edit/delete departments',
  },
  {
    key: 'users.view',
    module: 'Users',
    description: 'View user list for a Site',
  },
  {
    key: 'users.manage',
    module: 'Users',
    description: 'Create/edit/enable/disable/delete users on a Site',
  },
  {
    key: 'roles.view',
    module: 'Roles',
    description: 'View Roles and their permission sets',
  },
  {
    key: 'roles.manage',
    module: 'Roles',
    description:
      'Create/edit/delete Roles, change what permissions a Role grants',
  },
  {
    key: 'role_assignments.manage',
    module: 'Role Assignments',
    description:
      'Assign/revoke Roles to/from Users, including scope (Site vs Organization)',
  },
  {
    key: 'widget_config.view',
    module: 'Widget Config',
    description: "View a Site's widget configuration",
  },
  {
    key: 'widget_config.manage',
    module: 'Widget Config',
    description: "Edit a Site's widget configuration",
  },
  {
    key: 'triggers.view',
    module: 'Triggers',
    description: 'View page-trigger rules',
  },
  {
    key: 'triggers.manage',
    module: 'Triggers',
    description: 'Edit page-trigger rules',
  },
  {
    key: 'business_hours.manage',
    module: 'Business Hours',
    description: "Edit a Site's business hours",
  },
  {
    key: 'conversations.view_own',
    module: 'Conversations',
    description: 'View only conversations assigned to the User',
  },
  {
    key: 'conversations.view_site',
    module: 'Conversations',
    description:
      'View all conversations on a Site (own Department or all Departments, per assignment)',
  },
  {
    key: 'conversations.assign',
    module: 'Conversations',
    description: 'Assign/reassign a conversation to an Agent',
  },
  {
    key: 'conversations.close',
    module: 'Conversations',
    description: "Change a conversation's status",
  },
  {
    key: 'conversations.tag',
    module: 'Conversations',
    description: 'Add/remove tags',
  },
  {
    key: 'visitors.view',
    module: 'Visitors',
    description: 'View visitor profile/attribution data',
  },
  {
    key: 'visitors.edit',
    module: 'Visitors',
    description: 'Edit visitor name/email/phone/notes',
  },
  { key: 'visitors.ban', module: 'Visitors', description: 'Ban a visitor' },
  {
    key: 'visitors.view_live_activity',
    module: 'Visitors',
    description:
      "View a Visitor's real-time live activity — currently-typing draft " +
      'text before it is sent. Deliberately separate from visitors.view ' +
      '(seeing a Visitor at all) — this is a distinct, more sensitive ' +
      'capability and must never be folded into conversations.view_own/' +
      '.view_site or visitors.view. Not in any seeded non-Owner Role by ' +
      'default (see DEFAULT_ROLE_PERMISSIONS below) — an Owner grants it ' +
      'explicitly via Roles.',
  },
  { key: 'leads.view', module: 'Leads', description: 'View lead status' },
  { key: 'leads.manage', module: 'Leads', description: 'Update lead status' },
  {
    key: 'analytics.view_site',
    module: 'Analytics',
    description: 'View analytics/reports for Site(s) the User is scoped to',
  },
  {
    key: 'analytics.view_organization',
    module: 'Analytics',
    description: 'View combined analytics across all Sites in the Organization',
  },
  // Phase 2, SRS §3.11 (FR-P2-SHORT-01–08) — Shortcuts (Canned Responses).
  // Four keys, one per scopeLevel a Shortcut can be created at (PERSONAL/
  // SITE/ORGANIZATION) plus a separate `.view` to actually use them — kept
  // as four distinct, narrowly-scoped keys per the catalog's own "should
  // not collapse multiple distinct actions into one key" guidance, exactly
  // as the SRS's own Section 3.11 "New Permissions" table specifies.
  {
    key: 'shortcuts.manage_own',
    module: 'Shortcuts',
    description:
      "Create/edit/delete one's own Personal-level shortcuts (granted to " +
      'every default Role — Agent through Owner — since anyone should ' +
      'manage their own)',
  },
  {
    key: 'shortcuts.manage_site',
    module: 'Shortcuts',
    description:
      'Create/edit/delete Site-level shortcuts for a Site (default: ' +
      'Supervisor and above)',
  },
  {
    key: 'shortcuts.manage_organization',
    module: 'Shortcuts',
    description:
      'Create/edit/delete Organization-level shortcuts (default: Manager ' +
      'and Owner)',
  },
  {
    key: 'shortcuts.view',
    module: 'Shortcuts',
    description:
      'View/use shortcuts applicable to the caller (their Personal ones + ' +
      "Site-level ones for Sites they're active on + all Organization-" +
      'level ones) — granted to every default Role, required simply to ' +
      'use the feature',
  },
  // Business decision, post-QA (T-07-shortcuts.md Finding #1 follow-up),
  // SRS §3.11 FR-P2-SHORT-09 — Owner/oversight-only read visibility across
  // EVERY Shortcut in the Organization, including every individual's
  // Personal ones, with the creator's identity shown. Deliberately separate
  // from `shortcuts.manage_*` — this is visibility only and grants no
  // edit/delete rights over a Shortcut the holder didn't create and
  // doesn't otherwise hold `manage_site`/`manage_organization` over
  // (ShortcutsService's `assertOwnershipIfPersonal`/`assertCanManageScope`
  // are untouched by this key's existence). Checked Organization-wide only
  // (`{ siteSource: 'none' }`, same as `roles.manage`) — "every Shortcut in
  // the Organization" has no single Site to scope it to.
  {
    key: 'shortcuts.view_all',
    module: 'Shortcuts',
    description:
      'Read-only oversight: view every Shortcut that exists in the ' +
      "Organization, including every individual's Personal ones, with the " +
      "creator's identity shown. Does not grant edit/delete rights over a " +
      "Shortcut the viewer didn't create and doesn't otherwise hold " +
      'manage_site/manage_organization over. Default: Owner only.',
  },
  // Phase 3 (Tickets screen, replaces the scrapped Lead Creation Settings)
  // — Organization-wide (no Site involved), same { siteSource: 'none' }
  // pattern as roles.manage/shortcuts.view_all. Owner-only by default (via
  // ALL_PERMISSION_KEYS below) — deliberately NOT added to Manager/
  // Supervisor/Agent's DEFAULT_ROLE_PERMISSIONS, same precedent
  // shortcuts.view_all set.
  {
    key: 'tickets.view',
    module: 'Tickets',
    description:
      'View the Tickets screen — every online (live-chat) and offline ' +
      '(Offline Contact Form) Conversation, with transcript, across the ' +
      'Organization',
  },
] as const;

/** Union type of every valid permission key, derived from the catalog above. */
export type PermissionKey = (typeof PERMISSION_CATALOG)[number]['key'];

/** Flat array of every permission key — e.g. for seeding the Owner role with "all". */
export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATALOG.map(
  (p) => p.key,
);

/** Runtime guard: is `value` a real permission key from the catalog? */
export function isPermissionKey(value: string): value is PermissionKey {
  return ALL_PERMISSION_KEYS.includes(value);
}

/**
 * Default permission sets for the 4 seeded system Roles — SRS §5.13
 * "Default Seeded Roles" table. Used by the seed script; Owners with
 * `roles.manage` may edit these later per-Organization (FR-RBAC-04).
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<
  'Owner' | 'Manager' | 'Supervisor' | 'Agent',
  PermissionKey[]
> = {
  // Every permission in the catalog, including roles.manage and
  // role_assignments.manage — this is also how Owner picks up the new
  // `shortcuts.view_all` oversight key (SRS §3.11 FR-P2-SHORT-09) with no
  // separate line item needed here: the business decision named "Owner"
  // only ("Owner/Admin" in its own wording, and Admin has no seeded Role of
  // its own in this catalog), so Manager/Supervisor/Agent below deliberately
  // do NOT list `shortcuts.view_all` — confirm with the business before
  // extending it to Manager by default.
  Owner: [...ALL_PERMISSION_KEYS],
  Manager: [
    'analytics.view_organization',
    'conversations.view_site',
    'users.view',
    'leads.view',
    'leads.manage',
    // Phase 2 §3.11 — every default Role gets manage_own + view; Manager
    // additionally gets manage_site ("Supervisor and above" — Manager's
    // default scope, Organization/multiple Sites, is above Supervisor's
    // one-Site scope in the hierarchy) and manage_organization ("Manager
    // and Owner"), per this session's task instructions.
    'shortcuts.manage_own',
    'shortcuts.view',
    'shortcuts.manage_site',
    'shortcuts.manage_organization',
    // 'shortcuts.view_all' deliberately NOT included — business decision
    // named "Owner" as the default holder only (see Owner's own comment
    // above), not Manager, even though Manager already holds every other
    // Shortcuts key.
  ],
  Supervisor: [
    // 'visitors.view_live_activity' is DELIBERATELY not included here (or
    // in Manager/Agent below) — added this session as a distinct, more
    // sensitive permission (see its catalog entry above). Owner still gets
    // it automatically via ALL_PERMISSION_KEYS; every other seeded Role
    // starts without it and an Owner must grant it explicitly per-Role.
    'users.manage',
    // 'users.view'/'departments.view' added this session (chat-hub-web
    // Session 11.1 — Admin: Users/Departments): the SRS §5.13 table lists
    // only the `.manage` keys for Supervisor, but that left the seeded
    // Supervisor unable to LIST what it's supposed to manage
    // (`GET /sites/:siteId/users` and `.../departments` are gated on the
    // separate `.view` keys, per FR-USR-05/FR-USR-04) — only able to mutate
    // Users/Departments it already knew the id of, making the Admin Panel's
    // list/create screens unusable for this seeded Role. Confirmed with the
    // user before making this change (a backend/seed edit, not just a
    // frontend one) rather than silently patching around it.
    // `roles.view` was also tried here and then REVERTED: every Roles route
    // (`GET /roles` included) is gated `{ siteSource: 'none' }` (Session
    // 3) — i.e. checked against Organization-wide permissions only, never
    // a Site-scoped grant — so adding it to this Site-scoped Role can never
    // actually satisfy that check; live-verified still 403 after adding it.
    // A Supervisor onboarding a new User therefore still can't browse
    // `GET /roles` to pick a Role by name — the Admin Panel's Users screen
    // works around this client-side (a fallback Role-id picker built from
    // Role ids already visible in the Site's own User list, which
    // `users.view` now provides) rather than by further permission changes.
    // Deliberately NOT adding `role_assignments.manage`/`roles.manage`
    // here — those stay Owner-only; the initial Role Assignment on User
    // create is already reachable via `users.manage` alone (UsersService,
    // Session 4), so neither was needed for that flow specifically.
    'users.view',
    'departments.manage',
    'departments.view',
    'conversations.view_site',
    'conversations.assign',
    'conversations.close',
    'conversations.tag',
    'visitors.view',
    'visitors.edit',
    'visitors.ban',
    'leads.view',
    'leads.manage',
    'analytics.view_site',
    // Phase 2 §3.11 — every default Role gets manage_own + view; Supervisor
    // additionally gets manage_site per the SRS §3.11 table's default column.
    'shortcuts.manage_own',
    'shortcuts.view',
    'shortcuts.manage_site',
  ],
  Agent: [
    'conversations.view_own',
    'conversations.close',
    'conversations.tag',
    'visitors.view',
    'visitors.edit',
    'leads.view',
    'leads.manage',
    // Phase 2 §3.11 — every default Role, Agent through Owner, gets its own
    // Personal-shortcut management plus the ability to use shortcuts at all.
    'shortcuts.manage_own',
    'shortcuts.view',
  ],
};
