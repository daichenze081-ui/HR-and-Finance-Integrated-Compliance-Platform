/* Deterministic rule execution. Results are stamped with the data revision and
 * the rule version they were produced from, so a later change to either makes the
 * stored result visibly stale instead of silently wrong. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const { digest } = require('../lib/hash');
const money = require('../lib/money');
const access = require('../auth/access');
const cases = require('./cases.service');
const records = require('./records.service');
const audit = require('./audit.service');
const reconciliation = require('./reconciliation.service');
const rules = require('../rules/registry');

async function gather(store, caseRecord) {
  const [payrollRows, payments, bank, evidence] = await Promise.all([
    records.rawList(store, caseRecord.id),
    require('./ledger-source').allPayments(store, caseRecord.id),
    reconciliation.rawBankList(store, caseRecord.id),
    store.find('evidence_files', { case_id: caseRecord.id })
  ]);
  return { payrollRows, payments, bank, evidence };
}

async function run(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'checks.run');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const { payrollRows, payments, bank, evidence } = await gather(ctx.store, caseRecord);

  /* The three-way reconciliation is computed here, from the same snapshot the rules
   * see, and stored against the same data revision. A check and the reconciliation
   * it reports on can therefore never disagree, and both go stale together. */
  const reconciled = reconciliation.reconcile({ payments, bank, payrollRows });

  const result = rules.evaluate({
    records: payrollRows,
    payments,
    bank,
    reconciliation: reconciled,
    evidence,
    casePeriod: caseRecord.period,
    ruleSet
  });

  const row = await ctx.store.insert('checks', {
    id: id('chk'),
    case_id: caseId,
    data_revision: caseRecord.data_revision,
    rule_version: result.ruleVersion,
    rule_set_id: ruleSet.id,
    issues: result.issues,
    totals: result.totals,
    created_at: clock.now(),
    created_by: ctx.actor.id
  });

  await reconciliation.record(ctx.store, { caseRecord, ruleSet, result: reconciled, actorId: ctx.actor.id });

  await audit.record(ctx, 'checks.run', {
    caseId, subjectType: 'check', subjectId: row.id,
    detail: {
      dataRevision: caseRecord.data_revision,
      ruleVersion: result.ruleVersion,
      findingCount: result.issues.length,
      blockingCount: rules.blockingIssues(result.issues).length,
      reconciliation: reconciled.counts
    }
  });
  return view(row, caseRecord, ruleSet);
}

function isCurrent(checkRow, caseRecord, ruleSet) {
  if (!checkRow) return false;
  return checkRow.data_revision === caseRecord.data_revision && checkRow.rule_version === ruleSet.version;
}

function view(row, caseRecord, ruleSet) {
  const issues = row.issues || [];
  const blocking = rules.blockingIssues(issues);
  return {
    id: row.id,
    caseId: row.case_id,
    dataRevision: row.data_revision,
    ruleVersion: row.rule_version,
    ruleLabel: ruleSet.label,
    disclaimer: ruleSet.disclaimer,
    createdAt: row.created_at,
    createdBy: row.created_by,
    issues,
    blockingCount: blocking.length,
    reviewCount: issues.length - blocking.length,
    totals: row.totals,
    totalsFormatted: Object.fromEntries(Object.entries(row.totals).map(([k, v]) => [k, money.toAmount(v)])),
    current: isCurrent(row, caseRecord, ruleSet),
    staleReason: isCurrent(row, caseRecord, ruleSet) ? null
      : row.data_revision !== caseRecord.data_revision
        ? `Data has changed since this check (checked v${row.data_revision}, current v${caseRecord.data_revision}). Run checks again.`
        : 'Rules have changed since this check. Run checks again.'
  };
}

async function latestRow(store, caseId) {
  const rows = await store.find('checks', { case_id: caseId }, { order: [['created_at', 'desc'], ['id', 'desc']], limit: 1 });
  return rows[0] || null;
}

async function latest(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'rules.read');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const row = await latestRow(ctx.store, caseId);
  if (!row) return { caseId, check: null, current: false, ruleVersion: ruleSet.version, disclaimer: ruleSet.disclaimer };
  return { caseId, check: view(row, caseRecord, ruleSet), current: isCurrent(row, caseRecord, ruleSet) };
}

/**
 * Digest of everything a report version depends on. Any change to records,
 * findings, rule version or the attached evidence set produces a different digest,
 * which is what invalidates recorded approvals.
 */
function inputDigest({ caseRecord, checkRow, payrollRows, evidence, payments = [], bank = [] }) {
  return digest({
    caseId: caseRecord.id,
    period: caseRecord.period,
    dataRevision: checkRow.data_revision,
    ruleVersion: checkRow.rule_version,
    records: payrollRows.map(r => [
      r.employee_no, r.name, r.department, r.cost_center || '', r.period,
      r.base_pay_cents, r.allowances_cents, r.deductions_cents, r.net_paid_cents, r.evidence_ref || ''
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    issues: (checkRow.issues || []).map(i => [i.rule, i.recordId, i.detail]).sort(),
    payments: [...payments].sort((a,b) => a.id.localeCompare(b.id)),
    bank: [...bank].sort((a,b) => a.id.localeCompare(b.id)),
    totals: checkRow.totals,
    evidence: evidence.filter(f => !f.superseded_by).map(f => [f.id, f.sha256, f.version, f.readable]).sort()
  });
}

module.exports = { run, latest, latestRow, view, isCurrent, gather, inputDigest };
