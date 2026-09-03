/**
 * Regression test for direct user feedback: "a new visit" should mean the
 * browser tab was closed and reopened (matches Zendesk's own behavior),
 * NOT a 30-minute inactivity gap — and should NOT reset just because the
 * visitor left the tab open and browsed elsewhere for a while.
 *
 * The widget signals this with a per-tab `visitSessionId` (from
 * `sessionStorage` — see `widget/storage.ts`'s `getOrCreateVisitSessionId`).
 * `PageVisitsService.isNewVisit` treats a *different* incoming
 * `visitSessionId` as an immediate new visit regardless of elapsed time,
 * and a *repeated* one as the same ongoing visit regardless of elapsed
 * time. Only a caller that sends NO `visitSessionId` at all (an older
 * cached widget bundle, or a direct API caller — see this project's own
 * `visit-chat-counters.e2e-spec.ts`, TC-05.5a) falls back to the old
 * 30-minute-gap heuristic, unchanged.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from './helpers/app';
import { siteId } from '../helpers/fixtures';

describe('Regression — new-visit boundary is tab-close (visitSessionId), not a time gap', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const targetSiteId = siteId('Site D');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('same visitSessionId across calls (tab stayed open) never bumps pastVisitsCount, even with no delay guaranteed either way', async () => {
    const ip = nextFakeIp();
    const tabId = 'tab-stays-open-1';

    const init1 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/', visitSessionId: tabId })
      .expect(200);
    const { token } = init1.body;
    expect(init1.body.pastVisitsCount).toBe(1);

    // Same tab id — simulates navigating to another page (or even another
    // site entirely) and back, all without closing the tab.
    const init2 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/pricing', visitSessionId: tabId })
      .expect(200);
    expect(init2.body.pastVisitsCount).toBe(1);

    const init3 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/about', visitSessionId: tabId })
      .expect(200);
    expect(init3.body.pastVisitsCount).toBe(1);
  });

  it('a different visitSessionId (tab closed and reopened) bumps pastVisitsCount immediately, with zero elapsed time', async () => {
    const ip = nextFakeIp();

    const init1 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/', visitSessionId: 'tab-1' })
      .expect(200);
    const { token } = init1.body;
    expect(init1.body.pastVisitsCount).toBe(1);

    // A brand-new tab id, same visitor token (same browser, localStorage
    // survived), immediately after — no 30-minute gap at all. Under the
    // old gap-only rule this would NOT have counted as a new visit; under
    // the tab-close rule it must.
    const init2 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/', visitSessionId: 'tab-2' })
      .expect(200);
    expect(init2.body.pastVisitsCount).toBe(2);
  });

  it('omitting visitSessionId entirely still falls back to the old 30-minute-gap heuristic (backward compatibility)', async () => {
    const ip = nextFakeIp();

    const init1 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/' })
      .expect(200);
    const { token } = init1.body;
    expect(init1.body.pastVisitsCount).toBe(1);

    // No visitSessionId, immediately after — same visit under the gap rule.
    const init2 = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({ siteId: targetSiteId, pageUrl: 'https://site-d.example.com/pricing' })
      .expect(200);
    expect(init2.body.pastVisitsCount).toBe(1);
  });
});
