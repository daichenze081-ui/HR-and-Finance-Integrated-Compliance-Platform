/* Recruitment and onboarding.
 *
 * Progression is gated: a job cannot open without advertisement evidence, a
 * candidate cannot reach offer without a scorecard, and a hire cannot complete
 * without a cost center and a start date. Scorecards are append-only, so a
 * corrected assessment creates a new revision and the previous one stays readable.
 *
 * After onboarding, finance-side roles receive only the employee identifier,
 * display name, department, cost center and start date. Candidate contact details,
 * interview notes and scorecards are not exposed to them at all: those endpoints
 * require the recruitment permissions, which finance roles do not hold. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const money = require('../lib/money');
const validate = require('../lib/validate');
const { badRequest, notFound, conflict, unprocessable } = require('../lib/errors');
const rbac = require('../auth/rbac');
const access = require('../auth/access');
const audit = require('./audit.service');

const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
const RECOMMENDATIONS = ['strong_hire', 'hire', 'no_decision', 'no_hire'];
const CHANNELS = ['careers_site', 'job_board', 'agency', 'referral', 'internal'];

const TRANSITIONS = {
  applied: ['screening', 'rejected'],
  screening: ['interview', 'rejected'],
  interview: ['offer', 'rejected'],
  offer: ['hired', 'rejected'],
  hired: [],
  rejected: []
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobView = (row, extras = {}) => ({
  id: row.id,
  caseId: row.case_id || null,
  title: row.title,
  department: row.department,
  costCenter: row.cost_center || '',
  headcount: row.headcount,
  salaryMin: row.salary_min_cents === null ? null : money.toAmount(row.salary_min_cents),
  salaryMax: row.salary_max_cents === null ? null : money.toAmount(row.salary_max_cents),
  description: row.description || '',
  status: row.status,
  createdBy: row.created_by,
  createdAt: row.created_at,
  openedAt: row.opened_at || null,
  closedAt: row.closed_at || null,
  ...extras
});

async function createJob(ctx, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const body = validate.only(input, ['caseId', 'title', 'department', 'costCenter', 'headcount', 'salaryMin', 'salaryMax', 'description'], 'Job');
  if (body.caseId) await access.requireCase(ctx, body.caseId, 'recruitment.write');

  const salaryMin = body.salaryMin === undefined || body.salaryMin === '' ? null : money.toCents(body.salaryMin, 'salaryMin');
  const salaryMax = body.salaryMax === undefined || body.salaryMax === '' ? null : money.toCents(body.salaryMax, 'salaryMax');
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) throw badRequest('salaryMin must not exceed salaryMax');

  const row = await ctx.store.insert('jobs', {
    id: id('job'),
    case_id: body.caseId || null,
    title: validate.text(body.title, 'Job title', { max: 140 }),
    department: validate.text(body.department, 'Department', { max: 80 }),
    cost_center: validate.optionalText(body.costCenter, 'Cost center', { max: 40 }) || null,
    headcount: body.headcount === undefined ? 1 : validate.integer(body.headcount, 'Headcount', { min: 1, max: 999 }),
    salary_min_cents: salaryMin,
    salary_max_cents: salaryMax,
    description: validate.optionalText(body.description, 'Description', { max: 4000, multiline: true }) || null,
    status: 'draft',
    created_by: ctx.actor.id,
    created_at: clock.now(),
    opened_at: null,
    closed_at: null
  });
  await audit.record(ctx, 'job.created', { caseId: row.case_id, subjectType: 'job', subjectId: row.id, detail: { title: row.title } });
  return jobView(row);
}

/** Missing information that blocks opening a job. */
async function jobReadiness(store, job) {
  const advertisements = await store.find('advertisements', { job_id: job.id });
  const withEvidence = advertisements.filter(row => row.evidence_id);
  const missing = [];
  if (!job.cost_center) missing.push('costCenter');
  if (!job.description) missing.push('description');
  if (job.salary_min_cents === null || job.salary_max_cents === null) missing.push('salaryRange');
  if (!advertisements.length) missing.push('advertisement');
  if (!withEvidence.length) missing.push('advertisementEvidence');
  return { missing, advertisements, ready: missing.length === 0 };
}

async function openJob(ctx, jobId) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const job = await ctx.store.get('jobs', jobId);
  if (!job) throw notFound(`Job not found: ${jobId}`);
  if (job.status === 'open') return jobView(job);
  if (job.status === 'closed') throw conflict('A closed job cannot be reopened');

  const readiness = await jobReadiness(ctx.store, job);
  if (!readiness.ready) {
    throw unprocessable('This job cannot be opened until the required information is complete', {
      missing: readiness.missing,
      hint: 'Advertisement evidence must be uploaded and linked before a job can be opened.'
    });
  }
  const row = await ctx.store.update('jobs', jobId, { status: 'open', opened_at: clock.now() });
  await audit.record(ctx, 'job.opened', { caseId: row.case_id, subjectType: 'job', subjectId: row.id });
  return jobView(row);
}

async function closeJob(ctx, jobId) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const job = await ctx.store.get('jobs', jobId);
  if (!job) throw notFound(`Job not found: ${jobId}`);
  const row = await ctx.store.update('jobs', jobId, { status: 'closed', closed_at: clock.now() });
  await audit.record(ctx, 'job.closed', { caseId: row.case_id, subjectType: 'job', subjectId: row.id });
  return jobView(row);
}

async function listJobs(ctx) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.read');
  const rows = await ctx.store.find('jobs', {}, { order: [['created_at', 'desc']] });
  const out = [];
  for (const row of rows) {
    const readiness = await jobReadiness(ctx.store, row);
    const candidates = await ctx.store.find('candidates', { job_id: row.id });
    out.push(jobView(row, {
      advertisementCount: readiness.advertisements.length,
      advertisementsWithEvidence: readiness.advertisements.filter(a => a.evidence_id).length,
      blockedBy: readiness.missing,
      canOpen: readiness.ready && row.status === 'draft',
      candidateCount: candidates.length,
      hiredCount: candidates.filter(c => c.stage === 'hired').length
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisement evidence
// ---------------------------------------------------------------------------

async function addAdvertisement(ctx, jobId, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const job = await ctx.store.get('jobs', jobId);
  if (!job) throw notFound(`Job not found: ${jobId}`);
  const body = validate.only(input, ['channel', 'reference', 'postedAt', 'evidenceId'], 'Advertisement');

  let evidenceId = null;
  if (body.evidenceId) {
    const file = await ctx.store.get('evidence_files', validate.entityId(body.evidenceId, 'evidenceId'));
    if (!file) throw badRequest(`Evidence not found: ${body.evidenceId}`);
    if (file.subject_type !== 'job_advertisement') throw badRequest('Linked evidence must be uploaded with subjectType job_advertisement');
    if (file.subject_id !== jobId) throw badRequest('The linked evidence belongs to a different job');
    evidenceId = file.id;
  }

  const row = await ctx.store.insert('advertisements', {
    id: id('adv'),
    job_id: jobId,
    channel: validate.oneOf(body.channel, CHANNELS, 'channel'),
    reference: validate.text(body.reference, 'Advertisement reference', { max: 200 }),
    posted_at: body.postedAt ? validate.isoTimestamp(body.postedAt, 'postedAt') : clock.now(),
    evidence_id: evidenceId,
    created_by: ctx.actor.id,
    created_at: clock.now()
  });
  await audit.record(ctx, 'job.advertisement_added', {
    caseId: job.case_id, subjectType: 'advertisement', subjectId: row.id,
    detail: { jobId, channel: row.channel, evidenceLinked: !!evidenceId }
  });
  return {
    id: row.id, jobId, channel: row.channel, reference: row.reference,
    postedAt: row.posted_at, evidenceId: row.evidence_id, createdAt: row.created_at
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function candidateView(row, role, extras = {}) {
  const base = {
    id: row.id,
    jobId: row.job_id,
    candidateRef: row.candidate_ref,
    stage: row.stage,
    expectedStart: row.expected_start || null,
    offerAmount: row.offer_amount_cents === null ? null : money.toAmount(row.offer_amount_cents),
    decisionReason: row.decision_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extras
  };
  // Personal data is only returned to roles that need it.
  if (rbac.seesCandidateIdentity(role)) {
    base.fullName = row.full_name;
    base.contactEmail = row.contact_email || null;
  } else {
    base.fullName = '(withheld)';
    base.contactEmail = null;
    base.personalDataWithheld = true;
  }
  return base;
}

async function createCandidate(ctx, jobId, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const job = await ctx.store.get('jobs', jobId);
  if (!job) throw notFound(`Job not found: ${jobId}`);
  if (job.status !== 'open') throw unprocessable('Candidates can only be added to an open job', { jobStatus: job.status });
  const body = validate.only(input, ['fullName', 'contactEmail', 'candidateRef'], 'Candidate');
  const now = clock.now();
  const row = await ctx.store.insert('candidates', {
    id: id('cnd'),
    job_id: jobId,
    candidate_ref: body.candidateRef
      ? validate.text(body.candidateRef, 'candidateRef', { max: 40, pattern: /^[A-Za-z0-9_-]{1,40}$/ })
      : `CND-${id('x').slice(-8)}`,
    full_name: validate.text(body.fullName, 'Candidate name', { max: 120 }),
    contact_email: validate.optionalText(body.contactEmail, 'Contact email', { max: 160 }) || null,
    stage: 'applied',
    expected_start: null,
    offer_amount_cents: null,
    decision_reason: null,
    created_by: ctx.actor.id,
    created_at: now,
    updated_at: now
  });
  await audit.record(ctx, 'candidate.created', {
    caseId: job.case_id, subjectType: 'candidate', subjectId: row.id,
    detail: { jobId, candidateRef: row.candidate_ref }
  });
  return candidateView(row, ctx.actor.role);
}

/** What is still missing before a candidate can move to a given stage. */
async function stageReadiness(store, candidate, target) {
  const missing = [];
  const scorecards = await store.find('scorecards', { candidate_id: candidate.id });
  const meetings = await store.find('interviews', { candidate_id: candidate.id });
  const live = meetings.filter(row => ['scheduled', 'rescheduled'].includes(row.status));
  const job = await store.get('jobs', candidate.job_id);

  if (target === 'interview' && !live.length) missing.push('scheduledInterview');
  if (target === 'offer') {
    if (!scorecards.length) missing.push('scorecard');
    else if (!scorecards.some(card => ['strong_hire', 'hire'].includes(card.recommendation))) missing.push('positiveScorecardRecommendation');
  }
  if (target === 'hired') {
    if (!candidate.expected_start) missing.push('expectedStart');
    if (candidate.offer_amount_cents === null) missing.push('offerAmount');
    if (!job?.cost_center) missing.push('jobCostCenter');
  }
  return { missing, scorecards, meetings, job };
}

async function advanceCandidate(ctx, candidateId, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.advance');
  const candidate = await ctx.store.get('candidates', candidateId);
  if (!candidate) throw notFound(`Candidate not found: ${candidateId}`);
  const body = validate.only(input, ['stage', 'expectedStart', 'offerAmount', 'reason'], 'Stage change');
  const target = validate.oneOf(body.stage, STAGES, 'stage');

  const allowed = TRANSITIONS[candidate.stage] || [];
  if (!allowed.includes(target)) {
    throw conflict(`A candidate at stage ${candidate.stage} cannot move to ${target}`, { currentStage: candidate.stage, allowed });
  }

  const patch = { stage: target, updated_at: clock.now() };
  if (body.expectedStart) patch.expected_start = validate.isoTimestamp(body.expectedStart, 'expectedStart');
  if (body.offerAmount !== undefined && body.offerAmount !== '') patch.offer_amount_cents = money.toCents(body.offerAmount, 'offerAmount');
  if (target === 'rejected') patch.decision_reason = validate.text(body.reason, 'Reason', { max: 600, multiline: true });

  if (target !== 'rejected') {
    const probe = { ...candidate, ...patch };
    const readiness = await stageReadiness(ctx.store, probe, target);
    if (readiness.missing.length) {
      throw unprocessable(`This candidate cannot move to ${target} until the required information is present`, {
        missing: readiness.missing,
        currentStage: candidate.stage,
        targetStage: target
      });
    }
  }

  const row = await ctx.store.update('candidates', candidateId, patch);
  await audit.record(ctx, 'candidate.stage_changed', {
    subjectType: 'candidate', subjectId: candidateId,
    detail: { from: candidate.stage, to: target }
  });
  return candidateView(row, ctx.actor.role);
}

async function listCandidates(ctx, jobId) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.read');
  const where = jobId ? { job_id: jobId } : {};
  const rows = await ctx.store.find('candidates', where, { order: [['created_at', 'desc']] });
  const out = [];
  for (const row of rows) {
    const readiness = await stageReadiness(ctx.store, row, TRANSITIONS[row.stage]?.[0] || row.stage);
    out.push(candidateView(row, ctx.actor.role, {
      scorecardCount: readiness.scorecards.length,
      latestScorecardRevision: readiness.scorecards.length ? Math.max(...readiness.scorecards.map(card => card.revision)) : 0,
      interviewCount: readiness.meetings.length,
      nextStage: TRANSITIONS[row.stage]?.[0] || null,
      blockedBy: readiness.missing
    }));
  }
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { subjectType: 'candidates', subjectId: jobId || 'all', detail: { count: rows.length } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scorecards (append-only, revisions preserved)
// ---------------------------------------------------------------------------

const scorecardView = row => ({
  id: row.id,
  candidateId: row.candidate_id,
  revision: row.revision,
  interviewerId: row.interviewer_id,
  criteria: row.criteria,
  recommendation: row.recommendation,
  note: row.note || '',
  supersedes: row.supersedes || null,
  createdAt: row.created_at
});

async function addScorecard(ctx, candidateId, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.write');
  const candidate = await ctx.store.get('candidates', candidateId);
  if (!candidate) throw notFound(`Candidate not found: ${candidateId}`);
  const body = validate.only(input, ['criteria', 'recommendation', 'note'], 'Scorecard');
  const criteria = validate.array(
    Array.isArray(body.criteria) ? body.criteria : [],
    'criteria', { max: 20, min: 1 }
  ).map((entry, index) => {
    const item = validate.only(entry, ['name', 'score', 'comment'], `criteria[${index}]`);
    return {
      name: validate.text(item.name, `criteria[${index}].name`, { max: 80 }),
      score: validate.integer(item.score, `criteria[${index}].score`, { min: 1, max: 5 }),
      comment: validate.optionalText(item.comment, `criteria[${index}].comment`, { max: 600, multiline: true })
    };
  });

  const existing = await ctx.store.find('scorecards', { candidate_id: candidateId }, { order: [['revision', 'desc']] });
  const previous = existing[0] || null;
  const row = await ctx.store.insert('scorecards', {
    id: id('sc'),
    candidate_id: candidateId,
    revision: previous ? previous.revision + 1 : 1,
    interviewer_id: ctx.actor.id,
    criteria,
    recommendation: validate.oneOf(body.recommendation, RECOMMENDATIONS, 'recommendation'),
    note: validate.optionalText(body.note, 'Note', { max: 2000, multiline: true }) || null,
    // Earlier revisions are never modified or removed; they remain retrievable.
    supersedes: previous ? previous.id : null,
    created_at: clock.now()
  });
  await audit.record(ctx, 'scorecard.added', {
    subjectType: 'scorecard', subjectId: row.id,
    detail: { candidateId, revision: row.revision, recommendation: row.recommendation, supersedes: row.supersedes }
  });
  return scorecardView(row);
}

async function listScorecards(ctx, candidateId) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.read');
  const rows = await ctx.store.find('scorecards', { candidate_id: candidateId }, { order: [['revision', 'asc']] });
  const latest = rows.length ? Math.max(...rows.map(row => row.revision)) : 0;
  return rows.map(row => ({ ...scorecardView(row), current: row.revision === latest }));
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Turns a hired candidate into an employee record inside a case. Only the fields
 * finance needs are written; recruitment detail stays in the recruitment tables.
 */
async function onboard(ctx, candidateId, input) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.advance');
  const body = validate.only(input, ['caseId', 'employeeNo', 'startDate'], 'Onboarding');
  const caseId = validate.entityId(body.caseId, 'caseId');
  await access.requireCase(ctx, caseId, 'records.write');

  const candidate = await ctx.store.get('candidates', candidateId);
  if (!candidate) throw notFound(`Candidate not found: ${candidateId}`);
  if (candidate.stage !== 'hired') throw unprocessable('Only a hired candidate can be onboarded', { stage: candidate.stage });
  const job = await ctx.store.get('jobs', candidate.job_id);
  if (!job?.cost_center) throw unprocessable('The job has no cost center, so the employee cannot be created', { missing: ['jobCostCenter'] });

  const employeeNo = validate.text(body.employeeNo, 'employeeNo', { max: 40, pattern: /^[A-Za-z0-9_-]{1,40}$/ });
  const existing = await ctx.store.findOne('employees', { case_id: caseId, employee_no: employeeNo });
  if (existing) throw conflict(`Employee ${employeeNo} already exists in this case`);
  const alreadyOnboarded = await ctx.store.findOne('employees', { candidate_id: candidateId });
  if (alreadyOnboarded) {
    throw conflict('This candidate has already been onboarded', { employeeNo: alreadyOnboarded.employee_no });
  }

  const row = await ctx.store.insert('employees', {
    id: id('emp'),
    case_id: caseId,
    employee_no: employeeNo,
    display_name: candidate.full_name,
    department: job.department,
    cost_center: job.cost_center,
    source: 'recruitment',
    candidate_id: candidateId,
    start_date: body.startDate ? validate.isoTimestamp(body.startDate, 'startDate') : candidate.expected_start,
    created_at: clock.now()
  });
  await audit.record(ctx, 'employee.onboarded', {
    caseId, subjectType: 'employee', subjectId: row.id,
    detail: { employeeNo, jobId: job.id, candidateId, costCenter: job.cost_center }
  });
  return {
    employeeNo: row.employee_no,
    displayName: row.display_name,
    department: row.department,
    costCenter: row.cost_center,
    startDate: row.start_date,
    caseId,
    note: 'Finance-side roles receive identifier, display name, department, cost center and start date only.'
  };
}

module.exports = {
  STAGES, RECOMMENDATIONS, CHANNELS, TRANSITIONS,
  createJob, openJob, closeJob, listJobs, jobReadiness, addAdvertisement,
  createCandidate, advanceCandidate, listCandidates, candidateView,
  addScorecard, listScorecards, onboard
};
