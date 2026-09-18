/**
 * Session Feature-4a-realtime — SRS Feature 4 (Team Panel: Internal
 * Agent-to-Agent Chat). Single round-trip proof for the new `internal:*`
 * WebSocket handlers, following the exact same real-app/real-socket.io-client
 * pattern `test/rbac/websocket-authorization.e2e-spec.ts` established (no
 * mocking — real RealtimeGateway, real InternalConversationsService, real
 * Mongo).
 *
 * agent-a1 and agent-b1 are seeded on DIFFERENT Sites (Site A / Site B) with
 * no shared Site permission at all — deliberately, to prove the SRS's core
 * scope decision: internal chat is Organization-wide, not gated by any
 * `conversations.view_*`/Site-scoped permission the way visitor Conversations
 * are (see RealtimeGateway's new "Internal (Agent-to-Agent) conversations"
 * block doc comment).
 */
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { createTestApp } from '../helpers/bootstrap';
import { tokenFor, userIdFor } from '../helpers/fixtures';

function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const timer = setTimeout(
      () => reject(new Error('WS connect timeout')),
      8000,
    );
    socket.on('connected', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('auth_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`auth_error: ${JSON.stringify(err)}`));
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Same "race every possible response event name" shape as the RBAC WS spec — Nest WS handlers reply via a separate emit, not the ack callback. */
function emitAndWaitForResponse(
  socket: Socket,
  event: string,
  data: unknown,
  responseEvents: string[],
): Promise<{ event: string; data: any }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners: Array<[string, (...args: any[]) => void]> = [];
    const cleanup = () => {
      for (const [name, fn] of listeners) socket.off(name, fn);
    };
    for (const responseEvent of responseEvents) {
      const handler = (payload: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ event: responseEvent, data: payload });
      };
      listeners.push([responseEvent, handler]);
      socket.once(responseEvent, handler);
    }
    socket.emit(event, data);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`No response event received for ${event}`));
      }
    }, 5000);
  });
}

function waitForEvent(
  socket: Socket,
  event: string,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}'`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Session Feature-4a-realtime — internal:* WebSocket handlers', () => {
  let app: INestApplication;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    // Deliberately no app.close() — see websocket-authorization.e2e-spec.ts's
    // afterAll doc comment for the documented MongoNotConnectedError crash
    // this avoids (RealtimeGateway.handleDisconnect runs an async Mongo
    // query shortly after each disconnect() call above returns).
  });

  it('agent-a1 (Site A) and agent-b1 (Site B, no shared Site permission) can open a 1:1 internal conversation, exchange one message, and the recipient can mark it read — fully Organization-scoped, no Site-permission gate', async () => {
    const socketA = await connect(baseUrl, tokenFor('agent-a1@test.local'));
    const socketB = await connect(baseUrl, tokenFor('agent-b1@test.local'));
    sockets.push(socketA, socketB);

    const bUserId = userIdFor('agent-b1@test.local');
    const aUserId = userIdFor('agent-a1@test.local');

    // A opens (find-or-creates) the conversation and joins its room.
    const openAck = await emitAndWaitForResponse(
      socketA,
      'internal:open_conversation',
      { otherUserId: bUserId },
      ['internal_conversation_opened', 'error', 'exception'],
    );
    expect(openAck.event).toBe('internal_conversation_opened');
    const internalConversationId = openAck.data.internalConversationId;
    expect(typeof internalConversationId).toBe('string');
    // Find-or-create reuses the SAME InternalConversation across test runs
    // for this fixed pair (agent-a1, agent-b1) — never asserted empty here,
    // only that it's a well-formed array (see `store.push` semantics on the
    // real, persistent test DB, not a per-test-reset fixture).
    expect(Array.isArray(openAck.data.messages)).toBe(true);

    // B also opens it (same pair, reversed direction) — must resolve to the
    // SAME conversation id (find-or-create de-dup), and joins its room too
    // so it can receive the broadcast below.
    const openAckB = await emitAndWaitForResponse(
      socketB,
      'internal:open_conversation',
      { otherUserId: aUserId },
      ['internal_conversation_opened', 'error', 'exception'],
    );
    expect(openAckB.data.internalConversationId).toBe(internalConversationId);

    // B listens for the new-message broadcast before A sends.
    const messageReceived = waitForEvent(socketB, 'internalMessage:new');

    const sendAck = await emitAndWaitForResponse(
      socketA,
      'internal:send_message',
      { internalConversationId, body: 'Hello from agent-a1' },
      ['internal_message_sent', 'error', 'exception'],
    );
    expect(sendAck.event).toBe('internal_message_sent');
    const messageId = sendAck.data.messageId;
    expect(typeof messageId).toBe('string');

    const received = await messageReceived;
    expect(received.id).toBe(messageId);
    expect(received.body).toBe('Hello from agent-a1');
    expect(received.senderId).toBe(aUserId);
    expect(received.readAt).toBeNull();

    // B (the recipient, not the sender) marks it read — symmetric read
    // receipts, no visitor-side asymmetry.
    const readUpdateOnA = waitForEvent(socketA, 'internalMessage:new');
    const markReadAck = await emitAndWaitForResponse(
      socketB,
      'internal:mark_read',
      { internalConversationId },
      ['internal_marked_read', 'error', 'exception'],
    );
    expect(markReadAck.event).toBe('internal_marked_read');
    // >= 1, not === 1: reruns against the same persistent test DB reuse the
    // same InternalConversation (find-or-create), so an earlier run's own
    // message(s) from A may still have been unread going into this call.
    expect(markReadAck.data.count).toBeGreaterThanOrEqual(1);

    // The sender's own room membership means A also sees the tick update.
    const tickUpdate = await readUpdateOnA;
    expect(tickUpdate.id).toBe(messageId);
    expect(tickUpdate.readAt).not.toBeNull();
    expect(tickUpdate.deliveredAt).not.toBeNull();
  });
});
