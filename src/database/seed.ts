/**
 * Seed script — SRS §4 data model, Phase 1 starting data.
 *
 * Creates, idempotently (clears its own seeded collections first, so it's
 * safe to re-run against the same database):
 *   - 1 Organization
 *   - 4 Sites (each with a `businessHoursConfig` and its own Department)
 *   - 1 Department per Site
 *   - The 4 default Roles (Owner, Manager, Supervisor, Agent) with the
 *     permission sets from SRS §5.13, sourced from
 *     `src/rbac/permission.catalog.ts` (not hand-copied here)
 *   - 1 WidgetConfig per Site (defaults)
 *   - 1 sample User per Role, each with an appropriate `roleAssignments`
 *     entry:
 *       - owner@chat-hub.local     — Owner,      scope ORGANIZATION
 *       - manager@chat-hub.local   — Manager,    scope ORGANIZATION
 *       - supervisor.site1@chat-hub.local — Supervisor, scope SITE (Site 1)
 *       - agent.site1@chat-hub.local      — Agent,      scope SITE (Site 1),
 *         departmentId = Site 1's Department
 *
 * Standalone script — connects directly via Mongoose rather than
 * bootstrapping the full Nest app (no HTTP/WS listeners needed to seed
 * data). Run with `npm run seed` from `apps/chat-hub-api`.
 *
 * Password hashing: bcrypt (via `bcryptjs`, a pure-JS implementation —
 * chosen over the native `bcrypt` package specifically to avoid node-gyp/
 * native-build requirements on Windows dev machines; same algorithm,
 * same hash format, fully interchangeable). Updated in Session 2 (Auth)
 * — previously a scrypt placeholder; every seeded User's `passwordHash`
 * below is a real bcrypt hash the Auth login endpoint can verify.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';
import bcrypt from 'bcryptjs';

import { ALL_MODEL_DEFINITIONS } from './schemas';
import { DEFAULT_ROLE_PERMISSIONS } from '../rbac/permission.catalog';

// Environment workaround, not an app-wide change: this dev machine's
// configured DNS resolver doesn't answer Node's SRV lookup for the Atlas
// `mongodb+srv://` URI (Windows' own resolver handles it fine, Node's
// c-ares resolver does not). Point Node's resolver at public DNS just for
// this standalone script. Safe to remove once the environment's DNS is
// fixed; the running Nest app resolves this the same way and would need
// the same workaround if it hits the same issue.
dns.setServers(['1.1.1.1', '8.8.8.8']);

function hashPassword(plain: string): string {
  // Hardening session: bumped bcrypt cost 10 -> 12, matching UsersService's
  // create() path — see that call site's comment for why.
  return bcrypt.hashSync(plain, 12);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — check apps/chat-hub-api/.env');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.');

  const models = Object.fromEntries(
    ALL_MODEL_DEFINITIONS.map((def) => [
      def.name,
      mongoose.model(def.name, def.schema),
    ]),
  ) as Record<string, mongoose.Model<any>>;

  const { Organization, Site, Department, User, Role, WidgetConfig } = models;

  // --- Clear previously-seeded data (idempotent re-run) --------------
  console.log('Clearing existing seed collections...');
  await Promise.all([
    Organization.deleteMany({}),
    Site.deleteMany({}),
    Department.deleteMany({}),
    User.deleteMany({}),
    Role.deleteMany({}),
    WidgetConfig.deleteMany({}),
  ]);

  // --- Organization ----------------------------------------------------
  const organization = await Organization.create({
    name: 'Chat Hub (Phase 1 Business)',
    status: 'active',
  });
  console.log(
    `Created Organization: ${organization.name} (${organization._id})`,
  );

  // --- Sites + Departments + WidgetConfigs ------------------------------
  const siteDefs = [
    { name: 'Brand Site 1', domains: ['site1.example.com'] },
    { name: 'Brand Site 2', domains: ['site2.example.com'] },
    { name: 'Brand Site 3', domains: ['site3.example.com'] },
    { name: 'Brand Site 4', domains: ['site4.example.com'] },
  ];

  const sites: any[] = [];
  const departmentsBySite: Record<string, any> = {};

  for (const def of siteDefs) {
    const site = await Site.create({
      organizationId: organization._id,
      name: def.name,
      domains: def.domains,
      timezone: 'UTC',
      businessHoursConfig: { enabled: false, weeklySchedule: {} },
      status: 'active',
      // These 4 seeded Sites already ship with a `domains` entry above, so
      // there's nothing blocking chat from being live on them out of the box
      // (unlike a brand-new Site created via the Admin Panel, which always
      // starts `chatEnabled: false` regardless of `domains` — see
      // SitesService.create's doc comment).
      chatEnabled: true,
    });
    sites.push(site);

    const department = await Department.create({
      siteId: site._id,
      name: `${def.name} Team`,
    });
    departmentsBySite[site._id.toString()] = department;

    await WidgetConfig.create({
      siteId: site._id,
      topTitle: 'support',
      concierge: { displayName: 'Live Support', byline: 'Ask us anything' },
      primaryColor: '#1E88E5',
      messageStyle: 'modern',
      notificationSoundEnabled: true,
      satisfactionRatingsEnabled: true,
      offlineFormEnabled: true,
    });

    console.log(
      `Created Site: ${site.name} (${site._id}) + Department (${department._id}) + WidgetConfig`,
    );
  }

  const [site1] = sites;
  const site1Department = departmentsBySite[site1._id.toString()];

  // --- Roles (4 defaults, permissions sourced from the catalog) --------
  const roleDocs = await Role.insertMany(
    (['Owner', 'Manager', 'Supervisor', 'Agent'] as const).map((roleName) => ({
      organizationId: organization._id,
      name: roleName,
      description: `System default ${roleName} role`,
      isSystemDefault: true,
      permissions: DEFAULT_ROLE_PERMISSIONS[roleName],
    })),
  );
  const roleByName = Object.fromEntries(roleDocs.map((r: any) => [r.name, r]));
  for (const r of roleDocs) {
    console.log(
      `Created Role: ${r.name} (${r._id}) — ${r.permissions.length} permissions`,
    );
  }

  // --- Sample Users, one per Role, each with a roleAssignments entry ---
  const ownerUser = await User.create({
    organizationId: organization._id,
    displayName: 'Owner',
    fullName: 'Default Owner',
    email: 'owner@chat-hub.local',
    passwordHash: hashPassword('ChangeMe123!'),
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Owner._id,
        scopeType: 'ORGANIZATION',
      },
    ],
  });

  const managerUser = await User.create({
    organizationId: organization._id,
    displayName: 'Manager',
    fullName: 'Default Manager',
    email: 'manager@chat-hub.local',
    passwordHash: hashPassword('ChangeMe123!'),
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Manager._id,
        scopeType: 'ORGANIZATION',
        createdByUserId: ownerUser._id,
      },
    ],
  });

  const supervisorUser = await User.create({
    organizationId: organization._id,
    displayName: 'Supervisor (Site 1)',
    fullName: 'Default Supervisor',
    email: 'supervisor.site1@chat-hub.local',
    passwordHash: hashPassword('ChangeMe123!'),
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Supervisor._id,
        scopeType: 'SITE',
        siteId: site1._id,
        createdByUserId: ownerUser._id,
      },
    ],
  });

  const agentUser = await User.create({
    organizationId: organization._id,
    displayName: 'Agent (Site 1)',
    fullName: 'Default Agent',
    email: 'agent.site1@chat-hub.local',
    passwordHash: hashPassword('ChangeMe123!'),
    departmentId: site1Department._id,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: site1._id,
        createdByUserId: supervisorUser._id,
      },
    ],
  });

  console.log('Created sample Users:');
  for (const u of [ownerUser, managerUser, supervisorUser, agentUser]) {
    console.log(
      `  - ${u.email} (${u._id}) roleAssignments=${JSON.stringify(u.roleAssignments)}`,
    );
  }

  console.log('\nSeed complete.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
  return mongoose.disconnect();
});
