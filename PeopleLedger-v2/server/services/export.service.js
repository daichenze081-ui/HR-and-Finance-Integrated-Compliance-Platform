/* Evidence package export.
 *
 * The package contains the report, its linked evidence files, the deterministic
 * rule results, the full approval history and a hash manifest covering every entry
 * plus the manifest itself. The existing CSV, JSON and printable outputs are
 * retained alongside it.
 *
 * Every export is written to the activity log with the identity of the requester. */
'use strict';
const core = require('../../dist/demo/core.js');
const clock = require('../lib/clock');
const { sha256, digest } = require('../lib/hash');
const money = require('../lib/money');
const zip = require('../lib/zip');
const { notFound, conflict } = require('../lib/errors');
const config = require('../config');
const access = require('../auth/access');
const cases = require('./cases.service');
const records = require('./records.service');
const checks = require('./checks.service');
const reports = require('./reports.service');
const evidenceService = require('./evidence.service');
const audit = require('./audit.service');
const rules = require('../rules/registry');
const draftModule = require('../agent/draft');
const { getStorage } = require('../adapters/storage');

const FORMAT = 'people-ledger-evidence-package-v2';

const LIMITATIONS = [
  'Synthetic demonstration data. Do not place real employee or payroll records in this system.',
  'Demonstration rules only. Nothing in this package is a statutory, tax or legal compliance determination.',
  'SHA-256 values show that stored bytes are unchanged. They do not authenticate the original documents.',
  'Evidence whose content could not be read is marked as requiring manual review and was not verified.',
  'Enterprise SSO, ERP, banking, payroll-provider and regulator integrations are not connected.',
  'Microsoft Teams scheduling is simulated. No Microsoft Graph request is made.'
];

/**
 * Builds the package in memory.
 * @returns {{filename:string, archive:Buffer, manifest:object}}
 */
async function buildPackage(ctx, caseId, { reportId = null } = {}) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'export.package');
  const allReports = await ctx.store.find('reports', { case_id: caseId }, { order: [['version', 'desc']] });
  if (!allReports.length) throw notFound('This case has no report to export');
  const target = reportId ? allReports.find(row => row.id === reportId) : allReports[0];
  if (!target) throw notFound(`Report not found in this case: ${reportId}`);

  const reportView = await reports.view(ctx, target);
  if (!Array.isArray(target.snapshot?.records)) throw conflict('This historical report has no payroll snapshot; it cannot be exported as a complete package');
  const payrollRows = target.snapshot.records;
  const evidenceSnapshot = new Map((target.snapshot.evidence || []).map(file => [file.id, file]));
  const evidenceRows = (await ctx.store.find('evidence_files', { case_id: caseId }, { order: [['uploaded_at', 'asc']] })).filter(file => evidenceSnapshot.has(file.id));
  const approvals = await ctx.store.find('approvals', { case_id: caseId }, { order: [['at', 'asc']] });
  const checkRow = await ctx.store.get('checks', target.check_id);
  const agentRuns = await ctx.store.find('agent_runs', { case_id: caseId }, { order: [['started_at', 'asc']] });
  const activity = await ctx.store.find('audit_log', { case_id: caseId }, { order: [['at', 'asc']], limit: 2000 });

  const storage = await getStorage();
  const exportedAt = clock.now();

  // --- documents -----------------------------------------------------------
  const reportJson = {
    format: FORMAT,
    report: reportView,
    casePeriod: target.snapshot.casePeriod,
    dataRevision: target.data_revision,
    ruleVersion: target.rule_version,
    sealed: target.status === 'sealed',
    sealManifest: target.seal_manifest || null
  };
  const ruleResults = {
    ruleSet: target.snapshot.ruleSet,
    checkId: target.check_id,
    dataRevision: checkRow ? checkRow.data_revision : target.data_revision,
    evaluatedAt: checkRow ? checkRow.created_at : null,
    totals: target.snapshot.totals,
    totalsFormatted: Object.fromEntries(Object.entries(target.snapshot.totals)
      .map(([key, value]) => [key, money.toAmount(value)])),
    findings: target.snapshot.issues,
    blockingCount: rules.blockingIssues(target.snapshot.issues).length
  };
  const approvalHistory = {
    chain: ['submit', 'review', 'confirm', 'approve', 'seal'],
    currentStatus: target.status,
    decisions: approvals.map(row => ({
      reportId: row.report_id,
      reportVersion: row.report_version,
      stage: row.stage,
      decision: row.decision,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      note: row.note,
      at: row.at,
      inputDigest: row.input_digest,
      appliesToExportedVersion: row.report_id === target.id && row.input_digest === target.input_digest
    })),
    note: 'Decisions taken against different inputs are retained and marked as no longer applicable.'
  };

  const entries = [];
  const add = (name, data, options = {}) => { entries.push({ name, data, ...options }); return entries[entries.length - 1]; };

  add('report.json', JSON.stringify(reportJson, null, 2));
  add('report.txt', target.draft?.summary ? draftModule.toText(target, target.draft) : 'No draft content recorded.');
  add('rule-results.json', JSON.stringify(ruleResults, null, 2));
  add('approvals.json', JSON.stringify(approvalHistory, null, 2));
  add('records.csv', core.toCSV(payrollRows.map(row => ({ id: row.employeeNo, name: row.name, department: row.department, costCenter: row.costCenter, period: row.period, basePay: row.basePay, allowances: row.allowances, deductions: row.deductions, netPaid: row.netPaid, evidence: row.evidenceRef }))), { store: true });
  add('records.json', JSON.stringify(payrollRows, null, 2));
  for (const [name, key] of [['payments.json','payments'], ['bank-transactions.json','bank'], ['reconciliation.json','reconciliation'], ['payment-imports.json','paymentBatches'], ['bank-imports.json','bankBatches']]) {
    add(name, JSON.stringify(target.snapshot[key] ?? { unavailable: true, reason: 'This older report predates financial snapshots. Current data has not been substituted.' }, null, 2));
  }
  add('agent-runs.json', JSON.stringify(agentRuns.map(row => ({
    id: row.id, status: row.status, mode: row.mode, runKind: row.run_kind,
    toolExecution: row.tool_execution, draftSource: row.draft_source,
    modelId: row.model_id, promptVersion: row.prompt_version, guardrailId: row.guardrail_id,
    inputRefs: row.input_refs, outputHash: row.output_hash, toolCalls: row.tool_calls,
    startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
    steps: row.steps
  })), null, 2));
  add('activity-log.json', JSON.stringify(activity.map(row => ({
    at: row.at, actorId: row.actor_id, actorRole: row.actor_role, action: row.action,
    subjectType: row.subject_type, subjectId: row.subject_id, detail: row.detail
  })), null, 2));

  // --- evidence files ------------------------------------------------------
  const evidenceIndex = [];
  for (const file of evidenceRows) {
    const meta = evidenceSnapshot.get(file.id);
    const entryName = `evidence/${file.id}-${file.filename}`;
    let included = false;
    let integrity = 'not-retrieved';
    try {
      const bytes = await storage.get(file.storage_key);
      const actual = sha256(bytes);
      integrity = actual === meta.sha256 ? 'verified-unchanged' : 'MISMATCH';
      if (integrity === 'verified-unchanged') {
        add(entryName, bytes, { store: true });
        included = true;
      }
    } catch (error) {
      integrity = `unavailable: ${error.message}`;
    }
    evidenceIndex.push({
      ...meta,
      packageEntry: included ? entryName : null,
      storedByteIntegrity: integrity,
      contentVerification: meta.readable
        ? 'Content is machine-readable. Authenticity of the original document is not established.'
        : 'Content could not be read by the system. Requires manual review; not verified.'
    });
  }
  add('evidence-index.json', JSON.stringify(evidenceIndex, null, 2));

  // --- hash manifest -------------------------------------------------------
  const manifestEntries = entries.map(entry => {
    const bytes = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    return { name: entry.name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = {
    format: FORMAT,
    exportedAt,
    exportedBy: { userId: ctx.actor.id, role: ctx.actor.role },
    case: { id: caseRecord.id, title: caseRecord.title, period: target.snapshot.casePeriod, dataRevision: target.data_revision },
    report: { id: target.id, version: target.version, status: target.status, inputDigest: target.input_digest },
    ruleVersion: target.rule_version,
    storage: storage.driver,
    integrations: config.integrationStatus(),
    entries: manifestEntries,
    entryCount: manifestEntries.length,
    manifestDigest: digest(manifestEntries),
    limitations: LIMITATIONS
  };
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

  const archive = zip.create(entries, { at: new Date(Date.parse(exportedAt)) });
  const filename = `people-ledger-${caseRecord.id}-${target.id}-v${target.version}.zip`;

  await audit.record(ctx, 'export.package', {
    caseId, subjectType: 'report', subjectId: target.id,
    detail: {
      filename, reportVersion: target.version, reportStatus: target.status,
      entryCount: manifestEntries.length, manifestDigest: manifest.manifestDigest,
      archiveBytes: archive.length, archiveSha256: sha256(archive),
      evidenceIncluded: evidenceIndex.filter(item => item.packageEntry).length,
      evidenceUnavailable: evidenceIndex.filter(item => !item.packageEntry).length
    }
  });

  return { filename, archive, manifest, archiveSha256: sha256(archive) };
}

/** Retained JSON evidence export, in the same spirit as the browser-local one. */
async function evidenceJson(ctx, caseId) {
  const { case: caseRecord } = await access.requireCase(ctx, caseId, 'export.package');
  const ruleSet = await cases.ruleSetFor(ctx.store, caseRecord);
  const [payrollRows, evidenceRows, reportRows, approvals, checkRows, activity] = await Promise.all([
    records.rawList(ctx.store, caseId),
    ctx.store.find('evidence_files', { case_id: caseId }, { order: [['uploaded_at', 'asc']] }),
    ctx.store.find('reports', { case_id: caseId }, { order: [['version', 'asc']] }),
    ctx.store.find('approvals', { case_id: caseId }, { order: [['at', 'asc']] }),
    ctx.store.find('checks', { case_id: caseId }, { order: [['created_at', 'asc']] }),
    ctx.store.find('audit_log', { case_id: caseId }, { order: [['at', 'asc']], limit: 2000 })
  ]);
  const latestCheck = checkRows[checkRows.length - 1] || null;

  const payload = {
    format: 'people-ledger-evidence-v2',
    exportedAt: clock.now(),
    mode: `server-authoritative (${ctx.store.label})`,
    exportedBy: { userId: ctx.actor.id, role: ctx.actor.role },
    case: cases.view(caseRecord, ruleSet),
    scope: 'Current case state; historical report snapshots are stored separately',
    payments: await require('./ledger-source').allPayments(ctx.store, caseId),
    bank: await ctx.store.find('bank_transactions', { case_id: caseId }),
    reconciliations: await ctx.store.find('reconciliations', { case_id: caseId }),
    records: payrollRows.map(records.publicRow),
    totals: Object.fromEntries(Object.entries(money.totals(payrollRows)).map(([key, value]) => [key, money.toAmount(value)])),
    latestCheck: latestCheck ? checks.view(latestCheck, caseRecord, ruleSet) : null,
    evidence: evidenceRows.map(evidenceService.publicFile),
    reports: reportRows.map(row => ({
      id: row.id, version: row.version, status: row.status, dataRevision: row.data_revision,
      ruleVersion: row.rule_version, draftSource: row.draft_source, runKind: row.run_kind,
      inputDigest: row.input_digest, createdAt: row.created_at, sealedAt: row.sealed_at,
      draft: row.draft, text: row.draft?.summary ? draftModule.toText(row, row.draft) : null,
      snapshot: row.snapshot,
      sealManifest: row.seal_manifest || null
    })),
    approvals: approvals.map(row => ({
      reportId: row.report_id, reportVersion: row.report_version, stage: row.stage,
      decision: row.decision, actorId: row.actor_id, actorRole: row.actor_role,
      note: row.note, at: row.at, inputDigest: row.input_digest
    })),
    activity: activity.map(row => ({
      at: row.at, actorId: row.actor_id, actorRole: row.actor_role,
      action: row.action, subjectType: row.subject_type, subjectId: row.subject_id, detail: row.detail
    })),
    integrations: config.integrationStatus(),
    limitations: LIMITATIONS
  };

  await audit.record(ctx, 'export.evidence_json', {
    caseId, subjectType: 'case', subjectId: caseId,
    detail: { reportCount: reportRows.length, evidenceCount: evidenceRows.length, sha256: digest(payload) }
  });
  return payload;
}

async function recordsCsv(ctx, caseId) {
  const csv = await records.toCsv(ctx, caseId);
  await audit.record(ctx, 'export.records_csv', { caseId, subjectType: 'payroll_records', subjectId: caseId, detail: { bytes: Buffer.byteLength(csv, 'utf8') } });
  return csv;
}

module.exports = { FORMAT, LIMITATIONS, buildPackage, evidenceJson, recordsCsv };
