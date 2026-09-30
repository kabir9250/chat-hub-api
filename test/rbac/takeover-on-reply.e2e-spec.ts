/**
 * `conversations.assign_on_reply` — take over a chat just by replying.
 *
 * Real app + real Mongo (zendesk_test). The permission is granted to the
 * seeded Supervisor Role for the duration of the suite ($addToSet in
 * beforeAll, $pull in afterAll) — no seeded Role holds it by default.
 * Site A: supervisor-a (view_site + assign + close), agent-a1 (view_own).
 */
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';

import { createDataIntegrityTestApp, nextFakeIp } from '../data-integrity/helpers/app';
import { authHeader, siteId, userIdFor, orgIdFor } from '../helpers/fixtures';
import {
  ALL_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
} from '../../src/rbac/permission.catalog';
import { ConversationsService } from '../../src/conversations/conversations.service';

const KEY = 'conversations.assign_on_reply';

describe('conversations.assign_on_reply — takeover by replying', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let roleModel: any;
  const SITE = siteId('Site A');
  const SUP = authHeader('supervisor-a@test.local');
  const A1 = authHeader('agent-a1@test.local');
  const supId = userIdFor('supervisor-a@test.local');
  const a1Id = userIdFor('agent-a1@test.local');

  beforeAll(async () => {
    app = await createDataIntegrityTestApp();
    server = app.getHttpServer();
    roleModel = app.get(getModelToken('Role'));
    await roleModel.updateMany({ name: 'Supervisor' }, { $pull: { permissions: KEY } });
  });

  afterAll(async () => {
    await roleModel.updateMany({ name: 'Supervisor' }, { $pull: { permissions: KEY } });
    await app.close();
  });

  const grant = () =>
    roleModel.updateMany({ name: 'Supervisor' }, { $addToSet: { permissions: KEY } });
  const revoke = () =>
    roleModel.updateMany({ name: 'Supervisor' }, { $pull: { permissions: KEY } });

  /** Visitor starts a chat; supervisor hands it to agent-a1. */
  async function chatHeldByA1() {
    const init = await request(server)
      .post('/visitor-session/init')
      .set('X-Forwarded-For', nextFakeIp())
      .send({ siteId: SITE, pageUrl: 'https://site-a.example.com/' })
      .expect(200);
    const visitorToken: string = init.body.token;
    const created = await request(server)
      .post(`/sites/${SITE}/conversations`)
      .set('X-Forwarded-For', nextFakeIp())
      .set('Authorization', `Bearer ${visitorToken}`)
      .send({ initialMessage: 'hello, need help' })
      .expect(201);
    const convId: string = created.body.id ?? created.body._id;
    await request(server)
      .patch(`/sites/${SITE}/conversations/${convId}/assign`)
      .set(...SUP)
      .send({ agentId: a1Id })
      .expect(200);
    return { convId, visitorToken };
  }

  const view = async (convId: string) => {
    const res = await request(server)
      .get(`/sites/${SITE}/conversations/${convId}`)
      .set(...SUP)
      .expect(200);
    const a = res.body.conversation.assignedAgentId;
    return {
      assignee: (a && (a._id ?? a.id ?? a)) as string | null,
      messages: res.body.messages as { senderType: string; body: string | null }[],
    };
  };

  const visitorMessages = async (convId: string, token: string) => {
    const res = await request(server)
      .get(`/sites/${SITE}/conversations/${convId}/messages/mine`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as { senderType: string; body: string | null }[];
  };

  it('is in the catalog but held by no default Role (Owner included)', () => {
    expect(ALL_PERMISSION_KEYS).toContain(KEY);
    for (const perms of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      expect(perms).not.toContain(KEY);
    }
  });

  it('without the permission: replying to another agent\'s chat is still blocked', async () => {
    const { convId } = await chatHeldByA1();
    const res = await request(server)
      .post(`/sites/${SITE}/conversations/${convId}/messages`)
      .set(...SUP)
      .send({ body: 'jumping in' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/already assigned/i);
    expect((await view(convId)).assignee).toBe(a1Id);
  });

  it('with the permission: reply takes the chat over; agents see the system line, the visitor does not', async () => {
    await grant();
    try {
      const { convId, visitorToken } = await chatHeldByA1();
      await request(server)
        .post(`/sites/${SITE}/conversations/${convId}/messages`)
        .set(...SUP)
        .send({ body: 'I will take it from here' })
        .expect(201);

      const v = await view(convId);
      expect(v.assignee).toBe(supId);
      const system = v.messages.filter((m) => m.senderType === 'system');
      expect(system).toHaveLength(1);
      expect(system[0].body).toMatch(/took over this chat/i);
      // System line precedes the reply that triggered it.
      const order = v.messages.map((m) => m.senderType);
      expect(order.indexOf('system')).toBeLessThan(order.lastIndexOf('agent'));

      const seen = await visitorMessages(convId, visitorToken);
      expect(seen.some((m) => m.senderType === 'system')).toBe(false);
      expect(seen.some((m) => m.body === 'I will take it from here')).toBe(true);
    } finally {
      await revoke();
    }
  });

  it('the current holder replying to their own chat does not create a takeover line', async () => {
    await grant();
    try {
      const { convId } = await chatHeldByA1();
      await request(server)
        .post(`/sites/${SITE}/conversations/${convId}/messages`)
        .set(...A1)
        .send({ body: 'my own chat' })
        .expect(201);
      const v = await view(convId);
      expect(v.assignee).toBe(a1Id);
      expect(v.messages.some((m) => m.senderType === 'system')).toBe(false);
    } finally {
      await revoke();
    }
  });

  it('closed chats are never taken over', async () => {
    await grant();
    try {
      const { convId } = await chatHeldByA1();
      await request(server)
        .patch(`/sites/${SITE}/conversations/${convId}/status`)
        .set(...A1)
        .send({ status: 'closed' })
        .expect(200);
      const res = await request(server)
        .post(`/sites/${SITE}/conversations/${convId}/messages`)
        .set(...SUP)
        .send({ body: 'late reply' });
      expect(res.status).toBe(403);
      expect((await view(convId)).assignee).toBe(a1Id);
    } finally {
      await revoke();
    }
  });

  it('proactive send takes the chat over the same way', async () => {
    await grant();
    try {
      const { convId, visitorToken } = await chatHeldByA1();
      const svc = app.get(ConversationsService);
      const actor = {
        userId: supId,
        organizationId: orgIdFor('supervisor-a@test.local'),
        email: 'supervisor-a@test.local',
        displayName: 'Supervisor A',
      } as never;
      await svc.addAgentProactiveMessage(actor, SITE, convId, 'proactive hello');

      const v = await view(convId);
      expect(v.assignee).toBe(supId);
      expect(v.messages.some((m) => m.senderType === 'system')).toBe(true);
      const seen = await visitorMessages(convId, visitorToken);
      expect(seen.some((m) => m.senderType === 'system')).toBe(false);
    } finally {
      await revoke();
    }
  });
});
