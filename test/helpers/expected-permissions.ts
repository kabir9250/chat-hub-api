/**
 * T-01 RBAC session — the "expected" model.
 *
 * A deliberately independent re-statement of:
 *   - `src/rbac/permission.catalog.ts`'s `DEFAULT_ROLE_PERMISSIONS`
 *   - `src/database/seed-test.ts`'s Role Assignments (who holds which
 *     default Role, at which scope/Site)
 *
 * used to compute, for any (seeded user, permission key, Site) triple,
 * whether that user SHOULD pass a real PermissionGuard check — independent
 * of the application code, so the e2e assertions below are a genuine
 * cross-check against the SRS/seed data, not a tautology that re-imports
 * the app's own catalog and would pass even if the seed or the guard had a
 * bug. If SRS §5.13 or `seed-test.ts` ever changes, this file needs a
 * matching update (flagged in the T-01 report).
 */
import { SeededEmail, SiteName } from './fixtures';

type Role = 'Owner' | 'Manager' | 'Supervisor' | 'Agent';

// Mirrors src/rbac/permission.catalog.ts DEFAULT_ROLE_PERMISSIONS verbatim.
const ALL_KEYS = [
  'sites.view',
  'sites.manage',
  'departments.view',
  'departments.manage',
  'users.view',
  'users.manage',
  'roles.view',
  'roles.manage',
  'role_assignments.manage',
  'widget_config.view',
  'widget_config.manage',
  'triggers.view',
  'triggers.manage',
  'business_hours.manage',
  'conversations.view_own',
  'conversations.view_site',
  'conversations.assign',
  'conversations.close',
  'conversations.tag',
  'visitors.view',
  'visitors.edit',
  'visitors.ban',
  'visitors.view_live_activity',
  'leads.view',
  'leads.manage',
  'analytics.view_site',
  'analytics.view_organization',
  'shortcuts.manage_own',
  'shortcuts.manage_site',
  'shortcuts.manage_organization',
  'shortcuts.view',
];

const ROLE_PERMISSIONS: Record<Role, string[]> = {
  Owner: ALL_KEYS,
  Manager: [
    'analytics.view_organization',
    'conversations.view_site',
    'users.view',
    'leads.view',
    'leads.manage',
    'shortcuts.manage_own',
    'shortcuts.view',
    'shortcuts.manage_site',
    'shortcuts.manage_organization',
  ],
  Supervisor: [
    'users.manage',
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
    'shortcuts.manage_own',
    'shortcuts.view',
  ],
};

interface Assignment {
  role: Role;
  scope: 'ORGANIZATION' | 'SITE';
  site?: SiteName; // only for SITE scope
}

// Mirrors src/database/seed-test.ts's roleAssignments verbatim.
const USER_ASSIGNMENTS: Record<SeededEmail, Assignment[]> = {
  'owner@test.local': [{ role: 'Owner', scope: 'ORGANIZATION' }],
  'manager@test.local': [{ role: 'Manager', scope: 'ORGANIZATION' }],
  'supervisor-a@test.local': [
    { role: 'Supervisor', scope: 'SITE', site: 'Site A' },
  ],
  'supervisor-b@test.local': [
    { role: 'Supervisor', scope: 'SITE', site: 'Site B' },
  ],
  'agent-a1@test.local': [{ role: 'Agent', scope: 'SITE', site: 'Site A' }],
  'agent-a2@test.local': [{ role: 'Agent', scope: 'SITE', site: 'Site A' }],
  'agent-b1@test.local': [{ role: 'Agent', scope: 'SITE', site: 'Site B' }],
  'agent-multi@test.local': [
    { role: 'Agent', scope: 'SITE', site: 'Site A' },
    { role: 'Agent', scope: 'SITE', site: 'Site C' },
  ],
};

export const ALL_SITE_NAMES: SiteName[] = ['Site A', 'Site B', 'Site C', 'Site D'];

/** Every Site a user has ANY access to (org-scoped covers all 4). */
export function accessibleSites(email: SeededEmail): SiteName[] {
  const assignments = USER_ASSIGNMENTS[email];
  if (assignments.some((a) => a.scope === 'ORGANIZATION')) {
    return ALL_SITE_NAMES;
  }
  return assignments
    .filter((a) => a.scope === 'SITE')
    .map((a) => a.site!);
}

/** Effective permission set for `email` on `site` (or org-wide if site is null). */
export function effectivePermissions(
  email: SeededEmail,
  site: SiteName | null,
): Set<string> {
  const assignments = USER_ASSIGNMENTS[email];
  const applicableRoles = new Set<Role>();
  for (const a of assignments) {
    if (a.scope === 'ORGANIZATION') {
      applicableRoles.add(a.role);
    } else if (a.scope === 'SITE' && site && a.site === site) {
      applicableRoles.add(a.role);
    }
  }
  const union = new Set<string>();
  for (const role of applicableRoles) {
    for (const key of ROLE_PERMISSIONS[role]) union.add(key);
  }
  return union;
}

/** Does `email` hold ANY of `keys` on `site` (site: null => org-wide only)? */
export function expectAllowed(
  email: SeededEmail,
  keys: string[],
  site: SiteName | null,
): boolean {
  const effective = effectivePermissions(email, site);
  return keys.some((k) => effective.has(k));
}

/** Does `email` hold ANY of `keys` on ANY Site they're scoped to (siteSource: 'any')? */
export function expectAllowedAny(email: SeededEmail, keys: string[]): boolean {
  return accessibleSites(email).some((site) => expectAllowed(email, keys, site));
}
