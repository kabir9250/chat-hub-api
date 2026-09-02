'use strict';
// T-02 requirement 3: typing indicator. Visitor types, Agent sees indicator
// within 500ms; stops typing, indicator clears.
const h = require('./helpers');

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA2);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID);
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  const visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);

  await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId }, ['joined_conversation', 'error']);
  await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);

  // Visitor starts typing -> Agent should see 'typing' isTyping:true within 500ms.
  const t0 = process.hrtime.bigint();
  const waitTypingOn = h.waitForEvent(agentSocket, 'typing', 1000);
  visitorSocket.emit('visitor:typing', { conversationId, isTyping: true });
  const typingOnEvt = await waitTypingOn;
  const onLatencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`Typing-start latency: ${onLatencyMs.toFixed(1)}ms — ${onLatencyMs < 500 ? 'PASS (<500ms)' : 'FAIL (>=500ms)'}`);
  console.log('typing event payload:', typingOnEvt);

  // Visitor stops typing -> indicator clears (isTyping:false).
  const t1 = process.hrtime.bigint();
  const waitTypingOff = h.waitForEvent(agentSocket, 'typing', 1000);
  visitorSocket.emit('visitor:typing', { conversationId, isTyping: false });
  const typingOffEvt = await waitTypingOff;
  const offLatencyMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`Typing-stop latency: ${offLatencyMs.toFixed(1)}ms — ${typingOffEvt.isTyping === false ? 'PASS (cleared)' : 'FAIL (still true)'}`);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    typingStartWithin500ms: onLatencyMs < 500,
    typingStartLatencyMs: onLatencyMs,
    typingClearedCorrectly: typingOffEvt.isTyping === false,
    typingStopLatencyMs: offLatencyMs,
  }, null, 2));

  agentSocket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST3 FAILED', err);
  process.exit(1);
});
