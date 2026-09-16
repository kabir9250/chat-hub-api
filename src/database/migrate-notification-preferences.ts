/**
 * One-time migration — Session Feature-1b-backend (SRS "12-zendesk-feature-
 * parity" §1.2). `User.notificationPreferences` was restructured from the
 * old flat `{desktopEnabled, soundEnabled}` pair (Phase 2 P2-8) into the
 * new per-event shape (`user.schema.ts`'s `NotificationPreferences`/
 * `NotificationSounds`). Mongoose's usual "subdocument defaults apply at
 * hydration time, no migration needed" trick (the same one P2-8's own doc
 * comment relied on) does NOT fully cover this restructuring: it fills in
 * the brand-new fields with the schema's flat defaults, but it can't see
 * the OLD `desktopEnabled`/`soundEnabled` values to derive a *sensible*
 * per-field default from them — the task guardrail is "migrate ... rather
 * than discarding." This script reads those two legacy values with the
 * native driver (bypassing the schema, which no longer declares those
 * fields) and rewrites each User's `notificationPreferences` once.
 *
 * Idempotent: only touches documents that still have the old
 * `desktopEnabled`/`soundEnabled` keys (the query filter below), so running
 * it twice — or against a mix of already-migrated and legacy documents —
 * is safe. A brand-new User created after this session's schema change
 * never has those keys, so it never matches and is left untouched (it
 * already gets the new schema defaults directly).
 *
 * Run with `npm run migrate:notification-preferences` from
 * `apps/chat-hub-api` after deploying this session's schema change.
 * Not run live as part of this session — see PROGRESS.md ("Verify" note:
 * code review + build/lint only, no live DB write this session).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

import { SOUND_LIBRARY } from './schemas/user.schema';

// Same DNS workaround as seed.ts — see that file's comment.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const DEFAULT_SOUND_VOLUME = 70;
const MUTED_VOLUME = 0;

const SOUND_EVENT_DEFAULTS: Record<string, string> = {
  incomingVisitor: 'bright-ping',
  chatRequest: 'door-knock',
  incomingMessage: 'dot-dot',
  automaticStatusChange: 'single-dong',
  triggerActivated: 'whistle-tone',
  operatingHoursStartEnd: 'flute-note',
};

function soundSetting(eventKey: string, soundEnabled: boolean) {
  return {
    soundId: SOUND_EVENT_DEFAULTS[eventKey],
    volume: soundEnabled ? DEFAULT_SOUND_VOLUME : MUTED_VOLUME,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — check apps/chat-hub-api/.env');
  }
  // Fails loudly on a typo'd sound id rather than writing bad data.
  const validIds = new Set<string>(SOUND_LIBRARY.map((s) => s.id));
  for (const id of Object.values(SOUND_EVENT_DEFAULTS)) {
    if (!validIds.has(id)) {
      throw new Error(`SOUND_EVENT_DEFAULTS has an unknown soundId: ${id}`);
    }
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.');

  const users = mongoose.connection.collection('users');
  const legacyDocs = users.find({
    $or: [
      { 'notificationPreferences.desktopEnabled': { $exists: true } },
      { 'notificationPreferences.soundEnabled': { $exists: true } },
    ],
  });

  let migrated = 0;
  for await (const doc of legacyDocs) {
    const legacy = (doc.notificationPreferences ?? {}) as {
      desktopEnabled?: boolean;
      soundEnabled?: boolean;
    };
    // Both defaulted `true` in the old schema — a User with no
    // notificationPreferences path at all never matches this query filter
    // in the first place, so these fallbacks only cover a partially-legacy
    // document (one flag present, the other somehow missing).
    const desktopEnabled = legacy.desktopEnabled !== false;
    const soundEnabled = legacy.soundEnabled !== false;

    await users.updateOne(
      { _id: doc._id },
      {
        $set: {
          'notificationPreferences.chatRequest': desktopEnabled,
          'notificationPreferences.newMessages': desktopEnabled,
          'notificationPreferences.statusChanges': desktopEnabled,
          'notificationPreferences.sessionExpiry': desktopEnabled,
          'notificationPreferences.sounds': {
            incomingVisitor: soundSetting('incomingVisitor', soundEnabled),
            chatRequest: {
              ...soundSetting('chatRequest', soundEnabled),
              repeatCount: 1,
            },
            incomingMessage: soundSetting('incomingMessage', soundEnabled),
            automaticStatusChange: soundSetting(
              'automaticStatusChange',
              soundEnabled,
            ),
            triggerActivated: soundSetting('triggerActivated', soundEnabled),
            operatingHoursStartEnd: soundSetting(
              'operatingHoursStartEnd',
              soundEnabled,
            ),
          },
        },
        $unset: {
          'notificationPreferences.desktopEnabled': '',
          'notificationPreferences.soundEnabled': '',
        },
      },
    );
    migrated++;
  }

  console.log(`Migrated ${migrated} User document(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
