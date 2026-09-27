'use strict';
// Explicit one-time operator command. Never imported by the HTTP entry point.
const { cloudEnvironment } = require('./cloud/runtime.cjs');
function validateSetup(action, env) {
  if (!['migrate', 'seed', 'all'].includes(action)) throw new Error('Choose migrate, seed or all; reset is not supported');
  cloudEnvironment(env);
  if (action !== 'migrate') {
    const password = env.SEED_PASSWORD || '';
    if (password.length < 32 || password.length > 200 || /^(.)\1+$/.test(password)) {
      throw new Error('Inject a randomly generated SEED_PASSWORD of at least 32 characters');
    }
  }
}
function defaultDependencies() {
  const { createStore, setStore } = require('./server/adapters/db');
  const { getStorage } = require('./server/adapters/storage');
  const { seed } = require('./server/db/seed');
  require('./server/lib/logger').setSink(() => {});
  return { open: async () => setStore(await createStore()), storage: getStorage, seed };
}
async function runSetup(action, { env = process.env, dependencies } = {}) {
  validateSetup(action, env);
  const deps = dependencies || defaultDependencies();
  const store = await deps.open();
  try {
    if (store.driver !== 'postgres') throw new Error('Cloud setup requires PostgreSQL');
    if (action !== 'migrate') await deps.storage();
    // Serialize operators and wrap relational changes in one transaction.
    // Private content-addressed blobs may remain after DB rollback, but they
    // remain private and retries can reuse matching bytes. Never delete them.
    return await store.tx(async scoped => {
      await scoped.query("SELECT pg_advisory_xact_lock(hashtext('peopleledger-cloud-setup-v1'))");
      const result = { migrationsApplied: [], seedCreated: false, seedAlreadyPresent: false };
      if (action !== 'seed') {
        const migrated = await scoped.migrate({ reset: false });
        result.migrationsApplied = migrated.applied;
      }
      if (action !== 'migrate') {
        const seeded = await deps.seed(scoped, { quiet: true, dataset: 'v2' });
        result.seedAlreadyPresent = !!seeded.alreadySeeded;
        result.seedCreated = !seeded.alreadySeeded;
      }
      return result;
    });
  } finally { await store.close(); }
}
if (require.main === module) {
  const action = process.argv[2];
  Promise.resolve().then(() => {
    if (process.argv.length !== 3) throw new Error('Unexpected setup arguments');
    return runSetup(action);
  }).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(() => {
    process.stderr.write('Cloud setup failed. Check required environment, TLS database access, private storage, and random SEED_PASSWORD of at least 32 characters. No credentials were printed.\n');
    process.exitCode = 1;
  });
}
module.exports = { validateSetup, runSetup };
