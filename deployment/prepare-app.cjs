'use strict';
// Builds an isolated, allowlisted deployment copy; never modifies PeopleLedger-v2.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'PeopleLedger-v2');
const target = path.join(__dirname, 'app');
const templates = path.join(__dirname, 'templates');
const copied = [];
function write(relative, data) {
  const destination = path.resolve(target, relative);
  if (!destination.startsWith(target + path.sep)) throw new Error('Destination outside deployment/app');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
}
function copyTree(relative, extensions) {
  const location = path.join(source, relative);
  for (const item of fs.readdirSync(location, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Symlinks are not allowed in deployment input');
    const child = path.join(relative, item.name);
    if (item.isDirectory()) copyTree(child, extensions);
    else if (extensions.includes(path.extname(item.name))) {
      const bytes = fs.readFileSync(path.join(source, child));
      write(child, bytes);
      copied.push({ path: child.replaceAll(path.sep, '/'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
copyTree('server', ['.js', '.sql']);
copyTree('dist', ['.js', '.css', '.html']);
copyTree('examples', ['.csv', '.xlsx', '.pdf']);
copyTree('tests', ['.cjs']);
for (const name of ['check.js', 'migrate.js', 'seed.js']) write('scripts/' + name, fs.readFileSync(path.join(source, 'scripts', name)));

function patch(relative, before, after) {
  const file = path.join(target, relative);
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(before).length !== 2) throw new Error('Expected one overlay match in ' + relative);
  write(relative, text.replace(before, after));
}
// Cookies are secure on the deployed HTTPS app, with local original tests unchanged.
patch('server/http/routes.js', 'secure: false', "secure: config.env === 'production'");
patch('server/http/routes.js', '{ maxAgeSeconds: 0 }', "{ maxAgeSeconds: 0, secure: config.env === 'production' }");
patch('dist/workspace.js', "The seeded demonstration accounts use the password from <code class=\"mono\">SEED_PASSWORD</code>", 'Sign in with the account details supplied by the workspace owner.');
patch('dist/workspace.js', ' (<code class="mono">Demo!Passw0rd</code> unless changed). Run <code class="mono">npm run seed</code> if sign-in fails.', ' Contact the owner if you cannot sign in.');
patch('dist/workspace.js', '${esc(role.id)}@peopleledger.demo', "${esc(role.id === 'finance_preparer' ? 'preparer' : role.id)}@peopleledger.demo");
// Author display rules must not override the browser's native hidden attribute.
write('dist/styles.css', fs.readFileSync(path.join(target, 'dist/styles.css'), 'utf8') + '\n[hidden]{display:none!important}\n');
// The archived demo also works under the same strict CSP: no inline CSS.
patch('dist/demo/app.js', '<span style="width:${Math.max(3,n/max*100)}%">', '<span class="chart-width-${Math.max(3,Math.round(n/max*100))}">');
patch('dist/demo/app.js', '<small style="margin:8px 0 0">', '<small class="report-history-note">');
patch('dist/demo/app.js', '<p style="margin-top:16px">', '<p class="import-preview-note">');
write('dist/demo/styles.css', fs.readFileSync(path.join(target, 'dist/demo/styles.css'), 'utf8')
  + '\n.report-history-note{margin:8px 0 0}.import-preview-note{margin-top:16px}\n'
  + Array.from({ length: 100 }, (_, index) => '.chart-width-' + (index + 1) + '{width:' + (index + 1) + '%}').join('\n'));
// Vercel may have already parsed the request before dispatching to our raw reader.
patch('server/lib/http.js', 'const SECURITY_HEADERS = {', `const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",`);
patch('server/lib/http.js', 'function readBody(req, maxBytes) {', `function readBody(req, maxBytes) {
  if (req.body !== undefined) {
    let bytes;
    if (Buffer.isBuffer(req.body)) bytes = req.body;
    else if (typeof req.body === 'string') bytes = Buffer.from(req.body);
    else if (req.body !== null && typeof req.body === 'object') bytes = Buffer.from(JSON.stringify(req.body));
    else bytes = Buffer.alloc(0);
    if (bytes.length > maxBytes) return Promise.reject(tooLarge('Request body exceeds the application upload limit'));
    return Promise.resolve(bytes);
  }`);
// Keep a deterministic error below the Vercel payload ceiling, for JSON and ZIP.
patch('server/lib/http.js', "  const body = payload === undefined ? '' : JSON.stringify(payload);", `  const body = payload === undefined ? '' : JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4000000) throw tooLarge('Response exceeds the 4 MB cloud response limit. Request a smaller dataset.');`);
patch('server/lib/http.js', "  const extra = { ...headers };", `  if (buffer.length > 4000000) throw tooLarge('Download exceeds the 4 MB cloud response limit. Split the case or configure an object-storage download flow.');
  const extra = { ...headers };`);
// PostgreSQL TLS validation is enabled. The connection URL must also require TLS.
patch('server/adapters/db/pg.js', 'ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,', 'ssl: this.config.ssl ? { rejectUnauthorized: true } : undefined,');
patch('server/adapters/storage/index.js', "  if (driver === 's3') {", `  if (driver === 'blob') {
    const { BlobEvidenceStorage } = require('./blob');
    const storage = new BlobEvidenceStorage({ token: () => process.env.BLOB_READ_WRITE_TOKEN, prefix: process.env.BLOB_PREFIX || 'evidence/', maxBytes: config.evidence.maxBytes });
    await storage.init();
    return storage;
  }
  if (driver === 's3') {`);
patch('server/config.js', "  evidenceStorage: config.evidence.driver === 's3'", `  evidenceStorage: config.evidence.driver === 'blob'
    ? { state: process.env.BLOB_READ_WRITE_TOKEN ? 'live' : 'awaiting-configuration', detail: 'Private Vercel Blob. Access is checked by the application; provider connectivity is confirmed on upload/download.' }
    : config.evidence.driver === 's3'`);

const packageJson = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
packageJson.engines.node = '24.x';
packageJson.packageManager = 'pnpm@11.25.0';
packageJson.dependencies['@vercel/blob'] = '2.8.0';
packageJson.scripts = {
  build: 'node deployment-build.cjs',
  check: 'node check-deployment.cjs',
  test: 'node --test --test-concurrency=1 tests/*.test.cjs',
  migrate: 'node cloud-setup.cjs migrate',
  seed: 'node cloud-setup.cjs seed',
  setup: 'node cloud-setup.cjs all'
};
write('package.json', JSON.stringify(packageJson, null, 2) + '\n');
// A pnpm lock records the added Blob SDK. Never leave an outdated npm lock.
const staleLock = path.join(target, 'package-lock.json');
if (fs.existsSync(staleLock)) fs.unlinkSync(staleLock);
const deploymentLock = path.join(templates, 'pnpm-lock.yaml');
if (fs.existsSync(deploymentLock)) write('pnpm-lock.yaml', fs.readFileSync(deploymentLock));
for (const [template, destination] of [
  ['api-index.js', 'api/index.js'], ['runtime.cjs', 'cloud/runtime.cjs'],
  ['deployment-build.cjs', 'deployment-build.cjs'], ['cloud-setup.cjs', 'cloud-setup.cjs'],
  ['check-deployment.cjs', 'check-deployment.cjs'],
  ['vercel.json', 'vercel.json'], ['vercelignore', '.vercelignore'],
  ['serverless.test.cjs', 'tests/serverless.test.cjs'],
  ['blob-storage.js', 'server/adapters/storage/blob.js'],
  ['blob-storage.test.cjs', 'tests/blob-storage.test.cjs']
]) write(destination, fs.readFileSync(path.join(templates, template)));
write('SOURCE-MANIFEST.json', JSON.stringify({ source: 'PeopleLedger-v2', note: 'Hashes identify source inputs before documented cloud overlays. No environment, runtime database, credentials or local evidence are copied.', files: copied }, null, 2));
process.stdout.write('Prepared deployment/app from ' + copied.length + ' allowlisted source files. No cloud connection was made.\n');
