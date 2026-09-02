'use strict';
// T-02 requirement 7: agent proactive message to a closed/minimized widget
// (FR-MSG-07). With the Visitor's widget socket NOT connected (simulating
// closed/minimized — VisitorPresenceService's "connected" signal is the
// proxy the app itself uses for this, per RealtimeGateway's doc comment),
// an Agent sends via agent:send_proactive_message; verify the Visitor,
// once (re)connected, receives it as a proactive bubble event
// (agent.proactiveMessage), distinct from an ordinary message:new.
const h = require('./helpers');

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA2);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID);
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  // Visitor briefly connects/joins once (so the conversation room exists
  // for them), then disconnects — simulating "widget closed."
  let visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);
  await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);
  visitorSocket.disconnect();
  await h.sleep(500);

  const joinAck = await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId }, ['joined_conversation', 'error']);
  console.log('Agent sees visitorOnline (should be false, widget closed):', joinAck.visitorOnline);

  // Agent sends proactive message while visitor is offline ("Send anyway").
  const sendAck = await h.emitAndWaitEither(
    agentSocket,
    'agent:send_proactive_message',
    { siteId: h.SITE_A_ID, conversationId, body: 'Still there? We have a special offer for you!' },
    ['message_sent', 'error'],
  );
  if (sendAck.message) throw new Error(`proactive send rejected: ${sendAck.message}`);
  console.log('Proactive message sent while visitor offline:', sendAck);

  // Visitor "opens the widget" again (reconnects) — its personal room
  // (visitorRoom) should now receive the proactive bubble event live,
  // since it's still connected at the moment of a SECOND proactive send.
  visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);

  const waitProactive = h.waitForEvent(visitorSocket, 'agent.proactiveMessage', 5000);
  const sendAck2 = await h.emitAndWaitEither(
    agentSocket,
    'agent:send_proactive_message',
    { siteId: h.SITE_A_ID, conversationId, body: 'Second proactive nudge, widget still closed on visitor UI.' },
    ['message_sent', 'error'],
  );
  if (sendAck2.message) throw new Error(`proactive send #2 rejected: ${sendAck2.message}`);
  const proactiveEvt = await waitProactive;
  console.log('Visitor received agent.proactiveMessage event:', JSON.stringify(proactiveEvt, null, 2));

  // Confirm it did NOT also arrive as a plain message:new to distinguish it
  // (widget should render the proactive bubble via the dedicated event).
  let alsoGotPlainMessageNew = false;
  visitorSocket.once('message:new', () => { alsoGotPlainMessageNew = true; });
  await h.sleep(500);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    widgetShowedClosedToAgent: joinAck.visitorOnline === false,
    proactiveSentWhileOffline: !sendAck.message,
    proactiveBubbleEventReceivedOnReconnect: !!proactiveEvt,
    bodyMatches: proactiveEvt.body === 'Second proactive nudge, widget still closed on visitor UI.',
  }, null, 2));

  agentSocket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST7 FAILED', err);
  process.exit(1);
});
