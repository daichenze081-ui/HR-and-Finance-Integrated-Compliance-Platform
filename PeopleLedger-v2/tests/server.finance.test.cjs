/* Payment CSV preview and atomic import, duplicate-payment detection, period
 * validation, missing-evidence detection, and evidence upload/versioning/download. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, capture } = require('./helpers.cjs');

const paymentsService = require('../server/services/payments.service');
const evidenceService = require('../server/services/evidence.service');
const checksService = require('../server/services/checks.service');
const recordsService = require('../server/services/records.service');
const csv = require('../server/lib/csv');
const money = require('../server/lib/money');

const HEADERS = paymentsService.HEADERS;
const row = (employeeNo, amount, ref, paidAt = '2026-09-28T09:00:00.000Z', period = '2026-09') =>
  ({ employeeNo, period, amount, paymentRef: ref, paidAt });

const file = rows => csv.write(HEADERS, rows);

const MATCHING = [
  row('EMP-001', '7000.00', 'PAY-202609-001'),
  row('EMP-002', '6000.00', 'PAY-202609-002'),
  row('EMP-003', '4950.00', 'PAY-202609-003'),
  row('EMP-004', '5100.00', 'PAY-202609-004'),
  row('EMP-005', '6450.00', 'PAY-202609-005'),
  row('EMP-006', '5600.00', 'PAY-202609-006')
];

test('the payment template parses with the declared headers', async () => {
  const parsed = csv.parse(paymentsService.template(), HEADERS);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].employeeNo, 'EMP-001');
});

test('preview reports detections without writing, then import writes atomically', async () => {
  const h = await harness();
  try {
    const content = file(MATCHING);
    const preview = await paymentsService.preview(h.ctx.preparer, h.caseId, { csv: content });
    assert.equal(preview.acceptable, true);
    assert.equal(preview.rowCount, 6);
    assert.equal(preview.totalAmount, '35100.00');
    assert.equal(preview.sample.length, 6);
    // EMP-003 is still paid 4750.00 in the seeded records, so the ledger disagrees.
    assert.ok(preview.reconciliation.some(item => item.employeeNo === 'EMP-003' && item.difference === '200.00'));
    // No evidence file is linked to any payment reference yet.
    assert.equal(preview.missingEvidence.length, 6);
    assert.equal((await paymentsService.list(h.ctx.preparer, h.caseId)).payments.length, 0, 'preview wrote nothing');

    const imported = await paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: content, filename: 'payments.csv', expectedDigest: preview.fileDigest
    });
    assert.equal(imported.rowCount, 6);
    assert.equal(imported.totalAmount, '35100.00');

    const ledger = await paymentsService.list(h.ctx.preparer, h.caseId);
    assert.equal(ledger.payments.length, 6);
    assert.equal(ledger.totalAmount, '35100.00');
    assert.equal(ledger.batches.length, 1);
    assert.equal(ledger.batches[0].digest, preview.fileDigest);
  } finally { await h.close(); }
});

test('a single invalid row rejects the whole file and the ledger is unchanged', async () => {
  const h = await harness();
  try {
    await paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: file(MATCHING.slice(0, 2)), filename: 'first.csv' });
    const before = await paymentsService.list(h.ctx.preparer, h.caseId);

    const broken = [row('EMP-003', '4950.00', 'PAY-202609-003'), row('EMP-004', '1.234', 'PAY-202609-004')];
    const error = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: file(broken), filename: 'broken.csv' }));
    assert.equal(error.status, 400);
    assert.match(error.message, /No rows were imported/);
    assert.ok(error.detail.errors.some(message => /two decimal places/i.test(message)));

    const after = await paymentsService.list(h.ctx.preparer, h.caseId);
    assert.deepEqual(after.payments.map(p => p.id), before.payments.map(p => p.id));
    assert.equal(after.batches.length, 1);
  } finally { await h.close(); }
});

test('period validation rejects rows outside the case period and value dates outside the window', async () => {
  const h = await harness();
  try {
    const wrongPeriod = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'PAY-X', '2026-08-28T09:00:00.000Z', '2026-08')]), filename: 'p.csv'
    }));
    assert.equal(wrongPeriod.status, 400);
    assert.ok(wrongPeriod.detail.errors.some(message => /does not match the case review period 2026-09/.test(message)));

    const lateValueDate = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'PAY-X', '2026-12-01T09:00:00.000Z')]), filename: 'p.csv'
    }));
    assert.equal(lateValueDate.status, 400);
    assert.ok(lateValueDate.detail.errors.some(message => /outside the accepted window/.test(message)));

    // The month after the period is accepted.
    const accepted = await paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'PAY-OK', '2026-10-02T09:00:00.000Z')]), filename: 'p.csv'
    });
    assert.equal(accepted.rowCount, 1);
  } finally { await h.close(); }
});

test('duplicate submissions are refused and duplicate payments are detected', async () => {
  const h = await harness();
  try {
    const content = file(MATCHING);
    await paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: content, filename: 'payments.csv' });

    // Same file again: refused as an already-imported batch.
    const sameFile = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: content, filename: 'payments.csv' }));
    assert.equal(sameFile.status, 409);
    assert.match(sameFile.message, /already been imported/);

    // Same employee, period and reference in a new file: refused as already recorded.
    const repeated = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'PAY-202609-001')]), filename: 'again.csv'
    }));
    assert.equal(repeated.status, 400);
    assert.ok(repeated.detail.errors.some(message => /already recorded in this case/.test(message)));

    // Identical lines inside one file are refused.
    const inFile = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-002', '1.00', 'DUP-1'), row('EMP-002', '1.00', 'DUP-1')]), filename: 'dup.csv'
    }));
    assert.equal(inFile.status, 400);
    assert.ok(inFile.detail.errors.some(message => /duplicates row/.test(message)));

    // A second, differently referenced payment for the same period is accepted and
    // then reported by the rule engine as a duplicate payment for human review.
    const second = await paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'PAY-202609-001-B')]), filename: 'second.csv'
    });
    assert.ok(second.duplicatePayments.some(item => item.employeeNo === 'EMP-001' && item.count === 2));

    const check = await checksService.run(h.ctx.preparer, h.caseId);
    const duplicate = check.issues.find(issue => issue.rule === 'PAY-003' && issue.recordId === 'EMP-001');
    assert.ok(duplicate, 'PAY-003 reports the duplicate payment');
    assert.match(duplicate.detail, /2 payments were imported/);
    const reconcile = check.issues.find(issue => issue.rule === 'PAY-004' && issue.recordId === 'EMP-001');
    assert.ok(reconcile, 'PAY-004 reports the reconciliation difference');
    assert.match(reconcile.detail, /14000\.00/);
  } finally { await h.close(); }
});

test('a payment reference reused across employees is reported', async () => {
  const h = await harness();
  try {
    await paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-001', '7000.00', 'SHARED-REF'), row('EMP-002', '6000.00', 'SHARED-REF')]), filename: 'shared.csv'
    });
    const check = await checksService.run(h.ctx.preparer, h.caseId);
    const reused = check.issues.find(issue => issue.rule === 'PAY-003' && /reference reused/i.test(issue.title));
    assert.ok(reused);
    assert.match(reused.detail, /EMP-001, EMP-002/);
  } finally { await h.close(); }
});

test('a payment for an unknown employee is reported', async () => {
  const h = await harness();
  try {
    await paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file([row('EMP-999', '100.00', 'GHOST-1')]), filename: 'ghost.csv'
    });
    const check = await checksService.run(h.ctx.preparer, h.caseId);
    const orphan = check.issues.find(issue => issue.rule === 'PAY-005');
    assert.ok(orphan);
    assert.equal(orphan.recordId, 'EMP-999');
  } finally { await h.close(); }
});

test('a changed file after preview is refused', async () => {
  const h = await harness();
  try {
    const preview = await paymentsService.preview(h.ctx.preparer, h.caseId, { csv: file(MATCHING) });
    const error = await capture(() => paymentsService.importBatch(h.ctx.preparer, h.caseId, {
      csv: file(MATCHING.slice(0, 3)), filename: 'payments.csv', expectedDigest: preview.fileDigest
    }));
    assert.equal(error.status, 409);
    assert.match(error.message, /changed after the preview/);
  } finally { await h.close(); }
});

test('importing payments makes the previous check stale', async () => {
  const h = await harness();
  try {
    await checksService.run(h.ctx.preparer, h.caseId);
    assert.equal((await checksService.latest(h.ctx.preparer, h.caseId)).current, true);
    await paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: file(MATCHING), filename: 'payments.csv' });
    const latest = await checksService.latest(h.ctx.preparer, h.caseId);
    assert.equal(latest.current, false);
    assert.match(latest.check.staleReason, /Data has changed/);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test('an uploaded file records source, uploader, timestamp, version and SHA-256', async () => {
  const h = await harness();
  try {
    const bytes = Buffer.from('DEMO bank statement extract, synthetic.', 'utf8');
    const result = await evidenceService.upload(h.ctx.preparer, h.caseId, {
      filename: 'bank-2026-09.txt',
      subjectType: 'payment_reference',
      subjectId: 'PAY-202609-001',
      source: 'bank_statement',
      mediaType: 'text/plain'
    }, bytes);

    const file_ = result.file;
    assert.equal(file_.version, 1);
    assert.equal(file_.source, 'bank_statement');
    assert.equal(file_.uploadedBy, h.users.preparer.id);
    assert.ok(file_.uploadedAt);
    assert.equal(file_.sizeBytes, bytes.length);
    assert.equal(file_.sha256, require('../server/lib/hash').sha256(bytes));
    assert.equal(file_.readable, true);
    assert.equal(file_.reviewRequired, false);
    assert.match(file_.verificationStatus, /not authenticated/);

    const downloaded = await evidenceService.download(h.ctx.reviewer, file_.id);
    assert.equal(downloaded.buffer.toString('utf8'), bytes.toString('utf8'));
  } finally { await h.close(); }
});

test('re-uploading the same document creates a new version and supersedes the old one', async () => {
  const h = await harness();
  try {
    // A document name the seed does not already use, so version 1 is genuinely new.
    const meta = { filename: 'corrected-payslip-EMP-004.txt', subjectType: 'payroll_record', subjectId: 'EMP-004', source: 'payroll_system_export', mediaType: 'text/plain' };
    const first = await evidenceService.upload(h.ctx.hr, h.caseId, meta, Buffer.from('version one', 'utf8'));
    const second = await evidenceService.upload(h.ctx.hr, h.caseId, meta, Buffer.from('version two', 'utf8'));

    assert.equal(first.file.version, 1);
    assert.equal(second.file.version, 2);
    assert.notEqual(first.file.sha256, second.file.sha256);

    const reloaded = await evidenceService.get(h.ctx.hr, first.file.id);
    assert.equal(reloaded.supersededBy, second.file.id, 'the previous version is marked, not deleted');
    // The superseded object is still retrievable and still hashes correctly.
    const old = await evidenceService.download(h.ctx.hr, first.file.id);
    assert.equal(old.buffer.toString('utf8'), 'version one');
  } finally { await h.close(); }
});

test('identical content for the same subject is not stored twice', async () => {
  const h = await harness();
  try {
    const meta = { filename: 'note.txt', subjectType: 'case', subjectId: h.caseId, source: 'other', mediaType: 'text/plain' };
    const bytes = Buffer.from('same bytes', 'utf8');
    const first = await evidenceService.upload(h.ctx.hr, h.caseId, meta, bytes);
    const second = await evidenceService.upload(h.ctx.hr, h.caseId, meta, bytes);
    assert.equal(second.duplicate, true);
    assert.equal(second.file.id, first.file.id);
    assert.equal(second.file.version, 1);
  } finally { await h.close(); }
});

test('content that cannot be read is marked for manual review, not verified', async () => {
  const h = await harness();
  try {
    const pdf = await evidenceService.upload(h.ctx.hr, h.caseId, {
      filename: 'scan.pdf', subjectType: 'payroll_record', subjectId: 'EMP-004', source: 'upload', mediaType: 'application/pdf'
    }, Buffer.from('%PDF-1.7\n... binary ...', 'latin1'));
    assert.equal(pdf.file.readable, false);
    assert.equal(pdf.file.reviewRequired, true);
    assert.match(pdf.file.reviewReason, /OCR and document parsing are out of scope/);
    assert.equal(pdf.file.verificationStatus, 'requires manual review');

    const notPdf = evidenceService.assessReadability(Buffer.from('not a pdf'), 'application/pdf');
    assert.equal(notPdf.readable, 0);
    assert.match(notPdf.reason, /header is not %PDF-/);

    const empty = evidenceService.assessReadability(Buffer.alloc(0), 'text/plain');
    assert.equal(empty.readable, 0);

    const nullBytes = evidenceService.assessReadability(Buffer.from('a\u0000b', 'utf8'), 'text/plain');
    assert.equal(nullBytes.readable, 0);
  } finally { await h.close(); }
});

test('uploads are bounded and unsupported metadata is refused', async () => {
  const h = await harness();
  try {
    const base = { filename: 'x.txt', subjectType: 'case', subjectId: h.caseId, source: 'other', mediaType: 'text/plain' };
    const tooBig = await capture(() => evidenceService.upload(h.ctx.hr, h.caseId, base, Buffer.alloc(require('../server/config').evidence.maxBytes + 1)));
    assert.equal(tooBig.status, 413);

    const empty = await capture(() => evidenceService.upload(h.ctx.hr, h.caseId, base, Buffer.alloc(0)));
    assert.equal(empty.status, 400);

    const badSubject = await capture(() => evidenceService.upload(h.ctx.hr, h.caseId, { ...base, subjectType: 'anything' }, Buffer.from('x')));
    assert.equal(badSubject.status, 400);

    const badType = await capture(() => evidenceService.upload(h.ctx.hr, h.caseId, { ...base, mediaType: 'application/x-msdownload' }, Buffer.from('x')));
    assert.equal(badType.status, 400);

    // A path in the file name is reduced to its base name.
    const traversal = await evidenceService.upload(h.ctx.hr, h.caseId, { ...base, filename: '../../etc/passwd' }, Buffer.from('safe'));
    assert.equal(traversal.file.filename, 'passwd');
  } finally { await h.close(); }
});

test('attaching an evidence file clears the missing-evidence finding', async () => {
  const h = await harness();
  try {
    // Remove the seeded payslip for EMP-004 by superseding is not possible, so use a
    // fresh case with no evidence at all.
    const casesService = require('../server/services/cases.service');
    const access = require('../server/auth/access');
    const fresh = await casesService.create(h.ctx.admin, { title: 'Bare case', period: '2026-09' });
    await access.grant(h.ctx.director, { caseId: fresh.id, userId: h.users.hr.id, caseRole: 'hr' });
    await access.grant(h.ctx.director, { caseId: fresh.id, userId: h.users.preparer.id, caseRole: 'finance_preparer' });

    const core = require('../dist/demo/core.js');
    await recordsService.replaceAll(h.ctx.hr, fresh.id, { rows: [core.normalizeRows(core.SAMPLE)[0]], note: 'Single record' });

    let check = await checksService.run(h.ctx.preparer, fresh.id);
    assert.ok(check.issues.some(issue => issue.rule === 'DOC-002' && issue.recordId === 'EMP-001'));

    await evidenceService.upload(h.ctx.hr, fresh.id, {
      filename: 'payslip.txt', subjectType: 'payroll_record', subjectId: 'EMP-001', source: 'payroll_system_export', mediaType: 'text/plain'
    }, Buffer.from('DEMO payslip for EMP-001', 'utf8'));

    check = await checksService.run(h.ctx.preparer, fresh.id);
    assert.ok(!check.issues.some(issue => issue.rule === 'DOC-002'));
    assert.equal(check.blockingCount, 0);
  } finally { await h.close(); }
});

test('server totals are exact integer cents and reconcile with the records', async () => {
  const h = await harness();
  try {
    const listing = await recordsService.list(h.ctx.preparer, h.caseId);
    const expected = listing.records.reduce((total, record) => total + money.toCents(record.expectedNet), 0);
    assert.equal(listing.totals.expected, expected);
    assert.ok(Object.values(listing.totals).every(Number.isSafeInteger), 'totals are integer cents');
    assert.equal(money.toAmount(listing.totals.gross), '43800.00');
    assert.equal(money.toAmount(listing.totals.deductions), '8700.00');
    assert.equal(money.toAmount(listing.totals.expected), '35100.00');
    assert.equal(money.toAmount(listing.totals.paid), '34900.00');

    // The server agrees with the browser core engine to the cent.
    const core = require('../dist/demo/core.js');
    assert.deepEqual(listing.totals, core.totals(core.normalizeRows(core.SAMPLE)));
  } finally { await h.close(); }
});
