/* Shared test harness.
 *
 * The suite runs without PostgreSQL and without AWS: the in-process store and the
 * labelled mock model are selected explicitly here. Evidence is written to a
 * throwaway directory per suite so upload, download and packaging exercise the
 * real storage adapter rather than a stub. */
'use strict';

// Must be set before the configuration module is first required.
process.env.DB_DRIVER = 'memory';
process.env.MODEL_DRIVER = 'mock';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-0123456789';
process.env.SEED_PASSWORD = process.env.SEED_PASSWORD || 'Demo!Passw0rd';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logger = require('../server/lib/logger');
logger.setSink(() => {});

const config = require('../server/config');
const { MemoryStore } = require('../server/adapters/db/memory');
const { setStore, closeStore } = require('../server/adapters/db');
const { LocalEvidenceStorage } = require('../server/adapters/storage/local');
const { setStorage } = require('../server/adapters/storage');
const { setModel, clearModel, MockModel } = require('../server/adapters/model');
const { seed } = require('../server/db/seed');
const rbac = require('../server/auth/rbac');
const { createServer } = require('../server/http/app');

const temporaryDirs = [];

async function harness({ model, driver = 'memory', dataset = 'legacy' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-evidence-'));
  temporaryDirs.push(dir);
  const store = driver === 'sqlite' ? new (require('../server/adapters/db/sqlite').SqliteStore)({ filename: path.join(dir, 'test.sqlite') }) : new MemoryStore();
  await store.init();
  setStore(store);

  const storage = new LocalEvidenceStorage({ dir });
  await storage.init();
  setStorage(storage);

  const mock = model || new MockModel();
  setModel(mock);

  const seeded = await seed(store, { quiet: true, dataset });

  const ctxFor = user => ({
    store,
    actor: {
      id: user.id,
      role: user.role,
      email: user.email,
      displayName: user.display_name,
      permissions: rbac.permissionsFor(user.role)
    },
    ip: '127.0.0.1'
  });

  return {
    store,
    storage,
    storageDir: dir,
    model: mock,
    seeded,
    caseId: seeded.caseId,
    users: seeded.users,
    ctx: Object.fromEntries(Object.entries(seeded.users).map(([key, user]) => [key, ctxFor(user)])),
    ctxFor,
    async close() {
      await store.close();
      await closeStore();
      clearModel();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

/** Starts the real HTTP server on an ephemeral port and returns a small client. */
async function httpHarness(options) {
  const base = await harness(options);
  const server = createServer({ store: base.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  async function call(method, route, { body, token, raw, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) {
      init.body = raw;
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/octet-stream';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    if (token) init.headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}${route}`, init);
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: payload, headers: response.headers };
  }

  async function login(email) {
    const result = await call('POST', '/api/v1/auth/login', { body: { email, password: config.seed.password } });
    if (result.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(result.body)}`);
    return result.body.token;
  }

  return {
    ...base,
    origin,
    call,
    login,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await base.close();
    }
  };
}

/** Rows for a payroll import in which the three seeded findings are resolved. */
function cleanRows() {
  const core = require('../dist/demo/core.js');
  return core.normalizeRows(core.SAMPLE).map(row => ({
    ...row,
    netPaid: ((core.cents(row.basePay) + core.cents(row.allowances) - core.cents(row.deductions)) / 100).toFixed(2),
    costCenter: row.costCenter || 'CC-400',
    evidence: row.evidence || 'PAY-202609-005'
  }));
}

/** Runs an async function and returns the thrown error rather than failing. */
async function capture(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

process.on('exit', () => {
  for (const dir of temporaryDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

module.exports = { harness, httpHarness, cleanRows, capture, config };
