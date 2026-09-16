/**
 * Test seed script — QA Testing Foundation session (see
 * apps/files/reports/README.md). Creates a KNOWN, DETERMINISTIC dataset
 * dedicated to automated/manual test sessions (T-1 onward), completely
 * separate from `seed.ts`'s small dev/demo dataset.
 *
 * Seeds:
 *   - 1 Organization
 *   - 4 Sites (Site A, Site B, Site C, Site D), each with 1 Department and
 *     1 WidgetConfig (parity with `seed.ts` — not strictly asked for by the
 *     testing-foundation task, but every following test session that opens
 *     the Widget/Admin config screens needs one to exist)
 *   - The 4 default Roles (Owner, Manager, Supervisor, Agent), permissions
 *     sourced from `src/rbac/permission.catalog.ts` — never hand-copied
 *   - 8 test Users covering every default Role at different Site scopes
 *     (see the README's account table) — all password `Test1234!`
 *   - 20 Visitors per Site (80 total) — mix of named/unnamed, some banned
 *   - 50 Conversations per Site (200 total) — mix of Open/Pending/Closed,
 *     some with ratings/tags
 *   - A small, deterministic Message pair per Conversation (visitor +
 *     agent reply, when assigned) — not explicitly required by the task's
 *     entity list, but added so Conversations aren't empty shells; every
 *     following messaging/read-receipt/transcript test needs at least this
 *   - 10 PageVisit records per Visitor (800 total)
 *   - 5 Shortcuts across Personal/Site/Organization scopes
 *
 * SAFETY: this script refuses to run unless `MONGODB_URI` (read from
 * `.env.test`, NOT `.env`) points at a database whose name contains "test"
 * — a guard against ever pointing this at the dev/prod database by mistake.
 * See apps/files/reports/README.md for the full "how to run" + "which
 * database" writeup (guardrail: dedicated test DB, never production Atlas).
 *
 * Idempotent — clears every collection this script seeds before inserting,
 * safe to re-run. Run via `npm run seed:test` from `chat-hub-api`.
 *
 * Standalone script — connects directly via Mongoose, same pattern as
 * `seed.ts` (does not boot the full Nest app).
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load `.env.test` explicitly — deliberately NOT `import 'dotenv/config'`
// (which would load the default `.env`, i.e. the dev database). Resolved
// against process.cwd(), which `npm run seed:test` always sets to
// `chat-hub-api/` (matching every other npm script in this package).
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

import mongoose from 'mongoose';
import dns from 'dns';
import bcrypt from 'bcryptjs';

import { ALL_MODEL_DEFINITIONS } from './schemas';
import { DEFAULT_ROLE_PERMISSIONS } from '../rbac/permission.catalog';
import { derivePageCategory } from '../page-visits/page-category.util';

// Same Windows/Node DNS-resolver workaround `seed.ts` uses for Atlas SRV
// lookups — see that file's comment for why this is needed on this dev
// machine specifically.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const TEST_PASSWORD = 'Test1234!';
const REFERENCE_NUMBER_OFFSET = 10_000_000;

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12); // matches UsersService/seed.ts cost
}

/** Extracts the database name from a mongodb(+srv):// URI's path segment. */
function extractDbName(uri: string): string | null {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set — check chat-hub-api/.env.test exists (copy ' +
        'it from .env.test.example and fill in real Atlas credentials).',
    );
  }

  const dbName = extractDbName(uri);
  if (!dbName || !dbName.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing to run: the database name in MONGODB_URI ("${dbName ?? 'unknown'}") ` +
        'does not contain "test". This script clears whole collections — it ' +
        'must only ever run against a dedicated test database (e.g. ' +
        '"zendesk_test"), never the dev or production database. Fix ' +
        '.env.test\'s MONGODB_URI and re-run.',
    );
  }

  console.log(`Connecting to MongoDB (database: "${dbName}")...`);
  await mongoose.connect(uri);
  console.log('Connected.');

  const models = Object.fromEntries(
    ALL_MODEL_DEFINITIONS.map((def) => [
      def.name,
      mongoose.model(def.name, def.schema),
    ]),
  ) as Record<string, mongoose.Model<any>>;

  const {
    Organization,
    Site,
    Department,
    User,
    Role,
    WidgetConfig,
    Visitor,
    Conversation,
    Message,
    PageVisit,
    Shortcut,
    Counter,
    BannedEntry,
  } = models;

  // --- Clear every collection this script seeds (idempotent re-run) -----
  console.log('Clearing existing test-seed collections...');
  await Promise.all([
    Organization.deleteMany({}),
    Site.deleteMany({}),
    Department.deleteMany({}),
    User.deleteMany({}),
    Role.deleteMany({}),
    WidgetConfig.deleteMany({}),
    Visitor.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    PageVisit.deleteMany({}),
    Shortcut.deleteMany({}),
    Counter.deleteMany({}),
    BannedEntry.deleteMany({}),
  ]);

  const now = Date.now();

  // --- Organization ------------------------------------------------------
  const organization = await Organization.create({
    name: 'Chat Hub QA Test Organization',
    status: 'active',
  });
  console.log(`Created Organization: ${organization.name} (${organization._id})`);

  // --- Sites + Departments + WidgetConfigs --------------------------------
  const siteDefs = [
    { letter: 'A', name: 'Site A', domains: ['sitea.test.local'] },
    { letter: 'B', name: 'Site B', domains: ['siteb.test.local'] },
    { letter: 'C', name: 'Site C', domains: ['sitec.test.local'] },
    { letter: 'D', name: 'Site D', domains: ['sited.test.local'] },
  ] as const;

  const sites: Record<string, any> = {};
  const departments: Record<string, any> = {};

  for (const def of siteDefs) {
    const site = await Site.create({
      organizationId: organization._id,
      name: def.name,
      domains: def.domains,
      timezone: 'UTC',
      businessHoursConfig: { enabled: false, weeklySchedule: {} },
      status: 'active',
      chatEnabled: true,
    });
    sites[def.letter] = site;

    const department = await Department.create({
      siteId: site._id,
      name: `${def.name} Team`,
    });
    departments[def.letter] = department;

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
      `Created Site ${def.letter}: ${site.name} (${site._id}) + Department (${department._id}) + WidgetConfig`,
    );
  }

  // --- Roles (4 defaults, permissions sourced from the catalog) ---------
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
    console.log(`Created Role: ${r.name} (${r._id}) — ${r.permissions.length} permissions`);
  }

  // --- 8 test Users, one per README account table row --------------------
  const passwordHash = hashPassword(TEST_PASSWORD);

  const owner = await User.create({
    organizationId: organization._id,
    displayName: 'Test Owner',
    fullName: 'Test Owner',
    email: 'owner@test.local',
    passwordHash,
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [{ roleId: roleByName.Owner._id, scopeType: 'ORGANIZATION' }],
  });

  const manager = await User.create({
    organizationId: organization._id,
    displayName: 'Test Manager',
    fullName: 'Test Manager',
    email: 'manager@test.local',
    passwordHash,
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      { roleId: roleByName.Manager._id, scopeType: 'ORGANIZATION', createdByUserId: owner._id },
    ],
  });

  const supervisorA = await User.create({
    organizationId: organization._id,
    displayName: 'Test Supervisor A',
    fullName: 'Test Supervisor A',
    email: 'supervisor-a@test.local',
    passwordHash,
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Supervisor._id,
        scopeType: 'SITE',
        siteId: sites.A._id,
        createdByUserId: owner._id,
      },
    ],
  });

  const supervisorB = await User.create({
    organizationId: organization._id,
    displayName: 'Test Supervisor B',
    fullName: 'Test Supervisor B',
    email: 'supervisor-b@test.local',
    passwordHash,
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Supervisor._id,
        scopeType: 'SITE',
        siteId: sites.B._id,
        createdByUserId: owner._id,
      },
    ],
  });

  const agentA1 = await User.create({
    organizationId: organization._id,
    displayName: 'Test Agent A1',
    fullName: 'Test Agent A1',
    email: 'agent-a1@test.local',
    passwordHash,
    departmentId: departments.A._id,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: sites.A._id,
        createdByUserId: supervisorA._id,
      },
    ],
  });

  const agentA2 = await User.create({
    organizationId: organization._id,
    displayName: 'Test Agent A2',
    fullName: 'Test Agent A2',
    email: 'agent-a2@test.local',
    passwordHash,
    departmentId: departments.A._id,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: sites.A._id,
        createdByUserId: supervisorA._id,
      },
    ],
  });

  const agentB1 = await User.create({
    organizationId: organization._id,
    displayName: 'Test Agent B1',
    fullName: 'Test Agent B1',
    email: 'agent-b1@test.local',
    passwordHash,
    departmentId: departments.B._id,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: sites.B._id,
        createdByUserId: supervisorB._id,
      },
    ],
  });

  // Scoped to BOTH Site A and Site C (two separate SITE-scoped assignments)
  // — needed for "All Sites" combined-view tests (Phase 2 §3.5). Left
  // `departmentId: null` deliberately: a single Department field can't
  // meaningfully represent membership in two different Sites' Departments
  // at once — same reasoning a multi-Site Supervisor/Manager account has no
  // departmentId either.
  const agentMulti = await User.create({
    organizationId: organization._id,
    displayName: 'Test Agent Multi',
    fullName: 'Test Agent Multi (Site A + Site C)',
    email: 'agent-multi@test.local',
    passwordHash,
    departmentId: null,
    enabled: true,
    status: 'offline',
    roleAssignments: [
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: sites.A._id,
        createdByUserId: supervisorA._id,
      },
      {
        roleId: roleByName.Agent._id,
        scopeType: 'SITE',
        siteId: sites.C._id,
        createdByUserId: owner._id,
      },
    ],
  });

  const allUsers = [
    owner,
    manager,
    supervisorA,
    supervisorB,
    agentA1,
    agentA2,
    agentB1,
    agentMulti,
  ];
  console.log(`Created ${allUsers.length} test Users (password: "${TEST_PASSWORD}" for all):`);
  for (const u of allUsers) {
    console.log(`  - ${u.email} (${u._id})`);
  }

  // Per-Site pool of Agents available to be assigned a Conversation there —
  // drives the deterministic assignment pattern below. Site D intentionally
  // has NO dedicated agent (a real "nobody's scoped here but Owner/Manager"
  // edge case worth having in the fixture).
  const agentPoolBySite: Record<string, any[]> = {
    A: [agentA1, agentA2, agentMulti],
    B: [agentB1, agentMulti],
    C: [agentMulti],
    D: [],
  };

  // --- Visitors: 20 per Site (80 total) -----------------------------------
  const CITY_POOL = [
    { city: 'New York', region: 'NY', country: 'US' },
    { city: 'London', region: '', country: 'GB' },
    { city: 'Toronto', region: 'ON', country: 'CA' },
    { city: 'Sydney', region: 'NSW', country: 'AU' },
  ];
  const BROWSER_POOL = ['Chrome', 'Safari', 'Firefox', 'Edge'];
  const OS_POOL = ['Windows', 'macOS', 'iOS', 'Android'];
  const DEVICE_POOL = ['desktop', 'mobile', 'tablet'];

  const visitorsBySite: Record<string, any[]> = { A: [], B: [], C: [], D: [] };

  for (const def of siteDefs) {
    const site = sites[def.letter];
    const visitorDocs: any[] = [];

    for (let i = 0; i < 20; i++) {
      const globalIndex = siteDefs.findIndex((d) => d.letter === def.letter) * 20 + i;
      const named = i % 2 === 0;
      const banned = i % 7 === 0; // ~3 banned per Site
      const geo = CITY_POOL[i % CITY_POOL.length];
      const firstSeenAt = new Date(now - (globalIndex + 1) * 6 * HOUR_MS);
      const pastVisitsCount = (i % 5) + 1;
      const lastSeenAt =
        pastVisitsCount > 1
          ? new Date(firstSeenAt.getTime() + 2 * HOUR_MS)
          : firstSeenAt;

      visitorDocs.push({
        siteId: site._id,
        name: named ? `Test Visitor ${def.letter}${i + 1}` : null,
        email: named ? `visitor.${def.letter.toLowerCase()}${i + 1}@example.com` : null,
        phone: named && i % 3 === 0 ? `+15550${String(100 + i)}` : null,
        firstSeenAt,
        lastSeenAt,
        pastVisitsCount,
        pastChatsCount: i % 4,
        currentIp: `203.0.113.${(globalIndex % 254) + 1}`,
        location: geo,
        browser: BROWSER_POOL[i % BROWSER_POOL.length],
        os: OS_POOL[i % OS_POOL.length],
        deviceType: DEVICE_POOL[i % DEVICE_POOL.length],
        userAgentRaw: `Mozilla/5.0 (test fixture; ${OS_POOL[i % OS_POOL.length]})`,
        referrer: i % 3 === 0 ? 'https://www.google.com/' : null,
        landingPage: `https://${def.domains[0]}/`,
        utmSource: i % 5 === 0 ? 'newsletter' : undefined,
        utmMedium: i % 5 === 0 ? 'email' : undefined,
        utmCampaign: i % 5 === 0 ? 'qa-fixture-campaign' : undefined,
        visitorPath: i % 3 === 0 ? 'Google' : 'Direct traffic',
        notes: banned ? 'Seeded as banned for testing.' : '',
        isBanned: banned,
        customFields: {},
      });
    }

    const inserted = await Visitor.insertMany(visitorDocs);
    visitorsBySite[def.letter] = inserted;
    const namedCount = inserted.filter((v: any) => v.name).length;
    const bannedVisitors = inserted.filter((v: any) => v.isBanned);
    console.log(
      `Created 20 Visitors for Site ${def.letter} (${namedCount} named, ${bannedVisitors.length} banned)`,
    );

    // Feature-2a-backend — `BannedEntry` is now the real source of truth for
    // both ban enforcement and the Banned Visitors screen; `Visitor.isBanned`
    // above is kept in sync but no longer trusted by either. Without a
    // matching `BannedEntry` row, a fixture Visitor seeded `isBanned: true`
    // would show as banned on its own profile but never actually be blocked
    // at session init, and never appear on the Banned Visitors screen —
    // silently inconsistent with every ban created through the real
    // `ban()`/`banIp()` flows. `createdByUserId: owner._id` since `owner` is
    // the one User guaranteed to exist on every seeded Site by this point.
    if (bannedVisitors.length) {
      await BannedEntry.insertMany(
        bannedVisitors.map((v: any) => ({
          siteId: site._id,
          visitorId: v._id,
          ipAddress: v.currentIp ?? null,
          reason: 'Seeded as banned for testing.',
          createdByUserId: owner._id,
          createdAt: v.firstSeenAt,
        })),
      );
    }
  }

  // --- Conversations: 50 per Site (200 total) + a Message pair each ------
  const STATUS_CYCLE = ['open', 'pending', 'closed'] as const;
  const TAG_POOL = [
    ['billing'],
    ['sales'],
    ['support'],
    ['bug'],
    ['feature-request'],
    [],
    [],
  ];

  let referenceSeq = 0;
  const messageDocs: any[] = [];
  let conversationsCreated = 0;

  for (const def of siteDefs) {
    const site = sites[def.letter];
    const department = departments[def.letter];
    const visitors = visitorsBySite[def.letter];
    const agentPool = agentPoolBySite[def.letter];

    const conversationDocs: any[] = [];
    for (let i = 0; i < 50; i++) {
      referenceSeq += 1;
      const visitor = visitors[i % visitors.length];
      const status = STATUS_CYCLE[i % STATUS_CYCLE.length];
      const assignedAgent =
        agentPool.length > 0 ? agentPool[i % agentPool.length] : null;
      // Every 4th conversation is left unassigned regardless of Site, even
      // when agents are available — a realistic "nobody's claimed it yet" mix.
      const finalAssignedAgent = i % 4 === 3 ? null : assignedAgent;

      const startedAt = new Date(now - (referenceSeq - 1) * 45 * MIN_MS);
      const closedAt = status === 'closed' ? new Date(startedAt.getTime() + 20 * MIN_MS) : null;
      const rated = status === 'closed' && i % 3 === 0;

      conversationDocs.push({
        siteId: site._id,
        departmentId: department._id,
        visitorId: visitor._id,
        assignedAgentId: finalAssignedAgent ? finalAssignedAgent._id : null,
        status,
        startedAt,
        closedAt,
        channel: 'chat',
        ratingScore: rated ? (i % 5) + 1 : null,
        ratingComment: rated ? 'Seeded rating comment for QA fixtures.' : null,
        tags: TAG_POOL[i % TAG_POOL.length],
        referenceNumber: `#${REFERENCE_NUMBER_OFFSET + referenceSeq}`,
        triggeredByRuleId: null,
      });
    }

    const insertedConversations = await Conversation.insertMany(conversationDocs);
    conversationsCreated += insertedConversations.length;

    // One visitor message + (if assigned) one agent reply per Conversation.
    for (const conv of insertedConversations as any[]) {
      messageDocs.push({
        conversationId: conv._id,
        senderType: 'visitor',
        senderId: null,
        body: 'Hi, I have a question about your product.',
        attachments: [],
        sentAt: conv.startedAt,
        deliveredAt: new Date(conv.startedAt.getTime() + 1000),
        readAt: conv.assignedAgentId ? new Date(conv.startedAt.getTime() + 60_000) : null,
      });

      if (conv.assignedAgentId) {
        const agentReplyAt = new Date(conv.startedAt.getTime() + 2 * MIN_MS);
        messageDocs.push({
          conversationId: conv._id,
          senderType: 'agent',
          senderId: conv.assignedAgentId,
          body: "Hi! Happy to help — let me look into that for you.",
          attachments: [],
          sentAt: agentReplyAt,
          deliveredAt: new Date(agentReplyAt.getTime() + 1000),
          readAt: conv.status === 'closed' ? new Date(agentReplyAt.getTime() + 5 * MIN_MS) : null,
        });
      }
    }

    console.log(`Created 50 Conversations for Site ${def.letter}`);
  }

  await Message.insertMany(messageDocs);
  console.log(
    `Created ${messageDocs.length} Messages across ${conversationsCreated} Conversations`,
  );

  // Keep the shared reference-number Counter in sync so any Conversation
  // created later through the real API (against this test DB) continues
  // incrementing from where the seed left off, rather than colliding.
  await Counter.findOneAndUpdate(
    { _id: 'conversationReferenceNumber' },
    { $set: { seq: referenceSeq } },
    { upsert: true },
  );

  // --- PageVisits: 10 per Visitor (800 total) -----------------------------
  const PAGE_POOL = [
    '/',
    '/pricing',
    '/about',
    '/contact',
    '/blog/post-1',
    '/features',
    '/docs/getting-started',
    '/signup',
    '/support',
    '/checkout',
  ];

  let pageVisitsCreated = 0;
  for (const def of siteDefs) {
    const site = sites[def.letter];
    const visitors = visitorsBySite[def.letter];
    const pageVisitDocs: any[] = [];

    for (const visitor of visitors) {
      for (let j = 0; j < 10; j++) {
        const pageUrl = `https://${def.domains[0]}${PAGE_POOL[j]}`;
        const enteredAt = new Date(visitor.firstSeenAt.getTime() + j * 5 * MIN_MS);
        const durationSeconds = 30 + ((j * 23) % 240);
        const exitedAt = new Date(enteredAt.getTime() + durationSeconds * 1000);

        pageVisitDocs.push({
          siteId: site._id,
          visitorId: visitor._id,
          conversationId: null,
          pageUrl,
          pageCategory: derivePageCategory(pageUrl),
          enteredAt,
          exitedAt,
          durationSeconds,
          referrer: j === 0 ? visitor.referrer ?? null : null,
          landingPage: j === 0 ? visitor.landingPage ?? null : null,
          utmSource: j === 0 ? visitor.utmSource ?? null : null,
          utmMedium: j === 0 ? visitor.utmMedium ?? null : null,
          utmCampaign: j === 0 ? visitor.utmCampaign ?? null : null,
          visitorPathLabel: j === 0 ? visitor.visitorPath ?? null : null,
        });
      }
    }

    await PageVisit.insertMany(pageVisitDocs);
    pageVisitsCreated += pageVisitDocs.length;
    console.log(`Created ${pageVisitDocs.length} PageVisits for Site ${def.letter}`);
  }
  console.log(`Total PageVisits created: ${pageVisitsCreated}`);

  // --- Shortcuts: 5 total, across Personal/Site/Organization scopes ------
  const shortcutDocs = [
    {
      organizationId: organization._id,
      createdByUserId: agentA1._id,
      scopeLevel: 'PERSONAL',
      siteId: null,
      shortcutKeyword: 'brb',
      purpose: 'Stepping away briefly',
      message: "I'll be right back, thanks for your patience!",
    },
    {
      organizationId: organization._id,
      createdByUserId: agentB1._id,
      scopeLevel: 'PERSONAL',
      siteId: null,
      shortcutKeyword: 'thanks',
      purpose: 'Closing thanks',
      message: 'Thanks so much for chatting with us today!',
    },
    {
      organizationId: organization._id,
      createdByUserId: supervisorA._id,
      scopeLevel: 'SITE',
      siteId: sites.A._id,
      shortcutKeyword: 'welcome',
      purpose: 'Standard greeting for Site A',
      message: 'Welcome to Site A support! How can I help you today?',
    },
    {
      organizationId: organization._id,
      createdByUserId: supervisorB._id,
      scopeLevel: 'SITE',
      siteId: sites.B._id,
      shortcutKeyword: 'hours',
      purpose: 'Business hours info for Site B',
      message: 'Our Site B team is available Mon-Fri, 9am-5pm ET.',
    },
    {
      organizationId: organization._id,
      createdByUserId: owner._id,
      scopeLevel: 'ORGANIZATION',
      siteId: null,
      shortcutKeyword: 'escalate',
      purpose: 'Escalation notice',
      message: "I'm escalating this to a specialist who can better assist you.",
    },
  ];
  await Shortcut.insertMany(shortcutDocs);
  console.log(
    `Created ${shortcutDocs.length} Shortcuts (2 PERSONAL, 2 SITE, 1 ORGANIZATION)`,
  );

  console.log('\nTest seed complete.');
  console.log(`  Organization: 1, Sites: 4, Departments: 4, WidgetConfigs: 4, Roles: 4`);
  console.log(`  Users: ${allUsers.length}, Visitors: 80, Conversations: 200`);
  console.log(`  Messages: ${messageDocs.length}, PageVisits: ${pageVisitsCreated}, Shortcuts: 5`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Test seed failed:', err);
  process.exitCode = 1;
  return mongoose.disconnect();
});
