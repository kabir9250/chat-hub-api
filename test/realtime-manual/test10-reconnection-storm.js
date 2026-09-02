'use strict';
// T-02 requirement 10: reconnection storm. Connect 10 simulated Visitors +
// all 3 Site-A-scoped seeded Agents (agent-a1, agent-a2, supervisor-a) on
// Site A, then an EXTERNAL orchestrator (the shell) kills and restarts the
// chat-hub-api process while this script's sockets stay alive — proving
// real socket.io client-side reconnection, not a fresh connection made
// after the fact. Verifies all 13 sockets reconnect within 30s of the kill,
// and that no duplicate messages appear in any transcript afterward.
//
// Protocol with the orchestrator (see run-test10.sh / the shell commands
// driving this): this script prints a line starting with "READY_FOR_KILL"
// to stderr once setup is complete — the orchestrator kills the server
// only after seeing that line, then restarts it. This script then polls
// for reconnection for up to MONITOR_WINDOW_MS.
const h = require('./helpers');

// Generous outer bound — real orchestration (an operator killing/restarting
// a process from outside this script, via separate shell commands) has
// unpredictable round-trip latency on top of the actual reconnect time this
// test cares about, so this polls for reconnection rather than sleeping a
// fixed duration, and reports actual per-socket reconnect time (measured
// from THIS script's own detected-disconnect timestamp, not wall-clock
// guesswork) against the task's 30s budget.
const MONITOR_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const KILL_DEADLINE_GRACE_MS = 30_000; // the task's "within 30s" budget

function nowMs() { return Date.now(); }

async function main() {
  // --- 3 Site-A-scoped seeded Agents ---
  const agentAccounts = [h.ACCOUNTS.agentA1, h.ACCOUNTS.agentA2, h.ACCOUNTS.supervisorA];
  const agents = [];
  for (const email of agentAccounts) {
    const login = await h.login(email);
    const socket = h.connectUserSocket(login.token);
    await h.waitForConnect(socket);
    agents.push({ email, token: login.token, socket, disconnectedAt: null, reconnectedAt: null });
  }
  // Only agent-a1/agent-a2 actually route conversations (presence-eligible);
  // supervisor-a doesn't need presence.set (Supervisors aren't part of
  // FR-RTE-01 routing eligibility in this app — Section 5.13's Supervisor
  // role isn't `enabled`-routing-relevant the way Agents are — it's here
  // purely as a 3rd Site-A-scoped socket for the storm, per the task's
  // literal "all 3 seeded Agents" headcount).
  await Promise.all([
    h.emitAndWaitEither(agents[0].socket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']),
    h.emitAndWaitEither(agents[1].socket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']),
  ]);
  console.error(`Connected ${agents.length} agent sockets, presence set.`);

  // --- 10 simulated Visitors, each with their own Conversation ---
  const visitors = [];
  for (let i = 0; i < 10; i++) {
    const vs = await h.initVisitorSession(h.SITE_A_ID, { pageUrl: `https://sitea.test.local/storm-${i}` });
    const conv = await h.createConversation(vs.token, h.SITE_A_ID, { initialMessage: `storm visitor ${i} initial message` });
    const socket = h.connectVisitorSocket(vs.token);
    await h.waitForConnect(socket);
    await h.emitAndWaitEither(socket, 'visitor:join_conversation', { conversationId: conv._id }, ['joined_conversation', 'error']);
    visitors.push({
      index: i,
      visitorId: vs.visitorId,
      token: vs.token,
      conversationId: conv._id,
      socket,
      disconnectedAt: null,
      reconnectedAt: null,
    });
    await h.sleep(250); // stay under visitor-session/init's 20/min/IP throttle
  }
  console.error(`Connected ${visitors.length} visitor sockets, each in its own conversation.`);

  // Baseline transcript message counts (agent-a1 can see conversations it's
  // assigned; use owner for a permission-free read of every conversation).
  const owner = await h.login(h.ACCOUNTS.owner);
  const beforeCounts = {};
  for (const v of visitors) {
    const msgs = await h.fetchJson(`/sites/${h.SITE_A_ID}/conversations/${v.conversationId}/messages`, owner.token);
    beforeCounts[v.conversationId] = msgs.length;
  }
  console.error('Baseline transcript counts recorded:', beforeCounts);

  // Wire up disconnect/reconnect tracking on every socket, for BOTH groups.
  const allSockets = [...agents, ...visitors];
  for (const entry of allSockets) {
    entry.socket.on('disconnect', () => {
      if (!entry.disconnectedAt) entry.disconnectedAt = nowMs();
    });
    entry.socket.on('connect', () => {
      // The very first 'connect' (initial connection above) also fires this
      // — only record as a "reconnect" if we already saw a disconnect.
      if (entry.disconnectedAt && !entry.reconnectedAt) entry.reconnectedAt = nowMs();
    });
  }

  console.error(`READY_FOR_KILL ${nowMs()}`);

  // Poll for every socket's disconnect-then-reconnect, rather than sleeping
  // a fixed duration — decouples this measurement from the orchestrator's
  // own (unpredictable, human/tool-call-latency-bound) kill/restart timing.
  const pollStart = nowMs();
  while (nowMs() - pollStart < MONITOR_TIMEOUT_MS) {
    const anyDisconnected = allSockets.some((e) => e.disconnectedAt);
    const allDone = allSockets.every((e) => !e.disconnectedAt || e.reconnectedAt);
    if (anyDisconnected && allDone) break;
    await h.sleep(POLL_INTERVAL_MS);
  }
  console.error(`Polling ended after ${nowMs() - pollStart}ms.`);

  const killDetectedAt = Math.min(...allSockets.map((e) => e.disconnectedAt).filter(Boolean));
  const report = allSockets.map((e) => ({
    who: e.email || `visitor-${e.index}`,
    disconnected: !!e.disconnectedAt,
    reconnected: !!e.reconnectedAt,
    reconnectMs: e.disconnectedAt && e.reconnectedAt ? e.reconnectedAt - e.disconnectedAt : null,
  }));
  console.error('Reconnection report:', JSON.stringify(report, null, 2));

  const allReconnected = allSockets.every((e) => e.reconnectedAt);
  const allWithin30sOfFirstDetectedDrop = allSockets.every(
    (e) => e.reconnectedAt && (e.reconnectedAt - killDetectedAt) <= KILL_DEADLINE_GRACE_MS,
  );

  // Re-join conversation rooms after reconnect (a fresh transport-level
  // socket.io connection is a NEW server-side socket, so room membership
  // — server in-memory state — must be re-established exactly like a real
  // client would on reconnect; this is expected/correct behavior, not a bug).
  for (const a of agents.slice(0, 2)) {
    await h.emitAndWaitEither(a.socket, 'agent:presence.set', { status: 'online' }, ['presence_set', 'error']).catch(() => {});
  }
  for (const v of visitors) {
    await h.emitAndWaitEither(v.socket, 'visitor:join_conversation', { conversationId: v.conversationId }, ['joined_conversation', 'error']).catch(() => {});
  }

  // Post-restart liveness + duplicate check: each visitor sends ONE fresh
  // message; verify each conversation's transcript grows by EXACTLY 1 (no
  // duplicate delivery/replay from the reconnect).
  for (const v of visitors) {
    const body = `post-restart message from visitor ${v.index}`;
    const ack = await h.emitAndWaitEither(v.socket, 'visitor:send_message', { conversationId: v.conversationId, body }, ['message_sent', 'error']);
    if (ack.message) console.error(`Visitor ${v.index} post-restart send FAILED: ${ack.message}`);
    await h.sleep(150);
  }
  await h.sleep(1000);

  const afterCounts = {};
  const duplicateFindings = [];
  for (const v of visitors) {
    const msgs = await h.fetchJson(`/sites/${h.SITE_A_ID}/conversations/${v.conversationId}/messages`, owner.token);
    afterCounts[v.conversationId] = msgs.length;
    const bodies = msgs.map((m) => m.body);
    const counts = {};
    for (const b of bodies) counts[b] = (counts[b] || 0) + 1;
    const dups = Object.entries(counts).filter(([, c]) => c > 1);
    if (dups.length) duplicateFindings.push({ conversationId: v.conversationId, dups });
  }

  const growthCorrect = visitors.every((v) => afterCounts[v.conversationId] === beforeCounts[v.conversationId] + 1);

  console.log(JSON.stringify({
    totalSockets: allSockets.length,
    allReconnected,
    allWithin30sOfFirstDetectedDrop,
    reconnectionReport: report,
    beforeCounts,
    afterCounts,
    transcriptGrowthExactlyOnePerConversation: growthCorrect,
    duplicateFindings,
  }, null, 2));

  for (const e of allSockets) e.socket.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST10 FAILED', err);
  process.exit(1);
});
