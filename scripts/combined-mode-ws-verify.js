// Phase 2 FR-P2-SITE-04 combined-mode WebSocket verification — not part of
// the Nest build/Jest suite, same throwaway-script convention as
// scripts/realtime-smoke-test.js (Session 8). Run with the dev server up:
//   node scripts/combined-mode-ws-verify.js
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3001';
const SITES = {
  site1: '6a871a7e288c544575fce826', // combined.test IS authorized
  site2: '6a871a7f288c544575fce837', // combined.test is NOT authorized
  site3: '6a871a7f288c544575fce83e', // combined.test IS authorized
  site4: '6a871a7f288c544575fce844', // combined.test is NOT authorized
};

let failed = false;
function ok(cond, msg) {
  console.log(cond ? '✓' : '✗ FAIL', msg);
  if (!cond) failed = true;
}

async function j(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startConversation(siteId, label) {
  const vs = await j('POST', '/visitor-session/init', {
    siteId,
    pageUrl: `https://example.com/${label}`,
  });
  const conv = await fetch(`${BASE}/sites/${siteId}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${vs.token}`,
    },
    body: JSON.stringify({ initialMessage: `combined-mode-ws-verify from ${label}` }),
  }).then((r) => r.json());
  return { conv, visitorToken: vs.token };
}

async function main() {
  const login = await j('POST', '/auth/login', {
    email: 'combined.test@chat-hub.local',
    password: 'ChangeMe123!',
  });
  const token = login.accessToken;
  ok(!!token, 'combined.test user logged in');

  const socket = io(BASE, { auth: { token }, transports: ['websocket'] });

  const events = { conversationNew: [], conversationUpdated: [] };
  socket.on('conversation:new', (data) => events.conversationNew.push(data));
  socket.on('conversation:updated', (data) => events.conversationUpdated.push(data));
  socket.onAny((event, ...args) => console.log('  [any-event]', event, JSON.stringify(args)));

  // Wait for the app-level 'connected' event, not just the transport-level
  // 'connect' — handleConnection's identity/presence/room-join logic is
  // async (a DB lookup + PermissionsService call), so client.data.user isn't
  // populated yet at the moment 'connect' fires; emitting before 'connected'
  // races WsJwtGuard and gets spuriously rejected.
  const connectedPayload = await new Promise((resolve, reject) => {
    socket.on('connected', resolve);
    socket.on('connect_error', reject);
  });
  ok(socket.connected, 'combined.test connected over WebSocket');
  console.log('  connected payload:', JSON.stringify(connectedPayload));

  // NestJS Gateway handlers here return `{ event, data }` (`WsResponse`),
  // which Nest delivers as a NAMED event emit back to the client (NOT a
  // socket.io ack callback) — same convention scripts/realtime-smoke-test.js
  // (Session 8) already relies on. Listen for 'joined_combined' rather than
  // using emitWithAck.
  const joinAckPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for joined_combined')), 5000);
    socket.once('joined_combined', (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
  socket.emit('agent:join_combined');
  const joinAckData = await joinAckPromise;
  console.log('  agent:join_combined response:', JSON.stringify(joinAckData));
  ok(true, 'agent:join_combined responded');
  const joinedIds = new Set(joinAckData.authorizedSiteIds);
  ok(
    joinedIds.size === 2 && joinedIds.has(SITES.site1) && joinedIds.has(SITES.site3),
    'authorizedSiteIds = exactly [site1, site3]',
  );
  ok(
    new Set(joinAckData.siteRoomsJoined).size === 2 &&
      joinAckData.siteRoomsJoined.includes(SITES.site1) &&
      joinAckData.siteRoomsJoined.includes(SITES.site3),
    'siteRoomsJoined = exactly [site1, site3] (view_site Sites actually room-joined)',
  );

  // Give the join a beat, then create Conversations on ALL 4 Sites and see
  // which ones this ONE connection actually receives conversation:new for.
  await sleep(300);
  await startConversation(SITES.site1, 'ws-site1');
  await startConversation(SITES.site2, 'ws-site2');
  await startConversation(SITES.site3, 'ws-site3');
  await startConversation(SITES.site4, 'ws-site4');
  await sleep(800);

  const receivedSiteIds = new Set(events.conversationNew.map((e) => e.siteId));
  console.log('  conversation:new received from siteIds:', [...receivedSiteIds]);
  ok(
    receivedSiteIds.has(SITES.site1) && receivedSiteIds.has(SITES.site3),
    'received conversation:new from BOTH authorized Sites (site1 AND site3) on ONE connection',
  );
  ok(
    !receivedSiteIds.has(SITES.site2) && !receivedSiteIds.has(SITES.site4),
    'received NO conversation:new from either unauthorized Site (site2, site4)',
  );

  socket.disconnect();
  console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
