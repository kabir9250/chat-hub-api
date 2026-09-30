import { computeServedOutcome, ServedOutcomeInput } from './served-outcome.util';

const base: ServedOutcomeInput = {
  submissionChannel: 'online',
  status: 'open',
  visitorMsgCount: 0,
  agentMsgCount: 0,
  droppedAt: null,
  droppedBy: null,
};
const c = (o: Partial<ServedOutcomeInput>) => computeServedOutcome({ ...base, ...o });

describe('computeServedOutcome', () => {
  it('offline forms are their own bucket', () => {
    expect(c({ submissionChannel: 'offline', visitorMsgCount: 1, status: 'pending' })).toBe(
      'offline_form',
    );
  });

  it('missed: visitor wrote, no agent reply, chat closed or visitor dropped', () => {
    expect(c({ visitorMsgCount: 2, status: 'closed' })).toBe('missed');
    expect(
      c({ visitorMsgCount: 1, droppedAt: new Date(), droppedBy: 'visitor' }),
    ).toBe('missed');
  });

  it('a waiting visitor with no reply yet is still in progress', () => {
    expect(c({ visitorMsgCount: 1, status: 'pending' })).toBeNull();
  });

  it('unresponsive: agent wrote, visitor never did, chat is over', () => {
    expect(c({ agentMsgCount: 1, status: 'closed' })).toBe('unresponsive');
    expect(c({ agentMsgCount: 1, droppedAt: new Date(), droppedBy: 'visitor' })).toBe(
      'unresponsive',
    );
    expect(c({ agentMsgCount: 1 })).toBeNull();
  });

  it('dropped wins over completed, even if the chat was closed afterwards', () => {
    expect(
      c({
        visitorMsgCount: 2,
        agentMsgCount: 2,
        status: 'closed',
        droppedAt: new Date(),
        droppedBy: 'agent',
      }),
    ).toBe('dropped');
  });

  it('completed: both sides spoke and the chat was closed without a drop', () => {
    expect(c({ visitorMsgCount: 2, agentMsgCount: 3, status: 'closed' })).toBe('completed');
    expect(c({ visitorMsgCount: 2, agentMsgCount: 3, status: 'open' })).toBeNull();
  });
});
