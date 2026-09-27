/* Loads the synthetic demonstration data.
 *
 *   npm run seed
 *
 * Safe to run twice: if the demonstration case already exists nothing is changed.
 */
'use strict';
const config = require('../server/config');
const { createStore, closeStore, setStore } = require('../server/adapters/db');
const { getStorage } = require('../server/adapters/storage');
const { seed } = require('../server/db/seed');
const logger = require('../server/lib/logger');

async function main() {
  logger.setSink(() => {}); // keep the seed output readable
  const store = setStore(await createStore());
  await getStorage();
  try {
    if (config.db.driver === 'memory') {
      process.stdout.write(
        'Warning: the active data store is in-process, so this seed will be lost when the process exits.\n'
        + 'Set DATABASE_URL and run "npm run migrate" first for persistent data.\n\n'
      );
    }
    await seed(store);
  } finally {
    await store.close();
    await closeStore();
  }
}

main().catch(error => {
  process.stderr.write(`Seed failed: ${error.message}\n`);
  process.exit(1);
});
