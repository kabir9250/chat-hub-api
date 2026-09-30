/**
 * One-time backfill for the advanced History filter's denormalized
 * Conversation fields: messageCount / visitorMsgCount / agentMsgCount,
 * participantAgentIds, initiatedBy, unreadByAgent (=false) and servedOutcome.
 *
 * Old chats have no recorded disconnect history, so none can be classified
 * "dropped" retroactively; they land in completed / missed / unresponsive /
 * offline_form (or stay null while still open). Idempotent — recomputes the
 * derived fields from the messages every run and never touches droppedAt.
 *
 * Also builds the new indexes (syncIndexes is left to Nest's autoIndex; this
 * only ensures the text index exists before Keywords search is used).
 *
 * Run with `npm run migrate:backfill-conversation-history-fields`.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

import { computeServedOutcome } from '../conversations/served-outcome.util';

dns.setServers(['1.1.1.1', '8.8.8.8']);

const BATCH = 500;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set — check .env');
  await mongoose.connect(uri);
  const db = mongoose.connection;
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');

  await messages.createIndex({ body: 'text' });

  const cursor = conversations.find(
    {},
    {
      projection: {
        submissionChannel: 1,
        status: 1,
        triggeredByRuleId: 1,
        droppedAt: 1,
        droppedBy: 1,
      },
    },
  );

  let batch: Awaited<ReturnType<typeof cursor.next>>[] = [];
  let done = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const ids = batch.map((c) => c!._id);
    const stats = await messages
      .aggregate([
        { $match: { conversationId: { $in: ids }, senderType: { $ne: 'system' } } },
        { $sort: { sentAt: 1 } },
        {
          $group: {
            _id: '$conversationId',
            visitor: { $sum: { $cond: [{ $eq: ['$senderType', 'visitor'] }, 1, 0] } },
            agent: { $sum: { $cond: [{ $eq: ['$senderType', 'agent'] }, 1, 0] } },
            firstSender: { $first: '$senderType' },
            agentIds: {
              $addToSet: {
                $cond: [{ $eq: ['$senderType', 'agent'] }, '$senderId', '$$REMOVE'],
              },
            },
          },
        },
      ])
      .toArray();
    const byId = new Map(stats.map((s) => [String(s._id), s]));

    await conversations.bulkWrite(
      batch.map((c) => {
        const s = byId.get(String(c!._id));
        const visitorMsgCount = s?.visitor ?? 0;
        const agentMsgCount = s?.agent ?? 0;
        const initiatedBy = c!.triggeredByRuleId
          ? 'trigger'
          : s?.firstSender === 'agent'
            ? 'agent'
            : 'visitor';
        return {
          updateOne: {
            filter: { _id: c!._id },
            update: {
              $set: {
                messageCount: visitorMsgCount + agentMsgCount,
                visitorMsgCount,
                agentMsgCount,
                participantAgentIds: (s?.agentIds ?? []).filter(Boolean),
                initiatedBy,
                unreadByAgent: false,
                servedOutcome: computeServedOutcome({
                  submissionChannel: c!.submissionChannel,
                  status: c!.status,
                  visitorMsgCount,
                  agentMsgCount,
                  droppedAt: c!.droppedAt ?? null,
                  droppedBy: c!.droppedBy ?? null,
                }),
              },
            },
          },
        };
      }),
    );
    done += batch.length;
    console.log(`Backfilled ${done} conversation(s)...`);
    batch = [];
  };

  for await (const c of cursor) {
    batch.push(c);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`Done. ${done} conversation(s) updated.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
