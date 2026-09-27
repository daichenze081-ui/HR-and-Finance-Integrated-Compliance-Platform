'use strict';
const { cloudEnvironment, createEntry } = require('../cloud/runtime.cjs');

module.exports = createEntry({ initialize: async () => {
  cloudEnvironment();
  const { getStore, closeStore } = require('../server/adapters/db');
  const { getStorage } = require('../server/adapters/storage');
  const { createApp } = require('../server/http/app');
  try {
    const store = await getStore();
    const storage = await getStorage();
    if (store.driver !== 'postgres' || !['s3', 'blob'].includes(storage.driver)) throw new Error('Persistent cloud adapters are required');
    return createApp({ store });
  } catch (error) {
    await closeStore();
    throw error;
  }
} });
