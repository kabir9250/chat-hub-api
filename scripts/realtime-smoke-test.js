/**
 * Session 8 (Realtime Gateway) — end-to-end smoke test.
 *
 * Not a Jest test, not committed as part of the build — a standalone script
 * run manually against a live dev server (per the task's guardrail: "test
 * with a WebSocket client tool... or a minimal test script", "do not build
 * the widget or agent console UI yet"). Exercises:
 *
 *   1. A simulated visitor + a simulated agent exchanging a real message
 *      end to end over the WebSocket gateway.
 *   2. Auto-routing (FR-RTE-01/02) assigning a new Conversation to the one
 *      online, eligible Agent, and leaving a Conversation pending/
 *      unassigned when no Agent is online.
 *   3. Typing indicators both directions.
 *   4. Agent presence (online -> away) broadcast to a Supervisor's Site room.
 *   5. Permission scoping: an Agent (holds only conversations.view_own) is
 *      REJECTED joining a Site-wide room (needs .view_site), and cannot
 *      join/see a Conversation that isn't assigned to them.
 *   6. The FR-MSG-05 REST resync fallback (messages "since").
 *
 * Usage: `node scripts/realtime-smoke-test.js` (dev server must already be
 * running on http://localhost:3001, with the seeded accounts present —
 * `npm run seed` if needed). All test-created data is left in place
 * (Conversations/Messages), same as prior sessions' verification style.
 */
const { io } = require('socket.io-client');

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
const PASSWORD = 'ChangeMe123!';

function log(...args) {
  console.log(...args);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

async function login(email) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function me(token) {
  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`/auth/me failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function initVisitorSession(siteId) {
  const res = await fetch(`${BASE_URL}/visitor-session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId }),
  });
  if (!res.ok) throw new Error(`visitor-session/init failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createConversation(siteId, visitorToken, initialMessage) {
  const res = await fetch(`${BASE_URL}/sites/${siteId}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${visitorToken}`,
    },
    body: JSON.stringify({ initialMessage }),
  });
  if (!res.ok) throw new Error(`create conversation failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getMessagesSince(siteId, conversationId, userToken, query = '') {
  const res = await fetch(
    `${BASE_URL}/sites/${siteId}/conversations/${conversationId}/messages${query}`,
    { headers: { Authorization: `Bearer ${userToken}` } },
  );
  if (!res.ok) throw new Error(`messages-since failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getMyMessagesSince(conversationId, visitorToken, query = '') {
  const res = await fetch(
    `${BASE_URL}/sites/x/conversations/${conversationId}/messages/mine${query}`,
    { headers: { Authorization: `Bearer ${visitorToken}` } },
  );
  if (!res.ok) throw new Error(`visitor messages-since failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const timer = setTimeout(() => reject(new Error(`${label}: connect timeout`)), 8000);
    socket.once('connected', (payload) => {
      clearTimeout(timer);
      resolve({ socket, payload });
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: connect_error ${JSON.stringify(err)}`));
    });
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * NestJS Gateway handlers here return `{ event, data }` (`WsResponse`) —
 * per Nest's own convention (see the pre-existing `ping`/`pong` handler
 * this gateway kept), that's delivered as `client.emit(event, data)`, i.e.
 * a NAMED event back to the client — NOT a socket.io acknowledgement
 * callback. This waits for whichever of `responseEvents` arrives first and
 * returns `{ event, data }` to mirror the handler's own return shape.
 */
function emitAndWait(socket, emitEvent, data, responseEvents, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for a response to "${emitEvent}"`)),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      for (const ev of responseEvents) socket.off(ev, handlers[ev]);
    };
    const handlers = {};
    for (const ev of responseEvents) {
      handlers[ev] = (payload) => {
        cleanup();
        resolve({ event: ev, data: payload });
      };
      socket.once(ev, handlers[ev]);
    }
    socket.emit(emitEvent, data);
  });
}

async function main() {
  log('== Session 8 realtime smoke test ==\n');

  log('[setup] logging in seeded accounts + resolving Site 1 id...');
  const ownerLogin = await login('owner@chat-hub.local');
  const ownerMe = await me(ownerLogin.accessToken);
  const siteIds = Object.keys(ownerMe.sitePermissions);
  const site1 = siteIds[0];
  assert(!!site1, `resolved Site 1 id (${site1})`);

  const agentLogin = await login('agent.site1@chat-hub.local');
  const agentMe = await me(agentLogin.accessToken);
  const supervisorLogin = await login('supervisor.site1@chat-hub.local');
  ok(`agent userId=${agentMe.userId}, agent holds sitePermissions[site1]=${JSON.stringify(agentMe.sitePermissions[site1])}`);

  // ---------------------------------------------------------------------
  // 1. Connect Agent + Supervisor sockets. Agent holds only
  //    conversations.view_own by default -> should NOT auto-join the Site
  //    room. Supervisor holds conversations.view_site -> SHOULD.
  // ---------------------------------------------------------------------
  log('\n[connect] agent + supervisor sockets...');
  const { socket: agentSocket, payload: agentConnPayload } = await connectSocket(
    agentLogin.accessToken,
    'agent',
  );
  assert(agentConnPayload.kind === 'user', 'agent connected as kind=user');
  assert(
    !agentConnPayload.siteRooms.includes(site1),
    `agent did NOT auto-join site room for Site 1 (view_own only) — siteRooms=${JSON.stringify(agentConnPayload.siteRooms)}`,
  );
  assert(agentConnPayload.presence === 'online', 'agent presence is online on connect');

  const { socket: supervisorSocket, payload: supervisorConnPayload } = await connectSocket(
    supervisorLogin.accessToken,
    'supervisor',
  );
  assert(
    supervisorConnPayload.siteRooms.includes(site1),
    `supervisor DID auto-join site room for Site 1 (view_site) — siteRooms=${JSON.stringify(supervisorConnPayload.siteRooms)}`,
  );

  // ---------------------------------------------------------------------
  // 2. Permission rejection — Agent tries to join the Site-wide room they
  //    don't qualify for (needs conversations.view_site).
  // ---------------------------------------------------------------------
  log('\n[negative] agent attempts agent:join_site (should be rejected)...');
  const joinSiteRejection = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    agentSocket.once('exception', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
    agentSocket.emit('agent:join_site', { siteId: site1 });
  });
  assert(
    joinSiteRejection !== null,
    `agent:join_site was rejected (PermissionGuard) — got: ${JSON.stringify(joinSiteRejection)}`,
  );

  // ---------------------------------------------------------------------
  // 3. Visitor session + auto-routing: agent is online + eligible -> new
  //    Conversation should auto-assign to them (least-active strategy,
  //    trivially "least" since they have zero active Conversations).
  // ---------------------------------------------------------------------
  log('\n[routing] visitor starts a Conversation while Agent is online...');
  const visitorSession = await initVisitorSession(site1);
  const assignedEventPromise = once(agentSocket, 'conversation:assigned');
  const conversationA = await createConversation(
    site1,
    visitorSession.token,
    'Hello from the smoke test (conversation A)',
  );
  assert(
    conversationA.assignedAgentId === agentMe.userId,
    `Conversation A auto-assigned to the online Agent (assignedAgentId=${conversationA.assignedAgentId})`,
  );
  assert(conversationA.status === 'open', `Conversation A status is 'open' (assigned) — got ${conversationA.status}`);
  const assignedEvent = await assignedEventPromise;
  assert(
    assignedEvent.conversationId === conversationA._id,
    'agent received conversation:assigned push over their personal room',
  );

  // ---------------------------------------------------------------------
  // 4. Both sides join the Conversation room and exchange typing + a real
  //    message, end to end.
  // ---------------------------------------------------------------------
  log('\n[connect] visitor socket + join_conversation (both sides)...');
  const { socket: visitorSocket } = await connectSocket(visitorSession.token, 'visitor');

  const agentJoinAck = await emitAndWait(
    agentSocket,
    'agent:join_conversation',
    { siteId: site1, conversationId: conversationA._id },
    ['joined_conversation', 'error'],
  );
  assert(
    agentJoinAck.event === 'joined_conversation' &&
      agentJoinAck.data.messages.length === 1,
    `agent joined the Conversation room (transcript has ${agentJoinAck.data?.messages?.length} message(s))`,
  );

  const visitorJoinAck = await emitAndWait(
    visitorSocket,
    'visitor:join_conversation',
    { conversationId: conversationA._id },
    ['joined_conversation', 'error'],
  );
  assert(
    visitorJoinAck.event === 'joined_conversation',
    'visitor joined their own Conversation room',
  );

  log('\n[typing] agent -> visitor, visitor -> agent...');
  const visitorTypingPromise = once(visitorSocket, 'typing');
  agentSocket.emit('agent:typing', { conversationId: conversationA._id, isTyping: true });
  const visitorSawTyping = await visitorTypingPromise;
  assert(
    visitorSawTyping.senderType === 'agent' && visitorSawTyping.isTyping === true,
    'visitor received agent typing indicator',
  );

  const agentTypingPromise = once(agentSocket, 'typing');
  visitorSocket.emit('visitor:typing', { conversationId: conversationA._id, isTyping: true });
  const agentSawTyping = await agentTypingPromise;
  assert(
    agentSawTyping.senderType === 'visitor' && agentSawTyping.isTyping === true,
    'agent received visitor typing indicator',
  );

  log('\n[message] agent -> visitor, visitor -> agent, real-time...');
  const visitorMsgPromise = once(visitorSocket, 'message:new');
  const agentSendAck = await emitAndWait(
    agentSocket,
    'agent:send_message',
    { siteId: site1, conversationId: conversationA._id, body: 'Hi! How can I help you today?' },
    ['message_sent', 'error'],
  );
  assert(agentSendAck.event === 'message_sent', 'agent send_message acked');
  const visitorReceivedMsg = await visitorMsgPromise;
  assert(
    visitorReceivedMsg.body === 'Hi! How can I help you today?' &&
      visitorReceivedMsg.senderType === 'agent',
    'visitor received the agent message in real time',
  );

  const agentMsgPromise = once(agentSocket, 'message:new');
  const visitorSendAck = await emitAndWait(
    visitorSocket,
    'visitor:send_message',
    { conversationId: conversationA._id, body: 'Thanks, I have a billing question.' },
    ['message_sent', 'error'],
  );
  assert(visitorSendAck.event === 'message_sent', 'visitor send_message acked');
  const agentReceivedMsg = await agentMsgPromise;
  assert(
    agentReceivedMsg.body === 'Thanks, I have a billing question.' &&
      agentReceivedMsg.senderType === 'visitor',
    'agent received the visitor message in real time',
  );

  // ---------------------------------------------------------------------
  // 5. Presence: agent flips to 'away', supervisor (in the Site room)
  //    should see the broadcast.
  // ---------------------------------------------------------------------
  log('\n[presence] agent sets status to away, supervisor should see it...');
  const presenceEventPromise = once(supervisorSocket, 'presence:update');
  const presenceAck = await emitAndWait(
    agentSocket,
    'agent:presence.set',
    { status: 'away' },
    ['presence_set', 'error'],
  );
  assert(presenceAck.event === 'presence_set', 'agent presence.set acked');
  const presenceEvent = await presenceEventPromise;
  assert(
    presenceEvent.userId === agentMe.userId && presenceEvent.status === 'away',
    `supervisor received presence:update (${JSON.stringify(presenceEvent)})`,
  );

  // ---------------------------------------------------------------------
  // 6. FR-MSG-05 REST resync fallback.
  // ---------------------------------------------------------------------
  log('\n[resync] REST "messages since" fallback...');
  const allMessages = await getMessagesSince(site1, conversationA._id, agentLogin.accessToken);
  assert(allMessages.length === 3, `agent full transcript via REST has 3 messages (got ${allMessages.length})`);
  const lastId = allMessages[allMessages.length - 1]._id;
  const sinceLast = await getMessagesSince(
    site1,
    conversationA._id,
    agentLogin.accessToken,
    `?sinceMessageId=${lastId}`,
  );
  assert(sinceLast.length === 0, `messages "since" the last message id returns 0 (got ${sinceLast.length})`);
  const visitorTranscript = await getMyMessagesSince(conversationA._id, visitorSession.token);
  assert(visitorTranscript.length === 3, `visitor's own REST resync also sees 3 messages (got ${visitorTranscript.length})`);

  // ---------------------------------------------------------------------
  // 7. Negative: no-agent-available routing (FR-RTE-02) + Agent cannot
  //    join/see a Conversation that isn't theirs (view_own scoping).
  // ---------------------------------------------------------------------
  log('\n[routing] disconnect agent -> new Conversation should be unassigned/pending...');
  agentSocket.disconnect();
  await new Promise((r) => setTimeout(r, 500)); // let the server process the disconnect

  const visitorSession2 = await initVisitorSession(site1);
  const conversationB = await createConversation(
    site1,
    visitorSession2.token,
    'Hello from the smoke test (conversation B, agent offline)',
  );
  assert(
    conversationB.assignedAgentId === null,
    `Conversation B left unassigned (assignedAgentId=${conversationB.assignedAgentId})`,
  );
  assert(
    conversationB.status === 'pending',
    `Conversation B status is 'pending' (FR-RTE-02) — got ${conversationB.status}`,
  );

  log('\n[negative] reconnected agent cannot join Conversation B (not assigned to them)...');
  const { socket: agentSocket2 } = await connectSocket(agentLogin.accessToken, 'agent-reconnect');
  const forbiddenJoinAck = await emitAndWait(
    agentSocket2,
    'agent:join_conversation',
    { siteId: site1, conversationId: conversationB._id },
    ['joined_conversation', 'error'],
  );
  assert(
    forbiddenJoinAck.event === 'error',
    `agent was refused joining a Conversation not assigned to them — got: ${JSON.stringify(forbiddenJoinAck)}`,
  );

  // Cleanup sockets.
  agentSocket2.disconnect();
  supervisorSocket.disconnect();
  visitorSocket.disconnect();

  log('\n== Done ==');
  if (process.exitCode === 1) {
    log('One or more checks FAILED — see ✗ lines above.');
  } else {
    log('All checks passed.');
  }
}

main().catch((err) => {
  console.error('\nSMOKE TEST CRASHED:', err);
  process.exit(1);
});
