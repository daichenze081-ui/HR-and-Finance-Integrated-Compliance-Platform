'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createEntry, cloudEnvironment, MAX_PAYLOAD } = require('../cloud/runtime.cjs');
const { httpHarness, config } = require('./helpers.cjs');
const httpLib = require('../server/lib/http');

async function endpoint(handler, operation) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await operation('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function response() {
  return { headersSent: false, writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; }
  };
}
const validEnv = () => ({ DATABASE_URL: 'postgresql://example.invalid/review?sslmode=verify-full', BLOB_READ_WRITE_TOKEN: 'test-only', SESSION_SECRET: 'x'.repeat(32) });

test('cloud configuration refuses local or temporary persistence and clamps payload limits', () => {
  assert.throws(() => cloudEnvironment({}), /Missing cloud configuration/);
  assert.throws(() => cloudEnvironment({ ...validEnv(), DB_DRIVER: 'sqlite' }), /PostgreSQL/);
  assert.throws(() => cloudEnvironment({ ...validEnv(), EVIDENCE_DRIVER: 'local' }), /private Blob or S3/);
  assert.throws(() => cloudEnvironment({ ...validEnv(), MODEL_DRIVER: 'ollama' }), /mock or configured Bedrock/);
  assert.throws(() => cloudEnvironment({ ...validEnv(), DATABASE_URL: 'postgresql://example.invalid/review?sslmode=disable' }), /verify-full/);
  const env = cloudEnvironment({ ...validEnv(), MAX_JSON_BYTES: '8000000' });
  assert.equal(env.DB_DRIVER, 'postgres');
  assert.equal(env.EVIDENCE_DRIVER, 'blob');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(Number(env.MAX_JSON_BYTES), MAX_PAYLOAD);
  assert.equal(env.PGSSLMODE, 'require');
  const s3 = cloudEnvironment({ ...validEnv(), EVIDENCE_DRIVER: 's3', S3_BUCKET: 'synthetic', AWS_REGION: 'ap-southeast-1', AWS_ACCESS_KEY_ID: 'test-only', AWS_SECRET_ACCESS_KEY: 'test-only' });
  assert.equal(s3.EVIDENCE_DRIVER, 's3');
});

test('simultaneous cold-start requests share one initialization and preserve API URLs', async () => {
  let initialized = 0;
  const handler = createEntry({ initialize: async () => {
    initialized++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return (req, res) => { res.writeHead(200); res.end(req.url); };
  } });
  await endpoint(handler, async origin => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => fetch(origin + '/api/v1/cases?period=2026-09').then(r => r.text())));
    assert.equal(initialized, 1);
    assert.ok(replies.every(r => r === '/api/v1/cases?period=2026-09'));
  });
});

test('cloud initialization failures are private, fail closed, and can be retried', async () => {
  let attempt = 0;
  const handler = createEntry({ initialize: async () => {
    if (++attempt === 1) throw new Error('postgres://user:secret@example.invalid');
    return (req, res) => { res.writeHead(200); res.end('ready'); };
  } });
  await endpoint(handler, async origin => {
    const first = await fetch(origin + '/api/v1/meta');
    assert.equal(first.status, 503);
    const body = await first.text();
    assert.match(body, /cloud_not_ready/);
    assert.doesNotMatch(body, /secret|postgres:\/\//);
    assert.equal(await (await fetch(origin + '/api/v1/meta')).text(), 'ready');
  });
});

test('oversized requests are rejected before a database connection is attempted', async () => {
  let attempts = 0;
  const handler = createEntry({ initialize: async () => { attempts++; } });
  const res = response();
  await handler({ headers: { 'content-length': String(MAX_PAYLOAD + 1) } }, res);
  assert.equal(res.status, 413);
  assert.equal(attempts, 0);
});

test('already parsed JSON and binary bodies remain readable with original limits', async () => {
  const json = { body: { isbn: 'example' }, headers: { 'content-type': 'application/json' } };
  assert.deepEqual(await httpLib.readJson(json, 100), { isbn: 'example' });
  const binary = Buffer.from([0, 10, 255]);
  assert.deepEqual(await httpLib.readBody({ body: binary }, 3), binary);
  await assert.rejects(httpLib.readBody({ body: binary }, 2), error => error.status === 413);
});

test('production login and logout set secure HttpOnly cookies', async () => {
  const h = await httpHarness();
  const previous = config.env;
  config.env = 'production';
  try {
    const login = await h.call('POST', '/api/v1/auth/login', { body: { email: h.users.preparer.email, password: config.seed.password } });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure;/);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const logout = await h.call('POST', '/api/v1/auth/logout', { token: login.body.token });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /; Secure;/);
  } finally { config.env = previous; await h.close(); }
});

test('large binary downloads fail before response headers are sent', () => {
  const res = response();
  assert.throws(() => httpLib.sendBinary(res, 200, Buffer.alloc(MAX_PAYLOAD + 1), {}), error => error.status === 413);
  assert.equal(res.headersSent, false);
});
