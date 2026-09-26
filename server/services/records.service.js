/* Payroll source records. The server copy is authoritative: the browser may hold
 * a local demo state, but nothing is checked, drafted, approved or exported from
 * client-held values.
 *
 * Validation and monetary parsing are delegated to dist/demo/core.js so the accepted
 * CSV schema, identifier and period rules, and cent-exact arithmetic are the same
 * ones already covered by the existing test suite. */
'use strict';
const core = require('../../dist/demo/core.js');
const clock = require('../lib/clock');
const csv = require('../lib/csv');
const { id } = require('../lib/ids');
const money = require('../lib/money');
const validate = require('../lib/validate');
const { badRequest, notFound, conflict } = require('../lib/errors');
const rbac = require('../auth/rbac');
const access = require('../auth/access');
const cases = require('./cases.service');
const audit = require('./audit.service');
const rules = require('../rules/registry');

const CORE_FIELDS = core.FIELDS;

function toRow(caseId, coreRow, actorId, now) {
  return {
    id: id('rec'),
    case_id: caseId,
    employee_no: coreRow.id,
    name: coreRow.name,
    department: coreRow.department,
    cost_center: coreRow.costCenter || null,
    period: coreRow.period,
    base_pay_cents: money.toCents(coreRow.basePay, 'Base pay'),
    allowances_cents: money.toCents(coreRow.allowances, 'Allowances'),
    deductions_cents: money.toCents(coreRow.deductions, 'Deductions'),
    net_paid_cents: money.toCents(coreRow.netPaid, 'Recorded paid'),
    evidence_ref: coreRow.evidence || null,
    revision: 1,
    created_at: now,
    updated_at: now,
    updated_by: actorId
  };
}

const publicRow = row => ({
  id: row.id,
  employeeNo: row.employee_no,
  name: row.name,
  department: row.department,
  costCenter: row.cost_center || '',
  period: row.period,
  basePay: money.toAmount(row.base_pay_cents),
  allowances: money.toAmount(row.allowances_cents),
  deductions: money.toAmount(row.deductions_cents),
  netPaid: money.toAmount(row.net_paid_cents),
  expectedNet: money.toAmount(money.expectedNet(row)),
  evidenceRef: row.evidence_ref || '',
  revision: row.revision,
  updatedAt: row.updated_at
});

async function rawList(store, caseId) {
  return store.find('payroll_records', { case_id: caseId }, { order: [['employee_no', 'asc']] });
}

async function list(ctx, caseId) {
  const { case: record } = await access.requireCase(ctx, caseId, 'records.read');
  const rows = await rawList(ctx.store, caseId);
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId, subjectType: 'payroll_records', subjectId: caseId, detail: { rowCount: rows.length } });
  }
  return {
    caseId,
    dataRevision: record.data_revision,
    records: rows.map(publicRow),
    totals: money.totals(rows)
  };
}

/**
 * Reads an import source through the shared table reader and normalises it with
 * the existing strict payroll schema. Accepts CSV text or workbook bytes; the
 * header and column rules are the same either way.
 * @param {object|string} input a csv.requestSource result, or raw CSV text
 */
function readRows(input) {
  if (typeof input === 'string') {
    return { rows: core.parseCSV(input), format: 'csv', worksheet: null, worksheets: [] };
  }
  const read = csv.readTable(input, CORE_FIELDS, { maxRows: 1000 });
  // core.normalizeRows performs the payroll-specific validation and cent parsing.
  return {
    rows: core.normalizeRows(read.rows.map(row => Object.fromEntries(CORE_FIELDS.map(field => [field, row[field]])))),
    format: read.format,
    worksheet: read.worksheet,
    worksheets: read.worksheets
  };
}

/** Parses an uploaded file with the existing strict schema and returns a preview
 *  without writing anything. */
function preview(input) {
  const read = readRows(input);
  return {
    rowCount: read.rows.length,
    sourceFormat: read.format,
    worksheet: read.worksheet,
    worksheets: read.worksheets,
    totals: core.totals(read.rows),
    sample: read.rows.slice(0, 5).map(r => ({ employeeNo: r.id, name: r.name, period: r.period, netPaid: r.netPaid })),
    fields: CORE_FIELDS
  };
}

/**
 * Replaces the payroll records of a case in a single transaction. A rejected row
 * leaves the stored data byte-identical to before the attempt.
 */
async function replaceAll(ctx, caseId, input) {
  const { case: record } = await access.requireCase(ctx, caseId, 'records.import');
  const body = validate.only(input, ['rows', 'csv', 'workbookBase64', 'worksheet', 'note'], 'Import');
  const hasFile = typeof body.csv === 'string' || typeof body.workbookBase64 === 'string';
  if (!body.rows && !hasFile) throw badRequest('Provide rows, csv or workbookBase64');
  // core.parseCSV / core.normalizeRows perform the strict schema validation.
  const coreRows = hasFile ? readRows(csv.requestSource(body)).rows : core.normalizeRows(body.rows);
  const note = validate.text(body.note || 'Replacement import', 'Import note', { max: 500, multiline: true });
  const now = clock.now();

  const result = await ctx.store.tx(async store => {
    const existing = await rawList(store, caseId);
    for (const row of existing) await store.remove('payroll_records', row.id);
    const inserted = [];
    for (const coreRow of coreRows) inserted.push(await store.insert('payroll_records', toRow(caseId, coreRow, ctx.actor.id, now)));
    const updatedCase = await cases.bumpRevision(store, caseId);
    await store.insert('record_changes', {
      id: id('chg'),
      case_id: caseId,
      record_id: '*',
      revision: updatedCase.data_revision,
      note,
      changes: { action: 'replace_all', previousRowCount: existing.length, newRowCount: inserted.length },
      actor_id: ctx.actor.id,
      at: now
    });
    return { rows: inserted, dataRevision: updatedCase.data_revision, replaced: existing.length };
  });

  await audit.record(ctx, 'records.replaced', {
    caseId, subjectType: 'payroll_records', subjectId: caseId,
    detail: { rowCount: result.rows.length, replaced: result.replaced, dataRevision: result.dataRevision, casePeriod: record.period }
  });
  return {
    caseId,
    dataRevision: result.dataRevision,
    rowCount: result.rows.length,
    records: result.rows.map(publicRow),
    totals: money.totals(result.rows)
  };
}

/** Field-level edit with a mandatory explanation. Before/after values are kept. */
async function update(ctx, caseId, employeeNo, input) {
  await access.requireCase(ctx, caseId, 'records.write');
  const body = validate.only(input, ['changes', 'note'], 'Edit');
  const note = validate.text(body.note, 'Change explanation', { max: 500, multiline: true });
  const changes = validate.object(body.changes, 'Changes');
  const editable = CORE_FIELDS.filter(f => f !== 'id');
  const unknown = Object.keys(changes).filter(k => !editable.includes(k));
  if (unknown.length) throw badRequest(`Unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (!Object.keys(changes).length) throw badRequest('No changes to save');

  const current = await ctx.store.findOne('payroll_records', { case_id: caseId, employee_no: employeeNo });
  if (!current) throw notFound(`Payroll record not found: ${employeeNo}`);

  const before = rules.toCoreRow(current);
  const merged = core.normalizeRows([{ ...before, ...changes, id: before.id }])[0];
  const diff = CORE_FIELDS.filter(field => before[field] !== merged[field])
    .map(field => ({ field, before: before[field], after: merged[field] }));
  if (!diff.length) throw badRequest('No changes to save');

  const now = clock.now();
  const result = await ctx.store.tx(async store => {
    const updated = await store.update('payroll_records', current.id, {
      name: merged.name,
      department: merged.department,
      cost_center: merged.costCenter || null,
      period: merged.period,
      base_pay_cents: money.toCents(merged.basePay, 'Base pay'),
      allowances_cents: money.toCents(merged.allowances, 'Allowances'),
      deductions_cents: money.toCents(merged.deductions, 'Deductions'),
      net_paid_cents: money.toCents(merged.netPaid, 'Recorded paid'),
      evidence_ref: merged.evidence || null,
      revision: current.revision + 1,
      updated_at: now,
      updated_by: ctx.actor.id
    });
    const updatedCase = await cases.bumpRevision(store, caseId);
    await store.insert('record_changes', {
      id: id('chg'),
      case_id: caseId,
      record_id: employeeNo,
      revision: updatedCase.data_revision,
      note,
      changes: diff,
      actor_id: ctx.actor.id,
      at: now
    });
    return { updated, dataRevision: updatedCase.data_revision };
  });

  await audit.record(ctx, 'records.updated', {
    caseId, subjectType: 'payroll_record', subjectId: employeeNo,
    detail: { fields: diff.map(d => d.field), dataRevision: result.dataRevision }
  });
  return { record: publicRow(result.updated), dataRevision: result.dataRevision, changes: diff };
}

async function history(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'records.read');
  return (await ctx.store.find('record_changes', { case_id: caseId }, { order: [['at', 'desc'], ['id', 'desc']], limit: 300 }))
    .map(row => ({
      id: row.id, recordId: row.record_id, revision: row.revision, note: row.note,
      changes: row.changes, actorId: row.actor_id, at: row.at
    }));
}

/** CSV of the authoritative server records, using the existing export encoder. */
async function toCsv(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'records.read');
  const rows = await rawList(ctx.store, caseId);
  return core.toCSV(rows.map(rules.toCoreRow));
}

/**
 * Employee directory. Finance-side roles receive only what they need to review
 * payroll: identifier, display name, department, cost center and start date.
 * Recruitment identifiers, candidate contact details and scorecards are withheld.
 */
async function employees(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'records.read');
  const rows = await ctx.store.find('employees', { case_id: caseId }, { order: [['employee_no', 'asc']] });
  const full = rbac.seesCandidateIdentity(ctx.actor.role);
  return rows.map(row => {
    const projected = {
      employeeNo: row.employee_no,
      displayName: row.display_name,
      department: row.department,
      costCenter: row.cost_center || '',
      startDate: row.start_date || null,
      source: row.source
    };
    if (full) projected.candidateId = row.candidate_id || null;
    else projected.recruitmentDetail = 'withheld';
    return projected;
  });
}

module.exports = {
  list, rawList, preview, readRows, replaceAll, update, history, toCsv, employees, publicRow, toRow, CORE_FIELDS
};
