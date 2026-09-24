import { VisitorPresenceService } from './visitor-presence.service';

/**
 * Verifies the grace-timer redesign fixing the reported bug (direct user
 * feedback — "the agent is still in the previous session but the visitor is
 * now in a new one"): a Visitor's visit must not be declared over on a bare
 * disconnect (flaky connection, laptop lid, a frozen background tab all
 * disconnect too, then reconnect on their own), but MUST be declared over
 * once they've had zero live connections for the full grace window with no
 * reconnect. See `VisitorPresenceService.scheduleVisitEndCheck`'s doc
 * comment for the full reasoning this locks in.
 */
describe('VisitorPresenceService — visit-end grace timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const visitorId = 'visitor-1';
  const siteId = 'site-1';

  it('does not report a visit ended on an ordinary reconnect within the grace window', () => {
    const service = new VisitorPresenceService();
    const onVisitEnded = jest.fn();
    service.onVisitEnded(onVisitEnded);

    service.addConnection(visitorId, siteId, 'socket-1');
    service.removeConnection(visitorId, 'socket-1');

    // Reconnect (e.g. the same tab's socket re-establishing, or a second
    // tab) well inside the grace window — must cancel the pending check.
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS - 1);
    service.addConnection(visitorId, siteId, 'socket-2');

    // Even once the ORIGINAL timer's deadline has fully elapsed, no callback
    // should ever fire — it was cancelled, not merely delayed.
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS * 2);

    expect(onVisitEnded).not.toHaveBeenCalled();
    expect(service.isConnected(visitorId)).toBe(true);
  });

  it('reports a visit ended once the grace window elapses with no reconnect', () => {
    const service = new VisitorPresenceService();
    const onVisitEnded = jest.fn();
    service.onVisitEnded(onVisitEnded);

    service.addConnection(visitorId, siteId, 'socket-1');
    service.removeConnection(visitorId, 'socket-1');

    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS);

    expect(onVisitEnded).toHaveBeenCalledTimes(1);
    expect(onVisitEnded).toHaveBeenCalledWith(visitorId, siteId);
  });

  it('never fires for a Visitor with another live socket (multi-tab, shared visit)', () => {
    const service = new VisitorPresenceService();
    const onVisitEnded = jest.fn();
    service.onVisitEnded(onVisitEnded);

    // Two tabs' sockets, same Visitor.
    service.addConnection(visitorId, siteId, 'socket-1');
    service.addConnection(visitorId, siteId, 'socket-2');

    // Tab 1 closes — tab 2 is still live, so this must never even start a
    // grace timer (removeConnection only schedules one on the zero->0
    // transition).
    service.removeConnection(visitorId, 'socket-1');
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS * 2);

    expect(onVisitEnded).not.toHaveBeenCalled();
    expect(service.isConnected(visitorId)).toBe(true);
  });

  it('forceExpire (stale-heartbeat sweep) reports the visit ended immediately, with no grace wait', () => {
    const service = new VisitorPresenceService();
    const onVisitEnded = jest.fn();
    service.onVisitEnded(onVisitEnded);

    service.addConnection(visitorId, siteId, 'socket-1');
    service.forceExpire(visitorId);

    expect(onVisitEnded).toHaveBeenCalledTimes(1);
    expect(onVisitEnded).toHaveBeenCalledWith(visitorId, siteId);
  });

  it('cancels a pending grace timer on reconnect, then never fires it late even if that Visitor is later force-expired for an unrelated reason', () => {
    const service = new VisitorPresenceService();
    const onVisitEnded = jest.fn();
    service.onVisitEnded(onVisitEnded);

    service.addConnection(visitorId, siteId, 'socket-1');
    service.removeConnection(visitorId, 'socket-1'); // starts the grace timer
    service.addConnection(visitorId, siteId, 'socket-2'); // cancels it

    // The original timer's deadline elapsing must not fire a second,
    // stale callback on top of whatever forceExpire below reports.
    jest.advanceTimersByTime(VisitorPresenceService.VISIT_END_GRACE_MS * 2);
    expect(onVisitEnded).not.toHaveBeenCalled();

    // A later, independent stale-heartbeat expiry still reports exactly
    // once — the earlier cancelled timer left nothing dangling.
    service.forceExpire(visitorId);
    expect(onVisitEnded).toHaveBeenCalledTimes(1);
    expect(onVisitEnded).toHaveBeenCalledWith(visitorId, siteId);
  });
});
