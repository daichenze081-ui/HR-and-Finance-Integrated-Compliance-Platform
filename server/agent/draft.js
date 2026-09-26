/* Report draft structure, validation and the deterministic template generator.
 *
 * A draft is only accepted if:
 *   - the structure and field types are exactly as declared;
 *   - every rule identifier it cites was actually evaluated;
 *   - every record and evidence identifier it cites exists in the case;
 *   - the key amounts equal the server-computed totals to the cent;
 *   - evidence that could not be read is listed for human review rather than
 *     described as checked.
 *
 * This is what stops a model from inventing findings, amounts or sources. The
 * model never computes the numbers: it is given them and must reproduce them. */
'use strict';
const money = require('../lib/money');
const { unprocessable } = require('../lib/errors');
const registry = require('../rules/registry');

const SCHEMA_VERSION = 'people-ledger-draft-v1';
const AMOUNT_KEYS = ['grossPay', 'deductions', 'expectedNet', 'recordedPaid'];
const SEVERITIES = ['blocking', 'review', 'informational'];

const STANDING_LIMITATIONS = [
  'Demonstration rules only. This draft is not a statutory, tax or legal compliance determination.',
  'Deductions are values recorded in the source data. CPF and income tax are not calculated.',
  'Evidence references and uploaded files are not authenticated. A matching SHA-256 shows the stored bytes are unchanged, not that a document is genuine.',
  'This draft is prepared for human review and is not an audit opinion or assurance conclusion.'
];

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function fail(message, detail) { throw unprocessable(message, detail); }

/** Trims model text to a bounded, control-character-free string. */
function clean(value, max) {
  return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

/**
 * Validation context assembled entirely from server state.
 *
 * `payments`, `bank` and `reconciliation` are optional so an older caller keeps
 * working, but when they are supplied the draft is additionally held to the
 * financial totals, the bank sources and the proved reconciliation status.
 */
function buildContext({ caseRecord, checkRow, payrollRows, evidence, ruleSet, payments = [], bank = [], reconciliation = null }) {
  const totals = checkRow.totals;
  const paymentsTotal = money.sum(payments.filter(row => row.direction !== 'in').map(row => row.amount_cents));
  const bankIn = money.sum(bank.filter(row => row.direction === 'in').map(row => row.amount_cents));
  const bankOut = money.sum(bank.filter(row => row.direction === 'out').map(row => row.amount_cents));

  // Every reference the draft is allowed to treat as reconciled, and every one it
  // must not. Built from the deterministic reconciliation, never from the draft.
  const reconciledRefs = new Set();
  const unresolvedRefs = new Map(); // reference -> 'unmatched' | 'ambiguous'
  if (reconciliation) {
    for (const row of reconciliation.matched || []) if (row.reference) reconciledRefs.add(row.reference);
    for (const row of (reconciliation.bankRows || []).filter(entry => entry.status === 'matched')) {
      if (row.reference) reconciledRefs.add(row.reference);
    }
    for (const bucket of ['unmatched', 'ambiguous']) {
      for (const row of reconciliation[bucket] || []) if (row.reference) unresolvedRefs.set(row.reference, bucket);
    }
    for (const row of reconciliation.unmatchedBank || []) if (row.reference) unresolvedRefs.set(row.reference, 'unmatched');
    for (const row of reconciliation.ambiguousBank || []) if (row.reference) unresolvedRefs.set(row.reference, 'ambiguous');
    // A reference that is unresolved on either side is not reconciled at all.
    for (const reference of unresolvedRefs.keys()) reconciledRefs.delete(reference);
  }

  return {
    caseId: caseRecord.id,
    period: caseRecord.period,
    dataRevision: checkRow.data_revision,
    ruleVersion: checkRow.rule_version,
    ruleLabel: ruleSet.label,
    disclaimer: ruleSet.disclaimer,
    issues: checkRow.issues || [],
    recordIds: new Set(payrollRows.map(row => row.employee_no)),
    /* What a finding may name as its subject. Payroll records plus the subjects the
     * rule engine itself reported on, because some rules are about a payment
     * reference or a bank transaction rather than an employee. */
    citableSubjects: new Set([
      ...payrollRows.map(row => row.employee_no),
      ...(checkRow.issues || []).map(issue => issue.recordId).filter(Boolean),
      ...payments.map(row => row.payment_ref).filter(Boolean),
      ...bank.map(row => row.txn_ref).filter(Boolean),
      ...bank.map(row => row.id)
    ]),
    evaluatedRules: new Set((ruleSet.config?.rules || []).filter(r => r.enabled).map(r => r.id)),
    evidenceById: new Map(evidence.map(file => [file.id, file])),
    unreadableEvidence: evidence.filter(file => !file.readable),
    totals,
    keyAmounts: {
      grossPay: money.toAmount(totals.gross),
      deductions: money.toAmount(totals.deductions),
      expectedNet: money.toAmount(totals.expected),
      recordedPaid: money.toAmount(totals.paid)
    },
    // --- financial and bank state --------------------------------------------
    financeTotals: {
      paymentLedgerTotal: money.toAmount(paymentsTotal),
      bankIn: money.toAmount(bankIn),
      bankOut: money.toAmount(bankOut),
      bankNetMovement: money.toAmount(bankIn - bankOut),
      currency: 'SGD'
    },
    paymentRefs: new Set(payments.map(row => row.payment_ref).filter(Boolean)),
    bankIds: new Set(bank.map(row => row.id)),
    bankRefs: new Set(bank.map(row => row.txn_ref).filter(Boolean)),
    bankImported: bank.length > 0,
    reconciliation,
    reconciliationApplicable: !!reconciliation && reconciliation.applicable === true,
    reconciledRefs,
    unresolvedRefs,
    /* Every monetary value the server itself produced. A currency amount in the
     * draft text that is not in here was not derived from the reviewed data. */
    knownAmounts: collectKnownAmounts({ totals, payrollRows, payments, bank, issues: checkRow.issues || [], paymentsTotal, bankIn, bankOut }),
    /* Every identifier the draft may name. Rule identifiers are included because
     * a draft legitimately cites the rule that produced a finding. */
    knownIdentifiers: collectKnownIdentifiers({ payrollRows, payments, bank, evidence, ruleSet, caseRecord, issues: checkRow.issues || [] }),
    recordCount: payrollRows.length
  };
}

/** Canonical two-decimal strings for every amount the server can vouch for. */
function collectKnownAmounts({ totals, payrollRows, payments, bank, issues, paymentsTotal, bankIn, bankOut }) {
  const known = new Set();
  const add = cents => { if (Number.isSafeInteger(cents)) known.add(money.toAmount(cents)); };

  for (const value of Object.values(totals || {})) add(value);
  add(paymentsTotal); add(bankIn); add(bankOut); add(bankIn - bankOut); add(0);

  for (const row of payrollRows) {
    const derived = [
      row.base_pay_cents, row.allowances_cents, row.deductions_cents, row.net_paid_cents,
      money.gross(row), money.expectedNet(row), money.expectedNet(row) - row.net_paid_cents,
      row.net_paid_cents - money.expectedNet(row)
    ];
    for (const value of derived) add(value);
    // Per-employee ledger and bank sums, and the differences a finding may quote.
    const employeePayments = payments.filter(payment => payment.employee_no === row.employee_no);
    const paidTotal = money.sum(employeePayments.map(payment => payment.amount_cents));
    add(paidTotal);
    add(paidTotal - row.net_paid_cents);
    add(row.net_paid_cents - paidTotal);
  }
  for (const payment of payments) add(payment.amount_cents);
  for (const transaction of bank) add(transaction.amount_cents);

  /* Rule findings are server-generated text. Any amount the engine printed there is
   * by definition server-derived, so quoting a finding verbatim stays valid. */
  for (const issue of issues) {
    for (const match of String(issue.detail || '').matchAll(AMOUNT_IN_TEXT)) known.add(match[0].replace(/,/g, ''));
  }
  return known;
}

/** Identifier tokens the draft may name, in the shape they appear in the data. */
function collectKnownIdentifiers({ payrollRows, payments, bank, evidence, ruleSet, caseRecord, issues = [] }) {
  const known = new Set();
  const add = value => { const text = String(value ?? '').trim(); if (text) known.add(text.toUpperCase()); };
  /* Server-generated prose (filenames, review reasons, finding text) legitimately
   * contains identifier-shaped tokens. Harvesting them from that text keeps the
   * allow-list derived from server state rather than from guesses about format. */
  const harvest = value => {
    for (const match of String(value ?? '').matchAll(IDENTIFIER_IN_TEXT)) add(match[0]);
  };

  for (const row of payrollRows) {
    add(row.employee_no); add(row.cost_center); add(row.evidence_ref);
    harvest(row.department);
  }
  for (const payment of payments) { add(payment.employee_no); add(payment.payment_ref); add(payment.batch_id); }
  for (const transaction of bank) {
    add(transaction.txn_ref); add(transaction.id); add(transaction.batch_id);
    harvest(transaction.counterparty); harvest(transaction.description);
  }
  for (const file of evidence) {
    add(file.id); add(file.subjectId ?? file.subject_id); add(file.filename);
    harvest(file.filename); harvest(file.reviewReason ?? file.review_reason);
  }
  for (const issue of issues) { harvest(issue.title); harvest(issue.detail); add(issue.recordId); }
  for (const rule of registry.DEFAULT_RULES) add(rule.id);
  for (const rule of ruleSet.config?.rules || []) add(rule.id);
  add(caseRecord.id);
  add(caseRecord.period);
  add('SGD');
  add('CPF');
  return known;
}

/**
 * @param {object} draft candidate draft, treated as untrusted model output
 * @param {object} context result of buildContext
 * @returns {object} normalised draft safe to persist
 */
function validate(draft, context) {
  if (!isPlainObject(draft)) fail('The draft must be a JSON object');

  const summary = isString(draft.summary, 3000) ? clean(draft.summary, 3000) : fail('The draft must include a summary');
  if (!Array.isArray(draft.findings)) fail('The draft must include a findings list');
  if (draft.findings.length > 200) fail('The draft may contain at most 200 findings');
  if (!Array.isArray(draft.recommendations) || !draft.recommendations.length) fail('The draft must include at least one recommendation');
  if (!Array.isArray(draft.itemsRequiringHumanReview)) fail('The draft must include an itemsRequiringHumanReview list');
  if (!Array.isArray(draft.ruleVersions) || !draft.ruleVersions.length) fail('The draft must state the rule versions it was produced against');
  if (!isPlainObject(draft.keyAmounts)) fail('The draft must include keyAmounts');

  // --- Rule versions must match the check exactly ---------------------------
  const versions = draft.ruleVersions.map(v => clean(v, 80));
  if (versions.length !== 1 || versions[0] !== context.ruleVersion) {
    fail('The draft rule version does not match the check it was produced from', { expected: [context.ruleVersion], received: versions });
  }

  // --- Key amounts must equal the server totals to the cent ----------------
  const mismatched = AMOUNT_KEYS.filter(key => clean(draft.keyAmounts[key], 32) !== context.keyAmounts[key]);
  if (mismatched.length) {
    fail('The draft key amounts do not match the server-computed totals', {
      mismatchedFields: mismatched,
      expected: context.keyAmounts,
      received: Object.fromEntries(AMOUNT_KEYS.map(key => [key, clean(draft.keyAmounts[key], 32)]))
    });
  }

  // --- Findings: rule identifiers and record identifiers must exist ---------
  const findings = draft.findings.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`Finding ${index + 1} must be an object`);
    const ruleId = clean(raw.ruleId, 40);
    if (!context.evaluatedRules.has(ruleId)) {
      fail(`Finding ${index + 1} cites rule ${ruleId || '(empty)'}, which was not evaluated for this case`, { evaluatedRules: [...context.evaluatedRules] });
    }
    const recordId = clean(raw.recordId, 60);
    if (recordId && recordId !== 'case' && !context.citableSubjects.has(recordId)) {
      fail(`Finding ${index + 1} cites record ${recordId}, which does not exist in this case`);
    }
    const severity = SEVERITIES.includes(raw.severity) ? raw.severity : (registry.ruleMeta(ruleId).severity || 'review');
    const evidenceRefs = Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.map(r => clean(r, 80)) : [];
    for (const reference of evidenceRefs) {
      if (!context.evidenceById.has(reference)) {
        fail(`Finding ${index + 1} references evidence ${reference}, which does not exist in this case`, { knownEvidence: [...context.evidenceById.keys()].slice(0, 20) });
      }
    }
    return {
      ruleId,
      recordId: recordId || 'case',
      severity,
      explanation: isString(raw.explanation, 1500) ? clean(raw.explanation, 1500) : fail(`Finding ${index + 1} must include an explanation`),
      riskExplanation: isString(raw.riskExplanation, 1500) ? clean(raw.riskExplanation, 1500) : fail(`Finding ${index + 1} must include a riskExplanation`),
      evidenceRefs
    };
  });

  // Every blocking finding produced by the rule engine must appear in the draft.
  const blockingRules = new Set(registry.blockingIssues(context.issues).map(issue => `${issue.rule}:${issue.recordId}`));
  const covered = new Set(findings.map(f => `${f.ruleId}:${f.recordId}`));
  const omitted = [...blockingRules].filter(key => !covered.has(key));
  if (omitted.length) {
    fail('The draft omits blocking findings produced by the rule engine', { omitted });
  }

  // --- Evidence references --------------------------------------------------
  const evidenceReferences = (Array.isArray(draft.evidenceReferences) ? draft.evidenceReferences : []).map((raw, index) => {
    const reference = isPlainObject(raw) ? clean(raw.evidenceId, 80) : clean(raw, 80);
    const file = context.evidenceById.get(reference);
    if (!file) fail(`Evidence reference ${index + 1} (${reference || 'empty'}) does not exist in this case`);
    return {
      evidenceId: file.id,
      filename: file.filename,
      sha256: file.sha256,
      version: file.version,
      readable: !!file.readable,
      reviewRequired: !file.readable,
      relevance: isPlainObject(raw) && isString(raw.relevance, 400) ? clean(raw.relevance, 400) : 'Cited as a source for this review.'
    };
  });

  const humanReview = draft.itemsRequiringHumanReview.map((raw, index) => {
    const item = isPlainObject(raw) ? clean(raw.item, 400) : clean(raw, 400);
    if (!item) fail(`itemsRequiringHumanReview entry ${index + 1} must include an item`);
    return { item, reason: isPlainObject(raw) && isString(raw.reason, 800) ? clean(raw.reason, 800) : 'Requires a person to confirm.' };
  });

  // Unreadable evidence must never be presented as checked.
  const citedUnreadable = evidenceReferences.filter(reference => reference.reviewRequired);
  const humanReviewText = humanReview.map(entry => `${entry.item} ${entry.reason}`).join(' ').toLowerCase();
  for (const reference of citedUnreadable) {
    if (!humanReviewText.includes(reference.evidenceId.toLowerCase()) && !humanReviewText.includes(reference.filename.toLowerCase())) {
      fail(`Evidence ${reference.evidenceId} (${reference.filename}) could not be read by the system, so it must be listed under itemsRequiringHumanReview and not reported as checked`);
    }
  }
  if (registry.blockingIssues(context.issues).length && !humanReview.length) {
    fail('Blocking findings are present, so the draft must list at least one item requiring human review');
  }

  const recommendations = draft.recommendations
    .map((value, index) => (isString(value, 600) ? clean(value, 600) : fail(`Recommendation ${index + 1} must be text`)))
    .slice(0, 40);

  const declared = Array.isArray(draft.limitations) ? draft.limitations.filter(v => isString(v, 600)).map(v => clean(v, 600)) : [];

  // --- financial totals, bank sources and reconciliation status --------------
  const financeTotals = validateFinance(draft, context);
  const bankReferences = validateBankReferences(draft, context);
  validateReconciliationClaims(draft, findings, context);

  /* --- free text must align with the structured data -----------------------
   * Correct structured fields are not sufficient. The prose is what a reviewer
   * reads, so every currency amount and every identifier it names is checked
   * against server state as well. */
  alignText(
    [
      { label: 'summary', text: summary },
      ...findings.flatMap((finding, index) => [
        { label: `finding ${index + 1} explanation`, text: finding.explanation },
        { label: `finding ${index + 1} riskExplanation`, text: finding.riskExplanation }
      ]),
      ...recommendations.map((text, index) => ({ label: `recommendation ${index + 1}`, text })),
      ...humanReview.flatMap((entry, index) => [
        { label: `itemsRequiringHumanReview ${index + 1} item`, text: entry.item },
        { label: `itemsRequiringHumanReview ${index + 1} reason`, text: entry.reason }
      ]),
      ...evidenceReferences.map((entry, index) => ({ label: `evidence reference ${index + 1} relevance`, text: entry.relevance })),
      ...declared.map((text, index) => ({ label: `limitation ${index + 1}`, text }))
    ],
    context
  );

  return {
    schema: SCHEMA_VERSION,
    summary,
    period: context.period,
    dataRevision: context.dataRevision,
    ruleVersions: versions,
    ruleLabel: context.ruleLabel,
    keyAmounts: { ...context.keyAmounts, currency: 'SGD' },
    financeTotals: financeTotals || context.financeTotals,
    bankReferences,
    reconciliation: context.reconciliation
      ? {
        applicable: context.reconciliationApplicable,
        method: context.reconciliation.method,
        counts: context.reconciliation.counts,
        // Recorded from server state, never from the draft, so the report cannot
        // present a stronger reconciliation than the one that was proved.
        unresolvedReferences: [...context.unresolvedRefs].map(([reference, status]) => ({ reference, status }))
      }
      : null,
    findings,
    evidenceReferences,
    recommendations,
    itemsRequiringHumanReview: humanReview,
    limitations: [...new Set([...declared, ...STANDING_LIMITATIONS, context.disclaimer])],
    recordCount: context.recordCount
  };
}

// ---------------------------------------------------------------------------
// Financial totals, bank sources and reconciliation claims
// ---------------------------------------------------------------------------

const FINANCE_KEYS = ['paymentLedgerTotal', 'bankIn', 'bankOut', 'bankNetMovement'];

/** A declared financial total must equal the server figure to the cent. */
function validateFinance(draft, context) {
  if (draft.financeTotals === undefined || draft.financeTotals === null) return null;
  if (!isPlainObject(draft.financeTotals)) fail('financeTotals must be a JSON object');
  const supplied = Object.keys(draft.financeTotals).filter(key => key !== 'currency');
  const unknown = supplied.filter(key => !FINANCE_KEYS.includes(key));
  if (unknown.length) fail(`financeTotals contains unsupported field(s): ${unknown.join(', ')}`, { supported: FINANCE_KEYS });
  const mismatched = supplied.filter(key => clean(draft.financeTotals[key], 32) !== context.financeTotals[key]);
  if (mismatched.length) {
    fail('The draft financial totals do not match the server-computed totals', {
      mismatchedFields: mismatched,
      expected: context.financeTotals,
      received: Object.fromEntries(supplied.map(key => [key, clean(draft.financeTotals[key], 32)]))
    });
  }
  return { ...context.financeTotals };
}

/** Every cited bank source must be a bank transaction actually imported here. */
function validateBankReferences(draft, context) {
  const raw = draft.bankReferences;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('bankReferences must be a list');
  if (raw.length > 500) fail('bankReferences may contain at most 500 entries');

  return raw.map((entry, index) => {
    const reference = clean(isPlainObject(entry) ? (entry.reference ?? entry.txnRef ?? entry.bankId) : entry, 120);
    if (!reference) fail(`bankReference ${index + 1} must name a bank transaction`);
    if (!context.bankImported) {
      fail(`bankReference ${index + 1} cites ${reference}, but no bank statement has been imported for this case`);
    }
    if (!context.bankRefs.has(reference) && !context.bankIds.has(reference)) {
      fail(`bankReference ${index + 1} cites bank transaction ${reference}, which does not exist in this case`, {
        knownBankReferences: [...context.bankRefs].slice(0, 20)
      });
    }
    const status = context.unresolvedRefs.get(reference)
      || (context.reconciledRefs.has(reference) ? 'matched' : 'unmatched');
    // A declared status may not overstate the proved one.
    const claimed = isPlainObject(entry) ? clean(entry.status, 20).toLowerCase() : '';
    if (claimed && claimed !== status) {
      fail(`bankReference ${index + 1} (${reference}) is recorded as "${status}" by the server reconciliation but the draft states "${claimed}"`);
    }
    return { reference, status };
  });
}

const MATCH_CLAIM = /\b(reconcil\w*|matched|matches|match\b|confirmed|confirms|verified|verifies|agrees|agreed|traced|cleared|tallies|tallied|substantiat\w*|evidenced)\b/i;
const NEGATED_CLAIM = /\b(not|never|no|cannot|can't|without|un\w*matched|unmatched|unconfirmed|unverified|fails?|failed|missing|absent|outstanding|pending|ambiguous|discrepan\w*|disagree\w*)\b/i;

const sentencesOf = text => String(text || '').split(/(?<=[.!?;:])\s+|\n+/).filter(Boolean);

/**
 * Refuses a draft that presents an unmatched or ambiguous row as reconciled,
 * whether it does so in a structured field or in prose.
 */
function validateReconciliationClaims(draft, findings, context) {
  if (!context.reconciliation) return;

  // Structured: a per-finding reconciliation status may not overstate the proof.
  for (const [index, raw] of (Array.isArray(draft.findings) ? draft.findings : []).entries()) {
    if (!isPlainObject(raw)) continue;
    const claimed = clean(raw.reconciliationStatus, 20).toLowerCase();
    if (!claimed) continue;
    if (!['matched', 'unmatched', 'ambiguous'].includes(claimed)) {
      fail(`Finding ${index + 1} declares an unsupported reconciliationStatus "${claimed}"`, { supported: ['matched', 'unmatched', 'ambiguous'] });
    }
    const reference = clean(raw.bankReference ?? raw.paymentRef ?? '', 120);
    const actual = reference
      ? (context.unresolvedRefs.get(reference) || (context.reconciledRefs.has(reference) ? 'matched' : null))
      : null;
    if (reference && actual === null) {
      fail(`Finding ${index + 1} cites reference ${reference}, which is not part of the reconciled data for this case`);
    }
    if (actual && claimed !== actual) {
      fail(`Finding ${index + 1} states reference ${reference} is "${claimed}" but the server reconciliation proved it is "${actual}"`);
    }
    if (claimed === 'matched' && !reference) {
      fail(`Finding ${index + 1} claims a matched reconciliation without naming the reference it was matched against`);
    }
  }

  // Prose: an unresolved reference must not appear in a sentence asserting a match.
  if (!context.unresolvedRefs.size) return;
  const passages = [
    { label: 'summary', text: draft.summary },
    ...findings.map((finding, index) => ({ label: `finding ${index + 1}`, text: `${finding.explanation} ${finding.riskExplanation}` })),
    ...(Array.isArray(draft.recommendations) ? draft.recommendations : []).map((text, index) => ({ label: `recommendation ${index + 1}`, text }))
  ];
  for (const passage of passages) {
    for (const sentence of sentencesOf(passage.text)) {
      if (!MATCH_CLAIM.test(sentence) || NEGATED_CLAIM.test(sentence)) continue;
      for (const [reference, status] of context.unresolvedRefs) {
        if (!sentence.includes(reference)) continue;
        fail(
          `The ${passage.label} describes ${reference} as reconciled, but the server reconciliation records it as ${status}. `
          + 'An unmatched or ambiguous row must not be presented as matched.',
          { reference, actualStatus: status, sentence: sentence.slice(0, 300) }
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Free-text alignment
// ---------------------------------------------------------------------------

/* Amounts written as money: 1234.56, 1,234.56, optionally signed. Bare integers
 * such as record counts and data revisions are not monetary and are left alone. */
const AMOUNT_IN_TEXT = /-?\d{1,3}(?:,\d{3})*\.\d{2}\b|-?\d+\.\d{2}\b/g;
/* Identifier shape used throughout this system: EMP-001, PAY-202609-001, BANK-002,
 * CC-100, DOC-002. Also catches an explicit [kind:id] citation. */
const IDENTIFIER_IN_TEXT = /\[[a-z_]+:[^\]\s]+\]|\b[A-Z][A-Z0-9]{1,7}(?:-[A-Za-z0-9]+)+\b/g;

/**
 * Structured fields being correct is not enough to release a draft: the prose is
 * checked too. Every currency amount must be one the server computed, and every
 * identifier-shaped token must name something that exists in this case.
 */
function alignText(passages, context) {
  for (const passage of passages) {
    const text = String(passage.text || '');

    for (const match of text.matchAll(AMOUNT_IN_TEXT)) {
      if (!isMonetary(text, match)) continue;
      const normalised = match[0].replace(/,/g, '');
      if (context.knownAmounts.has(normalised)) continue;
      fail(
        `The draft ${passage.label} states the amount ${match[0]}, which is not a figure the server computed from the reviewed data. `
        + 'Every amount in the text must correspond to a stored record, payment, bank transaction or server total.',
        { amount: match[0], field: passage.label }
      );
    }

    for (const match of text.matchAll(IDENTIFIER_IN_TEXT)) {
      const token = match[0];
      if (token.startsWith('[')) {
        const [kind, ...rest] = token.slice(1, -1).split(':');
        const reference = rest.join(':').trim();
        if (!context.knownIdentifiers.has(reference.toUpperCase())) {
          fail(
            `The draft ${passage.label} cites [${kind}:${reference}], which does not exist in this case.`,
            { citation: token, field: passage.label }
          );
        }
        continue;
      }
      if (context.knownIdentifiers.has(token.toUpperCase())) continue;
      if (isDescriptiveToken(token, context)) continue;
      fail(
        `The draft ${passage.label} names ${token}, which is not a record, payment reference, bank reference, `
        + 'evidence file or rule identifier in this case.',
        { identifier: token, field: passage.label }
      );
    }
  }
}

/**
 * Distinguishes a stated amount from a decimal that is part of a longer token,
 * such as the "2026.09" inside a rule version like DEMO-2026.09-v2. Only a
 * free-standing decimal is treated as money and held to the server figures.
 */
function isMonetary(text, match) {
  const before = match.index > 0 ? text[match.index - 1] : '';
  const after = text[match.index + match[0].length] || '';
  if (before && /[A-Za-z0-9.\-/]/.test(before)) return false;
  if (after && /[A-Za-z0-9\-/]/.test(after)) return false;
  return true;
}

/* Non-identifier tokens the prose legitimately contains: the rule version string
 * and its fragments, and the currency code. Anything else that looks like an
 * identifier has to be a real one. */
function isDescriptiveToken(token, context) {
  const upper = token.toUpperCase();
  if (context.ruleVersion && context.ruleVersion.toUpperCase().includes(upper)) return true;
  if (context.ruleLabel && context.ruleLabel.toUpperCase().includes(upper)) return true;
  return ['SGD', 'SHA-256', 'RFC4180', 'ISO-8601', 'UTF-8', 'CSV', 'XLSX'].includes(upper);
}

/** Deterministic, model-free draft. Used for template drafts and as an explicitly
 *  labelled fallback when a model run fails. */
function template(context) {
  const issues = context.issues;
  const evidenceList = [...context.evidenceById.values()];
  const unreadable = evidenceList.filter(file => !file.readable);

  const findings = issues.map(issue => ({
    ruleId: issue.rule,
    // The engine's own subject is kept verbatim so the blocking-coverage check
    // compares like with like; a rule about a payment or bank reference is not
    // silently downgraded to "case".
    recordId: issue.recordId || 'case',
    severity: issue.severity,
    explanation: `${issue.title}. ${issue.detail}`,
    riskExplanation: issue.severity === 'blocking'
      ? 'A blocking finding means the recorded figures or required references do not reconcile, so the period cannot be reported as reviewed until it is resolved or explained.'
      : 'Flagged for attention. The system could not confirm this item, so a person must decide whether it is acceptable.',
    evidenceRefs: evidenceList
      .filter(file => file.subjectId === issue.recordId || file.subject_id === issue.recordId)
      .map(file => file.id)
  }));

  const humanReview = [
    ...unreadable.map(file => ({
      item: `Evidence ${file.id} (${file.filename})`,
      reason: file.reviewReason || file.review_reason || 'Content could not be read by the system and has not been verified.'
    })),
    ...(issues.length ? [{
      item: `${issues.length} rule finding${issues.length === 1 ? '' : 's'}`,
      reason: 'Each finding must be corrected in the source records or explained by a reviewer before submission.'
    }] : [])
  ];
  if (!humanReview.length) {
    humanReview.push({
      item: 'Scope of the demonstration rules',
      reason: 'No findings were raised by the configured rules. A reviewer must still confirm that the rule set covers the risks relevant to this period.'
    });
  }

  const recommendations = issues.length
    ? [
      'Correct the source records or record an explanation for each blocking finding, then run the checks again.',
      'Upload the supporting document for every payment reference so each amount can be traced to a file.',
      'Do not submit this period for review until the blocking findings are resolved or formally accepted.'
    ]
    : [
      'Proceed to finance review. The configured rules produced no blocking findings for this data revision.',
      'Confirm that the attached evidence set is complete for the period before approval.'
    ];

  return {
    summary: `Payroll review for ${context.period} covering ${context.recordCount} employee record${context.recordCount === 1 ? '' : 's'}. `
      + `The configured demonstration rules (${context.ruleVersion}) produced ${issues.length} finding${issues.length === 1 ? '' : 's'}, `
      + `of which ${registry.blockingIssues(issues).length} ${registry.blockingIssues(issues).length === 1 ? 'is' : 'are'} blocking. `
      + 'All amounts below are computed by the server from the stored records and are not produced by a language model.',
    findings,
    evidenceReferences: evidenceList.map(file => ({
      evidenceId: file.id,
      relevance: file.readable ? 'Attached supporting file for this period.' : 'Attached file that the system could not read.'
    })),
    ruleVersions: [context.ruleVersion],
    keyAmounts: context.keyAmounts,
    financeTotals: context.financeTotals,
    // Only references the deterministic reconciliation actually matched are listed,
    // each carrying the status that was proved rather than an assumed one.
    bankReferences: context.reconciliationApplicable
      ? [
        ...[...context.reconciledRefs].map(reference => ({ reference, status: 'matched' })),
        ...[...context.unresolvedRefs].map(([reference, status]) => ({ reference, status }))
      ]
      : [],
    recommendations,
    itemsRequiringHumanReview: humanReview,
    limitations: STANDING_LIMITATIONS
  };
}

/** Plain-text rendering retained for printing and the exported package. */
function toText(report, draft) {
  const lines = [
    'HR & Finance Review Draft',
    `${report.id} | version ${report.version} | data v${report.data_revision} | ${report.created_at}`,
    `Generation: ${report.draft_source === 'model' ? 'Amazon Bedrock agent draft, validated by the server' : 'deterministic server template'}`
      + ` | run kind: ${report.run_kind}`,
    draft.summary,
    `Gross pay SGD ${draft.keyAmounts.grossPay}; deductions SGD ${draft.keyAmounts.deductions}; `
      + `expected net SGD ${draft.keyAmounts.expectedNet}; recorded paid SGD ${draft.keyAmounts.recordedPaid}.`,
    ...(draft.financeTotals
      ? [`Payment ledger SGD ${draft.financeTotals.paymentLedgerTotal}; bank in SGD ${draft.financeTotals.bankIn}; `
        + `bank out SGD ${draft.financeTotals.bankOut}; net bank movement SGD ${draft.financeTotals.bankNetMovement}.`]
      : []),
    ...(draft.reconciliation
      ? [draft.reconciliation.applicable
        ? `Three-way reconciliation: ${draft.reconciliation.counts.matched} matched, `
          + `${draft.reconciliation.counts.unmatched + draft.reconciliation.counts.bankUnmatched} unmatched, `
          + `${draft.reconciliation.counts.ambiguous + draft.reconciliation.counts.bankAmbiguous} ambiguous. `
          + `Method: ${draft.reconciliation.method}`
        : 'Three-way reconciliation: no bank statement has been imported, so no payment is reported as bank-confirmed.']
      : []),
    `Rule version ${draft.ruleVersions.join(', ')} (${draft.ruleLabel}); ${draft.findings.length} finding(s).`,
    ...draft.findings.map(f => `[${f.ruleId}] ${f.recordId}: ${f.explanation} Risk: ${f.riskExplanation}`
      + (f.evidenceRefs.length ? ` Evidence: ${f.evidenceRefs.join(', ')}.` : '')),
    'Recommendations:',
    ...draft.recommendations.map(r => `- ${r}`),
    'Requires human review:',
    ...draft.itemsRequiringHumanReview.map(i => `- ${i.item}: ${i.reason}`),
    'Evidence referenced:',
    ...(draft.evidenceReferences.length
      ? draft.evidenceReferences.map(e => `- ${e.evidenceId} ${e.filename} sha256=${e.sha256} v${e.version}`
        + `${e.reviewRequired ? ' (content not readable by the system; requires manual review)' : ''}`)
      : ['- none attached']),
    'Limitations:',
    ...draft.limitations.map(l => `- ${l}`)
  ];
  return lines.join('\n\n');
}

module.exports = {
  SCHEMA_VERSION, AMOUNT_KEYS, FINANCE_KEYS, STANDING_LIMITATIONS,
  buildContext, validate, template, toText
};
