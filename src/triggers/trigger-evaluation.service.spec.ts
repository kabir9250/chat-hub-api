import { Types } from 'mongoose';

import {
  TriggerEvaluationService,
  TriggerEvalContext,
} from './trigger-evaluation.service';
import { TriggerCondition, TriggerDocument } from '../database/schemas';

/**
 * Session Feature-2b-engine VERIFY: a multi-category condition set ("Still
 * on site" — Time/Date category — + "Visitor country code" — Location
 * category) evaluated under both `conditionLogic` modes, per this task's
 * own instruction ("this is exactly the kind of logic worth one real
 * test"). `evaluateTrigger`/the private `evaluateCondition` it calls have
 * no DB dependency once a `TriggerEvalContext` is already built — this test
 * constructs one directly and skips DB/model mocking entirely, same as
 * `referrer-search.util.spec.ts`'s "test the pure logic directly" approach.
 */
describe('TriggerEvaluationService — multi-category condition evaluation', () => {
  // The constructor params are unused by evaluateTrigger/evaluateCondition
  // (both operate purely on an already-built TriggerEvalContext) — passed
  // as `undefined` rather than mocking 8 injected models/services that
  // never get called in this test.
  const service = new TriggerEvaluationService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

  function makeTrigger(
    conditionLogic: 'all' | 'any',
    conditions: TriggerCondition[],
  ): TriggerDocument {
    return {
      _id: new Types.ObjectId(),
      conditionLogic,
      conditions,
    } as unknown as TriggerDocument;
  }

  function makeContext(
    overrides: Partial<TriggerEvalContext> = {},
  ): TriggerEvalContext {
    return {
      visitor: {
        pastVisitsCount: 0,
        pastChatsCount: 0,
        wasTriggered: false,
        tags: [],
        referrer: null,
        utmSource: null,
        deviceType: null,
        name: null,
        email: null,
        department: null,
        userAgentRaw: null,
        browser: null,
        os: null,
        currentIp: null,
        location: { city: undefined, region: undefined, country: 'US' },
      } as never,
      site: { timezone: 'UTC' } as never,
      currentPageUrl: 'https://example.com/pricing',
      currentPageTitle: null,
      pageViewCount: 1,
      timeOnPageSeconds: 0,
      timeOnSiteSeconds: 400, // >= the 300s "Still on site" threshold used below
      previousPageUrl: null,
      isChatting: false,
      isRequestingChat: false,
      isServed: false,
      accountStatus: 'offline',
      ...overrides,
    };
  }

  const stillOnSite300: TriggerCondition = {
    type: 'stillOnSite',
    operator: 'gte',
    value: '300',
  };

  const countryUS: TriggerCondition = {
    type: 'visitorCountryCode',
    operator: 'equals',
    value: 'US',
  };

  describe('conditionLogic: "all"', () => {
    it('matches when both conditions hold (still on site >= 300s AND country == US)', () => {
      const trigger = makeTrigger('all', [stillOnSite300, countryUS]);
      const ctx = makeContext(); // timeOnSiteSeconds: 400, country: 'US'
      expect(service.evaluateTrigger(trigger, ctx)).toBe(true);
    });

    it('does not match when only one of the two conditions holds', () => {
      const trigger = makeTrigger('all', [stillOnSite300, countryUS]);
      const ctxWrongCountry = makeContext({
        visitor: {
          ...makeContext().visitor,
          location: { country: 'CA' },
        } as never,
      });
      expect(service.evaluateTrigger(trigger, ctxWrongCountry)).toBe(false);

      const ctxNotLongEnough = makeContext({ timeOnSiteSeconds: 100 });
      expect(service.evaluateTrigger(trigger, ctxNotLongEnough)).toBe(false);
    });

    it('does not match when neither condition holds', () => {
      const trigger = makeTrigger('all', [stillOnSite300, countryUS]);
      const ctx = makeContext({
        timeOnSiteSeconds: 100,
        visitor: {
          ...makeContext().visitor,
          location: { country: 'CA' },
        } as never,
      });
      expect(service.evaluateTrigger(trigger, ctx)).toBe(false);
    });
  });

  describe('conditionLogic: "any"', () => {
    it('matches when both conditions hold', () => {
      const trigger = makeTrigger('any', [stillOnSite300, countryUS]);
      expect(service.evaluateTrigger(trigger, makeContext())).toBe(true);
    });

    it('matches when only the Time/Date condition holds', () => {
      const trigger = makeTrigger('any', [stillOnSite300, countryUS]);
      const ctx = makeContext({
        visitor: {
          ...makeContext().visitor,
          location: { country: 'CA' },
        } as never,
      });
      expect(service.evaluateTrigger(trigger, ctx)).toBe(true);
    });

    it('matches when only the Location condition holds', () => {
      const trigger = makeTrigger('any', [stillOnSite300, countryUS]);
      const ctx = makeContext({ timeOnSiteSeconds: 100 });
      expect(service.evaluateTrigger(trigger, ctx)).toBe(true);
    });

    it('does not match when neither condition holds', () => {
      const trigger = makeTrigger('any', [stillOnSite300, countryUS]);
      const ctx = makeContext({
        timeOnSiteSeconds: 100,
        visitor: {
          ...makeContext().visitor,
          location: { country: 'CA' },
        } as never,
      });
      expect(service.evaluateTrigger(trigger, ctx)).toBe(false);
    });
  });
});
