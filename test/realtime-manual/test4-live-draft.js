'use strict';
// T-02 requirement 4: live draft preview (FR-MSG-09), server-side gated on
// `visitors.view_live_activity`. Per src/rbac/permission.catalog.ts, NONE of
// the 4 default seeded Roles hold this permission except Owner (Manager/
// Supervisor/Agent are all deliberately excluded — see that file's comment).
// So: owner@test.local = holder (positive case), agent-a1@test.local =
// non-holder (negative case) — both real seeded accounts, no ad-hoc Role
// edits needed.
const h = require('./helpers');

async function joinAsAgent(email, siteId, conversationId) {
  const agent = await h.login(email);
  const socket = h.connectUserSocket(agent.token);
  await h.waitForConnect(socket);
  const joinAck = await h.emitAndWaitEither(socket, 'agent:join_conversation', { siteId, conversationId }, ['joined_conversation', 'error']);
  if (joinAck.message) throw new Error(`${email} could not join conversation: ${joinAck.message}`);
  return { email, socket };
}

(async () => {
  // Use agent-a2 (holds conversations.view_own, no live-activity perm either,
  // but not under test) purely to auto-route/own the conversation so it's a
  // real, visible conversation both test subjects can join via their own
  // view permissions.
  const owningAgent = await h.login(h.ACCOUNTS.agentA2);
  const owningSocket = h.connectUserSocket(owningAgent.token);
  await h.waitForConnect(owningSocket);
  await h.emitAndWaitEither(owningSocket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']);

  const vs = await h.initVisitorSession(h.SITE_A_ID);
  const conv = await h.createConversation(vs.token, h.SITE_A_ID, {});
  const conversationId = conv._id;

  const visitorSocket = h.connectVisitorSocket(vs.token);
  await h.waitForConnect(visitorSocket);
  await h.emitAndWaitEither(visitorSocket, 'visitor:join_conversation', { conversationId }, ['joined_conversation', 'error']);

  // Owner: HOLDS visitors.view_live_activity (positive case).
  const holder = await joinAsAgent(h.ACCOUNTS.owner, h.SITE_A_ID, conversationId);
  // supervisor-a: does NOT hold visitors.view_live_activity (negative case),
  // but DOES hold conversations.view_site on Site A, so they can legitimately
  // join ANY Site A conversation (including one assigned to agent-a2) — a
  // real, permitted Conversation-view, just without the live-activity grant.
  // (agent-a1 was considered instead, but Agent's default conversations.view_own
  // would reject joining a conversation assigned to a different agent, which
  // would confound "blocked by view_live_activity" with "blocked from
  // joining at all" — supervisor-a isolates the one permission under test.)
  const nonHolder = await joinAsAgent(h.ACCOUNTS.supervisorA, h.SITE_A_ID, conversationId);

  let holderReceived = null;
  let nonHolderReceived = null;
  holder.socket.once('visitor.typingDraft', (payload) => { holderReceived = payload; });
  nonHolder.socket.once('visitor.typingDraft', (payload) => { nonHolderReceived = payload; });

  visitorSocket.emit('visitor:typing_draft', { conversationId, text: 'Hi, I was wondering about pricing for the ' });

  await h.sleep(1500);

  console.log('Holder (owner@test.local, HAS visitors.view_live_activity) received draft:', holderReceived);
  console.log('Non-holder (supervisor-a@test.local, LACKS visitors.view_live_activity) received draft:', nonHolderReceived);

  const holderGotIt = holderReceived && holderReceived.text.startsWith('Hi, I was wondering');
  const nonHolderCorrectlyBlocked = nonHolderReceived === null;

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    holderReceivedDraft: !!holderGotIt,
    nonHolderCorrectlyBlockedServerSide: nonHolderCorrectlyBlocked,
    verdict: holderGotIt && nonHolderCorrectlyBlocked ? 'PASS' : 'FAIL',
  }, null, 2));

  owningSocket.close();
  holder.socket.close();
  nonHolder.socket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST4 FAILED', err);
  process.exit(1);
});
