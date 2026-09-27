/* The versioned REST surface, exercised over real HTTP against the real server. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { httpHarness, config } = require('./helpers.cjs');

const ACCOUNTS = {
  hr: 'hr@peopleledger.demo',
  preparer: 'preparer@peopleledger.demo',
  reviewer: 'reviewer@peopleledger.demo',
  management: 'management@peopleledger.demo',
  director: 'director@peopleledger.demo',
  auditor: 'auditor@peopleledger.demo',
  admin: 'admin@peopleledger.demo'
};

test('metadata is readable without a session and states what is live or simulated', async () => {
  const h = await httpHarness();
  try {
    const { status, body } = await h.call('GET', '/api/v1/meta');
    assert.equal(status, 200);
    assert.equal(body.version, 'v1');
    assert.equal(body.serverAuthoritative, true);
    assert.equal(body.storage.database, 'memory');
    assert.equal(body.integrations.model.state, 'simulated');
    assert.equal(body.integrations.teamsScheduling.state, 'simulated');
    assert.equal(body.integrations.enterpriseSso.state, 'deferred');
    assert.deepEqual(body.agent.tools.map(tool => tool.name).sort(), ['get_evidence', 'get_reconciliation', 'get_records', 'run_checks', 'save_draft']);
    assert.deepEqual(body.imports.containers, ['csv', 'xlsx']);
    assert.deepEqual(body.imports.bank, ['txnRef', 'valueDate', 'direction', 'amount', 'counterparty', 'description']);
    assert.ok(body.agent.deniedOperations.some(entry => entry.operation === 'initiate_payment'));
    assert.equal(body.roles.length, 7);
    assert.match(body.rules.disclaimer, /not a statutory/i);
  } finally { await h.close(); }
});

test('API routes require a session', async () => {
  const h = await httpHarness();
  try {
    const anonymous = await h.call('GET', '/api/v1/cases');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'unauthenticated');

    const badToken = await h.call('GET', '/api/v1/cases', { token: 'not-a-real-token' });
    assert.equal(badToken.status, 401);

    const wrongPassword = await h.call('POST', '/api/v1/auth/login', { body: { email: ACCOUNTS.hr, password: 'wrong' } });
    assert.equal(wrongPassword.status, 401);
    assert.ok(!('token' in wrongPassword.body));
  } finally { await h.close(); }
});

test('sign-in issues a session cookie and a bearer token', async () => {
  const h = await httpHarness();
  try {
    const login = await h.call('POST', '/api/v1/auth/login', { body: { email: ACCOUNTS.director, password: config.seed.password } });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.role, 'director');
    assert.ok(!('password_hash' in login.body.user));

    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^pl_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const me = await h.call('GET', '/api/v1/auth/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.roleLabel, 'Director');
    assert.ok(me.body.permissions.includes('reports.approve'));

    const byCookie = await h.call('GET', '/api/v1/auth/me', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(byCookie.status, 200);

    await h.call('POST', '/api/v1/auth/logout', { token: login.body.token });
    const after = await h.call('GET', '/api/v1/auth/me', { token: login.body.token });
    assert.equal(after.status, 401);
  } finally { await h.close(); }
});

test('the whole workflow runs over the HTTP API', async () => {
  const h = await httpHarness();
  try {
    const tokens = {};
    for (const [key, email] of Object.entries(ACCOUNTS)) tokens[key] = await h.login(email);
    const caseId = h.caseId;

    const listed = await h.call('GET', '/api/v1/cases', { token: tokens.preparer });
    assert.equal(listed.body.cases.length, 1);
    // 10 payroll/payment rules plus the four bank reconciliation rules.
    assert.equal(listed.body.cases[0].ruleSet.rules.length, 14);

    // Checks
    const firstCheck = await h.call('POST', `/api/v1/cases/${caseId}/checks`, { token: tokens.preparer, body: {} });
    assert.equal(firstCheck.status, 201);
    assert.equal(firstCheck.body.blockingCount, 3);

    // Remediation by HR
    for (const [employeeNo, changes, note] of [
      ['EMP-003', { netPaid: '4950.00' }, 'Corrected against the demo payslip'],
      ['EMP-005', { evidence: 'PAY-202609-005' }, 'Payment reference supplied'],
      ['EMP-006', { costCenter: 'CC-400' }, 'Cost center assigned']
    ]) {
      const patched = await h.call('PATCH', `/api/v1/cases/${caseId}/records/${employeeNo}`, { token: tokens.hr, body: { changes, note } });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
    }

    const recheck = await h.call('POST', `/api/v1/cases/${caseId}/checks`, { token: tokens.preparer, body: {} });
    assert.equal(recheck.body.blockingCount, 0);
    assert.equal(recheck.body.reviewCount, 1);
    assert.equal(recheck.body.totalsFormatted.expected, '35100.00');

    // Agent draft
    const run = await h.call('POST', `/api/v1/cases/${caseId}/agent/runs`, { token: tokens.preparer, body: {} });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'completed');
    assert.equal(run.body.runKind, 'mock-model');
    const reportId = run.body.reportId;

    // Approval chain
    const submitted = await h.call('POST', `/api/v1/reports/${reportId}/submit`, { token: tokens.preparer, body: { note: 'Submitted for review' } });
    assert.equal(submitted.body.status, 'submitted');

    const wrongRole = await h.call('POST', `/api/v1/reports/${reportId}/review`, { token: tokens.hr, body: { note: 'Not my job' } });
    assert.equal(wrongRole.status, 403);

    const selfReview = await h.call('POST', `/api/v1/reports/${reportId}/review`, { token: tokens.preparer, body: { note: 'My own work' } });
    assert.equal(selfReview.status, 403);

    assert.equal((await h.call('POST', `/api/v1/reports/${reportId}/review`, { token: tokens.reviewer, body: { note: 'Checked' } })).body.status, 'finance_reviewed');
    assert.equal((await h.call('POST', `/api/v1/reports/${reportId}/confirm`, { token: tokens.management, body: { note: 'Confirmed' } })).body.status, 'management_confirmed');
    assert.equal((await h.call('POST', `/api/v1/reports/${reportId}/approve`, { token: tokens.director, body: { note: 'Approved' } })).body.status, 'approved');
    const sealed = await h.call('POST', `/api/v1/reports/${reportId}/seal`, { token: tokens.director, body: { note: 'Sealed' } });
    assert.equal(sealed.body.status, 'sealed');
    assert.ok(sealed.body.sealManifest.manifestDigest);

    // Export package
    const zipResponse = await h.call('GET', `/api/v1/cases/${caseId}/export/package`, { token: tokens.director });
    assert.equal(zipResponse.status, 200);
    assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
    assert.match(zipResponse.headers.get('content-disposition'), /attachment; filename=/);
    assert.match(zipResponse.headers.get('x-package-sha256'), /^[0-9a-f]{64}$/);
    const entries = require('../server/lib/zip').listEntries(zipResponse.body);
    assert.ok(entries.some(entry => entry.name === 'manifest.json'));
    assert.ok(entries.every(entry => entry.crcMatches));

    // Retained CSV and JSON exports
    const csvResponse = await h.call('GET', `/api/v1/cases/${caseId}/export/records.csv`, { token: tokens.auditor });
    assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
    assert.equal(require('../dist/demo/core.js').parseCSV(csvResponse.body.toString('utf8')).length, 6);

    const jsonResponse = await h.call('GET', `/api/v1/cases/${caseId}/export/evidence.json`, { token: tokens.auditor });
    assert.equal(jsonResponse.body.reports.length, 1);
    assert.equal(jsonResponse.body.reports[0].status, 'sealed');

    // The access log records the auditor's exports.
    const audit = await h.call('GET', `/api/v1/cases/${caseId}/audit?scope=access`, { token: tokens.director });
    assert.ok(audit.body.entries.some(entry => entry.action === 'export.records_csv' && entry.actor_role === 'auditor'));
  } finally { await h.close(); }
});

test('evidence uploads and downloads work over HTTP and are authorised', async () => {
  const h = await httpHarness();
  try {
    const hr = await h.login(ACCOUNTS.hr);
    const auditor = await h.login(ACCOUNTS.auditor);
    const content = 'DEMO bank advice, synthetic content only.';

    const query = new URLSearchParams({
      filename: 'bank-advice-001.txt',
      subjectType: 'payment_reference',
      subjectId: 'PAY-202609-001',
      source: 'bank_statement',
      mediaType: 'text/plain'
    });
    const upload = await h.call('POST', `/api/v1/cases/${h.caseId}/evidence?${query}`, {
      token: hr, raw: Buffer.from(content, 'utf8'), headers: { 'Content-Type': 'text/plain' }
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.file.version, 1);
    assert.equal(upload.body.file.readable, true);

    const duplicate = await h.call('POST', `/api/v1/cases/${h.caseId}/evidence?${query}`, {
      token: hr, raw: Buffer.from(content, 'utf8'), headers: { 'Content-Type': 'text/plain' }
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);

    const download = await h.call('GET', `/api/v1/evidence/${upload.body.file.id}/download`, { token: auditor });
    assert.equal(download.status, 200);
    assert.equal(download.body.toString('utf8'), content);
    assert.equal(download.headers.get('x-evidence-sha256'), upload.body.file.sha256);

    // The reviewer role may download; HR-only data is unaffected.
    const listing = await h.call('GET', `/api/v1/cases/${h.caseId}/evidence?subjectType=payment_reference`, { token: auditor });
    assert.equal(listing.body.files.length, 1);
  } finally { await h.close(); }
});

test('routing errors are explicit and unknown body fields are refused', async () => {
  const h = await httpHarness();
  try {
    const token = await h.login(ACCOUNTS.preparer);

    const unknown = await h.call('GET', '/api/v1/does-not-exist', { token });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');

    const wrongMethod = await h.call('DELETE', '/api/v1/meta', { token });
    assert.equal(wrongMethod.status, 405);

    const extraField = await h.call('POST', `/api/v1/cases/${h.caseId}/records`, {
      token, body: { rows: [], note: 'x', somethingElse: true }
    });
    assert.equal(extraField.status, 403, 'the preparer cannot import records at all');

    const hr = await h.login(ACCOUNTS.hr);
    const rejected = await h.call('POST', `/api/v1/cases/${h.caseId}/records`, {
      token: hr, body: { rows: [], note: 'x', somethingElse: true }
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /unsupported field/i);

    const notJson = await h.call('POST', '/api/v1/auth/login', { raw: 'email=x', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(notJson.status, 400);

    // A model draft cannot be pushed in over HTTP.
    const smuggled = await h.call('POST', `/api/v1/cases/${h.caseId}/reports`, { token, body: { draft: { summary: 'x' } } });
    assert.equal(smuggled.status, 400);
    assert.match(smuggled.body.error.message, /produced by the server template or by an agent run/);
  } finally { await h.close(); }
});

test('a case the caller is not a member of is not readable', async () => {
  const h = await httpHarness();
  try {
    const admin = await h.login(ACCOUNTS.admin);
    const preparer = await h.login(ACCOUNTS.preparer);
    const other = await h.call('POST', '/api/v1/cases', { token: admin, body: { title: 'October 2026 payroll review', period: '2026-10' } });
    assert.equal(other.status, 201);

    const refused = await h.call('GET', `/api/v1/cases/${other.body.id}/records`, { token: preparer });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /not a member of this case/i);

    const notFound = await h.call('GET', '/api/v1/cases/case_nope/records', { token: preparer });
    assert.equal(notFound.status, 404);
  } finally { await h.close(); }
});

test('recruitment and simulated scheduling are reachable over HTTP with correct status codes', async () => {
  const h = await httpHarness();
  try {
    const hr = await h.login(ACCOUNTS.hr);
    const preparer = await h.login(ACCOUNTS.preparer);

    const jobs = await h.call('GET', '/api/v1/jobs', { token: hr });
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.jobs.length, 2);

    const financeRefused = await h.call('GET', '/api/v1/jobs', { token: preparer });
    assert.equal(financeRefused.status, 403);

    const blocked = jobs.body.jobs.find(job => job.status === 'draft');
    const cannotOpen = await h.call('POST', `/api/v1/jobs/${blocked.id}/open`, { token: hr, body: {} });
    assert.equal(cannotOpen.status, 422);
    assert.ok(cannotOpen.body.error.detail.missing.includes('advertisementEvidence'));

    const candidates = await h.call('GET', `/api/v1/jobs/${h.seeded.jobId}/candidates`, { token: hr });
    const candidateId = candidates.body.candidates[0].id;
    const start = new Date(Date.now() + 3600000).toISOString();

    const scheduled = await h.call('POST', `/api/v1/candidates/${candidateId}/interviews`, { token: hr, body: { start } });
    assert.equal(scheduled.status, 201);
    assert.equal(scheduled.body.meeting.providerState, 'simulated');

    const repeat = await h.call('POST', `/api/v1/candidates/${candidateId}/interviews`, { token: hr, body: { start } });
    assert.equal(repeat.status, 200, 'a duplicate request is not a new creation');
    assert.equal(repeat.body.duplicate, true);

    const failing = await h.call('POST', `/api/v1/candidates/${candidateId}/interviews`, {
      token: hr, body: { start: new Date(Date.now() + 7200000).toISOString(), simulateFailure: true }
    });
    assert.equal(failing.status, 502, 'a provider failure is surfaced with an upstream status');
    assert.equal(failing.body.meeting.status, 'failed');
  } finally { await h.close(); }
});

test('the browser client is served with security headers', async () => {
  const h = await httpHarness();
  try {
    const page = await fetch(`${h.origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.match(html, /PeopleLedger/);

    const escape = await fetch(`${h.origin}/../package.json`);
    assert.ok([403, 404].includes(escape.status), 'paths outside dist are not served');
  } finally { await h.close(); }
});
