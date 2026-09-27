'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../server/lib/hash');
const { BlobEvidenceStorage } = require('../server/adapters/storage/blob');
const { validateSetup, runSetup } = require('../cloud-setup.cjs');
const { httpHarness } = require('./helpers.cjs');
const { setStorage } = require('../server/adapters/storage');
const evidence = require('../server/services/evidence.service');
function sdkFixture() {
  const values = new Map();
  const calls = [];
  class BlobNotFoundError extends Error {}
  return {
    values, calls, BlobNotFoundError,
    async put(path, bytes, options) {
      calls.push({ method: 'put', path, options });
      if (values.has(path)) throw new Error('already exists');
      values.set(path, Buffer.from(bytes));
      return { url: 'https://test.private.blob.vercel-storage.com/' + path, pathname: path };
    },
    async get(path, options) {
      calls.push({ method: 'get', path, options });
      if (!values.has(path)) return null;
      const bytes = values.get(path);
      return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), blob: { size: bytes.length, url: 'https://test.private.blob.vercel-storage.com/' + path } };
    },
    async head(path) {
      if (!values.has(path)) throw new BlobNotFoundError();
      return { url: 'https://test.private.blob.vercel-storage.com/' + path };
    }
  };
}
const keyFor = bytes => 'case-demo/payroll_record/' + sha256(bytes).slice(0, 2) + '/' + sha256(bytes);
async function storage(sdk = sdkFixture(), maxBytes = 4000000) {
  return new BlobEvidenceStorage({ token: () => 'synthetic-test-token', sdk, maxBytes }).init();
}

test('private Blob roundtrip uses private SDK operations and never returns a URL', async () => {
  const sdk = sdkFixture();
  const s = await storage(sdk);
  const bytes = Buffer.from('Synthetic document');
  const key = keyFor(bytes);
  assert.deepEqual(await s.put(key, bytes), { key, driver: 'blob', bytes: bytes.length });
  assert.deepEqual(await s.get(key), bytes);
  assert.equal(await s.exists(key), true);
  assert.ok(sdk.calls.every(call => call.options.access === 'private'));
  assert.equal(sdk.calls[0].options.allowOverwrite, false);
  assert.equal(sdk.calls[0].options.addRandomSuffix, false);
  assert.doesNotMatch(JSON.stringify(s.describe()), /synthetic-test-token|blob\.vercel-storage\.com/);
});

test('private Blob retries reuse identical bytes, but refuse tampered existing bytes', async () => {
  const sdk = sdkFixture();
  const s = await storage(sdk);
  const bytes = Buffer.from('Synthetic document');
  const key = keyFor(bytes);
  await s.put(key, bytes);
  await s.put(key, bytes);
  assert.equal(sdk.values.size, 1);
  sdk.values.set('evidence/' + key, Buffer.from('tampered'));
  await assert.rejects(s.put(key, bytes), /does not match/);
  await assert.rejects(s.put(key, Buffer.from('different')), /content-addressed/);
});

test('Blob access rejects external URLs, traversal, public storage and deletion', async () => {
  const s = await storage();
  await assert.rejects(s.get('https://external.invalid/file'), /Unsupported/);
  await assert.rejects(s.get('../private'), /Unsupported/);
  assert.throws(() => s.assertPrivate({ url: 'https://test.public.blob.vercel-storage.com/a' }), /private Blob/);
  await assert.rejects(s.remove('anything'), /cannot be deleted/);
});

test('Blob missing files return 404 and oversized streams are stopped', async () => {
  const sdk = sdkFixture();
  const s = await storage(sdk, 3);
  await assert.rejects(s.get(keyFor(Buffer.from('missing'))), error => error.status === 404);
  assert.equal(await s.exists(keyFor(Buffer.from('missing'))), false);
  const key = keyFor(Buffer.from('oversized'));
  sdk.values.set('evidence/' + key, Buffer.from('oversized'));
  await assert.rejects(s.get(key), error => error.status === 413);
  await assert.rejects(s.put(key, Buffer.from('oversized')), error => error.status === 413);
});

test('Blob provider failures do not disclose credentials or provider URLs', async () => {
  const sdk = sdkFixture();
  sdk.get = async () => { throw new Error('https://token-secret@provider.invalid'); };
  const s = await storage(sdk);
  await assert.rejects(s.get(keyFor(Buffer.from('x'))), error => error.status === 424 && !/secret|provider/.test(error.message));
});

test('the evidence API retains authentication and permission checks with Blob storage', async () => {
  const h = await httpHarness();
  try {
    const s = await storage();
    setStorage(s);
    const bytes = Buffer.from('Synthetic cloud evidence');
    const uploaded = await evidence.upload(h.ctx.hr, h.caseId, { filename: 'cloud.txt', subjectType: 'case', subjectId: h.caseId, source: 'upload', mediaType: 'text/plain' }, bytes);
    const route = '/api/v1/evidence/' + uploaded.file.id + '/download';
    const anonymous = await h.call('GET', route);
    assert.equal(anonymous.status, 401);
    const token = await h.login(h.users.hr.email);
    const allowed = await h.call('GET', route, { token });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, bytes);
    assert.doesNotMatch(JSON.stringify(uploaded), /blob\.vercel-storage\.com|synthetic-test-token/);
  } finally { await h.close(); }
});

const setupEnv = () => ({ DATABASE_URL: 'postgresql://example.invalid/review?sslmode=verify-full', BLOB_READ_WRITE_TOKEN: 'test-only', SESSION_SECRET: 's'.repeat(32), SEED_PASSWORD: 'SyntheticTestingPassword_0123456789' });
test('setup rejects reset and weak passwords before making a connection', async () => {
  assert.throws(() => validateSetup('reset', setupEnv()), /reset is not supported/);
  assert.throws(() => validateSetup('all', { ...setupEnv(), SEED_PASSWORD: 'Demo!Passw0rd' }), /randomly generated/);
  assert.throws(() => validateSetup('all', { ...setupEnv(), SEED_PASSWORD: 'a'.repeat(40) }), /randomly generated/);
  let opened = false;
  await assert.rejects(runSetup('all', { env: { ...setupEnv(), SEED_PASSWORD: '' }, dependencies: { open() { opened = true; } } }));
  assert.equal(opened, false);
});

test('one-time setup migrates without reset, seeds quietly and preserves existing seeds', async () => {
  const actions = [];
  const store = {
    driver: 'postgres', async tx(fn) { actions.push('transaction'); return fn(this); },
    async query(sql) { assert.match(sql, /pg_advisory_xact_lock/); actions.push('lock'); },
    async migrate(options) { assert.deepEqual(options, { reset: false }); actions.push('migrate'); return { applied: [] }; },
    async close() { actions.push('close'); }
  };
  const result = await runSetup('all', { env: setupEnv(), dependencies: {
    async open() { actions.push('open'); return store; }, async storage() { actions.push('storage'); },
    async seed(scoped, options) { assert.equal(scoped, store); assert.deepEqual(options, { quiet: true, dataset: 'v2' }); actions.push('seed'); return { alreadySeeded: true }; }
  } });
  assert.deepEqual(actions, ['open', 'storage', 'transaction', 'lock', 'migrate', 'seed', 'close']);
  assert.equal(result.seedAlreadyPresent, true);
  assert.equal(result.seedCreated, false);
  assert.doesNotMatch(JSON.stringify(result), /Password|test-only/);
});
