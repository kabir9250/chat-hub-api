/**
 * One-time migration — adds the `visitors.ban` permission key to every
 * already-seeded Role document that doesn't already have it. `Role.permissions`
 * is a snapshot array written once at `npm run seed` time (see
 * `permission.catalog.ts`'s `DEFAULT_ROLE_PERMISSIONS` doc comment) — editing
 * the catalog/defaults in code does not retroactively reach Roles already
 * persisted in an existing environment, so this patches them directly.
 *
 * `visitors.ban` previously shipped only on the seeded Owner/Supervisor
 * Roles; this session's task was to make the Ban Visitor capability
 * available to all users by default, so it's added here to every Role
 * document, seeded or custom, that lacks it.
 *
 * Idempotent: `$addToSet` is a no-op on a Role that already has the key, so
 * running this twice — or against a mix of patched/unpatched Roles — is
 * safe.
 *
 * Run with `npm run migrate:add-visitors-ban-permission` from
 * `apps/chat-hub-api`.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

// Same DNS workaround as seed.ts — see that file's comment.
dns.setServers(['1.1.1.1', '8.8.8.8']);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — check apps/chat-hub-api/.env');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.');

  const roles = mongoose.connection.collection('roles');
  const result = await roles.updateMany(
    { permissions: { $ne: 'visitors.ban' } },
    { $addToSet: { permissions: 'visitors.ban' } },
  );

  console.log(
    `Matched ${result.matchedCount} Role document(s), modified ${result.modifiedCount}.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
