'use strict';
const csv = require('../lib/csv');
const validate = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const LEDGER_HEADERS = ['id','date','type','category','department','costCenter','amount','currency','reference','evidence','description'];
const BANK_HEADERS = ['id','date','direction','amount','currency','reference','description'];

function grid(source) {
  if (source.buffer && require('../lib/xlsx').isWorkbook(source.buffer)) {
    const data = require('../lib/xlsx').parseRows(source.buffer, { sheet: source.worksheet });
    return { grid: data.rows, format: 'xlsx', worksheet: data.worksheet, worksheets: data.worksheets };
  }
  return { grid: csv.parseRows(source.text ?? csv.decodeUtf8(source.buffer)), format: 'csv', worksheet: null, worksheets: [] };
}
function sourceTable(source, nativeHeaders, alternateHeaders) {
  const read = grid(source);
  const headers = read.grid[0]?.map(x => String(x).trim()) || [];
  const alternate = alternateHeaders.every(h => headers.includes(h));
  return { ...read, alternate, rows: csv.toObjects(read.grid, alternate ? alternateHeaders : nativeHeaders) };
}
function validateV2(rows) {
  const ids = new Set();
  for (const row of rows) {
    validate.text(row.id, 'Source ID', { max: 40, pattern: /^[A-Za-z0-9_-]+$/ });
    if (ids.has(row.id)) throw badRequest(`Duplicate v2 source ID: ${row.id}`);
    ids.add(row.id);
    if (row.currency !== 'SGD') throw badRequest(`Row ${row.__line}: only SGD is supported; currency cannot be silently converted`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0,10) !== row.date) throw badRequest(`Row ${row.__line}: invalid date`);
  }
}
async function paymentTable(store, caseId, source, headers) {
  const read = sourceTable(source, headers, LEDGER_HEADERS);
  if (!read.alternate) return read;
  validateV2(read.rows);
  const payroll = await store.find('payroll_records', { case_id: caseId });
  return { ...read, sourceRows: read.rows, rows: read.rows.map(row => {
    validate.oneOf(row.type, ['income', 'expense'], 'Ledger type');
    validate.text(row.reference, 'Ledger reference', { max: 120 });
    validate.text(row.category, 'Ledger category', { max: 80 });
    validate.text(row.costCenter, 'Cost center', { max: 80 });
    const isPayroll = row.category === 'payroll';
    const candidates = payroll.filter(p => p.evidence_ref && p.evidence_ref === row.reference);
    if (isPayroll && (row.type !== 'expense' || candidates.length !== 1)) {
      throw badRequest(`Row ${row.__line}: payroll reference ${row.reference} must identify exactly one employee; import corrected payroll first`);
    }
    return {
      __line: row.__line, employeeNo: isPayroll ? candidates[0].employee_no : '',
      period: isPayroll ? candidates[0].period : row.date.slice(0,7), amount: row.amount,
      paymentRef: row.reference, paidAt: row.date, general: !isPayroll, source: row
    };
  }) };
}
function bankTable(source, headers) {
  const read = sourceTable(source, headers, BANK_HEADERS);
  if (!read.alternate) return read;
  validateV2(read.rows);
  return { ...read, rows: read.rows.map(row => ({
    __line: row.__line, txnRef: row.reference, valueDate: row.date,
    direction: row.direction, amount: row.amount, counterparty: '', description: row.description
  })) };
}
// Financial entries stay separate from employee payments, but use the same
// normalized shape at the reconciliation boundary. No fabricated employees.
async function allPayments(store, caseId) {
  const [payments, entries] = await Promise.all([
    store.find('payments', { case_id: caseId }, { order: [['employee_no','asc'],['paid_at','asc']] }),
    store.find('ledger_entries', { case_id: caseId }, { order: [['source_id','asc']] })
  ]);
  return [...payments, ...entries.map(row => ({
    ...row, ledger_kind: 'general', employee_no: null, payment_ref: row.reference,
    paid_at: row.value_date
  }))];
}
module.exports = { paymentTable, bankTable, allPayments, LEDGER_HEADERS, BANK_HEADERS };
