/* Third-party bank statement import and three-way reconciliation.
 *
 * A bank statement is external evidence, so it is kept apart from "payments",
 * which is the organisation's own ledger. Reconciliation compares the two and,
 * through the payroll records, closes the third side of the triangle:
 *
 *     payroll record  --(recorded paid)-->  payment ledger  --(reference)-->  bank
 *
 * Matching is exact and one-to-one on reference, amount in integer cents and
 * direction. Nothing is inferred from dates, near amounts or similar names, so a
 * match is either provable or it is not claimed:
 *
 *   matched    exactly one ledger row and exactly one bank row share the key
 *   ambiguous  the key is not unique on one or both sides; a person must decide
 *   unmatched  no counterpart exists at all
 *
 * Import follows the payment-ledger pattern exactly: one validation pass shared by
 * preview and confirm, a content digest that makes a repeated submission of the
 * same file detectable, and an all-or-nothing write. A rejected row leaves the
 * stored statement byte-identical to before the attempt. */
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
const HEADERS = ['txnRef', 'valueDate', 'direction', 'amount', 'counterparty', 'description'];
const DIRECTIONS = ['in', 'out'];
const MAX_ROWS = 1000;

const METHOD =
  'Exact match on reference, amount in integer SGD cents and direction, accepted only when the key identifies '
  + 'exactly one ledger row and exactly one bank row. Dates, similar amounts and counterparty names are never used '
  + 'to infer a match; they are retained for human review.';

const monthOf = value => String(value || '').slice(0, 7);

function nextMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

/** Validates one untrusted row. Errors are collected, not thrown, so the preview
 *  shows every problem in the file at once. */
function readRow(raw, casePeriod) {
  const errors = [];
  const row = { line: raw.__line };
  const attempt = (label, fn) => {
    try { return fn(); } catch (error) { errors.push(`Row ${raw.__line} ${label}: ${error.message}`); return null; }
  };

  row.txnRef = attempt('txnRef', () => validate.text(raw.txnRef, 'txnRef', { max: 120 }));
  row.direction = attempt('direction', () => validate.oneOf(String(raw.direction || '').trim().toLowerCase(), DIRECTIONS, 'direction'));
  row.amountCents = attempt('amount', () => money.toCents(raw.amount, 'amount'));
  row.counterparty = attempt('counterparty', () => validate.optionalText(raw.counterparty, 'counterparty', { max: 160 }));
  row.description = attempt('description', () => validate.optionalText(raw.description, 'description', { max: 400 }));

  // A workbook cell formatted as a date arrives as an ISO timestamp; accept both
  // that and a plain date, and store the calendar date.
  const rawDate = String(raw.valueDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(rawDate) || Number.isNaN(Date.parse(rawDate.slice(0, 10)))) {
    errors.push(`Row ${raw.__line} valueDate: use a valid YYYY-MM-DD date`);
  } else {
    row.valueDate = rawDate.slice(0, 10);
  }

  // The statement must cover the period under review. A payment made at the end of
  // the month can clear in the month after it, which is accepted and visible.
  if (row.valueDate) {
    const month = monthOf(row.valueDate);
    if (month !== casePeriod && month !== nextMonth(casePeriod)) {
      errors.push(`Row ${raw.__line}: valueDate ${month} is outside the accepted window for the review period ${casePeriod} (${casePeriod} or ${nextMonth(casePeriod)})`);
    }
  }
  if (row.amountCents === 0) errors.push(`Row ${raw.__line}: amount must be greater than zero`);
  return { row, errors };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const keyOf = (reference, amountCents, direction) => `${String(reference || '').trim()}|${amountCents}|${direction}`;

const group = (list, key) => list.reduce((map, item) => {
  const k = key(item);
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(item);
  return map;
}, new Map());

/**
 * Pure, deterministic reconciliation. No database access, no clock, no model: the
 * same three inputs always produce the same output, which is what allows the
 * result to be stamped with a data revision and later shown to be stale.
 *
 * @param {object} input
 * @param {Array} input.payments      payment ledger rows (database shape)
 * @param {Array} input.bank          bank transaction rows (database shape)
 * @param {Array} input.payrollRows   payroll rows (database shape)
 * @returns {object} matched / unmatched / ambiguous views plus the three-way check
 */
function reconcile({ payments = [], bank = [], payrollRows = [] } = {}) {
  // A ledger payment is money leaving the organisation.
  const ledger = payments.map(payment => ({
    paymentId: payment.id,
    employeeNo: payment.employee_no,
    period: payment.period,
    reference: payment.payment_ref,
    amountCents: payment.amount_cents,
    direction: payment.direction || 'out',
    paidAt: payment.paid_at
  }));
  const statement = bank.map(transaction => ({
    bankId: transaction.id,
    reference: transaction.txn_ref,
    amountCents: transaction.amount_cents,
    direction: transaction.direction,
    valueDate: transaction.value_date,
    counterparty: transaction.counterparty || '',
    description: transaction.description || ''
  }));

  const ledgerByKey = group(ledger, row => keyOf(row.reference, row.amountCents, row.direction));
  const bankByKey = group(statement, row => keyOf(row.reference, row.amountCents, row.direction));

  const statusFor = (reference, amountCents, direction) => {
    if (!String(reference || '').trim()) return { status: 'unmatched', reason: 'The row carries no reference, so no exact match can be established.' };
    const key = keyOf(reference, amountCents, direction);
    const ledgerSide = ledgerByKey.get(key) || [];
    const bankSide = bankByKey.get(key) || [];
    if (!ledgerSide.length || !bankSide.length) return { status: 'unmatched', reason: 'No counterpart shares this reference, amount and direction.', ledgerSide, bankSide };
    if (ledgerSide.length > 1 || bankSide.length > 1) {
      return {
        status: 'ambiguous',
        reason: `The key is not unique: ${ledgerSide.length} ledger row(s) and ${bankSide.length} bank row(s) share this reference, amount and direction.`,
        ledgerSide,
        bankSide
      };
    }
    return { status: 'matched', reason: 'One ledger row and one bank row share this reference, amount and direction.', ledgerSide, bankSide };
  };

  const ledgerRows = ledger.map(row => {
    const verdict = statusFor(row.reference, row.amountCents, row.direction);
    return {
      paymentId: row.paymentId,
      employeeNo: row.employeeNo,
      period: row.period,
      reference: row.reference,
      amount: money.toAmount(row.amountCents),
      amountCents: row.amountCents,
      direction: row.direction,
      paidAt: row.paidAt,
      status: verdict.status,
      detail: verdict.reason,
      bankIds: (verdict.bankSide || []).map(entry => entry.bankId),
      bankRefs: [...new Set((verdict.bankSide || []).map(entry => entry.reference))]
    };
  });

  const bankRows = statement.map(row => {
    const verdict = statusFor(row.reference, row.amountCents, row.direction);
    return {
      bankId: row.bankId,
      reference: row.reference,
      amount: money.toAmount(row.amountCents),
      amountCents: row.amountCents,
      direction: row.direction,
      valueDate: row.valueDate,
      counterparty: row.counterparty,
      description: row.description,
      status: verdict.status,
      detail: verdict.reason,
      paymentIds: (verdict.ledgerSide || []).map(entry => entry.paymentId),
      employeeNos: [...new Set((verdict.ledgerSide || []).map(entry => entry.employeeNo))]
    };
  });

  const pick = (rows, status) => rows.filter(row => row.status === status);

  /* With no statement imported there is nothing to reconcile against. That is
   * reported as "not applicable" rather than as one unmatched finding per payment:
   * a missing statement is a single gap in the evidence, not dozens of defects.
   * Nothing is reported as reconciled in this state either. */
  const applicable = statement.length > 0;

  // --- third side of the triangle: payroll against ledger against bank -------
  const paymentsByEmployee = group(ledgerRows, row => row.employeeNo);
  const threeWay = [];
  for (const payroll of applicable ? payrollRows : []) {
    const forEmployee = (paymentsByEmployee.get(payroll.employee_no) || []).filter(row => row.period === payroll.period);
    if (!forEmployee.length) continue; // absence of a payment is rule PAY-004/PAY-005, not a bank disagreement
    const ledgerTotal = money.sum(forEmployee.map(row => row.amountCents));
    const matchedRows = forEmployee.filter(row => row.status === 'matched');
    const bankTotal = money.sum(matchedRows.map(row => row.amountCents));
    const unverified = forEmployee.filter(row => row.status !== 'matched');
    if (ledgerTotal === payroll.net_paid_cents && !unverified.length) continue;
    threeWay.push({
      employeeNo: payroll.employee_no,
      name: payroll.name,
      period: payroll.period,
      recordedPaid: money.toAmount(payroll.net_paid_cents),
      paymentsTotal: money.toAmount(ledgerTotal),
      bankMatchedTotal: money.toAmount(bankTotal),
      payrollToLedgerDifference: money.toAmount(ledgerTotal - payroll.net_paid_cents),
      ledgerToBankDifference: money.toAmount(bankTotal - ledgerTotal),
      unverifiedReferences: unverified.map(row => ({ reference: row.reference, amount: row.amount, status: row.status })),
      detail: ledgerTotal !== payroll.net_paid_cents
        ? `Recorded paid ${money.toAmount(payroll.net_paid_cents)} SGD, payment ledger ${money.toAmount(ledgerTotal)} SGD, `
          + `bank-confirmed ${money.toAmount(bankTotal)} SGD. The three sources do not agree.`
        : `The payment ledger equals the recorded paid amount (${money.toAmount(ledgerTotal)} SGD), but `
          + `${unverified.length} reference(s) are not confirmed by the bank statement, so only `
          + `${money.toAmount(bankTotal)} SGD of it is evidenced.`
    });
  }

  const inCents = money.sum(bankRows.filter(row => row.direction === 'in').map(row => row.amountCents));
  const outCents = money.sum(bankRows.filter(row => row.direction === 'out').map(row => row.amountCents));

  return {
    method: METHOD,
    applicable,
    ledgerRows,
    bankRows,
    matched: pick(ledgerRows, 'matched'),
    unmatched: pick(ledgerRows, 'unmatched'),
    ambiguous: pick(ledgerRows, 'ambiguous'),
    unmatchedBank: pick(bankRows, 'unmatched'),
    ambiguousBank: pick(bankRows, 'ambiguous'),
    threeWay,
    counts: {
      payments: ledgerRows.length,
      bankTransactions: bankRows.length,
      matched: pick(ledgerRows, 'matched').length,
      unmatched: pick(ledgerRows, 'unmatched').length,
      ambiguous: pick(ledgerRows, 'ambiguous').length,
      bankUnmatched: pick(bankRows, 'unmatched').length,
      bankAmbiguous: pick(bankRows, 'ambiguous').length,
      threeWayDisagreements: threeWay.length
    },
    totals: {
      bankIn: money.toAmount(inCents),
      bankOut: money.toAmount(outCents),
      bankNetMovement: money.toAmount(inCents - outCents),
      matchedAmount: money.toAmount(money.sum(pick(ledgerRows, 'matched').map(row => row.amountCents))),
      unmatchedAmount: money.toAmount(money.sum(pick(ledgerRows, 'unmatched').map(row => row.amountCents))),
      ambiguousAmount: money.toAmount(money.sum(pick(ledgerRows, 'ambiguous').map(row => row.amountCents))),
      currency: 'SGD'
    },
    note: applicable
      ? 'Reconciliation states what can be proved from the imported files. An unmatched or ambiguous row is never reported as reconciled.'
      : 'No bank statement has been imported for this case, so no payment can be described as confirmed by a bank.'
  };
}

const rawBankList = (store, caseId) =>
  store.find('bank_transactions', { case_id: caseId }, { order: [['value_date', 'asc'], ['txn_ref', 'asc'], ['id', 'asc']] });

// ---------------------------------------------------------------------------
// Import: one validation pass shared by preview and confirm
// ---------------------------------------------------------------------------

async function analyse(store, caseRecord, source) {
  const read = ledgerSource.bankTable(source, HEADERS);
  const errors = [];
  const rows = [];
  for (const raw of read.rows) {
    const { row, errors: rowErrors } = readRow(raw, caseRecord.period);
    errors.push(...rowErrors);
    if (!rowErrors.length) rows.push(row);
  }

  // Identical lines inside one file are a file-preparation defect, not a finding.
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.txnRef}|${row.direction}|${row.amountCents}|${row.valueDate}`;
    if (seen.has(key)) errors.push(`Row ${row.line}: duplicates row ${seen.get(key)} (same reference, direction, amount and value date)`);
    else seen.set(key, row.line);
  }

  const existing = await rawBankList(store, caseRecord.id);
  const existingKeys = new Set(existing.map(t => `${t.txn_ref}|${t.direction}|${t.amount_cents}|${t.value_date}`));
  for (const row of rows) {
    if (existingKeys.has(`${row.txnRef}|${row.direction}|${row.amountCents}|${row.valueDate}`)) {
      errors.push(`Row ${row.line}: bank transaction ${row.txnRef} is already recorded in this case`);
    }
  }

  // Reported, not blocking: the rule engine raises these so a person decides.
  const payments = await require('./ledger-source').allPayments(store, caseRecord.id);
  const payrollRows = await records.rawList(store, caseRecord.id);
  const projected = reconcile({
    payments,
    payrollRows,
    bank: [
      ...existing,
      ...rows.map(row => ({
        id: `pending:${row.line}`,
        txn_ref: row.txnRef,
        direction: row.direction,
        amount_cents: row.amountCents,
        value_date: row.valueDate,
        counterparty: row.counterparty,
        description: row.description
      }))
    ]
  });

  return {
    rows,
    errors,
    format: read.format,
    worksheet: read.worksheet,
    worksheets: read.worksheets,
    digest: sha256(source.bytes),
    rowCount: rows.length,
    inCents: money.sum(rows.filter(row => row.direction === 'in').map(row => row.amountCents)),
    outCents: money.sum(rows.filter(row => row.direction === 'out').map(row => row.amountCents)),
    projected
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
    totalIn: money.toAmount(analysis.inCents),
    totalOut: money.toAmount(analysis.outCents),
    acceptable: analysis.errors.length === 0,
    errors: analysis.errors,
    sample: analysis.rows.slice(0, 10).map(row => ({
      txnRef: row.txnRef, valueDate: row.valueDate, direction: row.direction,
      amount: money.toAmount(row.amountCents), counterparty: row.counterparty, description: row.description
    })),
    // What the reconciliation would say if this file were imported unchanged.
    projectedReconciliation: {
      method: analysis.projected.method,
      counts: analysis.projected.counts,
      unmatched: analysis.projected.unmatched.map(row => ({ reference: row.reference, employeeNo: row.employeeNo, amount: row.amount, detail: row.detail })),
      ambiguous: analysis.projected.ambiguous.map(row => ({ reference: row.reference, employeeNo: row.employeeNo, amount: row.amount, detail: row.detail })),
      unmatchedBank: analysis.projected.unmatchedBank.map(row => ({ reference: row.reference, amount: row.amount, direction: row.direction, detail: row.detail })),
      threeWay: analysis.projected.threeWay
    },
    fileDigest: analysis.digest,
    note: 'Preview only. Nothing has been written. Import is all-or-nothing.'
  };
}

async function preview(ctx, caseId, input) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'payments.preview');
  const body = validate.only(input, ['csv', 'workbookBase64', 'worksheet', 'filename'], 'Bank statement preview');
  const source = csv.requestSource(body);
  const analysis = await analyse(ctx.store, caseRecord, source);
  const result = previewView(analysis, caseRecord);
  const existingBatch = await ctx.store.findOne('bank_batches', { digest: analysis.digest });
  if (existingBatch) {
    result.acceptable = false;
    result.alreadyImportedBatchId = existingBatch.id;
    result.errors = [`This exact file was already imported as batch ${existingBatch.id} on ${existingBatch.created_at}`, ...result.errors];
  }
  await audit.record(ctx, 'bank.previewed', {
    caseId, subjectType: 'bank_batch', subjectId: analysis.digest.slice(0, 16),
    detail: {
      filename: body.filename ? validate.filename(body.filename) : null,
      sourceFormat: analysis.format, worksheet: analysis.worksheet,
      rowCount: analysis.rowCount, acceptable: result.acceptable, rejectedRows: analysis.errors.length
    }
  });
  return result;
}

/** Atomic import. Any rejected row aborts the whole file. */
async function importBatch(ctx, caseId, input) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'payments.import');
  const body = validate.only(input, ['csv', 'workbookBase64', 'worksheet', 'filename', 'expectedDigest'], 'Bank statement import');
  const filename = validate.filename(body.filename || 'bank-statement.csv');
  const source = csv.requestSource(body);
  const analysis = await analyse(ctx.store, caseRecord, source);

  // The preparer confirms the exact file they previewed.
  if (body.expectedDigest && body.expectedDigest !== analysis.digest) {
    throw conflict('The file changed after the preview. Preview again before importing.', { previewed: body.expectedDigest, received: analysis.digest });
  }
  // Checked before row validation so a repeated submission of a file that was
  // already accepted is reported as a duplicate request, not as invalid content.
  const duplicateFile = await ctx.store.findOne('bank_batches', { digest: analysis.digest });
  if (duplicateFile) {
    throw conflict('This bank statement has already been imported', { batchId: duplicateFile.id, importedAt: duplicateFile.created_at });
  }
  if (analysis.errors.length) {
    throw badRequest('The bank statement was rejected. No rows were imported.', { errors: analysis.errors.slice(0, 30), rejectedRows: analysis.errors.length });
  }

  const now = clock.now();
  const result = await ctx.store.tx(async store => {
    const batch = await store.insert('bank_batches', {
      id: id('bnk'),
      case_id: caseId,
      filename,
      source_format: analysis.format,
      worksheet: analysis.worksheet,
      row_count: analysis.rowCount,
      in_cents: analysis.inCents,
      out_cents: analysis.outCents,
      status: 'imported',
      digest: analysis.digest,
      created_at: now,
      created_by: ctx.actor.id
    });
    const inserted = [];
    for (const row of analysis.rows) {
      inserted.push(await store.insert('bank_transactions', {
        id: id('btx'),
        case_id: caseId,
        batch_id: batch.id,
        txn_ref: row.txnRef,
        value_date: row.valueDate,
        direction: row.direction,
        amount_cents: row.amountCents,
        counterparty: row.counterparty || null,
        description: row.description || null,
        created_at: now,
        created_by: ctx.actor.id
      }));
    }
    // A new statement changes what the review is based on, so the data revision
    // advances and every stored check, reconciliation and report goes stale.
    const updatedCase = await cases.bumpRevision(store, caseId);
    return { batch, transactions: inserted, dataRevision: updatedCase.data_revision };
  });

  await audit.record(ctx, 'bank.imported', {
    caseId, subjectType: 'bank_batch', subjectId: result.batch.id,
    detail: {
      filename, sourceFormat: analysis.format, worksheet: analysis.worksheet,
      rowCount: analysis.rowCount, totalIn: money.toAmount(analysis.inCents), totalOut: money.toAmount(analysis.outCents),
      fileDigest: analysis.digest, dataRevision: result.dataRevision,
      projectedUnmatched: analysis.projected.counts.unmatched + analysis.projected.counts.bankUnmatched,
      projectedAmbiguous: analysis.projected.counts.ambiguous
    }
  });

  return {
    batchId: result.batch.id,
    caseId,
    sourceFormat: analysis.format,
    worksheet: analysis.worksheet,
    rowCount: analysis.rowCount,
    totalIn: money.toAmount(analysis.inCents),
    totalOut: money.toAmount(analysis.outCents),
    dataRevision: result.dataRevision,
    note: 'Imported. Run the checks again so the reconciliation and the report reflect the new statement.'
  };
}

// ---------------------------------------------------------------------------
// Stored reconciliation results, stamped like a check row
// ---------------------------------------------------------------------------

const isCurrent = (row, caseRecord, ruleSet) =>
  !!row && row.data_revision === caseRecord.data_revision && row.rule_version === ruleSet.version;

function view(row, caseRecord, ruleSet) {
  const current = isCurrent(row, caseRecord, ruleSet);
  return {
    id: row.id,
    caseId: row.case_id,
    dataRevision: row.data_revision,
    ruleVersion: row.rule_version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    matchedCount: row.matched_count,
    unmatchedCount: row.unmatched_count,
    ambiguousCount: row.ambiguous_count,
    result: row.result,
    current,
    staleReason: current ? null
      : row.data_revision !== caseRecord.data_revision
        ? `Data has changed since this reconciliation (reconciled v${row.data_revision}, current v${caseRecord.data_revision}). Run the checks again.`
        : 'Rules have changed since this reconciliation. Run the checks again.'
  };
}

async function latestRow(store, caseId) {
  const rows = await store.find('reconciliations', { case_id: caseId }, { order: [['created_at', 'desc'], ['id', 'desc']], limit: 1 });
  return rows[0] || null;
}

/** Computes and stores a reconciliation for the current data revision. Called by
 *  checks.service on every run so the two results can never disagree. */
async function record(store, { caseRecord, ruleSet, result, actorId }) {
  return store.insert('reconciliations', {
    id: id('rcn'),
    case_id: caseRecord.id,
    data_revision: caseRecord.data_revision,
    rule_version: ruleSet.version,
    matched_count: result.counts.matched,
    unmatched_count: result.counts.unmatched + result.counts.bankUnmatched,
    ambiguous_count: result.counts.ambiguous + result.counts.bankAmbiguous,
    result,
    created_at: clock.now(),
    created_by: actorId
  });
}

async function run(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'checks.run');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const [payments, bank, payrollRows] = await Promise.all([
    require('./ledger-source').allPayments(ctx.store, caseId),
    rawBankList(ctx.store, caseId),
    records.rawList(ctx.store, caseId)
  ]);
  const result = reconcile({ payments, bank, payrollRows });
  const row = await record(ctx.store, { caseRecord, ruleSet, result, actorId: ctx.actor.id });
  await audit.record(ctx, 'reconciliation.run', {
    caseId, subjectType: 'reconciliation', subjectId: row.id,
    detail: { dataRevision: caseRecord.data_revision, ruleVersion: ruleSet.version, ...result.counts }
  });
  return view(row, caseRecord, ruleSet);
}

async function latest(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'rules.read');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const row = await latestRow(ctx.store, caseId);
  if (!row) {
    return {
      caseId, reconciliation: null, current: false,
      method: METHOD,
      note: 'No reconciliation has been produced yet. Run the data checks to produce one.'
    };
  }
  const shaped = view(row, caseRecord, ruleSet);
  return { caseId, reconciliation: shaped, current: shaped.current, method: METHOD };
}

/** Imported statement batches and their transactions. */
async function list(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'records.read');
  const [batches, transactions] = await Promise.all([
    ctx.store.find('bank_batches', { case_id: caseId }, { order: [['created_at', 'desc']] }),
    rawBankList(ctx.store, caseId)
  ]);
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId, subjectType: 'bank_transactions', subjectId: caseId, detail: { rowCount: transactions.length } });
  }
  return {
    caseId,
    batches: batches.map(batch => ({
      id: batch.id, filename: batch.filename, sourceFormat: batch.source_format,
      worksheet: batch.worksheet, rowCount: batch.row_count,
      totalIn: money.toAmount(batch.in_cents), totalOut: money.toAmount(batch.out_cents),
      status: batch.status, digest: batch.digest, createdAt: batch.created_at, createdBy: batch.created_by
    })),
    transactions: transactions.map(transaction => ({
      id: transaction.id, batchId: transaction.batch_id, txnRef: transaction.txn_ref,
      valueDate: transaction.value_date, direction: transaction.direction,
      amount: money.toAmount(transaction.amount_cents),
      counterparty: transaction.counterparty || '', description: transaction.description || ''
    })),
    totalIn: money.toAmount(money.sum(transactions.filter(t => t.direction === 'in').map(t => t.amount_cents))),
    totalOut: money.toAmount(money.sum(transactions.filter(t => t.direction === 'out').map(t => t.amount_cents)))
  };
}

const template = () => csv.write(HEADERS, [
  {
    txnRef: 'PAY-202609-001', valueDate: '2026-09-28', direction: 'out', amount: '7000.00',
    counterparty: 'Demo Company payroll', description: 'September net salary'
  }
]);

module.exports = {
  HEADERS, METHOD, MAX_ROWS,
  reconcile, rawBankList, analyse,
  preview, importBatch, list, template,
  run, latest, latestRow, record, view, isCurrent
};
