// Phase 2 FR-P2-SITE-01–04 combined-mode REST verification — not part of
// the Nest build/Jest suite, same throwaway-script convention as
// scripts/realtime-smoke-test.js (Session 8). Run with the dev server up:
//   node scripts/combined-mode-rest-verify.js
//
// Depends on a fixture User seeded during this session's own verification —
// combined.test@chat-hub.local / ChangeMe123!, holding the seeded
// Supervisor Role via two SITE-scoped Role Assignments, on exactly 2 of the
// 4 seeded Sites. See PROGRESS.md ("Phase 2 — combined/'All Sites' backend")
// for how to recreate it if it's ever removed. Site ids below are this
// Organization's 4 seeded Sites (from Owner's GET /auth/me) — update if the
// seed is ever re-run (Session 3's own note: seed re-runs mint new ids).
const BASE = 'http://localhost:3001';

const SITES = {
  site1: '6a871a7e288c544575fce826', // combined.test IS authorized
  site2: '6a871a7f288c544575fce837', // combined.test is NOT authorized
  site3: '6a871a7f288c544575fce83e', // combined.test IS authorized
  site4: '6a871a7f288c544575fce844', // combined.test is NOT authorized
};

async function j(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

let failed = false;
function assert(cond, msg) {
  if (!cond) {
    console.error('✗ FAIL:', msg);
    failed = true;
  } else {
    console.log('✓', msg);
  }
}

async function main() {
  const login = await j('POST', '/auth/login', {
    email: 'combined.test@chat-hub.local',
    password: 'ChangeMe123!',
  });
  const token = login.body.accessToken;
  assert(!!token, 'combined.test user logged in');

  // Seed one Conversation + Visitor on EACH of the 4 Sites, so a combined
  // query has something to wrongly leak if the scoping is broken.
  const conversations = {};
  for (const [label, siteId] of Object.entries(SITES)) {
    const vs = await j('POST', '/visitor-session/init', {
      siteId,
      pageUrl: `https://example.com/${label}`,
    });
    const visitorToken = vs.body.token;
    // create() is VisitorAuthGuard-gated — needs the visitor token, not a User one.
    const convReal = await fetch(`${BASE}/sites/${siteId}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${visitorToken}`,
      },
      body: JSON.stringify({ initialMessage: `hello from ${label}` }),
    }).then((r) => r.json());
    conversations[label] = { siteId, conversationId: convReal._id, visitorId: vs.body.visitorId };
    console.log(`  created conversation on ${label}: ${convReal._id} (status ${convReal.status})`);
  }

  // Combined Conversations list — must contain ONLY site1 + site3 items.
  const combinedConv = await j('GET', '/conversations?combined=true', undefined, token);
  assert(combinedConv.status === 200, `GET /conversations?combined=true -> 200 (got ${combinedConv.status})`);
  const returnedSiteIds = new Set((combinedConv.body.items || []).map((c) => c.siteId));
  assert(
    combinedConv.body.siteIds && new Set(combinedConv.body.siteIds).size === 2 &&
      combinedConv.body.siteIds.includes(SITES.site1) && combinedConv.body.siteIds.includes(SITES.site3),
    `siteIds field = exactly [site1, site3] (got ${JSON.stringify(combinedConv.body.siteIds)})`,
  );
  assert(
    [...returnedSiteIds].every((id) => id === SITES.site1 || id === SITES.site3),
    `combined Conversations items only ever carry siteId site1/site3 (got ${JSON.stringify([...returnedSiteIds])})`,
  );
  const convSiteLabels = (combinedConv.body.items || []).map((c) => c.siteId);
  assert(
    convSiteLabels.includes(SITES.site1) && convSiteLabels.includes(SITES.site3),
    'combined Conversations actually includes an item from BOTH authorized Sites',
  );

  // A status filter still works correctly across the merged set.
  const statusFiltered = await j('GET', '/conversations?combined=true&status=pending', undefined, token);
  assert(statusFiltered.status === 200, 'GET /conversations?combined=true&status=pending -> 200');
  assert(
    (statusFiltered.body.items || []).every(
      (c) => c.status === 'pending' && (c.siteId === SITES.site1 || c.siteId === SITES.site3),
    ),
    'status filter narrows correctly AND stays scoped to authorized Sites in combined mode',
  );

  // Combined Visitors list — must contain ONLY site1 + site3 Visitors.
  const combinedVisitors = await j('GET', '/visitors?combined=true', undefined, token);
  assert(combinedVisitors.status === 200, `GET /visitors?combined=true -> 200 (got ${combinedVisitors.status})`);
  const visitorSiteIds = new Set((combinedVisitors.body.items || []).map((v) => v.siteId));
  assert(
    combinedVisitors.body.siteIds && new Set(combinedVisitors.body.siteIds).size === 2 &&
      combinedVisitors.body.siteIds.includes(SITES.site1) && combinedVisitors.body.siteIds.includes(SITES.site3),
    `Visitors siteIds field = exactly [site1, site3] (got ${JSON.stringify(combinedVisitors.body.siteIds)})`,
  );
  assert(
    [...visitorSiteIds].every((id) => id === SITES.site1 || id === SITES.site3),
    `combined Visitors items only ever carry siteId site1/site3 (got ${JSON.stringify([...visitorSiteIds])})`,
  );

  // combined=false must be rejected (400), pointing at the single-Site route.
  const rejected = await j('GET', '/conversations?combined=false', undefined, token);
  assert(rejected.status === 400, `GET /conversations?combined=false -> 400 (got ${rejected.status})`);
  const rejectedVisitors = await j('GET', '/visitors?combined=false', undefined, token);
  assert(rejectedVisitors.status === 400, `GET /visitors?combined=false -> 400 (got ${rejectedVisitors.status})`);

  // No Authorization header at all -> 401 on both combined endpoints.
  const noAuthConv = await j('GET', '/conversations?combined=true');
  assert(noAuthConv.status === 401, `GET /conversations?combined=true with no token -> 401 (got ${noAuthConv.status})`);
  const noAuthVis = await j('GET', '/visitors?combined=true');
  assert(noAuthVis.status === 401, `GET /visitors?combined=true with no token -> 401 (got ${noAuthVis.status})`);

  console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
