/* Configurable demonstration rules.
 *
 * These are deterministic bookkeeping checks chosen for a demonstration. They are
 * NOT a statutory or legal compliance determination: CPF, income tax, employment
 * law and regulator requirements are not evaluated anywhere in this system.
 *
 * The four original rules are executed by the shared browser core engine so the
 * server and the client produce byte-identical findings. Extended rules are
 * additive and each one can be switched off through the rule-set configuration. */
'use strict';
const core = require('../../dist/demo/core.js');
const money = require('../lib/money');
const { digest } = require('../lib/hash');
const clock = require('../lib/clock');
const { badRequest } = require('../lib/errors');

const BASE_VERSION = 'DEMO-2026.09-v2';
const LABEL = 'Configurable demonstration rules';
const DISCLAIMER =
  'Demonstration rules only. Passing these checks is not a statutory, tax or legal compliance determination. '
  + 'CPF, income tax and employment-law requirements are not evaluated. Findings require human review.';

/** Rules delegated to dist/demo/core.js, preserving its exact identifiers and wording. */
const CORE_RULES = ['PAY-001', 'DOC-001', 'ORG-001', 'PAY-002'];

const DEFAULT_RULES = [
  { id: 'PAY-001', title: 'Net pay reconciliation', engine: 'core', enabled: true, severity: 'blocking', description: 'Compare base pay + allowances − deductions against the recorded paid amount.' },
  { id: 'DOC-001', title: 'Evidence reference present', engine: 'core', enabled: true, severity: 'blocking', description: 'Check that a payslip or payment reference is recorded. Authenticity is not verified by this rule.' },
  { id: 'ORG-001', title: 'Cost center present', engine: 'core', enabled: true, severity: 'blocking', description: 'Check that each payroll record has an assigned cost center.' },
  { id: 'PAY-002', title: 'Deduction range', engine: 'core', enabled: true, severity: 'blocking', description: 'Flag deductions that exceed base pay plus allowances.' },
  { id: 'PER-001', title: 'Period matches the case', engine: 'server', enabled: true, severity: 'blocking', description: 'Payroll and payment periods must equal the review period of the case.' },
  { id: 'DOC-002', title: 'Supporting evidence file attached', engine: 'server', enabled: true, severity: 'blocking', description: 'An uploaded evidence file must exist for the payroll record, not only a reference string.' },
  { id: 'DOC-003', title: 'Evidence readable', engine: 'server', enabled: true, severity: 'review', description: 'Evidence whose content could not be read is marked for manual review and is never reported as verified.' },
  { id: 'PAY-003', title: 'Duplicate payment detection', engine: 'server', enabled: true, severity: 'blocking', description: 'Flag more than one imported payment for the same employee and period, and repeated payment references.' },
  { id: 'PAY-004', title: 'Payments reconcile to payroll', engine: 'server', enabled: true, severity: 'blocking', description: 'Imported payment totals per employee must equal the recorded paid amount for the period.' },
  { id: 'PAY-005', title: 'Payment without a payroll record', engine: 'server', enabled: true, severity: 'blocking', description: 'Flag imported payments that have no matching payroll record in the case.' },
  { id: 'BANK-001', title: 'Payment not confirmed by the bank statement', engine: 'server', enabled: true, severity: 'blocking', description: 'Every ledger payment must match exactly one bank transaction on reference, amount and direction. An unmatched payment is not evidenced.' },
  { id: 'BANK-002', title: 'Bank transaction not in the payment ledger', engine: 'server', enabled: true, severity: 'blocking', description: 'Flag money that moved through the bank account with no corresponding imported payment.' },
  { id: 'BANK-003', title: 'Ambiguous reconciliation match', engine: 'server', enabled: true, severity: 'review', description: 'The reference, amount and direction do not identify a unique pair, so the match cannot be asserted and a person must decide.' },
  { id: 'BANK-004', title: 'Payroll, payment ledger and bank do not agree', engine: 'server', enabled: true, severity: 'blocking', description: 'Three-way check: the recorded paid amount, the imported payments and the bank-confirmed amount must reconcile for each employee and period.' }
];

function normaliseConfig(input) {
  const requested = Array.isArray(input?.rules) ? input.rules : [];
  const rules = DEFAULT_RULES.map(rule => {
    const override = requested.find(r => r && r.id === rule.id);
    if (!override) return { ...rule };
    if (override.enabled !== undefined && typeof override.enabled !== 'boolean') throw badRequest(`Rule ${rule.id}: enabled must be true or false`);
    return { ...rule, enabled: override.enabled === undefined ? rule.enabled : override.enabled };
  });
  const unknown = requested.filter(r => !DEFAULT_RULES.some(d => d.id === r?.id)).map(r => r?.id);
  if (unknown.length) throw badRequest(`Unknown rule identifier: ${unknown.join(', ')}`);
  return { rules };
}

/** A configuration change produces a different version string, which is what
 *  makes previously recorded approvals no longer applicable. */
function buildRuleSet(input = {}) {
  const config = normaliseConfig(input);
  const fingerprint = digest(config.rules.map(r => [r.id, r.enabled])).slice(0, 10);
  return {
    version: `${BASE_VERSION}.${fingerprint}`,
    label: LABEL,
    disclaimer: DISCLAIMER,
    config,
    createdAt: clock.now()
  };
}

const enabledIds = ruleSet => new Set((ruleSet.config?.rules || DEFAULT_RULES).filter(r => r.enabled).map(r => r.id));

const ruleMeta = ruleId => DEFAULT_RULES.find(r => r.id === ruleId) || { id: ruleId, title: ruleId, severity: 'blocking' };

/** Database payroll row -> the row shape dist/demo/core.js validates and evaluates. */
const toCoreRow = row => ({
  id: row.employee_no,
  name: row.name,
  department: row.department,
  costCenter: row.cost_center || '',
  period: row.period,
  basePay: money.toAmount(row.base_pay_cents),
  allowances: money.toAmount(row.allowances_cents),
  deductions: money.toAmount(row.deductions_cents),
  netPaid: money.toAmount(row.net_paid_cents),
  evidence: row.evidence_ref || ''
});

function finding(rule, row, title, detail, field, severity) {
  return {
    id: `${rule}:${row.employee_no}`,
    recordId: row.employee_no,
    name: row.name,
    rule,
    ruleVersion: null, // stamped by evaluate()
    severity: severity || ruleMeta(rule).severity,
    title,
    detail,
    field
  };
}

/**
 * Deterministic evaluation. The model never participates in this function and
 * never alters its output.
 *
 * @param {object} input
 * @param {Array}  input.records   payroll rows for the case
 * @param {Array}  input.payments  imported payment rows for the case
 * @param {Array}  input.bank      imported bank transaction rows for the case
 * @param {object} input.reconciliation  result of reconciliation.service.reconcile
 * @param {Array}  input.evidence  evidence file rows for the case
 * @param {string} input.casePeriod
 * @param {object} input.ruleSet
 */
function evaluate({ records = [], payments = [], bank = [], reconciliation = null, evidence = [], casePeriod, ruleSet }) {
  payments = payments.filter(row => row.ledger_kind !== 'general');
  const version = ruleSet.version;
  const enabled = enabledIds(ruleSet);
  const issues = [];

  // --- Rules delegated to the shared core engine -----------------------------
  if (records.length && CORE_RULES.some(id => enabled.has(id))) {
    const coreRows = records.map(toCoreRow);
    for (const issue of core.evaluate(coreRows).issues) {
      if (enabled.has(issue.rule)) issues.push({ ...issue, ruleVersion: version, engine: 'core' });
    }
  }

  const byEmployee = new Map();
  for (const payment of payments) {
    if (!byEmployee.has(payment.employee_no)) byEmployee.set(payment.employee_no, []);
    byEmployee.get(payment.employee_no).push(payment);
  }

  const activeEvidence = evidence.filter(file => !file.superseded_by);
  const evidenceFor = row => activeEvidence.filter(file =>
    (file.subject_type === 'payroll_record' && file.subject_id === row.employee_no)
    || (file.subject_type === 'payment_reference' && row.evidence_ref && file.subject_id === row.evidence_ref));

  for (const row of records) {
    if (enabled.has('PER-001') && row.period !== casePeriod) {
      issues.push(finding('PER-001', row, 'Period does not match the case',
        `Record period ${row.period} differs from the case review period ${casePeriod}.`, 'period'));
    }

    const files = evidenceFor(row);
    if (enabled.has('DOC-002') && files.length === 0) {
      issues.push(finding('DOC-002', row, 'No evidence file attached',
        'Only a reference string is present. Upload the supporting document so the reference can be traced to a file.', 'evidence'));
    }
    const unreadable = files.filter(file => file.readable === 0);
    if (enabled.has('DOC-003') && unreadable.length) {
      issues.push(finding('DOC-003', row, 'Evidence requires manual review',
        `${unreadable.length} attached file${unreadable.length === 1 ? '' : 's'} could not be read automatically `
        + `(${unreadable.map(f => f.review_reason || 'unreadable content').join('; ')}). `
        + 'The content has not been verified and must be checked by a person.', 'evidence', 'review'));
    }

    const paid = byEmployee.get(row.employee_no) || [];
    const forPeriod = paid.filter(p => p.period === row.period);
    if (enabled.has('PAY-003') && forPeriod.length > 1) {
      issues.push(finding('PAY-003', row, 'Duplicate payment detected',
        `${forPeriod.length} payments were imported for ${row.period} `
        + `(references ${forPeriod.map(p => p.payment_ref).join(', ')}), totalling `
        + `${money.toAmount(money.sum(forPeriod.map(p => p.amount_cents)))} SGD.`, 'netPaid'));
    }
    if (enabled.has('PAY-004') && forPeriod.length) {
      const total = money.sum(forPeriod.map(p => p.amount_cents));
      if (total !== row.net_paid_cents) {
        issues.push(finding('PAY-004', row, 'Payments do not reconcile to payroll',
          `Imported payments total ${money.toAmount(total)} against a recorded paid amount of `
          + `${money.toAmount(row.net_paid_cents)}; difference ${money.toAmount(total - row.net_paid_cents)} SGD.`, 'netPaid'));
      }
    }
  }

  if (enabled.has('PAY-005')) {
    const known = new Set(records.map(r => r.employee_no));
    const orphans = [...new Set(payments.filter(p => !known.has(p.employee_no)).map(p => p.employee_no))];
    for (const employeeNo of orphans) {
      const rows = payments.filter(p => p.employee_no === employeeNo);
      issues.push({
        id: `PAY-005:${employeeNo}`,
        recordId: employeeNo,
        name: '(no payroll record)',
        rule: 'PAY-005',
        ruleVersion: version,
        severity: 'blocking',
        title: 'Payment without a payroll record',
        detail: `${rows.length} imported payment${rows.length === 1 ? '' : 's'} reference employee ${employeeNo}, `
          + `which has no payroll record in this case. Total ${money.toAmount(money.sum(rows.map(p => p.amount_cents)))} SGD.`,
        field: 'id',
        engine: 'server'
      });
    }
  }

  // Duplicate payment references across different employees.
  if (enabled.has('PAY-003')) {
    const byRef = new Map();
    for (const payment of payments) {
      const key = `${payment.period}|${payment.payment_ref}`;
      if (!byRef.has(key)) byRef.set(key, []);
      byRef.get(key).push(payment);
    }
    for (const [key, group] of byRef) {
      if (group.length < 2) continue;
      const employees = [...new Set(group.map(p => p.employee_no))];
      if (employees.length < 2) continue; // already reported per employee
      issues.push({
        id: `PAY-003:ref:${key}`,
        recordId: employees.join(','),
        name: '(multiple employees)',
        rule: 'PAY-003',
        ruleVersion: version,
        severity: 'blocking',
        title: 'Payment reference reused',
        detail: `Reference ${group[0].payment_ref} for ${group[0].period} appears against employees ${employees.join(', ')}.`,
        field: 'evidence',
        engine: 'server'
      });
    }
  }

  /* --- Three-way bank reconciliation ----------------------------------------
   * The matching itself is done by reconciliation.service and handed in, so these
   * rules only translate a proved state into findings. The reconciliation rows
   * carry the same identifiers used everywhere else, which is what lets a draft
   * that cites them be checked against reality. */
  if (reconciliation && reconciliation.applicable) {
    const nameFor = employeeNo => records.find(row => row.employee_no === employeeNo)?.name || '(no payroll record)';

    if (enabled.has('BANK-001')) {
      for (const row of reconciliation.unmatched) {
        issues.push({
          id: `BANK-001:${row.reference || row.paymentId}`,
          recordId: row.employeeNo || row.reference || row.paymentId,
          name: nameFor(row.employeeNo),
          rule: 'BANK-001',
          ruleVersion: version,
          severity: 'blocking',
          title: 'Payment not confirmed by the bank statement',
          detail: `Payment reference ${row.reference || '(missing)'} for ${money.toAmount(row.amountCents)} SGD `
            + `has no matching bank transaction. ${row.detail}`,
          field: 'netPaid',
          engine: 'server'
        });
      }
    }

    if (enabled.has('BANK-002')) {
      for (const row of reconciliation.unmatchedBank) {
        issues.push({
          id: `BANK-002:${row.bankId}`,
          recordId: row.reference || row.bankId,
          name: '(bank transaction)',
          rule: 'BANK-002',
          ruleVersion: version,
          severity: 'blocking',
          title: 'Bank transaction not in the payment ledger',
          detail: `Bank reference ${row.reference || '(missing)'} moved ${money.toAmount(row.amountCents)} SGD `
            + `${row.direction === 'in' ? 'into' : 'out of'} the account on ${row.valueDate} with no corresponding imported payment. ${row.detail}`,
          field: 'evidence',
          engine: 'server'
        });
      }
    }

    if (enabled.has('BANK-003')) {
      for (const row of reconciliation.ambiguous) {
        issues.push({
          id: `BANK-003:ledger:${row.reference || row.paymentId}`,
          recordId: row.employeeNo,
          name: nameFor(row.employeeNo),
          rule: 'BANK-003',
          ruleVersion: version,
          severity: 'review',
          title: 'Ambiguous reconciliation match',
          detail: `Payment reference ${row.reference || '(missing)'} for ${money.toAmount(row.amountCents)} SGD `
            + `cannot be matched one-to-one. ${row.detail} Candidate bank rows: ${row.bankIds.join(', ') || 'none'}. `
            + 'This is not reported as reconciled.',
          field: 'netPaid',
          engine: 'server'
        });
      }
      for (const row of reconciliation.ambiguousBank) {
        issues.push({
          id: `BANK-003:bank:${row.bankId}`,
          recordId: row.reference || row.bankId,
          name: '(bank transaction)',
          rule: 'BANK-003',
          ruleVersion: version,
          severity: 'review',
          title: 'Ambiguous reconciliation match',
          detail: `Bank reference ${row.reference || '(missing)'} for ${money.toAmount(row.amountCents)} SGD `
            + `cannot be matched one-to-one. ${row.detail} Candidate payments: ${row.paymentIds.join(', ') || 'none'}. `
            + 'This is not reported as reconciled.',
          field: 'evidence',
          engine: 'server'
        });
      }
    }

    if (enabled.has('BANK-004')) {
      for (const row of reconciliation.threeWay) {
        issues.push({
          id: `BANK-004:${row.employeeNo}`,
          recordId: row.employeeNo,
          name: row.name || nameFor(row.employeeNo),
          rule: 'BANK-004',
          ruleVersion: version,
          severity: 'blocking',
          title: 'Payroll, payment ledger and bank do not agree',
          detail: row.detail,
          field: 'netPaid',
          engine: 'server'
        });
      }
    }
  }

  const ordered = issues.sort((a, b) => (a.rule === b.rule ? a.id.localeCompare(b.id) : a.rule.localeCompare(b.rule)));
  return {
    issues: ordered,
    totals: money.totals(records),
    ruleVersion: version,
    ruleLabel: LABEL,
    disclaimer: DISCLAIMER,
    evaluatedRules: DEFAULT_RULES.filter(r => enabled.has(r.id)).map(r => r.id)
  };
}

const blockingIssues = issues => issues.filter(issue => issue.severity === 'blocking');

module.exports = {
  BASE_VERSION, LABEL, DISCLAIMER, DEFAULT_RULES, CORE_RULES,
  buildRuleSet, normaliseConfig, evaluate, toCoreRow, blockingIssues, ruleMeta, enabledIds
};
