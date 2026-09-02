'use strict';
// T-02 requirement 6: visitor profile-updated event (FR-MSG-08). Visitor
// submits pre-chat form, Agent's Visitor Info panel updates without refresh.
const h = require('./helpers');

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA2);
  const agentSocket = h.connectUserSocket(agent.token);
  await h.waitForConnect(agentSocket);
  await h.emitAndWaitEither(agentSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID);
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  await h.emitAndWaitEither(agentSocket, 'agent:join_conversation', { siteId: h.SITE_A_ID, conversationId }, ['joined_conversation', 'error']);

  const waitProfileUpdated = h.waitForEvent(agentSocket, 'visitor.profileUpdated', 5000);

  const res = await fetch(`${h.BASE_HTTP}/visitor-session/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vs.token}` },
    body: JSON.stringify({ name: 'Jane QA Tester', email: 'jane.qa@example.com', phone: '+1-555-0100' }),
  });
  if (!res.ok) throw new Error(`submitProfile failed: ${res.status} ${await res.text()}`);
  const profileResult = await res.json();
  console.log('Pre-chat form submitted, REST response:', JSON.stringify(profileResult).slice(0, 300));

  const evt = await waitProfileUpdated;
  console.log('visitor.profileUpdated event received by agent:', JSON.stringify(evt, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    eventReceived: !!evt,
    nameMatches: JSON.stringify(evt).includes('Jane QA Tester'),
    emailMatches: JSON.stringify(evt).includes('jane.qa@example.com'),
  }, null, 2));

  agentSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST6 FAILED', err);
  process.exit(1);
});
