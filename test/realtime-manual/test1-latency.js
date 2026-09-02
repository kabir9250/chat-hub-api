'use strict';
// T-02 requirement 1: message delivery latency, 100 msgs each direction,
// P50/P95/max round-trip time.
//
// NOTE: RealtimeGateway's WsRateLimiterService caps message-sending at 30
// per 60s PER USER/VISITOR (§6.3 anti-spam limit, MESSAGE_SEND_LIMIT in
// realtime.gateway.ts) — sending 100 messages back-to-back in one direction
// would trip that limiter well before completing, which would measure the
// rate limiter's rejection behavior, not real delivery latency. Paced at
// ~2.1s/message (≈28.5/min, safely under the 30/min cap) so every one of
// the 100 messages is a genuine, accepted send — this IS a "quiet local
// run" in message-content terms, just deliberately slow in wall-clock time
// to respect the app's own anti-abuse guardrail rather than work around it.
const h = require('./helpers');

const N = 100;
const PACE_MS = 2100;

function waitForMatchingMessage(socket, matchBody, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message:new', handler);
      reject(new Error(`timeout waiting for message:new body="${matchBody}"`));
    }, timeoutMs);
    function handler(payload) {
      if (payload && payload.body === matchBody) {
        clearTimeout(timer);
        socket.off('message:new', handler);
        resolve(payload);
      }
    }
    socket.on('message:new', handler);
  });
}

async function measureDirection(agentSocket, visitorSocket, conversationId, siteId, direction) {
  const rtts = [];
  const errors = [];
  for (let i = 0; i < N; i++) {
    const body = `${direction} msg ${i} ${Date.now()}`;
    const t0 = process.hrtime.bigint();
    try {
      if (direction === 'agent->visitor') {
        const waitMsg = waitForMatchingMessage(visitorSocket, body, 8000);
        const sendPromise = h.emitAndWaitEither(agentSocket, 'agent:send_message', { siteId, conversationId, body }, ['message_sent', 'error']);
        const [sendAck] = await Promise.all([sendPromise, waitMsg]);
        if (sendAck && sendAck.message) throw new Error(`send rejected: ${sendAck.message}`);
      } else {
        const waitMsg = waitForMatchingMessage(agentSocket, body, 8000);
        const sendPromise = h.emitAndWaitEither(visitorSocket, 'visitor:send_message', { conversationId, body }, ['message_sent', 'error']);
        const [sendAck] = await Promise.all([sendPromise, waitMsg]);
        if (sendAck && sendAck.message) throw new Error(`send rejected: ${sendAck.message}`);
      }
      const t1 = process.hrtime.bigint();
      rtts.push(Number(t1 - t0) / 1e6); // ms
    } catch (err) {
      errors.push({ i, error: err.message });
    }
    await h.sleep(PACE_MS);
  }
  rtts.sort((a, b) => a - b);
  return {
    p50: h.percentile(rtts, 50),
    p95: h.percentile(rtts, 95),
    max: rtts.length ? rtts[rtts.length - 1] : null,
    min: rtts.length ? rtts[0] : null,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    successCount: rtts.length,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
  };
}

(async () => {
  const agent = await h.login(h.ACCOUNTS.agentA1);
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

  console.error(`Conversation: ${conversationId}`);
  console.error('Measuring Agent -> Visitor (100 messages, paced)...');
  const a2v = await measureDirection(agentSocket, visitorSocket, conversationId, h.SITE_A_ID, 'agent->visitor');
  console.error('Agent->Visitor done:', a2v);

  console.error('Measuring Visitor -> Agent (100 messages, paced)...');
  const v2a = await measureDirection(agentSocket, visitorSocket, conversationId, h.SITE_A_ID, 'visitor->agent');
  console.error('Visitor->Agent done:', v2a);

  console.log(JSON.stringify({ conversationId, agentToVisitor: a2v, visitorToAgent: v2a }, null, 2));

  agentSocket.close();
  visitorSocket.close();
  process.exit(0);
})().catch((err) => {
  console.error('TEST1 FAILED', err);
  process.exit(1);
});
