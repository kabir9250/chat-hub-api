/**
 * One-time migration — adds the History filter permission keys to Role
 * documents already persisted (Role.permissions is a snapshot written at
 * seed time, so catalog/default edits don't reach existing Roles).
 *
 *  - `history.basic_filter`    → every Role (the existing filter everyone had).
 *  - `history.advanced_filter` → every Role that already holds
 *    `conversations.view_site` (Owner/Manager/Supervisor and custom Roles
 *    with Site-wide visibility).
 *
 * Idempotent ($addToSet). Run with `npm run migrate:add-history-filter-permissions`.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

dns.setServers(['1.1.1.1', '8.8.8.8']);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set — check .env');
  await mongoose.connect(uri);
  const roles = mongoose.connection.collection('roles');

  const basic = await roles.updateMany(
    { permissions: { $ne: 'history.basic_filter' } },
    { $addToSet: { permissions: 'history.basic_filter' } },
  );
  const advanced = await roles.updateMany(
    {
      permissions: {
        $all: ['conversations.view_site'],
        $ne: 'history.advanced_filter',
      },
    },
    { $addToSet: { permissions: 'history.advanced_filter' } },
  );
  console.log(
    `basic_filter: modified ${basic.modifiedCount}; advanced_filter: modified ${advanced.modifiedCount}.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
