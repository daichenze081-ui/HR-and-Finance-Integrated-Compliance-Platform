/* Authorisation, self-approval prevention, case scoping, time-limited auditor
 * access, version invalidation and evidence integrity. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, capture } = require('./helpers.cjs');

const clock = require('../server/lib/clock');
const casesService = require('../server/services/cases.service');
const recordsService = require('../server/services/records.service');
const checksService = require('../server/services/checks.service');
const reportsService = require('../server/services/reports.service');
const evidenceService = require('../server/services/evidence.service');
const exportService = require('../server/services/export.service');
const auditService = require('../server/services/audit.service');
const access = require('../server/auth/access');
const sessions = require('../server/auth/sessions');

async function readyReport(h) {
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-003', { changes: { netPaid: '4950.00' }, note: 'Corrected' });
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-005', { changes: { evidence: 'PAY-202609-005' }, note: 'Reference added' });
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-006', { changes: { costCenter: 'CC-400' }, note: 'Cost center added' });
  await checksService.run(h.ctx.preparer, h.caseId);
  return reportsService.create(h.ctx.preparer, h.caseId, {});
}

test('roles are refused actions outside their permissions', async () => {
  const h = await harness();
  try {
    const attempts = [
      ['hr cannot import payments', () => require('../server/services/payments.service').importBatch(h.ctx.hr, h.caseId, { csv: 'x' })],
      ['reviewer cannot replace payroll records', () => recordsService.replaceAll(h.ctx.reviewer, h.caseId, { rows: [] })],
      ['auditor cannot edit a record', () => recordsService.update(h.ctx.auditor, h.caseId, 'EMP-001', { changes: { basePay: '1.00' }, note: 'no' })],
      ['management cannot run checks', () => checksService.run(h.ctx.management, h.caseId)],
      ['auditor cannot create a case', () => casesService.create(h.ctx.auditor, { title: 'New', period: '2026-10' })],
      ['preparer cannot grant case access', () => access.grant(h.ctx.preparer, { caseId: h.caseId, userId: h.users.auditor.id })],
      ['hr cannot request an agent run', () => require('../server/agent/loop').run(h.ctx.hr, h.caseId, {})]
    ];
    for (const [label, action] of attempts) {
      const error = await capture(action);
      assert.ok(error, `${label}: an error is raised`);
      assert.equal(error.status, 403, `${label}: refused with 403 (got ${error.status}: ${error.message})`);
    }
  } finally { await h.close(); }
});

test('the preparer of a report version cannot review, confirm or approve it', async () => {
  const h = await harness();
  try {
    const report = await readyReport(h);
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });

    // The preparer holds no review permission, and is additionally the author.
    const asPreparer = await capture(() => reportsService.advance(h.ctx.preparer, report.id, 'review', { note: 'Reviewing my own work' }));
    assert.equal(asPreparer.status, 403);

    // Same account, granted the reviewer role, is still refused as the author.
    const dualRole = { ...h.ctx.preparer, actor: { ...h.ctx.preparer.actor, role: 'reviewer' } };
    const authorBlocked = await capture(() => reportsService.advance(dualRole, report.id, 'review', { note: 'Still my own work' }));
    assert.equal(authorBlocked.status, 403);
    assert.match(authorBlocked.message, /you cannot also record an approval decision/i);
    assert.equal(authorBlocked.detail.preparedBy, h.users.preparer.id);
  } finally { await h.close(); }
});

test('one account cannot occupy two approval stages on the same version', async () => {
  const h = await harness();
  try {
    const report = await readyReport(h);
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });
    await reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Reviewed' });

    // The reviewer account, even if also granted management rights, cannot confirm
    // a version it has already reviewed.
    const escalated = { ...h.ctx.reviewer, actor: { ...h.ctx.reviewer.actor, role: 'management' } };
    const error = await capture(() => reportsService.advance(escalated, report.id, 'confirm', { note: 'Confirming my own review' }));
    assert.equal(error.status, 403);
    assert.match(error.message, /already recorded the review decision/i);

    // A genuinely separate account can.
    const confirmed = await reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Confirmed' });
    assert.equal(confirmed.status, 'management_confirmed');
  } finally { await h.close(); }
});

test('case membership is required, and a second case is not readable without it', async () => {
  const h = await harness();
  try {
    const other = await casesService.create(h.ctx.admin, { title: 'October 2026 payroll review', period: '2026-10' });

    const refused = await capture(() => recordsService.list(h.ctx.preparer, other.id));
    assert.equal(refused.status, 403);
    assert.match(refused.message, /not a member of this case/i);
    assert.equal(refused.detail.expired, false);

    const visible = await casesService.list(h.ctx.preparer);
    assert.deepEqual(visible.map(item => item.id), [h.caseId]);

    await access.grant(h.ctx.director, { caseId: other.id, userId: h.users.preparer.id, caseRole: 'finance_preparer' });
    const allowed = await recordsService.list(h.ctx.preparer, other.id);
    assert.equal(allowed.records.length, 0);
  } finally { await h.close(); }
});

test('auditor access is case scoped, time limited and logged', async () => {
  const h = await harness();
  try {
    const before = await casesService.detail(h.ctx.auditor, h.caseId);
    assert.ok(before.membership.expiresAt, 'auditor membership carries an expiry');
    await evidenceService.list(h.ctx.auditor, h.caseId);
    await reportsService.list(h.ctx.auditor, h.caseId);

    const logged = await auditService.list(h.ctx.director, { caseId: h.caseId, actions: ['auditor.access.read'] });
    assert.ok(logged.length >= 3, 'each auditor read is recorded');
    assert.ok(logged.every(entry => entry.actor_id === h.users.auditor.id));

    // After the grant expires the same account is refused, and told why.
    clock.freeze(new Date(Date.parse(before.membership.expiresAt) + 60000).toISOString());
    const expired = await capture(() => casesService.detail(h.ctx.auditor, h.caseId));
    clock.unfreeze();
    assert.equal(expired.status, 403);
    assert.match(expired.message, /expired or been revoked/i);
    assert.equal(expired.detail.expired, true);
  } finally { await h.close(); }
});

test('revoking access takes effect immediately', async () => {
  const h = await harness();
  try {
    const members = await access.listMembers(h.ctx.director, h.caseId);
    const target = members.find(member => member.role === 'reviewer');
    await access.revoke(h.ctx.director, target.id);
    const error = await capture(() => reportsService.list(h.ctx.reviewer, h.caseId));
    assert.equal(error.status, 403);
  } finally { await h.close(); }
});

test('a record change invalidates recorded approvals but preserves them', async () => {
  const h = await harness();
  try {
    const report = await readyReport(h);
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });
    await reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Reviewed' });

    await recordsService.update(h.ctx.hr, h.caseId, 'EMP-001', { changes: { allowances: '500.00' }, note: 'Allowance corrected after review' });

    const after = await reportsService.detail(h.ctx.management, report.id);
    assert.equal(after.applicable, false);
    assert.match(after.staleReason, /Case data has changed/);
    assert.equal(after.nextStage, null);
    // Decisions are still on file, flagged as no longer applicable.
    assert.equal(after.decisions.length, 2);
    assert.ok(after.decisions.every(decision => decision.appliesToCurrentInputs === false));
    assert.equal(after.decisions[1].note, 'Reviewed');
    // The snapshot is untouched by the later edit.
    assert.equal(after.snapshot.records.find(row => row.employeeNo === 'EMP-001').allowances, '300.00');

    const blocked = await capture(() => reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Confirming anyway' }));
    assert.equal(blocked.status, 409);
    assert.match(blocked.message, /no longer apply/);
  } finally { await h.close(); }
});

test('a rule configuration change invalidates checks and pending approvals', async () => {
  const h = await harness();
  try {
    const report = await readyReport(h);
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });

    const changed = await casesService.setRuleConfig(h.ctx.admin, h.caseId, { rules: [{ id: 'PAY-002', enabled: false }] });
    assert.equal(changed.changed, true);
    assert.notEqual(changed.ruleSet.version, report.ruleVersion);

    const latest = await checksService.latest(h.ctx.preparer, h.caseId);
    assert.equal(latest.current, false);
    assert.match(latest.check.staleReason, /Rules have changed/);

    const blocked = await capture(() => reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Reviewing' }));
    assert.equal(blocked.status, 409);
    assert.match(blocked.message, /Rules have changed/);
  } finally { await h.close(); }
});

test('evidence whose stored bytes no longer match its digest is refused', async () => {
  const h = await harness();
  try {
    const files = await evidenceService.list(h.ctx.director, h.caseId);
    const target = files.find(file => file.filename.startsWith('payslip-EMP-001'));

    const clean = await evidenceService.download(h.ctx.director, target.id);
    assert.equal(clean.file.sha256, target.sha256);

    const row = await h.store.findOne('evidence_files', { id: target.id });
    fs.writeFileSync(path.join(h.storageDir, row.storage_key), 'tampered content');

    const error = await capture(() => evidenceService.download(h.ctx.director, target.id));
    assert.equal(error.status, 403);
    assert.match(error.message, /failed its integrity check/);

    const logged = await auditService.list(h.ctx.director, { caseId: h.caseId, actions: ['evidence.download'] });
    assert.ok(logged.some(entry => entry.detail.integrityVerified === false));
  } finally { await h.close(); }
});

test('exports are logged with the identity of the requester', async () => {
  const h = await harness();
  try {
    await readyReport(h);
    await exportService.buildPackage(h.ctx.auditor, h.caseId);
    await exportService.recordsCsv(h.ctx.auditor, h.caseId);

    const logged = await auditService.list(h.ctx.director, { caseId: h.caseId, actions: auditService.ACCESS_ACTIONS });
    const exports_ = logged.filter(entry => entry.action.startsWith('export.'));
    assert.ok(exports_.length >= 2);
    assert.ok(exports_.every(entry => entry.actor_id === h.users.auditor.id && entry.actor_role === 'auditor'));
    assert.ok(exports_.some(entry => typeof entry.detail.archiveSha256 === 'string'));
  } finally { await h.close(); }
});

test('sign-in failures are uniform and no credential material is ever returned', async () => {
  const h = await harness();
  try {
    const wrongPassword = await capture(() => sessions.login(h.store, { email: h.users.hr.email, password: 'not-the-password' }));
    const unknownUser = await capture(() => sessions.login(h.store, { email: 'nobody@peopleledger.demo', password: 'not-the-password' }));
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.message, unknownUser.message);

    const good = await sessions.login(h.store, { email: h.users.hr.email, password: require('./helpers.cjs').config.seed.password });
    const shaped = sessions.publicUser(good.user);
    assert.deepEqual(Object.keys(shaped).sort(), ['displayName', 'email', 'id', 'lastLoginAt', 'role']);
    assert.ok(!JSON.stringify(shaped).includes(good.user.password_hash));

    // The raw token is not what is stored.
    const stored = await h.store.get('sessions', good.session.id);
    assert.notEqual(stored.token_hash, good.token);
    assert.ok(await sessions.resolve(h.store, good.token));
    await sessions.logout(h.store, good.token);
    assert.equal(await sessions.resolve(h.store, good.token), null);
  } finally { await h.close(); }
});

test('an expired session stops resolving', async () => {
  const h = await harness();
  try {
    const good = await sessions.login(h.store, { email: h.users.director.email, password: require('./helpers.cjs').config.seed.password });
    await h.store.update('sessions', good.session.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await sessions.resolve(h.store, good.token), null);
  } finally { await h.close(); }
});
