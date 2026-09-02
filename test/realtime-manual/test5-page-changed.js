'use strict';
// T-02 requirement 5: visitor page-changed event (FR-VIS-11). Visitor
// navigates, Agent viewing that conversation receives previous/new page.
const h = require('./helpers');

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA2);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID, { pageUrl: 'https://sitea.test.local/pricing' });
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  const visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId }, ['joined_conversation', 'error']);
  await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);

  const waitPageChanged = h.waitForEvent(agentSocket, 'visitor.pageChanged', 3000);
  const ack = await h.emitAndWaitEither(
    visitorSocket,
    'visitor:page_changed',
    { pageUrl: 'https://sitea.test.local/features', conversationId },
    ['page_change_recorded', 'error'],
  );
  if (ack.message) throw new Error(`page_changed rejected: ${ack.message}`);
  const evt = await waitPageChanged;
  console.log('visitor.pageChanged event received by agent:', JSON.stringify(evt, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    eventReceived: !!evt,
    hasConversationId: evt.conversationId === conversationId,
    payloadKeys: Object.keys(evt),
  }, null, 2));

  agentSocket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST5 FAILED', err);
  process.exit(1);
});
