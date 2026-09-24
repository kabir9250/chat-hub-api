import { Types } from 'mongoose';

import { VisitorSessionService } from './visitor-session.service';
import { VisitorPresenceService } from '../realtime/visitor-presence.service';
import { ConversationDocument } from '../database/schemas';

/**
 * Verifies the reported bug's actual end-to-end fix: a Conversation left
 * open/pending by a Visitor who has genuinely gone (tab closed, past the
 * grace window, no reconnect) gets closed — via `VisitorPresenceService`'s
 * `onVisitEnded` callback, registered by this service's own constructor —
 * with no `init()` call involved at all, and multiple live sockets for the
 * same Visitor (shared-visit multi-tab) never trigger a close.
 *
 * Uses a REAL `VisitorPresenceService` (not a mock) so the constructor's
 * `onVisitEnded` registration and the timer/grace-window mechanics are
 * exercised for real, per the plan's own instruction to test this as one
 * flow rather than mock the seam between the two services.
 */
describe('VisitorSessionService — visit-end chat close (grace-timer driven)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const siteId = new Types.ObjectId();
  const visitorId = new Types.ObjectId();

  function makeConversation(
    overrides: Partial<ConversationDocument> = {},
  ): ConversationDocument {
    return {
      _id: new Types.ObjectId(),
      visitorId,
      siteId,
      status: 'open',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: null,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as ConversationDocument;
  }

  function makeService(conversations: ConversationDocument[]) {
    const visitorPresence = new VisitorPresenceService();

    const conversationModel = {
      find: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(conversations),
      })),
    };
    const messageModel = {
      // No conversation in these tests relies on the unanswered-outreach
      // carve-out (that's `closeChatsForEndedVisit`'s own, already-covered
      // concern) — every stale Conversation here has a visitor message, so
      // this is never actually consulted for the skip path either way.
      exists: jest.fn().mockResolvedValue(true),
    };
    const auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    const realtimeEvents = { emit: jest.fn() };
    const pageVisitsService = {
      getCurrentVisitStartedAt: jest.fn().mockResolvedValue(null),
    };

    const service = new VisitorSessionService(
      {} as never, // siteModel — unused by this path
      {} as never, // visitorModel — unused by this path
      conversationModel as never,
      messageModel as never,
      {} as never, // widgetConfigModel
      {} as never, // bannedEntryModel
      {} as never, // jwtService
      auditLogService as never,
      {} as never, // attributionService
      {} as never, // leadsService
      pageVisitsService as never,
      realtimeEvents as never,
      visitorPresence,
      {} as never, // analyticsEvents
      {} as never, // ipVisitorIdentityGuard
    );

    return { service, visitorPresence, conversationModel, auditLogService, realtimeEvents };
  }

  it('closes a stale Conversation once the Visitor has been gone past the grace window', async () => {
    const conversation = makeConversation();
    const { visitorPresence, auditLogService, realtimeEvents } = makeService([
      conversation,
    ]);

    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-1');
    visitorPresence.removeConnection(visitorId.toString(), 'socket-1');

    // Not yet past the grace window — must not have closed anything.
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS - 1);
    expect(conversation.status).toBe('open');

    // Cross the grace window — the registered handler runs fire-and-forget
    // inside the service (several `await`s deep: getCurrentVisitStartedAt →
    // find → messageModel.exists → save → auditLogService.record). Real
    // timers + a real `setTimeout(0)` flush every one of those microtask/
    // macrotask hops reliably, rather than guessing an exact `Promise
    // .resolve()` count against fake timers.
    jest.advanceTimersByTime(1);
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conversation.status).toBe('closed');
    expect(conversation.save).toHaveBeenCalledTimes(1);
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conversation.closed_on_visit_end',
        actorType: 'system',
      }),
    );
    expect(realtimeEvents.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'conversation.updated',
        conversationId: conversation._id.toString(),
        visitorId: visitorId.toString(),
        changeType: 'status',
        data: { before: 'open', after: 'closed' },
      }),
    );
  });

  it('never closes anything while a second tab (another live socket) keeps the visit alive', async () => {
    const conversation = makeConversation();
    const { visitorPresence } = makeService([conversation]);

    // Two tabs' sockets for the same Visitor.
    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-1');
    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-2');

    // Tab 1 closes — tab 2 is still live, so no grace timer even starts.
    visitorPresence.removeConnection(visitorId.toString(), 'socket-1');
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS * 2);
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conversation.status).toBe('open');
    expect(conversation.save).not.toHaveBeenCalled();
  });

  it('reconnecting within the grace window (same tab or a new one) cancels the close entirely', async () => {
    const conversation = makeConversation();
    const { visitorPresence } = makeService([conversation]);

    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-1');
    visitorPresence.removeConnection(visitorId.toString(), 'socket-1');

    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS - 1);
    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-2');

    // Let the original timer's deadline fully elapse — must never fire late.
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS * 2);
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conversation.status).toBe('open');
    expect(conversation.save).not.toHaveBeenCalled();
  });

  it('leaves an unanswered same-visit proactive outreach open (existing carve-out, unaffected by this redesign)', async () => {
    // startedAt >= visitStartedAt (the visit that just ended) and no visitor
    // message yet — the exact "outreach sent moments ago, still current"
    // shape the carve-out protects.
    const outreach = makeConversation({ startedAt: new Date('2026-06-01T00:00:00Z') });
    const visitorPresence = new VisitorPresenceService();

    const conversationModel = {
      find: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([outreach]) })),
    };
    const messageModel = { exists: jest.fn().mockResolvedValue(false) };
    const auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    const realtimeEvents = { emit: jest.fn() };
    const pageVisitsService = {
      // Visit that just ended started AT/BEFORE the outreach — carve-out applies.
      getCurrentVisitStartedAt: jest
        .fn()
        .mockResolvedValue(new Date('2026-06-01T00:00:00Z')),
    };

    new VisitorSessionService(
      {} as never,
      {} as never,
      conversationModel as never,
      messageModel as never,
      {} as never,
      {} as never,
      {} as never,
      auditLogService as never,
      {} as never,
      {} as never,
      pageVisitsService as never,
      realtimeEvents as never,
      visitorPresence,
      {} as never,
      {} as never,
    );

    visitorPresence.addConnection(visitorId.toString(), siteId.toString(), 'socket-1');
    visitorPresence.removeConnection(visitorId.toString(), 'socket-1');
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS);
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outreach.status).toBe('open');
    expect(outreach.save).not.toHaveBeenCalled();
  });
});
