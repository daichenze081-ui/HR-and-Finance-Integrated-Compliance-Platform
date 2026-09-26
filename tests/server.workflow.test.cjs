/* End-to-end server workflow: seeded case -> checks -> remediation -> report ->
 * finance review -> management confirmation -> director approval -> sealing ->
 * evidence package. Runs against the in-process store and the labelled mock model. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers.cjs');

const checksService = require('../server/services/checks.service');
const recordsService = require('../server/services/records.service');
const reportsService = require('../server/services/reports.service');
const exportService = require('../server/services/export.service');
const zip = require('../server/lib/zip');
const { capture } = require('./helpers.cjs');

async function resolveSeededFindings(h) {
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-003', { changes: { netPaid: '4950.00' }, note: 'Corrected against the demo payslip' });
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-005', { changes: { evidence: 'PAY-202609-005' }, note: 'Payment reference supplied' });
  await recordsService.update(h.ctx.hr, h.caseId, 'EMP-006', { changes: { costCenter: 'CC-400' }, note: 'Cost center assigned' });
}

test('seeded case starts with the intended blocking findings plus an unreadable-evidence review item', async () => {
  const h = await harness();
  try {
    const check = await checksService.run(h.ctx.preparer, h.caseId);
    const ids = check.issues.map(issue => issue.id);
    assert.ok(ids.includes('PAY-001:EMP-003'), 'net pay mismatch is detected');
    assert.ok(ids.includes('DOC-001:EMP-005'), 'missing payment reference is detected');
    assert.ok(ids.includes('ORG-001:EMP-006'), 'missing cost center is detected');
    assert.equal(check.blockingCount, 3);

    const review = check.issues.filter(issue => issue.severity === 'review');
    assert.equal(review.length, 1);
    assert.equal(review[0].rule, 'DOC-003');
    assert.match(review[0].detail, /must be checked by a person/);
    assert.equal(check.current, true);
  } finally { await h.close(); }
});

test('a report cannot be prepared while the stored check is stale', async () => {
  const h = await harness();
  try {
    await checksService.run(h.ctx.preparer, h.caseId);
    await recordsService.update(h.ctx.hr, h.caseId, 'EMP-001', { changes: { allowances: '400.00' }, note: 'Allowance corrected' });

    const stale = await checksService.latest(h.ctx.preparer, h.caseId);
    assert.equal(stale.current, false);
    assert.match(stale.check.staleReason, /Data has changed/);

    const error = await capture(() => reportsService.create(h.ctx.preparer, h.caseId, {}));
    assert.equal(error.status, 409);
    assert.match(error.message, /Run the checks again/);
  } finally { await h.close(); }
});

test('full approval chain: submit, review, confirm, approve, seal', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    const check = await checksService.run(h.ctx.preparer, h.caseId);
    assert.equal(check.blockingCount, 0, 'blocking findings are resolved');
    assert.equal(check.reviewCount, 1, 'the unreadable PDF still requires manual review');

    const report = await reportsService.create(h.ctx.preparer, h.caseId, {});
    assert.equal(report.status, 'draft');
    assert.equal(report.draftSource, 'template');
    assert.equal(report.applicable, true);
    assert.equal(report.draft.keyAmounts.currency, 'SGD');
    // The unreadable file must be listed for a person, never described as checked.
    assert.ok(report.draft.itemsRequiringHumanReview.some(item => /payslip-EMP-002/.test(item.item)));

    const submitted = await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Prepared for review' });
    assert.equal(submitted.status, 'submitted');

    const reviewed = await reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Amounts and references checked' });
    assert.equal(reviewed.status, 'finance_reviewed');

    const confirmed = await reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Confirmed for the period' });
    assert.equal(confirmed.status, 'management_confirmed');

    const approved = await reportsService.advance(h.ctx.director, report.id, 'approve', { note: 'Approved' });
    assert.equal(approved.status, 'approved');

    const sealed = await reportsService.advance(h.ctx.director, report.id, 'seal', { note: 'Sealed for the record' });
    assert.equal(sealed.status, 'sealed');
    assert.ok(sealed.sealManifest.manifestDigest);
    assert.equal(sealed.sealManifest.inputDigest, report.inputDigest);
    assert.deepEqual(sealed.decisions.map(d => d.stage), ['submit', 'review', 'confirm', 'approve', 'seal']);
    assert.deepEqual(sealed.decisions.map(d => d.actorRole),
      ['finance_preparer', 'reviewer', 'management', 'director', 'director']);
    assert.ok(sealed.decisions.every(d => d.appliesToCurrentInputs));
  } finally { await h.close(); }
});

test('stage order is enforced and terminal states are final', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    await checksService.run(h.ctx.preparer, h.caseId);
    const report = await reportsService.create(h.ctx.preparer, h.caseId, {});

    const tooEarly = await capture(() => reportsService.advance(h.ctx.director, report.id, 'approve', { note: 'Skipping ahead' }));
    assert.equal(tooEarly.status, 409);
    assert.match(tooEarly.message, /requires status management_confirmed/);

    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });
    const returned = await reportsService.reject(h.ctx.reviewer, report.id, { note: 'Clarify the allowance basis' });
    assert.equal(returned.status, 'rejected');
    assert.equal(returned.decisions.at(-1).decision, 'rejected');

    const afterReject = await capture(() => reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Ignoring the return' }));
    assert.equal(afterReject.status, 409);

    // Remediation: a new version is prepared and the rejected one stays on file.
    const next = await reportsService.create(h.ctx.preparer, h.caseId, {});
    assert.equal(next.version, report.version + 1);
    const all = await reportsService.list(h.ctx.preparer, h.caseId);
    assert.equal(all.length, 2);
    assert.ok(all.some(item => item.status === 'rejected'));
  } finally { await h.close(); }
});

test('a decision note is mandatory at every stage', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    await checksService.run(h.ctx.preparer, h.caseId);
    const report = await reportsService.create(h.ctx.preparer, h.caseId, {});
    for (const note of ['', '   ', undefined]) {
      const error = await capture(() => reportsService.advance(h.ctx.preparer, report.id, 'submit', { note }));
      assert.equal(error.status, 400, `note ${JSON.stringify(note)} is rejected`);
    }
  } finally { await h.close(); }
});

test('sealed reports are amended into a new version, never edited', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    await checksService.run(h.ctx.preparer, h.caseId);
    const report = await reportsService.create(h.ctx.preparer, h.caseId, {});
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });
    await reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Reviewed' });
    await reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Confirmed' });
    await reportsService.advance(h.ctx.director, report.id, 'approve', { note: 'Approved' });
    const sealed = await reportsService.advance(h.ctx.director, report.id, 'seal', { note: 'Sealed' });

    const reopened = await capture(() => reportsService.advance(h.ctx.reviewer, sealed.id, 'review', { note: 'Re-reviewing' }));
    assert.equal(reopened.status, 409);

    const amendment = await reportsService.create(h.ctx.preparer, h.caseId, { amendsReportId: sealed.id });
    assert.equal(amendment.amendsReportId, sealed.id);
    assert.equal(amendment.status, 'draft');
    assert.ok(amendment.version > sealed.version);

    // Only a sealed report may be amended.
    const notSealed = await capture(() => reportsService.create(h.ctx.preparer, h.caseId, { amendsReportId: amendment.id }));
    assert.equal(notSealed.status, 400);
    assert.match(notSealed.message, /Only a sealed report can be amended/);
  } finally { await h.close(); }
});

test('the exported package contains the report, evidence, rule results, approvals and a verifiable hash manifest', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    await checksService.run(h.ctx.preparer, h.caseId);
    const report = await reportsService.create(h.ctx.preparer, h.caseId, {});
    await reportsService.advance(h.ctx.preparer, report.id, 'submit', { note: 'Submitted' });
    await reportsService.advance(h.ctx.reviewer, report.id, 'review', { note: 'Reviewed' });
    await reportsService.advance(h.ctx.management, report.id, 'confirm', { note: 'Confirmed' });
    await reportsService.advance(h.ctx.director, report.id, 'approve', { note: 'Approved' });
    await reportsService.advance(h.ctx.director, report.id, 'seal', { note: 'Sealed' });

    const built = await exportService.buildPackage(h.ctx.director, h.caseId);
    const entries = zip.listEntries(built.archive);
    const names = entries.map(entry => entry.name);

    for (const expected of ['manifest.json', 'report.json', 'report.txt', 'rule-results.json', 'approvals.json', 'records.csv', 'evidence-index.json']) {
      assert.ok(names.includes(expected), `package contains ${expected}`);
    }
    // Six payslips plus the job advertisement evidence seeded for recruitment.
    assert.equal(names.filter(name => name.startsWith('evidence/')).length, 7, 'every evidence file in the case is included');
    assert.ok(names.some(name => /advertisement-payroll-specialist/.test(name)));
    assert.ok(entries.every(entry => entry.crcMatches), 'every archive entry passes its CRC check');

    // Manifest hashes must match the bytes actually stored in the archive.
    const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
    const { sha256, digest } = require('../server/lib/hash');
    for (const declared of manifest.entries) {
      const actual = entries.find(entry => entry.name === declared.name);
      assert.ok(actual, `manifest entry ${declared.name} exists in the archive`);
      assert.equal(sha256(actual.data), declared.sha256, `${declared.name} hash matches`);
      assert.equal(actual.data.length, declared.bytes);
    }
    assert.equal(digest(manifest.entries), manifest.manifestDigest);

    const approvals = JSON.parse(entries.find(entry => entry.name === 'approvals.json').data.toString('utf8'));
    assert.deepEqual(approvals.decisions.map(d => d.stage), ['submit', 'review', 'confirm', 'approve', 'seal']);
    assert.ok(approvals.decisions.every(d => d.appliesToExportedVersion));

    const index = JSON.parse(entries.find(entry => entry.name === 'evidence-index.json').data.toString('utf8'));
    assert.ok(index.every(item => item.storedByteIntegrity === 'verified-unchanged'));
    assert.ok(index.some(item => /requires manual review/i.test(item.contentVerification)));
    assert.ok(manifest.limitations.some(line => /statutory, tax or legal compliance determination/i.test(line)));
  } finally { await h.close(); }
});

test('the retained JSON and CSV exports reconcile with the stored records', async () => {
  const h = await harness();
  try {
    await resolveSeededFindings(h);
    await checksService.run(h.ctx.preparer, h.caseId);
    await reportsService.create(h.ctx.preparer, h.caseId, {});

    const payload = await exportService.evidenceJson(h.ctx.director, h.caseId);
    assert.equal(payload.format, 'people-ledger-evidence-v2');
    assert.equal(payload.records.length, 6);
    assert.equal(payload.reports.length, 1);
    assert.ok(payload.limitations.length >= 4);

    const core = require('../dist/demo/core.js');
    const csv = await exportService.recordsCsv(h.ctx.director, h.caseId);
    const parsed = core.parseCSV(csv);
    assert.equal(parsed.length, 6);
    assert.equal(
      core.totals(parsed).expected,
      payload.records.reduce((total, row) => total + core.cents(row.expectedNet), 0)
    );
  } finally { await h.close(); }
});
