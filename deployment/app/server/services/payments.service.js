/* Payment ledger import.
 *
 * Preview and import share one validation pass, so what a preparer is shown is
 * exactly what would be written. Import is atomic: any rejected row aborts the
 * whole file and leaves the ledger unchanged. Re-submitting a file that has
 * already been imported is refused rather than silently duplicated. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const { sha256 } = require('../lib/hash');
const money = require('../lib/money');
const csv = require('../lib/csv');
const validate = require('../lib/validate');
const { badRequest, conflict } = require('../lib/errors');
const access = require('../auth/access');
const cases = require('./cases.service');
const records = require('./records.service');
const audit = require('./audit.service');

const ledgerSource = require('./ledger-source');
const HEADERS = ['employeeNo', 'period', 'amount', 'paymentRef', 'paidAt'];

const monthOf = isoDate => String(isoDate || '').slice(0, 7);

function nextMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Validates one untrusted CSV row. Errors are collected, not thrown, so the
 *  preview can show every problem in the file at once. */
function readRow(raw, casePeriod) {
  const errors = [];
  const row = { line: raw.__line };
  const attempt = (label, fn) => { try { return fn(); } catch (error) { errors.push(`Row ${raw.__line} ${label}: ${error.message}`); return null; } };

  row.general = !!raw.general; row.source = raw.source || null;
  row.employeeNo = raw.general ? null : attempt('employeeNo', () => validate.text(raw.employeeNo, 'employeeNo', { max: 40, pattern: /^[A-Za-z0-9_-]{1,40}$/ }));
  row.period = attempt('period', () => validate.period(raw.period, 'period'));
  row.amountCents = attempt('amount', () => money.toCents(raw.amount, 'amount'));
  row.paymentRef = attempt('paymentRef', () => validate.text(raw.paymentRef, 'paymentRef', { max: 120 }));
  row.paidAt = attempt('paidAt', () => validate.isoTimestamp(raw.paidAt, 'paidAt'));

  // Period validation: the row must belong to the period under review, and the
  // value date must fall in that month or the month after it.
  if (row.period && row.period !== casePeriod) {
    errors.push(`Row ${raw.__line}: period ${row.period} does not match the case review period ${casePeriod}`);
  }
  if (row.paidAt && row.period) {
    const month = monthOf(row.paidAt);
    if (month !== row.period && month !== nextMonth(row.period)) {
      errors.push(`Row ${raw.__line}: paidAt ${month} is outside the accepted window for period ${row.period} (${row.period} or ${nextMonth(row.period)})`);
    }
  }
  if (row.amountCents === 0) errors.push(`Row ${raw.__line}: amount must be greater than zero`);
  return { row, errors };
}

/**
 * One validation pass over an import source.
 * @param {object|string} input a csv.requestSource result, or raw CSV text
 */
async function analyse(store, caseRecord, input) {
  const source = typeof input === 'string' ? { text: input, bytes: Buffer.from(input, 'utf8'), worksheet: null } : input;
  const read = await ledgerSource.paymentTable(store, caseRecord.id, source, HEADERS);
  const errors = [];
  const rows = [];
  for (const raw of read.rows) {
    const { row, errors: rowErrors } = readRow(raw, caseRecord.period);
    errors.push(...rowErrors);
    if (!rowErrors.length) rows.push(row);
  }

  // Identical lines inside one file are a file-preparation defect, not a finding.
  const seenInFile = new Map();
  for (const row of rows) {
    const key = `${row.employeeNo}|${row.period}|${row.paymentRef}`;
    if (seenInFile.has(key)) {
      errors.push(`Row ${row.line}: duplicates row ${seenInFile.get(key)} (same employee, period and payment reference)`);
    } else seenInFile.set(key, row.line);
  }

  const existing = await store.find('payments', { case_id: caseRecord.id });
  const existingKeys = new Set(existing.map(p => `${p.employee_no}|${p.period}|${p.payment_ref}`));
  const alreadyImported = rows.filter(row => existingKeys.has(`${row.employeeNo}|${row.period}|${row.paymentRef}`));
  for (const row of alreadyImported) {
    errors.push(`Row ${row.line}: payment ${row.paymentRef} for ${row.employeeNo} ${row.period} is already recorded in this case`);
  }

  // Detections that are reported but do not block the import: the rule engine
  // raises them as findings so a person decides.
  const payrollRows = await records.rawList(store, caseRecord.id);
  const payrollByEmployee = new Map(payrollRows.map(r => [r.employee_no, r]));
  const evidence = (await store.find('evidence_files', { case_id: caseRecord.id })).filter(f => !f.superseded_by);
  const evidenceRefs = new Set(evidence.filter(f => f.subject_type === 'payment_reference').map(f => f.subject_id));

  const perEmployee = new Map();
  for (const row of rows.filter(r => !r.general)) {
    const key = `${row.employeeNo}|${row.period}`;
    if (!perEmployee.has(key)) perEmployee.set(key, []);
    perEmployee.get(key).push(row);
  }
  for (const payment of existing) {
    const key = `${payment.employee_no}|${payment.period}`;
    if (!perEmployee.has(key)) perEmployee.set(key, []);
    perEmployee.get(key).push({ employeeNo: payment.employee_no, period: payment.period, amountCents: payment.amount_cents, paymentRef: payment.payment_ref, existing: true });
  }

  const duplicateWarnings = [];
  const reconciliationWarnings = [];
  for (const [key, group] of perEmployee) {
    const [employeeNo, period] = key.split('|');
    if (group.length > 1) {
      duplicateWarnings.push({
        employeeNo, period, count: group.length,
        references: group.map(g => g.paymentRef),
        totalAmount: money.toAmount(money.sum(group.map(g => g.amountCents))),
        detail: 'More than one payment exists for this employee and period. Rule PAY-003 will report this for human review.'
      });
    }
    const payroll = payrollByEmployee.get(employeeNo);
    if (!payroll) {
      reconciliationWarnings.push({ employeeNo, period, detail: 'No payroll record exists for this employee in this case (rule PAY-005).' });
      continue;
    }
    const total = money.sum(group.map(g => g.amountCents));
    if (total !== payroll.net_paid_cents) {
      reconciliationWarnings.push({
        employeeNo, period,
        paymentsTotal: money.toAmount(total),
        recordedPaid: money.toAmount(payroll.net_paid_cents),
        difference: money.toAmount(total - payroll.net_paid_cents),
        detail: 'Imported payments do not equal the recorded paid amount (rule PAY-004).'
      });
    }
  }

  const missingEvidence = rows
    .filter(row => !evidenceRefs.has(row.paymentRef))
    .map(row => ({ employeeNo: row.employeeNo, paymentRef: row.paymentRef, detail: 'No uploaded evidence file is linked to this payment reference (rule DOC-002).' }));

  return {
    rows,
    sourceRows: read.sourceRows || read.rows,
    errors,
    format: read.format,
    worksheet: read.worksheet,
    worksheets: read.worksheets,
    digest: sha256(source.bytes),
    rowCount: rows.length,
    totalCents: money.sum(rows.map(row => row.amountCents)),
    duplicateWarnings,
    reconciliationWarnings,
    missingEvidence
  };
}

function previewView(analysis, caseRecord) {
  return {
    caseId: caseRecord.id,
    casePeriod: caseRecord.period,
    headers: HEADERS,
    sourceFormat: analysis.format,
    worksheet: analysis.worksheet,
    worksheets: analysis.worksheets,
    rowCount: analysis.rowCount,
    totalAmount: money.toAmount(analysis.totalCents),
    acceptable: analysis.errors.length === 0,
    errors: analysis.errors,
    ledgerSummary: { payroll: analysis.rows.filter(r => !r.general).length, general: analysis.rows.filter(r => r.general).length },
    sample: analysis.rows.slice(0, 10).map(row => ({
      employeeNo: row.employeeNo || row.source?.category, period: row.period,
      amount: money.toAmount(row.amountCents), paymentRef: row.paymentRef, paidAt: row.paidAt
    })),
    duplicatePayments: analysis.duplicateWarnings,
    reconciliation: analysis.reconciliationWarnings,
    missingEvidence: analysis.missingEvidence,
    fileDigest: analysis.digest,
    note: 'Preview only. Nothing has been written. Import is all-or-nothing.'
  };
}

async function preview(ctx, caseId, input) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'payments.preview');
  const body = validate.only(input, ['csv', 'workbookBase64', 'worksheet', 'filename'], 'Payment preview');
  const analysis = await analyse(ctx.store, caseRecord, csv.requestSource(body));
  const existingBatch = await ctx.store.findOne('payment_batches', { digest: analysis.digest });
  const result = previewView(analysis, caseRecord);
  if (existingBatch) {
    result.acceptable = false;
    result.alreadyImportedBatchId = existingBatch.id;
    result.errors = [`This exact file was already imported as batch ${existingBatch.id} on ${existingBatch.created_at}`, ...result.errors];
  }
  return result;
}

async function importBatch(ctx, caseId, input) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'payments.import');
  const body = validate.only(input, ['csv', 'workbookBase64', 'worksheet', 'filename', 'expectedDigest'], 'Payment import');
  const filename = validate.filename(body.filename || 'payments.csv');
  const analysis = await analyse(ctx.store, caseRecord, csv.requestSource(body));

  // The preparer confirms the exact file they previewed.
  if (body.expectedDigest && body.expectedDigest !== analysis.digest) {
    throw conflict('The file changed after the preview. Preview again before importing.', { previewed: body.expectedDigest, received: analysis.digest });
  }
  // Checked before row validation so a repeated submission of a file that was
  // already accepted is reported as a duplicate request, not as invalid content.
  const duplicateFile = await ctx.store.findOne('payment_batches', { digest: analysis.digest });
  if (duplicateFile) {
    throw conflict('This payment file has already been imported', { batchId: duplicateFile.id, importedAt: duplicateFile.created_at });
  }
  if (analysis.errors.length) {
    throw badRequest('The payment file was rejected. No rows were imported.', { errors: analysis.errors.slice(0, 30), rejectedRows: analysis.errors.length });
  }

  const now = clock.now();
  const result = await ctx.store.tx(async store => {
    const batch = await store.insert('payment_batches', {
      id: id('bat'),
      case_id: caseId,
      filename,
      row_count: analysis.rowCount,
      total_cents: analysis.totalCents,
      status: 'imported',
      digest: analysis.digest,
      source_rows: analysis.sourceRows,
      created_at: now,
      created_by: ctx.actor.id
    });
    const inserted = [];
    for (const row of analysis.rows) {
      if (row.general) {
        inserted.push(await store.insert('ledger_entries', {
          id: id('led'), case_id: caseId, batch_id: batch.id, source_id: row.source.id,
          period: row.period, direction: row.source.type === 'income' ? 'in' : 'out',
          category: row.source.category, department: row.source.department,
          cost_center: row.source.costCenter, amount_cents: row.amountCents,
          reference: row.paymentRef, evidence_ref: row.source.evidence,
          description: row.source.description, value_date: row.paidAt,
          created_at: now, created_by: ctx.actor.id
        }));
        continue;
      }
      inserted.push(await store.insert('payments', {
        id: id('pay'),
        case_id: caseId,
        batch_id: batch.id,
        employee_no: row.employeeNo,
        period: row.period,
        amount_cents: row.amountCents,
        payment_ref: row.paymentRef,
        paid_at: row.paidAt,
        created_at: now,
        created_by: ctx.actor.id
      }));
    }
    const updatedCase = await cases.bumpRevision(store, caseId);
    return { batch, payments: inserted, dataRevision: updatedCase.data_revision };
  });

  await audit.record(ctx, 'payments.imported', {
    caseId, subjectType: 'payment_batch', subjectId: result.batch.id,
    detail: {
      filename, sourceFormat: analysis.format, worksheet: analysis.worksheet,
      rowCount: analysis.rowCount, totalAmount: money.toAmount(analysis.totalCents),
      fileDigest: analysis.digest, dataRevision: result.dataRevision,
      duplicateDetections: analysis.duplicateWarnings.length,
      reconciliationDetections: analysis.reconciliationWarnings.length
    }
  });

  return {
    batchId: result.batch.id,
    caseId,
    rowCount: analysis.rowCount,
    totalAmount: money.toAmount(analysis.totalCents),
    dataRevision: result.dataRevision,
    duplicatePayments: analysis.duplicateWarnings,
    reconciliation: analysis.reconciliationWarnings,
    missingEvidence: analysis.missingEvidence,
    note: 'Imported. Run checks again so the report reflects the new payment ledger.'
  };
}

async function list(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'records.read');
  const [batches, payments] = await Promise.all([
    ctx.store.find('payment_batches', { case_id: caseId }, { order: [['created_at', 'desc']] }),
    ledgerSource.allPayments(ctx.store, caseId)
  ]);
  return {
    caseId,
    batches: batches.map(b => ({
      id: b.id, filename: b.filename, rowCount: b.row_count,
      totalAmount: money.toAmount(b.total_cents), status: b.status,
      digest: b.digest, createdAt: b.created_at, createdBy: b.created_by
    })),
    payments: payments.map(p => ({
      id: p.id, batchId: p.batch_id, employeeNo: p.employee_no || p.category, direction: p.direction || 'out', category: p.category || 'payroll', period: p.period,
      amount: money.toAmount(p.amount_cents), paymentRef: p.payment_ref, paidAt: p.paid_at
    })),
    income: money.toAmount(money.sum(payments.filter(p => p.direction === 'in').map(p => p.amount_cents))),
    expense: money.toAmount(money.sum(payments.filter(p => p.direction !== 'in').map(p => p.amount_cents))),
    totalAmount: money.toAmount(money.sum(payments.map(p => p.amount_cents)))
  };
}

const template = () => csv.write(HEADERS, [
  { employeeNo: 'EMP-001', period: '2026-09', amount: '7000.00', paymentRef: 'PAY-202609-001', paidAt: '2026-09-28T09:00:00.000Z' }
]);

module.exports = { HEADERS, preview, importBatch, list, template, analyse };
