/**
 * One-time migration — Session Feature-2b-engine
 * (`12-zendesk-feature-parity-srs.md` §2.2). An EARLIER, undated session
 * already rebuilt the live `Trigger` schema from the original
 * `{matchType: exact|prefix|contains|regex, matchValue, action}` shape into
 * the condition/action builder (`trigger.schema.ts`) — see this session's
 * PROGRESS-PHASE2.md entry's "pre-flight finding". That rebuild shipped
 * with no migration script of its own, so any Trigger document still
 * sitting in a database from BEFORE that rebuild (old field names,
 * `matchType`/`matchValue`/`action` at the top level, no `conditions`/
 * `actions` arrays) was never converted and would fail today's
 * `TriggerSchema` validation on next load/save. This script is that
 * missing conversion, run now as part of formalizing the condition
 * engine's own schema.
 *
 * Mapping (per this session's own task spec: "a path-prefix rule becomes
 * one 'Visitor page URL' condition"):
 *   matchType 'exact'    -> condition { type: 'url', operator: 'exact path', value: matchValue }
 *   matchType 'prefix'   -> condition { type: 'url', operator: 'path prefix', value: matchValue }
 *   matchType 'contains' -> condition { type: 'url', operator: 'contains',   value: matchValue }
 *   matchType 'regex'    -> condition { type: 'url', operator: 'regex',     value: matchValue }
 *   action 'autoOpenWidget'      -> actions: [{ type: 'autoOpenWidget', value: null }]
 *   action 'showProactiveMessage'-> actions: [{ type: 'showProactiveMessage', value: <untouched — the old shape had no message text field, so this is set to a placeholder the Admin must fill in; flagged via a console warning per document> }]
 *   action 'both'                -> actions: [autoOpenWidget, showProactiveMessage(placeholder)]
 * `conditionLogic: 'all'` (a single condition either way), `runEvent:
 * 'widgetLoaded'` (the old shape had no run-event concept — this was its
 * implicit behavior, evaluated on every page load), `fireOncePerVisitor:
 * false` (the old shape had no such flag), `priority`/`isEnabled`/`name`/
 * `description`/`siteId` carried over unchanged.
 *
 * Idempotent: only matches documents that still have a top-level
 * `matchType` field (which the current schema never writes), so running it
 * twice, or against a mix of legacy and already-current documents, is safe.
 *
 * Run with `npm run migrate:triggers-to-condition-engine` from
 * `chat-hub-api` after deploying this session's schema change.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

// Same DNS workaround as seed.ts — see that file's comment.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const URL_OPERATOR_BY_MATCH_TYPE: Record<string, string> = {
  exact: 'exact path',
  prefix: 'path prefix',
  contains: 'contains',
  regex: 'regex',
};

const PLACEHOLDER_MESSAGE = '[Migrated Trigger — set this message text]';

interface LegacyTriggerDoc {
  _id: mongoose.Types.ObjectId;
  matchType?: string;
  matchValue?: string;
  action?: string;
}

function buildActions(action: string | undefined) {
  switch (action) {
    case 'autoOpenWidget':
      return [{ type: 'autoOpenWidget', value: null }];
    case 'showProactiveMessage':
      return [{ type: 'showProactiveMessage', value: PLACEHOLDER_MESSAGE }];
    case 'both':
      return [
        { type: 'autoOpenWidget', value: null },
        { type: 'showProactiveMessage', value: PLACEHOLDER_MESSAGE },
      ];
    default:
      // Unknown/missing legacy action — leave the migrated Trigger with no
      // actions rather than guessing; it'll evaluate its condition but do
      // nothing, same as any other Trigger an Admin hasn't configured
      // actions for yet.
      return [];
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — check chat-hub-api/.env');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.');

  const triggers = mongoose.connection.collection('triggers');
  const legacyDocs = triggers.find<LegacyTriggerDoc>({
    matchType: { $exists: true },
  });

  let migrated = 0;
  let placeholdersWritten = 0;
  for await (const doc of legacyDocs) {
    const operator = URL_OPERATOR_BY_MATCH_TYPE[doc.matchType ?? ''];
    if (!operator || !doc.matchValue) {
      console.warn(
        `Trigger ${doc._id.toString()}: unrecognized matchType ` +
          `"${doc.matchType}" or missing matchValue — skipped, needs manual review.`,
      );
      continue;
    }

    const actions = buildActions(doc.action);
    if (actions.some((a) => a.value === PLACEHOLDER_MESSAGE)) {
      placeholdersWritten++;
    }

    await triggers.updateOne(
      { _id: doc._id },
      {
        $set: {
          runEvent: 'widgetLoaded',
          conditionLogic: 'all',
          conditions: [{ type: 'url', operator, value: doc.matchValue }],
          actions,
          fireOncePerVisitor: false,
        },
        $unset: { matchType: '', matchValue: '', action: '' },
      },
    );
    migrated++;
  }

  console.log(`Migrated ${migrated} Trigger document(s).`);
  if (placeholdersWritten > 0) {
    console.log(
      `${placeholdersWritten} migrated Trigger(s) need their ` +
        `"showProactiveMessage" text filled in by an Admin (the old schema ` +
        `had no message-text field to carry over) — search for ` +
        `"${PLACEHOLDER_MESSAGE}".`,
    );
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
