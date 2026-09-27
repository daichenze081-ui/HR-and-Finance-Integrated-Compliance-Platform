/* Store factory. Business services depend only on the contract below, never on a
 * concrete driver, so a future backend can swap persistence without touching
 * business logic. */
'use strict';
const config = require('../../config');
const logger = require('../../lib/logger');
const { MemoryStore } = require('./memory');
const { SqliteStore } = require('./sqlite');
const { PgStore } = require('./pg');

let active = null;

async function createStore(overrides = {}) {
  const driver = overrides.driver || config.db.driver;
  if (driver === 'sqlite') { const store = new SqliteStore({ ...config.db, ...overrides }); await store.init(); return store; }
  if (driver === 'postgres') {
    const store = new PgStore({ ...config.db, ...overrides });
    await store.init();
    return store;
  }
  if (driver !== 'memory') throw new Error(`Unsupported database driver: ${driver}`);
  const store = new MemoryStore();
  await store.init();
  return store;
}

async function getStore() {
  if (!active) {
    active = await createStore();
    logger.info('Data store ready', { driver: active.driver, label: active.label });
  }
  return active;
}

async function closeStore() {
  if (active) { await active.close(); active = null; }
}

function setStore(store) { active = store; return store; }

module.exports = { createStore, getStore, closeStore, setStore };
