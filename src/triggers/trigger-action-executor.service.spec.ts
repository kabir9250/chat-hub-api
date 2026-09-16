import { Types } from 'mongoose';

import { TriggerActionExecutorService } from './trigger-action-executor.service';
import {
  SiteDocument,
  TriggerActionConfig,
  VisitorDocument,
} from '../database/schemas';
import { VisitorsService } from '../visitors/visitors.service';

/**
 * Session Feature-2c-complex-actions VERIFY — the one genuinely tricky
 * piece per this task's own instruction: `wait` must delay the REMAINING
 * actions in the same Trigger's action list (send → wait 2s → add tag),
 * confirming both ORDER (the tag isn't added before the wait elapses) and
 * TIMING (it lands right after, not immediately and not indefinitely
 * stalled) — without blocking the event loop for anything else.
 *
 * Fake timers make this deterministic and instant to run: `applyAll`'s
 * `await sleep(seconds * 1000)` resolves via `setTimeout`, which
 * `jest.advanceTimersByTimeAsync` can fast-forward without a real 2-second
 * wait, while still exercising the real Promise/setTimeout code path (not a
 * mocked `sleep`).
 */
describe('TriggerActionExecutorService — Wait sequencing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeVisitor(): VisitorDocument {
    return {
      _id: new Types.ObjectId(),
      tags: [] as string[],
      notes: '',
      wasTriggered: false,
      department: null,
    } as unknown as VisitorDocument;
  }

  function makeSite(): SiteDocument {
    return { _id: new Types.ObjectId() } as unknown as SiteDocument;
  }

  it('runs actions before a Wait immediately, then holds the remaining actions until the delay elapses', async () => {
    // VisitorsService is only needed for `blockVisitor` — unused by this
    // test's action list, so a bare mock with no implementation is enough.
    const visitorsService = {
      banFromTrigger: jest.fn(),
    } as unknown as VisitorsService;
    const executor = new TriggerActionExecutorService(visitorsService);
    const visitor = makeVisitor();
    const site = makeSite();

    const actions: TriggerActionConfig[] = [
      { type: 'setVisitorName', value: 'Jordan', fromName: null },
      { type: 'wait', value: '2', fromName: null },
      { type: 'addTag', value: 'waited-for-me', fromName: null },
    ];

    const applyAllPromise = executor.applyAll(site, visitor, actions);

    // Let the microtask queue settle so every action BEFORE the wait has
    // already run and the `wait` action's setTimeout has been scheduled.
    await Promise.resolve();
    await Promise.resolve();

    expect(visitor.name).toBe('Jordan'); // ran immediately, before the wait
    expect(visitor.tags).not.toContain('waited-for-me'); // NOT yet — still waiting

    // Advance just short of the 2s delay — still must not have run.
    await jest.advanceTimersByTimeAsync(1900);
    expect(visitor.tags).not.toContain('waited-for-me');

    // Cross the 2s mark — the remaining action(s) now run.
    await jest.advanceTimersByTimeAsync(200);
    await applyAllPromise;

    expect(visitor.tags).toContain('waited-for-me');
  });

  it('does not delay actions that come BEFORE the Wait in the list', async () => {
    const visitorsService = {
      banFromTrigger: jest.fn(),
    } as unknown as VisitorsService;
    const executor = new TriggerActionExecutorService(visitorsService);
    const visitor = makeVisitor();
    const site = makeSite();

    const actions: TriggerActionConfig[] = [
      { type: 'addTag', value: 'before-wait', fromName: null },
      { type: 'wait', value: '5', fromName: null },
      { type: 'addTag', value: 'after-wait', fromName: null },
    ];

    const applyAllPromise = executor.applyAll(site, visitor, actions);
    await Promise.resolve();
    await Promise.resolve();

    // The action before Wait must be applied without waiting on the delay.
    expect(visitor.tags).toContain('before-wait');
    expect(visitor.tags).not.toContain('after-wait');

    await jest.advanceTimersByTimeAsync(5000);
    await applyAllPromise;

    expect(visitor.tags).toContain('after-wait');
  });
});
