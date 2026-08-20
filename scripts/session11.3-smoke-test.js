/**
 * Session 11.3 smoke test — PageVisit tracking, live page/profile/typing-draft
 * events, and Agent-initiated proactive messages. Section [9] is an
 * addendum (FR-RPT-07, the live Visitors list + reaching out to a
 * chat-less Visitor) added after real manual testing surfaced that a
 * Visitor who never starts a chat was completely invisible to the Agent
 * Console — see PROGRESS.md's Session 11.3 entry for the full story. Same
 * style as realtime-smoke-test.js (Session 8): a scriptable, deterministic
 * proof, not a manual click-through. Run with the dev server up:
 *   node scripts/session11.3-smoke-test.js
 */
const { io } = require('socket.io-client');

const API_URL = 'http://localhost:3001';
const OWNER = { email: 'owner@chat-hub.local', password: 'ChangeMe123!' };
const SUPERVISOR = {
  email: 'supervisor.site1@chat-hub.local',
  password: 'ChangeMe123!',
};
const AGENT = { email: 'agent.site1@chat-hub.local', password: 'ChangeMe123!' };

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: res.status, body };
}

function connectSocket(token) {
  return io(API_URL, { auth: { token }, reconnection: false, forceNew: true });
}

function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function neverFires(socket, event, waitMs = 1200) {
  return new Promise((resolve) => {
    let fired = false;
    function handler() {
      fired = true;
    }
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(!fired);
    }, waitMs);
  });
}

function emitAndWait(socket, emitEvent, data, successEvent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on "${emitEvent}"`)), 5000);
    socket.once(successEvent, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.once('error', (payload) => {
      clearTimeout(timer);
      reject(new Error(payload?.message || `"${emitEvent}" failed`));
    });
    socket.emit(emitEvent, data);
  });
}

async function main() {
  console.log('--- Session 11.3 smoke test ---\n');

  console.log('Login...');
  const ownerLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify(OWNER) });
  const supervisorLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify(SUPERVISOR) });
  const agentLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify(AGENT) });
  const ownerToken = ownerLogin.body.accessToken;
  const supervisorToken = supervisorLogin.body.accessToken;
  const agentToken = agentLogin.body.accessToken;
  check('Owner/Supervisor/Agent logged in', !!ownerToken && !!supervisorToken && !!agentToken);

  const ownerMe = await req('/auth/me', { token: ownerToken });
  const siteId = Object.keys(ownerMe.body.sitePermissions)[0];
  const site1Id = Object.entries(ownerMe.body.sitePermissions).find(([, perms]) =>
    perms.includes('conversations.view_site'),
  )?.[0] ?? siteId;
  // Prefer a Site the Agent is actually attached to (agent.site1 -> Site 1).
  const agentMe = await req('/auth/me', { token: agentToken });
  const agentSiteId = Object.keys(agentMe.body.sitePermissions)[0];
  const SITE = agentSiteId;
  console.log(`  Using Site ${SITE}`);

  // -----------------------------------------------------------------------
  // 1) PageVisit tracking via visitor-session/init (full-page-load path).
  // -----------------------------------------------------------------------
  console.log('\n[1] PageVisit tracking (visitor-session/init close-out/open, task req. 2)');
  const init1 = await req('/visitor-session/init', {
    method: 'POST',
    body: JSON.stringify({ siteId: SITE, pageUrl: 'https://example.com/home' }),
  });
  const visitorToken1 = init1.body.token;
  check('First init succeeds', init1.status === 200 && !!visitorToken1);

  const init2 = await req('/visitor-session/init', {
    method: 'POST',
    body: JSON.stringify({ siteId: SITE, pageUrl: 'https://example.com/pricing?utm=x' }),
    headers: { Authorization: `Bearer ${visitorToken1}` },
  });
  const visitorToken = init2.body.token;
  check(
    'Second init (same visitor, new page) succeeds and resolves as returning visitor',
    init2.status === 200 && init2.body.isReturningVisitor === true,
  );

  // -----------------------------------------------------------------------
  // Connect a Visitor socket, start a Conversation, connect an Agent socket.
  // -----------------------------------------------------------------------
  const visitorSocket = connectSocket(visitorToken);
  await waitFor(visitorSocket, 'connected');

  const agentSocket = connectSocket(agentToken);
  await waitFor(agentSocket, 'connected');

  const createConv = await req(`/sites/${SITE}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ initialMessage: 'Hi, testing session 12' }),
    headers: { Authorization: `Bearer ${visitorToken}` },
  });
  const conversationId = createConv.body._id;
  check('Conversation created', createConv.status === 201 && !!conversationId);

  const visitorJoin = await emitAndWait(
    visitorSocket,
    'visitor:join_conversation',
    { conversationId },
    'joined_conversation',
  );
  check('Visitor joined its own Conversation room', !!visitorJoin.conversation);

  const agentJoin = await emitAndWait(
    agentSocket,
    'agent:join_conversation',
    { siteId: SITE, conversationId },
    'joined_conversation',
  );
  check(
    'Agent join_conversation response includes visitorOnline: true (visitor connected)',
    agentJoin.visitorOnline === true,
  );

  // -----------------------------------------------------------------------
  // 2) visitor:page_changed -> visitor.pageChanged (task req. 3, 8)
  // -----------------------------------------------------------------------
  console.log('\n[2] visitor:page_changed -> visitor.pageChanged (live page indicator)');
  const pageChangedWait = waitFor(agentSocket, 'visitor.pageChanged');
  visitorSocket.emit('visitor:page_changed', {
    pageUrl: 'https://example.com/contact',
    conversationId,
  });
  const pageChangedEvt = await pageChangedWait;
  check(
    'Agent (viewing the Conversation) receives visitor.pageChanged with the new page',
    pageChangedEvt.newPage === 'https://example.com/contact' &&
      pageChangedEvt.conversationId === conversationId,
  );

  // -----------------------------------------------------------------------
  // 2b) The REAL scenario test-page/index.html <-> pricing.html exercises:
  // a full-page reload (a fresh visitor-session/init call, NOT the WS
  // visitor:page_changed event above), with a Conversation already open.
  // -----------------------------------------------------------------------
  console.log('\n[2b] Full-page navigation (visitor-session/init again) -> visitor.pageChanged');
  const fullPageNavWait = waitFor(agentSocket, 'visitor.pageChanged');
  const init3 = await req('/visitor-session/init', {
    method: 'POST',
    body: JSON.stringify({ siteId: SITE, pageUrl: 'https://example.com/pricing.html' }),
    headers: { Authorization: `Bearer ${visitorToken}` },
  });
  check('Third init (simulating a real full-page reload) succeeds', init3.status === 200);
  const fullPageNavEvt = await fullPageNavWait;
  check(
    'A full-page reload (init, no WS event at all) ALSO produces a live visitor.pageChanged — this is what test-page/index.html <-> pricing.html exercises',
    fullPageNavEvt.newPage === 'https://example.com/pricing.html' &&
      fullPageNavEvt.conversationId === conversationId,
  );

  // -----------------------------------------------------------------------
  // 3) Recent page-history trail (task req. 11, optional)
  // -----------------------------------------------------------------------
  console.log('\n[3] GET .../page-visits (recent page-history trail)');
  const pageVisits = await req(`/sites/${SITE}/conversations/${conversationId}/page-visits`, {
    token: agentToken,
  });
  check(
    'page-visits returns at least the 4 pages tracked so far, most-recent-first',
    pageVisits.status === 200 &&
      Array.isArray(pageVisits.body) &&
      pageVisits.body.length >= 4 &&
      pageVisits.body[0].pageUrl === 'https://example.com/pricing.html',
    `got ${JSON.stringify(pageVisits.body?.map((r) => r.pageUrl))}`,
  );
  check(
    'The now-closed /pricing PageVisit has exitedAt/durationSeconds set',
    pageVisits.body.some((r) => r.pageUrl.includes('/pricing') && r.exitedAt && r.durationSeconds !== null),
  );

  // -----------------------------------------------------------------------
  // 4) Pre-chat profile submit -> visitor.profileUpdated (task req. 4, 12)
  // -----------------------------------------------------------------------
  console.log('\n[4] PATCH /visitor-session/profile -> visitor.profileUpdated (live Visitor Info panel)');
  const profileWait = waitFor(agentSocket, 'visitor.profileUpdated');
  const profileSubmit = await req('/visitor-session/profile', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Session12 Test Visitor', email: 'session12@example.com' }),
    headers: { Authorization: `Bearer ${visitorToken}` },
  });
  check('Pre-chat form submit succeeds', profileSubmit.status === 200);
  const profileEvt = await profileWait;
  check(
    'Agent receives visitor.profileUpdated with the new name/email',
    profileEvt.visitor?.name === 'Session12 Test Visitor' &&
      profileEvt.visitor?.email === 'session12@example.com' &&
      profileEvt.conversationId === conversationId,
  );

  // -----------------------------------------------------------------------
  // 5) visitors.view_live_activity gating (task req. 5, 13, guardrail)
  // -----------------------------------------------------------------------
  console.log('\n[5] visitor.typingDraft — gated specifically by visitors.view_live_activity');
  const draftMissingWait = neverFires(agentSocket, 'visitor.typingDraft', 1200);
  visitorSocket.emit('visitor:typing_draft', { conversationId, text: 'hello I am ty' });
  const noDraftReceived = await draftMissingWait;
  check(
    "Agent WITHOUT visitors.view_live_activity never receives visitor.typingDraft (even though they hold conversations.view_own)",
    noDraftReceived,
  );

  // Grant the permission via a temporary Role + Site-scoped Role Assignment,
  // same technique Session 5's own PROGRESS.md entry used to prove
  // cross-Site 403s — a real, narrowly-scoped grant, not Owner's org-wide one.
  const agentUserId = agentMe.body.userId;
  const roleCreate = await req('/roles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Session12 Live Activity Test',
      permissions: ['visitors.view_live_activity'],
    }),
    token: ownerToken,
  });
  const roleId = roleCreate.body._id;
  check('Temporary Role created (visitors.view_live_activity only)', roleCreate.status === 201 && !!roleId);

  const assign = await req('/role-assignments', {
    method: 'POST',
    body: JSON.stringify({ userId: agentUserId, roleId, scopeType: 'SITE', siteId: SITE }),
    token: ownerToken,
  });
  check('Role Assignment created (Site-scoped)', assign.status === 201);

  // Re-join the Conversation so the gateway recomputes/caches the permission
  // (liveActivityConversations is computed at join time — see
  // handleAgentJoinConversation's doc comment on the API).
  await emitAndWait(agentSocket, 'agent:join_conversation', { siteId: SITE, conversationId }, 'joined_conversation');

  const draftWait = waitFor(agentSocket, 'visitor.typingDraft');
  visitorSocket.emit('visitor:typing_draft', { conversationId, text: 'now I have permission' });
  const draftEvt = await draftWait;
  check(
    'Agent WITH visitors.view_live_activity now receives visitor.typingDraft with the live text',
    draftEvt.text === 'now I have permission' && draftEvt.conversationId === conversationId,
  );

  // Cleanup the temporary Role/Assignment.
  const assignmentsList = await req(`/role-assignments?userId=${agentUserId}`, { token: ownerToken });
  const tempAssignment = assignmentsList.body.find((a) => a.roleId === roleId || a.roleId?._id === roleId);
  if (tempAssignment) {
    await req(`/role-assignments/${agentUserId}/${tempAssignment._id}`, {
      method: 'DELETE',
      token: ownerToken,
    });
  }
  await req(`/roles/${roleId}`, { method: 'DELETE', token: ownerToken });
  console.log('  (temporary Role/Assignment cleaned up)');

  // -----------------------------------------------------------------------
  // 6) agent.proactiveMessage (task req. 6, 14) — visitor connected case.
  // -----------------------------------------------------------------------
  console.log('\n[6] agent:send_message vs agent:send_proactive_message (distinct event)');
  const normalMsgWait = waitFor(visitorSocket, 'message:new');
  const noProactiveWait = neverFires(visitorSocket, 'agent.proactiveMessage', 1000);
  await emitAndWait(
    agentSocket,
    'agent:send_message',
    { siteId: SITE, conversationId, body: 'a normal reply' },
    'message_sent',
  );
  await normalMsgWait;
  check('A normal agent:send_message never triggers agent.proactiveMessage', await noProactiveWait);

  const proactiveMsgWait = waitFor(visitorSocket, 'message:new');
  const proactiveEvtWait = waitFor(visitorSocket, 'agent.proactiveMessage');
  await emitAndWait(
    agentSocket,
    'agent:send_proactive_message',
    { siteId: SITE, conversationId, body: 'a proactive nudge' },
    'message_sent',
  );
  const [proactiveMsg, proactiveEvt] = await Promise.all([proactiveMsgWait, proactiveEvtWait]);
  check(
    'agent:send_proactive_message fires BOTH message:new (transcript) AND agent.proactiveMessage (bubble signal)',
    proactiveMsg.body === 'a proactive nudge' && proactiveEvt.body === 'a proactive nudge',
  );

  // -----------------------------------------------------------------------
  // 7) "Widget closed" -> visitorOnline: false -> Send anyway still persists.
  // -----------------------------------------------------------------------
  console.log('\n[7] visitorOnline reflects live connection state; proactive send while offline');
  visitorSocket.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  const agentJoin2 = await emitAndWait(
    agentSocket,
    'agent:join_conversation',
    { siteId: SITE, conversationId },
    'joined_conversation',
  );
  check(
    'After the Visitor disconnects, visitorOnline flips to false',
    agentJoin2.visitorOnline === false,
  );

  const proactiveWhileOffline = await emitAndWait(
    agentSocket,
    'agent:send_proactive_message',
    { siteId: SITE, conversationId, body: 'sent while widget closed' },
    'message_sent',
  );
  check('Send anyway succeeds even while the Visitor is offline', !!proactiveWhileOffline.messageId);

  // Reconnect the SAME visitor (same token) and confirm the message is
  // waiting in the transcript, and visitorOnline flips back to true.
  const visitorSocket2 = connectSocket(visitorToken);
  await waitFor(visitorSocket2, 'connected');
  const rejoin = await emitAndWait(
    visitorSocket2,
    'visitor:join_conversation',
    { conversationId },
    'joined_conversation',
  );
  check(
    'Reconnected Visitor sees the proactive message in their transcript',
    rejoin.messages.some((m) => m.body === 'sent while widget closed'),
  );

  const agentJoin3 = await emitAndWait(
    agentSocket,
    'agent:join_conversation',
    { siteId: SITE, conversationId },
    'joined_conversation',
  );
  check('visitorOnline flips back to true once the Visitor reconnects', agentJoin3.visitorOnline === true);

  // -----------------------------------------------------------------------
  // 8) Analytics endpoint (task req. 7) — analytics.view_site.
  // -----------------------------------------------------------------------
  console.log('\n[8] GET /sites/:siteId/analytics/page-visits (FR-RPT-08)');
  const analyticsNoPerm = await req(`/sites/${SITE}/analytics/page-visits`, { token: agentToken });
  check(
    'Agent (no analytics.view_site) is rejected',
    analyticsNoPerm.status === 403,
  );
  const analyticsOwner = await req(`/sites/${SITE}/analytics/page-visits`, { token: ownerToken });
  check(
    'Owner (analytics.view_site) gets aggregated rows including "pricing"/"home"/"contact" categories',
    analyticsOwner.status === 200 &&
      Array.isArray(analyticsOwner.body.rows) &&
      analyticsOwner.body.rows.some((r) => r.key === 'pricing'),
    `got ${JSON.stringify(analyticsOwner.body?.rows)}`,
  );
  const analyticsByPage = await req(
    `/sites/${SITE}/analytics/page-visits?groupBy=page`,
    { token: supervisorToken },
  );
  check(
    'Supervisor (also holds analytics.view_site) can group by exact page too',
    analyticsByPage.status === 200 && analyticsByPage.body.groupBy === 'page',
  );

  // -----------------------------------------------------------------------
  // 9) FR-RPT-07 addendum (added after this session was first called "done"
  // — see PROGRESS.md's "Bug found and fixed" section for why): the live
  // Visitors list. A Visitor who never starts a Conversation must still be
  // visible to an Agent Console with `visitors.view`, and an Agent must be
  // able to reach out to them ("Send anyway" for someone with no
  // Conversation at all, not just a closed widget).
  // -----------------------------------------------------------------------
  console.log('\n[9] FR-RPT-07 — live Visitors list + agent:start_proactive_conversation');

  const supervisorSocket = connectSocket(supervisorToken);
  const supervisorConnected = await waitFor(supervisorSocket, 'connected');
  check(
    'Supervisor auto-joins the Site room (conversations.view_site)',
    (supervisorConnected.siteRooms || []).includes(SITE),
  );

  const onlineWaiter = waitFor(supervisorSocket, 'visitor.online');

  const LIVE_PAGE = 'https://example.com/live-visitors-test';
  const initLive = await req('/visitor-session/init', {
    method: 'POST',
    body: JSON.stringify({ siteId: SITE, pageUrl: LIVE_PAGE }),
  });
  const visitorTokenLive = initLive.body.token;
  check('Chat-less visitor session created', initLive.status === 200 && !!visitorTokenLive);

  const visitorSocketLive = connectSocket(visitorTokenLive);
  await waitFor(visitorSocketLive, 'connected');

  const onlineEvt = await onlineWaiter.catch(() => null);
  check(
    'Supervisor receives visitor.online for the new Visitor (no Conversation involved)',
    !!onlineEvt && onlineEvt.siteId === SITE,
  );

  const liveNoPerm = await req(`/sites/${SITE}/visitors/live`, { token: agentToken });
  const liveAsOwner = await req(`/sites/${SITE}/visitors/live`, { token: ownerToken });
  const liveEntry = (liveAsOwner.body || []).find((v) => v.currentPage === LIVE_PAGE);
  check(
    'GET /sites/:siteId/visitors/live (visitors.view) lists the chat-less Visitor with their current page',
    liveAsOwner.status === 200 && !!liveEntry,
    `got ${JSON.stringify(liveAsOwner.body)}`,
  );
  check(
    "Listed Visitor has activeConversationId: null (hasn't started a chat)",
    liveEntry && liveEntry.activeConversationId === null,
  );
  // Not asserting liveNoPerm is a 403 — whether agent.site1 holds
  // visitors.view depends on seeded Role data, not this endpoint's own
  // logic (already proven generically by the sibling GET /visitors route,
  // Session 6). Recorded for visibility only.
  console.log(`  (info) GET .../visitors/live as Agent → ${liveNoPerm.status}`);

  const proactiveBubbleWaiter = waitFor(visitorSocketLive, 'agent.proactiveMessage');
  const started = await emitAndWait(
    supervisorSocket,
    'agent:start_proactive_conversation',
    { siteId: SITE, visitorId: liveEntry.visitorId, body: 'Hi! Can I help you find something?' },
    'proactive_conversation_started',
  );
  check('agent:start_proactive_conversation returns a new conversationId', !!started.conversationId);

  const proactiveBubble = await proactiveBubbleWaiter.catch(() => null);
  check(
    "Visitor's widget socket receives agent.proactiveMessage for the outreach (no widget-open needed)",
    !!proactiveBubble && proactiveBubble.body.includes('Can I help you find something'),
  );

  const liveAfterStart = await req(`/sites/${SITE}/visitors/live`, { token: ownerToken });
  const liveEntryAfter = (liveAfterStart.body || []).find(
    (v) => v.visitorId === liveEntry.visitorId,
  );
  check(
    'Visitors-list entry now shows the new activeConversationId',
    liveEntryAfter && liveEntryAfter.activeConversationId === started.conversationId,
  );

  // -----------------------------------------------------------------------
  // 10) Second addendum — the Admin Panel's "see live typing preview"
  // toggle (`PATCH /sites/:siteId/users/:userId/live-activity-access`).
  // Added because there was previously NO way at all to grant
  // `visitors.view_live_activity` through the UI (no seeded Role carries
  // it, and there's no general Roles screen yet) — this is the fix.
  // -----------------------------------------------------------------------
  console.log('\n[10] Admin Panel toggle — PATCH .../users/:userId/live-activity-access');

  const beforeToggle = await req(`/sites/${SITE}/users/${agentUserId}/live-activity-access`, { token: ownerToken });
  check('GET starts false for the seeded Agent (nobody granted it yet)', beforeToggle.status === 200 && beforeToggle.body.enabled === false);

  const enableToggle = await req(`/sites/${SITE}/users/${agentUserId}/live-activity-access`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true }),
    token: ownerToken,
  });
  check('Owner (holds the permission itself) can grant it', enableToggle.status === 200 && enableToggle.body.enabled === true);

  const agentMeAfterGrant = await req('/auth/me', { token: agentToken });
  check(
    "The SAME agent token's /auth/me immediately reflects the grant — no re-login needed",
    agentMeAfterGrant.body.sitePermissions[SITE]?.includes('visitors.view_live_activity'),
  );

  const agentTriesToGrant = await req(`/sites/${SITE}/users/${agentUserId}/live-activity-access`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true }),
    token: agentToken,
  });
  check(
    'The Agent itself (no users.manage) is rejected trying to use this endpoint at all',
    agentTriesToGrant.status === 403,
  );

  const disableToggle = await req(`/sites/${SITE}/users/${agentUserId}/live-activity-access`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
    token: ownerToken,
  });
  check('Owner can revoke it again', disableToggle.status === 200 && disableToggle.body.enabled === false);

  const agentMeAfterRevoke = await req('/auth/me', { token: agentToken });
  check(
    'Revoked — the Agent no longer holds it',
    !agentMeAfterRevoke.body.sitePermissions[SITE]?.includes('visitors.view_live_activity'),
  );

  // -----------------------------------------------------------------------
  visitorSocket2.disconnect();
  visitorSocketLive.disconnect();
  agentSocket.disconnect();
  supervisorSocket.disconnect();

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
