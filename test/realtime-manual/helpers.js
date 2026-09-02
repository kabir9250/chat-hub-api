// Shared helpers for T-02 realtime manual test scripts.
// Run these scripts with `node test/realtime-manual/<script>.js` from
// chat-hub-api/ so `require('socket.io-client')` resolves normally.
'use strict';

const { io } = require('socket.io-client');

const BASE_HTTP = 'http://localhost:3011';
const SITE_A_ID = '6a8f2ee514d9b9bd2b790f0e';
const SITE_B_ID = '6a8f2ee614d9b9bd2b790f1d';

const ACCOUNTS = {
  owner: 'owner@test.local',
  manager: 'manager@test.local',
  supervisorA: 'supervisor-a@test.local',
  supervisorB: 'supervisor-b@test.local',
  agentA1: 'agent-a1@test.local',
  agentA2: 'agent-a2@test.local',
  agentB1: 'agent-b1@test.local',
  agentMulti: 'agent-multi@test.local',
};
const PASSWORD = 'Test1234!';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(email) {
  const res = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return { token: body.accessToken, userId: body.user.userId };
}

async function initVisitorSession(siteId, opts = {}) {
  const res = await fetch(`${BASE_HTTP}/visitor-session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, pageUrl: opts.pageUrl || 'https://sitea.test.local/' }),
  });
  if (!res.ok) {
    throw new Error(`visitor-session/init failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // { token, visitor, ... } shape TBD, inspect at call site
}

function connectUserSocket(token) {
  return io(BASE_HTTP, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
  });
}

function connectVisitorSocket(token) {
  return io(BASE_HTTP, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
  });
}

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`timeout waiting for '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(eventName, handler);
  });
}

function waitForConnect(socket, timeoutMs = 5000) {
  return waitForEvent(socket, 'connected', timeoutMs);
}

// IMPORTANT (documented finding, T-01 report): this gateway's handlers
// return `{event, data}`-shaped values from a plain `@SubscribeMessage`
// method. NestJS's WS adapter delivers that as a SEPARATE EMITTED SOCKET
// EVENT (`socket.emit(event, data)`), NOT via the socket.io ack callback —
// so `socket.emitWithAck()` silently times out even on a success path.
// Listen for the named response event instead.
function emitAndWait(socket, emitEvent, data, responseEvent, timeoutMs = 5000) {
  const p = waitForEvent(socket, responseEvent, timeoutMs);
  socket.emit(emitEvent, data);
  return p;
}

// Some handlers (e.g. handleAgentSendMessage) return either
// `{event:'message_sent',...}` or `{event:'error',...}` — both delivered as
// bare emitted events under THEIR OWN name (not a shared name), so the
// caller must race both possibilities.
function emitAndWaitEither(socket, emitEvent, data, responseEvents, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      responseEvents.forEach((e) => socket.off(e, handler));
      reject(new Error(`timeout waiting for one of [${responseEvents.join(',')}] after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      responseEvents.forEach((e) => socket.off(e, handler));
      resolve(payload);
    }
    responseEvents.forEach((e) => socket.once(e, handler));
    socket.emit(emitEvent, data);
  });
}

async function createConversation(visitorToken, siteId, opts = {}) {
  const res = await fetch(`${BASE_HTTP}/sites/${siteId}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${visitorToken}`,
    },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    throw new Error(`create conversation failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchJson(path, token) {
  const res = await fetch(`${BASE_HTTP}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))];
}

module.exports = {
  BASE_HTTP,
  SITE_A_ID,
  SITE_B_ID,
  ACCOUNTS,
  PASSWORD,
  sleep,
  login,
  initVisitorSession,
  connectUserSocket,
  connectVisitorSocket,
  waitForEvent,
  waitForConnect,
  emitAndWait,
  emitAndWaitEither,
  fetchJson,
  createConversation,
  percentile,
};
