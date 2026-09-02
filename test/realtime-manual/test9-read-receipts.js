'use strict';
// T-02 requirement 9: read-receipt state progression (FR-P2-READ-01..05).
const h = require('./helpers');

async function getMessage(token, siteId, conversationId, messageId) {
  const all = await h.fetchJson(`/sites/${siteId}/conversations/${conversationId}/messages`, token);
  // NOTE (finding worth flagging in the report): REST's message shape uses
  // raw Mongoose `_id` (ConversationsService.toMessageWire keeps
  // `.toObject()`'s shape as-is), while the WebSocket `message:new`/
  // `message_sent` payloads use a normalized `id` field — a real,
  // pre-existing minor inconsistency between the two transports' message
  // DTOs, not something introduced by this test.
  return all.find((m) => m._id === messageId);
}

function tickState(m) {
  if (m.readAt) return 'Read (double blue)';
  if (m.deliveredAt) return 'Delivered (double grey)';
  return 'Sent (single grey)';
}

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA1);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const results = {};

  // --- Scenario A: connected + foregrounded visitor -> Read immediately ---
  {
    const vs = await h.initVisitorSession(h.SITE_A_ID);
    const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
    const visitorSocket = h.connectVisitorSocket(vs.token);
    await h.waitForConnect(visitorSocket);
    await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conv_marker: 'A', conversationId: conv._id }, ['joined_conversation', 'error']);
    await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId: conv._id }, ['joined_conversation', 'error']);
    // Visitor reports foreground BEFORE the message is sent.
    await h.emitAndWaitEither(visitorSocket, 'visitor:conversation_foreground', { conversationId: conv._id, foreground: true }, ['conversation_foreground_ack', 'error']);

    const sendAck = await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId: conv._id, body: 'scenario A' }, ['message_sent', 'error']);
    await h.sleep(300);
    const msg = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    results.scenarioA_connectedForeground = { tick: tickState(msg), deliveredAt: msg.deliveredAt, readAt: msg.readAt };
    console.log('Scenario A (connected+foreground):', results.scenarioA_connectedForeground);
    visitorSocket.close();
  }

  // --- Scenario B: disconnected visitor -> stays Sent ---
  {
    const vs = await h.initVisitorSession(h.SITE_A_ID);
    const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
    // Visitor NEVER connects at all (widget fully closed / gone from site).
    await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId: conv._id }, ['joined_conversation', 'error']);
    const sendAck = await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId: conv._id, body: 'scenario B' }, ['message_sent', 'error']);
    await h.sleep(300);
    const msg = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    results.scenarioB_disconnected = { tick: tickState(msg), deliveredAt: msg.deliveredAt, readAt: msg.readAt };
    console.log('Scenario B (disconnected):', results.scenarioB_disconnected);
  }

  // --- Scenario C: connected but NOT foregrounded -> Delivered, then Read on focus ---
  {
    const vs = await h.initVisitorSession(h.SITE_A_ID);
    const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
    const visitorSocket = h.connectVisitorSocket(vs.token);
    await h.waitForConnect(visitorSocket);
    await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId: conv._id }, ['joined_conversation', 'error']);
    await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId: conv._id }, ['joined_conversation', 'error']);
    // Deliberately do NOT report foreground:true — simulates tab open but
    // not focused / conversation not the active one.
    const sendAck = await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId: conv._id, body: 'scenario C' }, ['message_sent', 'error']);
    await h.sleep(300);
    const msgAfterSend = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    const afterSendTick = tickState(msgAfterSend);
    console.log('Scenario C after send (expect Delivered):', { tick: afterSendTick, deliveredAt: msgAfterSend.deliveredAt, readAt: msgAfterSend.readAt });

    // Now visitor focuses the tab -> foreground:true -> should advance to Read.
    const waitTickUpdate = h.waitForEvent(agentSocket, 'message:new', 5000); // message.updated reuses message:new per gateway doc comment
    await h.emitAndWaitEither(visitorSocket, 'visitor:conversation_foreground', { conversationId: conv._id, foreground: true }, ['conversation_foreground_ack', 'error']);
    const tickUpdateEvt = await waitTickUpdate.catch((e) => ({ __timeout: e.message }));
    await h.sleep(300);
    const msgAfterFocus = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    results.scenarioC_connectedUnfocusedThenFocused = {
      afterSend: { tick: afterSendTick, deliveredAt: msgAfterSend.deliveredAt, readAt: msgAfterSend.readAt },
      liveTickUpdateEventReceived: !tickUpdateEvt.__timeout,
      afterFocus: { tick: tickState(msgAfterFocus), deliveredAt: msgAfterFocus.deliveredAt, readAt: msgAfterFocus.readAt },
    };
    console.log('Scenario C (connected, unfocused -> focused):', JSON.stringify(results.scenarioC_connectedUnfocusedThenFocused, null, 2));
    visitorSocket.close();
  }

  // --- Scenario D (MOST IMPORTANT): Read message, visitor disconnects -> tick does NOT revert ---
  {
    const vs = await h.initVisitorSession(h.SITE_A_ID);
    const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
    const visitorSocket = h.connectVisitorSocket(vs.token);
    await h.waitForConnect(visitorSocket);
    await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId: conv._id }, ['joined_conversation', 'error']);
    await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId: conv._id }, ['joined_conversation', 'error']);
    await h.emitAndWaitEither(visitorSocket, 'visitor:conversation_foreground', { conversationId: conv._id, foreground: true }, ['conversation_foreground_ack', 'error']);

    const sendAck = await h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId: h.SITE_A_ID, conversationId: conv._id, body: 'scenario D' }, ['message_sent', 'error']);
    await h.sleep(300);
    const msgBeforeDisconnect = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    const tickBefore = tickState(msgBeforeDisconnect);
    console.log('Scenario D before disconnect (expect Read):', { tick: tickBefore, deliveredAt: msgBeforeDisconnect.deliveredAt, readAt: msgBeforeDisconnect.readAt });

    // Visitor disconnects entirely.
    visitorSocket.disconnect();
    await h.sleep(1000);

    const msgAfterDisconnect = await getMessage(agent.token, h.SITE_A_ID, conv._id, sendAck.messageId);
    const tickAfter = tickState(msgAfterDisconnect);
    results.scenarioD_readThenDisconnect = {
      tickBeforeDisconnect: tickBefore,
      tickAfterDisconnect: tickAfter,
      readAtUnchanged: msgBeforeDisconnect.readAt === msgAfterDisconnect.readAt,
      stillReadAfterDisconnect: !!msgAfterDisconnect.readAt,
    };
    console.log('Scenario D after disconnect (must STILL be Read — the critical assertion):', results.scenarioD_readThenDisconnect);
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));

  agentSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST9 FAILED', err);
  process.exit(1);
});
