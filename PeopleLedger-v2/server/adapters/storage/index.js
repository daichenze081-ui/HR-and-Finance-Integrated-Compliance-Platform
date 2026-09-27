/* Evidence storage factory. Services depend only on put/get/exists/describe, so
 * the backing store can change without touching business logic. */
'use strict';
const config = require('../../config');
const { LocalEvidenceStorage } = require('./local');
const { S3EvidenceStorage } = require('./s3');

let active = null;

async function createStorage(overrides = {}) {
  const driver = overrides.driver || config.evidence.driver;
  if (driver === 's3') {
    const storage = new S3EvidenceStorage({
      bucket: overrides.bucket || config.evidence.s3Bucket,
      prefix: overrides.prefix || config.evidence.s3Prefix,
      region: overrides.region || config.model.region,
      credentials: config.awsCredentials
    });
    await storage.init();
    return storage;
  }
  const storage = new LocalEvidenceStorage({ dir: overrides.dir || config.evidence.localDir });
  await storage.init();
  return storage;
}

async function getStorage() {
  if (!active) active = await createStorage();
  return active;
}

const setStorage = storage => { active = storage; return storage; };

module.exports = { createStorage, getStorage, setStorage };
