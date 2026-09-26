/* Synthetic seed data.
 *
 * Separate accounts, one per role, plus one review case that deliberately starts
 * with unresolved findings so the whole workflow can be demonstrated end to end:
 *   EMP-003 paid 4750.00 against an expected 4950.00
 *   EMP-005 has no payment reference
 *   EMP-006 has no cost center
 *
 * All names, amounts and documents here are invented. Passwords come from
 * SEED_PASSWORD and are never written to source control. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../dist/demo/core.js');
const config = require('../config');
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const passwords = require('../auth/passwords');
const casesService = require('../services/cases.service');
const recordsService = require('../services/records.service');
const evidenceService = require('../services/evidence.service');
const recruitmentService = require('../services/recruitment.service');
const rules = require('../rules/registry');

const ACCOUNTS = [
  { key: 'hr', email: 'hr@peopleledger.demo', displayName: 'Mei Ling Ong', role: 'hr' },
  { key: 'preparer', email: 'preparer@peopleledger.demo', displayName: 'Rohan Das', role: 'finance_preparer' },
  { key: 'reviewer', email: 'reviewer@peopleledger.demo', displayName: 'Grace Tan', role: 'reviewer' },
  { key: 'management', email: 'management@peopleledger.demo', displayName: 'Daniel Ho', role: 'management' },
  { key: 'director', email: 'director@peopleledger.demo', displayName: 'Farah Ismail', role: 'director' },
  { key: 'auditor', email: 'auditor@peopleledger.demo', displayName: 'Kenji Watanabe', role: 'auditor' },
  { key: 'admin', email: 'admin@peopleledger.demo', displayName: 'Platform Administrator', role: 'admin' }
];

const payslipFor = row => [
  'DEMO PAYSLIP — SYNTHETIC DATA, NOT A REAL DOCUMENT',
  'Employer: PeopleLedger Demo Company',
  `Employee: ${row.id}`,
  `Period: ${row.period}`,
  `Base pay: ${row.basePay} SGD`,
  `Allowances: ${row.allowances} SGD`,
  `Deductions: ${row.deductions} SGD`,
  `Net paid: ${row.netPaid} SGD`,
  `Payment reference: ${row.evidence || '(not recorded)'}`
].join('\n');

const PAYSLIP_TEXT = payslipFor({
  id: 'EMP-001', period: '2026-09', basePay: '8500.00', allowances: '300.00',
  deductions: '1800.00', netPaid: '7000.00', evidence: 'PAY-202609-001'
});

// A minimal, structurally valid PDF. The system cannot read its text, so it must
// be recorded as requiring manual review rather than as verified.
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'
);

async function ensureUsers(store) {
  const created = {};
  for (const account of ACCOUNTS) {
    const existing = await store.findOne('users', { email: account.email });
    if (existing) { created[account.key] = existing; continue; }
    const secret = await passwords.hash(config.seed.password);
    created[account.key] = await store.insert('users', {
      id: id('usr'),
      email: account.email,
      display_name: account.displayName,
      role: account.role,
      password_hash: secret.hash,
      password_salt: secret.salt,
      active: 1,
      created_at: clock.now(),
      last_login_at: null
    });
  }
  return created;
}

async function seed(store, { quiet = false, dataset = 'v2' } = {}) {
  const isV2 = dataset === 'v2';
  const title = isV2 ? 'September 2026 integrated review (v2 sample)' : 'September 2026 payroll review';
  const exampleRoot = path.resolve(__dirname, '../../examples');
  const sample = isV2 ? core.parseCSV(fs.readFileSync(path.join(exampleRoot, 'payroll-corrected.csv'), 'utf8')) : core.SAMPLE;
  const log = message => { if (!quiet) process.stdout.write(`${message}\n`); };
  const users = await ensureUsers(store);
  const adminCtx = { store, actor: { id: users.admin.id, role: 'admin' }, ip: 'seed' };
  const hrCtx = { store, actor: { id: users.hr.id, role: 'hr' }, ip: 'seed' };

  const existingCase = await store.findOne('cases', { title, period: '2026-09' });
  if (existingCase) {
    log(`Seed already present: case ${existingCase.id}. Nothing was changed.`);
    return { users, caseId: existingCase.id, alreadySeeded: true };
  }

  // --- rule set and case ---------------------------------------------------
  const ruleSet = await casesService.ensureRuleSet(store, {});
  const reviewCase = await store.insert('cases', {
    id: id('case'),
    title,
    period: '2026-09',
    status: 'open',
    data_revision: 1,
    rule_set_id: ruleSet.id,
    created_at: clock.now(),
    created_by: users.admin.id
  });

  // --- access: everyone on the case, auditor time limited -------------------
  for (const account of ACCOUNTS) {
    const user = users[account.key];
    if (account.role === 'admin') continue;
    await store.insert('case_members', {
      id: id('mem'),
      case_id: reviewCase.id,
      user_id: user.id,
      case_role: account.role,
      granted_by: users.admin.id,
      granted_at: clock.now(),
      // Read-only auditor access is granted for seven days only.
      expires_at: account.role === 'auditor' ? clock.plusMinutes(7 * 24 * 60) : null,
      revoked_at: null
    });
  }

  // --- payroll records, reusing the validated sample fixture ----------------
  const now = clock.now();
  for (const coreRow of core.normalizeRows(sample)) {
    await store.insert('payroll_records', recordsService.toRow(reviewCase.id, coreRow, users.hr.id, now));
  }
  for (const coreRow of core.normalizeRows(sample)) {
    await store.insert('employees', {
      id: id('emp'),
      case_id: reviewCase.id,
      employee_no: coreRow.id,
      display_name: coreRow.name,
      department: coreRow.department,
      cost_center: coreRow.costCenter || null,
      source: 'payroll_import',
      candidate_id: null,
      start_date: null,
      created_at: now
    });
  }

  // --- evidence -------------------------------------------------------------
  // A payslip for every payroll record, so rule DOC-002 (evidence file present)
  // is satisfied. EMP-002's document is a PDF: the system cannot read it, so it is
  // recorded as requiring manual review rather than as verified. That produces one
  // non-blocking finding that survives the happy path on purpose.
  for (const coreRow of core.normalizeRows(sample)) {
    if (isV2) {
      await evidenceService.upload(hrCtx, reviewCase.id, { filename: coreRow.evidence + '.pdf', subjectType: 'payment_reference', subjectId: coreRow.evidence, source: 'payroll_system_export', mediaType: 'application/pdf' }, fs.readFileSync(path.join(exampleRoot, 'evidence', coreRow.evidence + '.pdf')));
      continue;
    }
    const isPdf = coreRow.id === 'EMP-002';
    await evidenceService.upload(hrCtx, reviewCase.id, {
      filename: `payslip-${coreRow.id}-${reviewCase.period}.${isPdf ? 'pdf' : 'txt'}`,
      subjectType: 'payroll_record',
      subjectId: coreRow.id,
      source: 'payroll_system_export',
      mediaType: isPdf ? 'application/pdf' : 'text/plain'
    }, isPdf ? PDF_BYTES : Buffer.from(payslipFor(coreRow), 'utf8'));
  }

  if (isV2) {
    for (const reference of ['INV-001', 'RENT-001']) await evidenceService.upload(hrCtx, reviewCase.id, {
      filename: reference + '.pdf', subjectType: 'payment_reference', subjectId: reference,
      source: 'upload', mediaType: 'application/pdf'
    }, fs.readFileSync(path.join(exampleRoot, 'evidence', reference + '.pdf')));
    const financeCtx = { store, actor: { id: users.preparer.id, role: 'finance_preparer' }, ip: 'seed' };
    await require('../services/payments.service').importBatch(financeCtx, reviewCase.id, { csv: fs.readFileSync(path.join(exampleRoot, 'ledger-demo.csv'), 'utf8'), filename: 'ledger-demo.csv' });
    await require('../services/reconciliation.service').importBatch(financeCtx, reviewCase.id, { csv: fs.readFileSync(path.join(exampleRoot, 'bank-demo.csv'), 'utf8'), filename: 'bank-demo.csv' });
    await require('../services/checks.service').run(financeCtx, reviewCase.id);
  }
  // --- recruitment: one blocked draft job, one open job with a candidate ----
  const blockedJob = await recruitmentService.createJob(hrCtx, {
    caseId: reviewCase.id,
    title: 'Operations Analyst',
    department: 'Operations',
    headcount: 1,
    description: 'Synthetic demonstration vacancy. Missing cost center, salary range and advertisement evidence on purpose.'
  });

  const openJob = await recruitmentService.createJob(hrCtx, {
    caseId: reviewCase.id,
    title: 'Payroll Specialist',
    department: 'Finance',
    costCenter: 'CC-300',
    headcount: 1,
    salaryMin: '5200.00',
    salaryMax: '6800.00',
    description: 'Synthetic demonstration vacancy used to show the gated hiring workflow.'
  });

  const advertEvidence = await evidenceService.upload(hrCtx, reviewCase.id, {
    filename: 'advertisement-payroll-specialist.txt',
    subjectType: 'job_advertisement',
    subjectId: openJob.id,
    source: 'job_board',
    mediaType: 'text/plain'
  }, Buffer.from(
    `DEMO JOB ADVERTISEMENT (synthetic)\nRole: Payroll Specialist\nDepartment: Finance\nCost center: CC-300\n`
    + `Salary range: 5200.00 - 6800.00 SGD\nPosted: ${clock.now()}\n`, 'utf8'));

  await recruitmentService.addAdvertisement(hrCtx, openJob.id, {
    channel: 'job_board',
    reference: 'DEMO-BOARD-2026-09-001',
    evidenceId: advertEvidence.file.id
  });
  await recruitmentService.openJob(hrCtx, openJob.id);

  const candidate = await recruitmentService.createCandidate(hrCtx, openJob.id, {
    fullName: 'Nurul Aisyah',
    contactEmail: 'candidate@example.invalid',
    candidateRef: 'CND-2026-0001'
  });
  await recruitmentService.advanceCandidate(hrCtx, candidate.id, { stage: 'screening' });

  await casesService.ruleSetFor(store, reviewCase);
  const findings = rules.evaluate({
    records: await recordsService.rawList(store, reviewCase.id),
    payments: [],
    evidence: await store.find('evidence_files', { case_id: reviewCase.id }),
    casePeriod: reviewCase.period,
    ruleSet
  });

  log('Seed complete.');
  log(`  Case          ${reviewCase.id} (${reviewCase.title})`);
  log(`  Rule set      ${ruleSet.version}`);
  log(`  Records       ${sample.length}`);
  log(`  Open findings ${findings.issues.length} (${rules.blockingIssues(findings.issues).length} blocking)`);
  log(`  Jobs          ${openJob.id} (open), ${blockedJob.id} (draft, blocked until advertisement evidence exists)`);
  log(`  Candidate     ${candidate.candidateRef} at stage screening`);
  log('');
  log('Accounts (password from SEED_PASSWORD):');
  for (const account of ACCOUNTS) log(`  ${account.role.padEnd(17)} ${account.email}`);

  return { users, caseId: reviewCase.id, jobId: openJob.id, blockedJobId: blockedJob.id, candidateId: candidate.id, ruleSet, alreadySeeded: false };
}

module.exports = { seed, ACCOUNTS, PAYSLIP_TEXT, PDF_BYTES };
