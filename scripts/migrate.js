/* Applies SQL migrations. Use --reset to drop and recreate the public schema.
 *
 *   npm run migrate
 *   node scripts/migrate.js --reset
 */
'use strict';
const config = require('../server/config');
const { createStore, closeStore } = require('../server/adapters/db');

async function main() {
  const reset = process.argv.includes('--reset');
  if (config.db.driver === 'sqlite') { const store = await createStore(); try { const result = await store.migrate({ reset }); process.stdout.write(result.note + '\n'); } finally { await store.close(); } return; }
  if (config.db.driver !== 'postgres') {
    process.stdout.write(
      `No migration to run: the active data store is "${config.db.driver}".\n`
      + (config.db.requestedDriver === 'memory'
        ? 'DB_DRIVER=memory keeps everything in memory and creates its structure implicitly.\n'
        : 'Set DATABASE_URL in .env to run PostgreSQL migrations.\n')
    );
    return;
  }
  const store = await createStore();
  try {
    if (reset) process.stdout.write('Resetting the public schema. All existing data will be dropped.\n');
    const result = await store.migrate({ reset });
    process.stdout.write(result.applied.length
      ? `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}\n`
      : 'Database is already up to date.\n');
  } finally {
    await store.close();
    await closeStore();
  }
}

main().catch(error => {
  process.stderr.write(`Migration failed: ${error.message}\n`);
  process.exit(1);
});
