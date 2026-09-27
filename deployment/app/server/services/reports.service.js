/* Report versions and the human approval chain.
 *
 *   draft -> submitted -> finance_reviewed -> management_confirmed -> approved -> sealed
 *                                      \-> rejected -> (remediate) -> new version
 *
 * Every decision is bound to the report version and to a digest of the exact
 * inputs it was taken against. If records, payments, evidence or the rule version
 * change afterwards the decisions remain on file but stop being applicable, and a
 * new version has to be prepared. A sealed report is immutable; corrections are
 * made by amending it into a new version. */
'use strict';
const clock = require('../lib/clock');
const { id, seq } = require('../lib/ids');
const { digest } = require('../lib/hash');
const money = require('../lib/money');
const validate = require('../lib/validate');
const { badRequest, notFound, conflict, forbidden } = require('../lib/errors');
const rbac = require('../auth/rbac');
const access = require('../auth/access');
const cases = require('./cases.service');
const records = require('./records.service');
const checks = require('./checks.service');
const reconciliation = require('./reconciliation.service');
const evidenceService = require('./evidence.service');
const audit = require('./audit.service');
const draftModule = require('../agent/draft');

const TERMINAL = ['sealed', 'rejected'];
const stageFor = stage => rbac.APPROVAL_CHAIN.find(entry => entry.stage === stage);

async function loadReport(ctx, reportId) {
  const report = await ctx.store.get('reports', reportId);
  if (!report) throw notFound(`Report not found: ${reportId}`);
  return report;
}

/** Everything a report version depends on, recomputed from current state. */
async function currentInputs(store, caseRecord, checkRow) {
  const [payrollRows, payments, bank, evidence] = await Promise.all([
    records.rawList(store, caseRecord.id),
    require('./ledger-source').allPayments(store, caseRecord.id),
    reconciliation.rawBankList(store, caseRecord.id),
    store.find('evidence_files', { case_id: caseRecord.id })
  ]);
  return {
    payrollRows,
    payments,
    bank,
    evidence,
    // Recomputed rather than read back, so a draft is always validated against the
    // reconciliation that current data produces.
    reconciled: reconciliation.reconcile({ payments, bank, payrollRows }),
    digest: checks.inputDigest({ caseRecord, checkRow, payrollRows, evidence, payments, bank })
  };
}

/**
 * Whether decisions on this report still apply. Historical reports stay readable.
 */
async function applicability(ctx, report) {
  const caseRecord = await ctx.store.get('cases', report.case_id);
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const checkRow = await ctx.store.get('checks', report.check_id);
  if (!checkRow) return { applicable: false, reason: 'The check this report was produced from is no longer available.' };

  if (caseRecord.data_revision !== report.data_revision) {
    return {
      applicable: false,
      reason: `Case data has changed since this version (report v${report.data_revision}, case v${caseRecord.data_revision}). `
        + 'Recorded decisions remain on file but no longer apply. Run checks again and prepare a new report version.'
    };
  }
  if (ruleSet.version !== report.rule_version) {
    return {
      applicable: false,
      reason: `Rules have changed since this version (report ${report.rule_version}, current ${ruleSet.version}). `
        + 'Run checks again and prepare a new report version.'
    };
  }
  const inputs = await currentInputs(ctx.store, caseRecord, checkRow);
  if (inputs.digest !== report.input_digest) {
    return {
      applicable: false,
      reason: 'The inputs this report version was produced from have changed (records, payments or evidence). '
        + 'Recorded decisions remain on file but no longer apply.'
    };
  }
  return { applicable: true, reason: null, caseRecord, ruleSet, checkRow, inputs };
}

async function approvalRows(store, reportId) {
  return store.find('approvals', { report_id: reportId }, { order: [['at', 'asc'], ['id', 'asc']] });
}

async function view(ctx, report, { includeSnapshot = true } = {}) {
  const state = await applicability(ctx, report);
  const decisions = await approvalRows(ctx.store, report.id);
  const draft = report.draft || {};
  return {
    id: report.id,
    caseId: report.case_id,
    version: report.version,
    amendsReportId: report.amends_report_id || null,
    status: report.status,
    dataRevision: report.data_revision,
    ruleVersion: report.rule_version,
    checkId: report.check_id,
    mode: report.mode,
    runKind: report.run_kind,
    draftSource: report.draft_source,
    agentRunId: report.agent_run_id || null,
    inputDigest: report.input_digest,
    createdBy: report.created_by,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
    sealedAt: report.sealed_at || null,
    sealedBy: report.sealed_by || null,
    sealManifest: report.seal_manifest || null,
    applicable: state.applicable,
    staleReason: state.reason,
    nextStage: nextStageFor(report, state.applicable),
    draft,
    text: draft.summary ? draftModule.toText(report, draft) : null,
    snapshot: includeSnapshot ? report.snapshot : undefined,
    decisions: decisions.map(row => ({
      id: row.id,
      stage: row.stage,
      decision: row.decision,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      note: row.note,
      at: row.at,
      reportVersion: row.report_version,
      inputDigest: row.input_digest,
      // A decision taken against different inputs is preserved but marked.
      appliesToCurrentInputs: row.input_digest === report.input_digest && state.applicable
    }))
  };
}

function nextStageFor(report, applicable) {
  if (!applicable || TERMINAL.includes(report.status)) return null;
  const entry = rbac.APPROVAL_CHAIN.find(step => step.from === report.status);
  return entry ? { stage: entry.stage, permission: entry.permission, label: entry.label } : null;
}

/**
 * Creates a new report version from the current, fresh check.
 * @param {object} options.draftOverride validated structured draft from an agent run
 */
async function create(ctx, caseId, input = {}) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'reports.create');
  const body = validate.only(input, ['amendsReportId', 'draft', 'agentRunId', 'mode', 'runKind', 'draftSource'], 'Report');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const checkRow = await checks.latestRow(ctx.store, caseId);
  if (!checkRow) throw badRequest('Run the checks before preparing a report');
  if (!checks.isCurrent(checkRow, caseRecord, ruleSet)) {
    throw conflict('Data or rules have changed since the last check. Run the checks again before preparing a report.', {
      checkedDataRevision: checkRow.data_revision,
      currentDataRevision: caseRecord.data_revision,
      checkedRuleVersion: checkRow.rule_version,
      currentRuleVersion: ruleSet.version
    });
  }

  let amends = null;
  if (body.amendsReportId) {
    amends = await loadReport(ctx, body.amendsReportId);
    if (amends.case_id !== caseId) throw badRequest('The amended report belongs to a different case');
    if (amends.status !== 'sealed') throw badRequest('Only a sealed report can be amended. Prepare a new version instead.');
  }

  const inputs = await currentInputs(ctx.store, caseRecord, checkRow);
  const evidenceManifest = inputs.evidence.map(evidenceService.publicFile);
  const context = draftModule.buildContext({
    caseRecord, checkRow, payrollRows: inputs.payrollRows, evidence: evidenceManifest, ruleSet,
    payments: inputs.payments, bank: inputs.bank, reconciliation: inputs.reconciled
  });

  const source = body.draft ? 'model' : 'template';
  const candidate = body.draft || draftModule.template(context);
  // Model output and template output pass through exactly the same validation.
  const validated = draftModule.validate(candidate, context);

  const version = await ctx.store.nextValue(`report:${caseId}`);
  const now = clock.now();
  const report = await ctx.store.insert('reports', {
    // Readable and unique: sequence within the case, suffixed with the case tail.
    id: `${seq('RPT', version)}-${caseId.slice(-6).toUpperCase()}`,
    case_id: caseId,
    version,
    amends_report_id: amends ? amends.id : null,
    data_revision: checkRow.data_revision,
    rule_version: checkRow.rule_version,
    check_id: checkRow.id,
    status: 'draft',
    mode: body.mode || (source === 'model' ? 'agent' : 'template'),
    run_kind: body.runKind || 'deterministic-template',
    draft_source: body.draftSource || source,
    agent_run_id: body.agentRunId || null,
    snapshot: {
      records: inputs.payrollRows.map(records.publicRow),
      payments: inputs.payments,
      bank: inputs.bank,
      reconciliation: inputs.reconciled,
      paymentBatches: await ctx.store.find('payment_batches', { case_id: caseId }),
      bankBatches: await ctx.store.find('bank_batches', { case_id: caseId }),
      totals: checkRow.totals,
      issues: checkRow.issues,
      evidence: evidenceManifest,
      casePeriod: caseRecord.period,
      ruleSet: { version: ruleSet.version, label: ruleSet.label, disclaimer: ruleSet.disclaimer, rules: ruleSet.config.rules }
    },
    draft: validated,
    input_digest: inputs.digest,
    created_by: ctx.actor.id,
    created_at: now,
    updated_at: now,
    sealed_at: null,
    sealed_by: null,
    seal_manifest: null
  });

  await audit.record(ctx, 'report.created', {
    caseId, subjectType: 'report', subjectId: report.id,
    detail: {
      version, dataRevision: checkRow.data_revision, ruleVersion: checkRow.rule_version,
      draftSource: report.draft_source, runKind: report.run_kind, agentRunId: report.agent_run_id,
      inputDigest: inputs.digest, amendsReportId: report.amends_report_id
    }
  });
  return view(ctx, report);
}

/** Guards against a person advancing their own work. */
async function assertNoSelfApproval(ctx, report, stage) {
  if (stage === 'submit') return; // submitting is not an approval
  if (report.created_by === ctx.actor.id) {
    throw forbidden('You prepared this report version, so you cannot also record an approval decision on it', {
      stage, reportId: report.id, preparedBy: report.created_by
    });
  }
  const existing = await approvalRows(ctx.store, report.id);
  // Sealing finalises a decision the same director already took; it is not a
  // second, independent approval, so it is exempt from the distinct-actor rule.
  const own = stage === 'seal' ? null : existing.find(row => row.actor_id === ctx.actor.id && row.stage !== stage);
  if (own) {
    throw forbidden(`You already recorded the ${own.stage} decision on this report version, so you cannot also perform ${stage}`, {
      stage, previousStage: own.stage, reportId: report.id
    });
  }
  const repeat = existing.find(row => row.actor_id === ctx.actor.id && row.stage === stage);
  if (repeat) throw conflict(`A ${stage} decision has already been recorded by this account for this version`);
}

async function advance(ctx, reportId, stage, input) {
  const entry = stageFor(stage);
  if (!entry) throw badRequest(`Unknown approval stage: ${stage}`);
  const report = await loadReport(ctx, reportId);
  await access.requireCase(ctx, report.case_id, entry.permission);

  const body = validate.only(input, ['note'], 'Decision');
  const note = validate.text(body.note, stage === 'seal' ? 'Sealing note' : 'Decision note', { max: 1000, multiline: true });

  if (report.status !== entry.from) {
    throw conflict(`This report is ${report.status}. The ${stage} step requires status ${entry.from}.`, {
      status: report.status, requiredStatus: entry.from
    });
  }
  const state = await applicability(ctx, report);
  if (!state.applicable) throw conflict(state.reason, { reportId, applicable: false });
  await assertNoSelfApproval(ctx, report, stage);

  const now = clock.now();
  const result = await ctx.store.tx(async store => {
    const patch = { status: entry.to, updated_at: now };
    if (stage === 'seal') {
      patch.sealed_at = now;
      patch.sealed_by = ctx.actor.id;
      patch.seal_manifest = await buildSealManifest(store, report, ctx.actor.id, now);
    }
    const updated = await store.update('reports', report.id, patch);
    await store.insert('approvals', {
      id: id('apr'),
      report_id: report.id,
      case_id: report.case_id,
      report_version: report.version,
      input_digest: report.input_digest,
      stage,
      decision: stage === 'seal' ? 'sealed' : 'advanced',
      actor_id: ctx.actor.id,
      actor_role: ctx.actor.role,
      note,
      at: now
    });
    return updated;
  });

  await audit.record(ctx, `report.${stage}`, {
    caseId: report.case_id, subjectType: 'report', subjectId: report.id,
    detail: { stage, fromStatus: entry.from, toStatus: entry.to, version: report.version, inputDigest: report.input_digest }
  });
  return view(ctx, result);
}

/** Return for remediation. Recorded decisions stay on file. */
async function reject(ctx, reportId, input) {
  const report = await loadReport(ctx, reportId);
  const allowed = ['submitted', 'finance_reviewed', 'management_confirmed'];
  if (!allowed.includes(report.status)) {
    throw conflict(`A report with status ${report.status} cannot be returned`, { allowedStatuses: allowed });
  }
  // The role that would have advanced this stage is the role that may return it.
  const entry = rbac.APPROVAL_CHAIN.find(step => step.from === report.status);
  await access.requireCase(ctx, report.case_id, entry.permission);
  const body = validate.only(input, ['note'], 'Rejection');
  const note = validate.text(body.note, 'Reason for return', { max: 1000, multiline: true });
  await assertNoSelfApproval(ctx, report, entry.stage);

  const now = clock.now();
  const result = await ctx.store.tx(async store => {
    const updated = await store.update('reports', report.id, { status: 'rejected', updated_at: now });
    await store.insert('approvals', {
      id: id('apr'),
      report_id: report.id,
      case_id: report.case_id,
      report_version: report.version,
      input_digest: report.input_digest,
      stage: entry.stage,
      decision: 'rejected',
      actor_id: ctx.actor.id,
      actor_role: ctx.actor.role,
      note,
      at: now
    });
    return updated;
  });

  await audit.record(ctx, 'report.rejected', {
    caseId: report.case_id, subjectType: 'report', subjectId: report.id,
    detail: { stage: entry.stage, version: report.version, previousStatus: report.status }
  });
  return view(ctx, result);
}

/** Hash manifest fixing the sealed content and its linked evidence. */
async function buildSealManifest(store, report, actorId, at) {
  const evidence = (await store.find('evidence_files', { case_id: report.case_id })).filter(file => !file.superseded_by);
  const decisions = await approvalRows(store, report.id);
  const entries = [
    { name: 'report.json', sha256: digest({ id: report.id, version: report.version, draft: report.draft, snapshot: report.snapshot }) },
    { name: 'rule-results.json', sha256: digest(report.snapshot.issues || []) },
    { name: 'approvals.json', sha256: digest(decisions.map(d => [d.stage, d.decision, d.actor_id, d.at, d.note])) },
    ...evidence.map(file => ({ name: `evidence/${file.id}-${file.filename}`, sha256: file.sha256, version: file.version, bytes: file.size_bytes }))
  ];
  return {
    sealedAt: at,
    sealedBy: actorId,
    inputDigest: report.input_digest,
    dataRevision: report.data_revision,
    ruleVersion: report.rule_version,
    entries,
    manifestDigest: digest(entries),
    note: 'Hashes fix the sealed content. They demonstrate that stored bytes are unchanged; they do not authenticate the original documents.'
  };
}

async function list(ctx, caseId) {
  await access.requireCase(ctx, caseId, 'reports.read');
  const rows = await ctx.store.find('reports', { case_id: caseId }, { order: [['version', 'desc']] });
  const out = [];
  for (const row of rows) out.push(await view(ctx, row, { includeSnapshot: false }));
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId, subjectType: 'reports', subjectId: caseId, detail: { reportCount: rows.length } });
  }
  return out;
}

async function detail(ctx, reportId) {
  const report = await loadReport(ctx, reportId);
  await access.requireCase(ctx, report.case_id, 'reports.read');
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId: report.case_id, subjectType: 'report', subjectId: report.id });
  }
  return view(ctx, report);
}

/** Latest version, plus whether a new one can be prepared right now. */
async function summary(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'reports.read');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const checkRow = await checks.latestRow(ctx.store, caseId);
  const rows = await ctx.store.find('reports', { case_id: caseId }, { order: [['version', 'desc']], limit: 1 });
  return {
    caseId,
    dataRevision: caseRecord.data_revision,
    ruleVersion: ruleSet.version,
    checkCurrent: checks.isCurrent(checkRow, caseRecord, ruleSet),
    latest: rows[0] ? await view(ctx, rows[0], { includeSnapshot: false }) : null,
    canPrepare: !!checkRow && checks.isCurrent(checkRow, caseRecord, ruleSet),
    totals: checkRow ? Object.fromEntries(Object.entries(checkRow.totals).map(([k, v]) => [k, money.toAmount(v)])) : null
  };
}

module.exports = {
  create, advance, reject, list, detail, summary, view, applicability,
  loadReport, currentInputs, buildSealManifest, TERMINAL
};
