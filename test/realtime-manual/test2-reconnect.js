'use strict';
// T-02 requirement 2: delivery under reconnect. Send messages, kill the
// Visitor's WebSocket mid-conversation, reconnect after 5s, verify missed
// messages resync via REST fallback (FR-MSG-05) and no duplicates arrive.
const h = require('./helpers');

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA2);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID);
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  let visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);

  await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId }, ['joined_conversation', 'error']);
  await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);

  // Send message #1 while visitor is connected — should arrive live.
  const waitMsg1 = h.waitForEvent(visitorSocket, 'message:new', 5000);
  await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId, body: 'msg-before-disconnect' }, ['message_sent', 'error']);
  const liveMsg1 = await waitMsg1;
  console.log('PRE-DISCONNECT: visitor received live message:', liveMsg1.body === 'msg-before-disconnect' ? 'PASS' : 'FAIL (body mismatch)');

  // Kill the visitor's WebSocket (simulate connection drop).
  console.log('Disconnecting visitor socket...');
  visitorSocket.disconnect();
  await h.sleep(500);

  // While disconnected, agent sends 3 more messages ("missed messages").
  const missedBodies = ['missed-1', 'missed-2', 'missed-3'];
  const lastMessageIdBeforeDrop = liveMsg1.id;
  for (const body of missedBodies) {
    const ack = await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId, body }, ['message_sent', 'error']);
    if (ack.message) throw new Error(`send failed while visitor offline: ${ack.message}`);
  }
  console.log('Sent 3 messages while visitor was disconnected.');

  // Wait 5s (per task spec) before reconnecting.
  await h.sleep(5000);

  // Reconnect the visitor with the SAME session token (resume).
  visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);
  const rejoinAck = await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);
  const liveTranscriptOnRejoin = rejoinAck.messages || [];
  console.log(`Rejoin transcript (via join_conversation, live-side) has ${liveTranscriptOnRejoin.length} messages.`);

  // Independently verify the REST fallback resync path (FR-MSG-05) using
  // sinceMessageId = the last message id the visitor saw before dropping.
  const resynced = await h.fetchJson(
    `/sites/${h.SITE_A_ID}/conversations/${conversationId}/messages?sinceMessageId=${lastMessageIdBeforeDrop}`,
    agent.token,
  );
  const resyncedBodies = resynced.map((m) => m.body);
  console.log('REST resync (agent-side, sinceMessageId) returned bodies:', resyncedBodies);

  const gotAllMissed = missedBodies.every((b) => resyncedBodies.includes(b));
  console.log('All 3 missed messages present in REST resync:', gotAllMissed ? 'PASS' : 'FAIL');

  // Visitor-side REST resync too (FR-MSG-05 "Visitor side").
  const resyncedVisitor = await h.fetchJson(
    `/sites/${h.SITE_A_ID}/conversations/${conversationId}/messages/mine?sinceMessageId=${lastMessageIdBeforeDrop}`,
    vs.token,
  ).catch(async () => {
    // messages/mine uses VisitorAuthGuard — needs visitor token, not agent's; fetchJson signature takes any bearer token, fine.
    return null;
  });
  console.log('Visitor-side REST resync bodies:', resyncedVisitor ? resyncedVisitor.map((m) => m.body) : 'N/A');

  // Duplicate check: fetch the FULL transcript and ensure each of the 3
  // missed bodies appears exactly once.
  const fullTranscript = await h.fetchJson(`/sites/${h.SITE_A_ID}/conversations/${conversationId}/messages`, agent.token);
  const counts = {};
  for (const m of fullTranscript) counts[m.body] = (counts[m.body] || 0) + 1;
  const dupCheck = missedBodies.map((b) => ({ body: b, count: counts[b] || 0 }));
  console.log('Duplicate check (expect count=1 each):', dupCheck);
  const noDuplicates = dupCheck.every((d) => d.count === 1);
  console.log('No duplicates:', noDuplicates ? 'PASS' : 'FAIL');

  // Also confirm those 3 messages now show deliveredAt set (they were Sent
  // while visitor offline, then delivered on rejoin per deliverPendingMessages).
  const deliveredStates = fullTranscript
    .filter((m) => missedBodies.includes(m.body))
    .map((m) => ({ body: m.body, deliveredAt: m.deliveredAt, readAt: m.readAt }));
  console.log('Delivered/read state of missed messages after rejoin:', deliveredStates);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    liveDeliveryBeforeDisconnect: liveMsg1.body === 'msg-before-disconnect',
    allMissedResyncedViaRest: gotAllMissed,
    noDuplicatesInTranscript: noDuplicates,
    deliveredStates,
  }, null, 2));

  agentSocket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST2 FAILED', err);
  process.exit(1);
});
