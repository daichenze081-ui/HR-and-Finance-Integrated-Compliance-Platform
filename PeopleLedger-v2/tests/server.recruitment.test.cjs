/* Recruitment gates, scorecard revisions, onboarding projection, and simulated
 * Teams scheduling including duplicate protection and visible failure states. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, capture } = require('./helpers.cjs');

const recruitment = require('../server/services/recruitment.service');
const interviews = require('../server/services/interviews.service');
const evidenceService = require('../server/services/evidence.service');
const recordsService = require('../server/services/records.service');
const config = require('../server/config');
const clock = require('../server/lib/clock');

const future = (minutes = 60) => new Date(Date.now() + minutes * 60000).toISOString();

async function openJobWithCandidate(h, title = 'Finance Analyst') {
  const job = await recruitment.createJob(h.ctx.hr, {
    caseId: h.caseId, title, department: 'Finance', costCenter: 'CC-300',
    headcount: 1, salaryMin: '5000.00', salaryMax: '7000.00', description: 'Synthetic vacancy.'
  });
  const evidence = await evidenceService.upload(h.ctx.hr, h.caseId, {
    filename: `advert-${job.id}.txt`, subjectType: 'job_advertisement', subjectId: job.id,
    source: 'job_board', mediaType: 'text/plain'
  }, Buffer.from(`DEMO advertisement for ${title}`, 'utf8'));
  await recruitment.addAdvertisement(h.ctx.hr, job.id, { channel: 'job_board', reference: `REF-${job.id}`, evidenceId: evidence.file.id });
  await recruitment.openJob(h.ctx.hr, job.id);
  const candidate = await recruitment.createCandidate(h.ctx.hr, job.id, { fullName: 'Test Candidate', contactEmail: 'c@example.invalid' });
  return { job, candidate };
}

test('a job cannot open until required information and advertisement evidence exist', async () => {
  const h = await harness();
  try {
    const jobs = await recruitment.listJobs(h.ctx.hr);
    const blocked = jobs.find(job => job.id === h.seeded.blockedJobId);
    assert.equal(blocked.status, 'draft');
    assert.equal(blocked.canOpen, false);
    assert.deepEqual(blocked.blockedBy.sort(), ['advertisement', 'advertisementEvidence', 'costCenter', 'salaryRange'].sort());

    const refused = await capture(() => recruitment.openJob(h.ctx.hr, blocked.id));
    assert.equal(refused.status, 422);
    assert.match(refused.message, /cannot be opened until the required information is complete/);
    assert.ok(refused.detail.missing.includes('advertisementEvidence'));

    // An advertisement without evidence is still not enough.
    await recruitment.addAdvertisement(h.ctx.hr, blocked.id, { channel: 'careers_site', reference: 'NO-EVIDENCE' });
    const stillRefused = await capture(() => recruitment.openJob(h.ctx.hr, blocked.id));
    assert.equal(stillRefused.status, 422);
    assert.ok(stillRefused.detail.missing.includes('advertisementEvidence'));
    assert.ok(!stillRefused.detail.missing.includes('advertisement'));
  } finally { await h.close(); }
});

test('advertisement evidence must belong to the job it is linked to', async () => {
  const h = await harness();
  try {
    const wrongSubject = (await evidenceService.list(h.ctx.hr, h.caseId)).find(file => file.subjectType === 'payroll_record');
    const error = await capture(() => recruitment.addAdvertisement(h.ctx.hr, h.seeded.blockedJobId, {
      channel: 'job_board', reference: 'X', evidenceId: wrongSubject.id
    }));
    assert.equal(error.status, 400);
    assert.match(error.message, /subjectType job_advertisement/);
  } finally { await h.close(); }
});

test('candidates can only be added to an open job', async () => {
  const h = await harness();
  try {
    const error = await capture(() => recruitment.createCandidate(h.ctx.hr, h.seeded.blockedJobId, { fullName: 'Too Early' }));
    assert.equal(error.status, 422);
    assert.match(error.message, /only be added to an open job/);
  } finally { await h.close(); }
});

test('hiring progression is blocked until each prerequisite is present', async () => {
  const h = await harness();
  try {
    const { job, candidate } = await openJobWithCandidate(h);

    // applied -> offer is not a permitted step at all.
    const skip = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'offer' }));
    assert.equal(skip.status, 409);
    assert.deepEqual(skip.detail.allowed, ['screening', 'rejected']);

    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'screening' });

    // interview requires a live scheduled meeting.
    const noMeeting = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'interview' }));
    assert.equal(noMeeting.status, 422);
    assert.deepEqual(noMeeting.detail.missing, ['scheduledInterview']);

    const scheduled = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(120) });
    assert.equal(scheduled.meeting.status, 'scheduled');
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'interview' });

    // offer requires a scorecard with a positive recommendation.
    const noScorecard = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'offer' }));
    assert.deepEqual(noScorecard.detail.missing, ['scorecard']);

    await recruitment.addScorecard(h.ctx.hr, candidate.id, {
      criteria: [{ name: 'Payroll knowledge', score: 2, comment: 'Gaps in reconciliation' }],
      recommendation: 'no_hire'
    });
    const negative = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'offer' }));
    assert.deepEqual(negative.detail.missing, ['positiveScorecardRecommendation']);

    await recruitment.addScorecard(h.ctx.hr, candidate.id, {
      criteria: [{ name: 'Payroll knowledge', score: 4, comment: 'Reassessed after a second interview' }],
      recommendation: 'hire',
      note: 'Corrects the earlier assessment'
    });
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'offer' });

    // hired requires a start date and an offer amount.
    const noOffer = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'hired' }));
    assert.equal(noOffer.status, 422);
    assert.deepEqual(noOffer.detail.missing.sort(), ['expectedStart', 'offerAmount']);

    const hired = await recruitment.advanceCandidate(h.ctx.hr, candidate.id, {
      stage: 'hired', expectedStart: future(60 * 24 * 30), offerAmount: '6200.00'
    });
    assert.equal(hired.stage, 'hired');
    assert.equal(hired.offerAmount, '6200.00');
    assert.equal(job.costCenter, 'CC-300');
  } finally { await h.close(); }
});

test('rejection requires a reason and is final', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Rejected Role');
    const noReason = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'rejected' }));
    assert.equal(noReason.status, 400);

    const rejected = await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'rejected', reason: 'Withdrew from the process' });
    assert.equal(rejected.stage, 'rejected');
    assert.equal(rejected.decisionReason, 'Withdrew from the process');

    const revive = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'screening' }));
    assert.equal(revive.status, 409);
  } finally { await h.close(); }
});

test('scorecard revisions are preserved and never overwritten', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Scorecard Role');
    const first = await recruitment.addScorecard(h.ctx.hr, candidate.id, {
      criteria: [{ name: 'Communication', score: 3 }], recommendation: 'no_decision', note: 'Initial view'
    });
    const second = await recruitment.addScorecard(h.ctx.hr, candidate.id, {
      criteria: [{ name: 'Communication', score: 5, comment: 'Much stronger on the second call' }], recommendation: 'hire', note: 'Revised view'
    });

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(second.supersedes, first.id);

    const all = await recruitment.listScorecards(h.ctx.hr, candidate.id);
    assert.equal(all.length, 2);
    assert.equal(all[0].revision, 1);
    assert.equal(all[0].current, false);
    assert.equal(all[0].note, 'Initial view', 'the earlier revision is unchanged');
    assert.equal(all[0].criteria[0].score, 3);
    assert.equal(all[1].current, true);

    // Scores are bounded and criteria are required.
    const badScore = await capture(() => recruitment.addScorecard(h.ctx.hr, candidate.id, { criteria: [{ name: 'X', score: 9 }], recommendation: 'hire' }));
    assert.equal(badScore.status, 400);
    const noCriteria = await capture(() => recruitment.addScorecard(h.ctx.hr, candidate.id, { criteria: [], recommendation: 'hire' }));
    assert.equal(noCriteria.status, 400);
  } finally { await h.close(); }
});

test('onboarding exposes only the employee and cost-center fields finance needs', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Onboarding Role');
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'screening' });
    await interviews.schedule(h.ctx.hr, candidate.id, { start: future(120) });
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'interview' });
    await recruitment.addScorecard(h.ctx.hr, candidate.id, { criteria: [{ name: 'Fit', score: 4 }], recommendation: 'hire' });
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'offer' });

    const tooEarly = await capture(() => recruitment.onboard(h.ctx.hr, candidate.id, { caseId: h.caseId, employeeNo: 'EMP-010' }));
    assert.equal(tooEarly.status, 422);

    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'hired', expectedStart: future(60 * 24 * 20), offerAmount: '6000.00' });
    const employee = await recruitment.onboard(h.ctx.hr, candidate.id, { caseId: h.caseId, employeeNo: 'EMP-010' });
    assert.equal(employee.employeeNo, 'EMP-010');
    assert.equal(employee.costCenter, 'CC-300');

    // Finance-side roles see the projection, not the recruitment link.
    const forFinance = await recordsService.employees(h.ctx.preparer, h.caseId);
    const projected = forFinance.find(item => item.employeeNo === 'EMP-010');
    assert.deepEqual(Object.keys(projected).sort(), ['costCenter', 'department', 'displayName', 'employeeNo', 'recruitmentDetail', 'source', 'startDate'].sort());
    assert.equal(projected.recruitmentDetail, 'withheld');
    assert.equal(projected.candidateId, undefined);

    // HR sees the recruitment link.
    const forHr = await recordsService.employees(h.ctx.hr, h.caseId);
    assert.equal(forHr.find(item => item.employeeNo === 'EMP-010').candidateId, candidate.id);

    // Finance roles hold no recruitment permission at all.
    for (const ctx of [h.ctx.preparer, h.ctx.reviewer, h.ctx.management]) {
      const refused = await capture(() => recruitment.listCandidates(ctx, null));
      assert.equal(refused.status, 403);
    }
    // A director may review recruitment but not the candidate's personal data.
    const asDirector = await recruitment.listCandidates(h.ctx.director, null);
    assert.ok(asDirector.every(item => item.fullName === '(withheld)' && item.personalDataWithheld === true));

    // A candidate cannot be onboarded twice.
    const again = await capture(() => recruitment.onboard(h.ctx.hr, candidate.id, { caseId: h.caseId, employeeNo: 'EMP-011' }));
    assert.equal(again.status, 409);
    assert.match(again.message, /already been onboarded/);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Simulated Teams scheduling
// ---------------------------------------------------------------------------

test('scheduling is created, rescheduled and cancelled, and is always labelled simulated', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Scheduling Role');
    const created = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(120) });
    assert.equal(created.duplicate, false);
    assert.equal(created.meeting.status, 'scheduled');
    assert.equal(created.meeting.provider, 'simulated-teams');
    assert.equal(created.meeting.providerState, 'simulated');
    assert.match(created.meeting.providerNote, /No Microsoft Graph request is made/);
    assert.match(created.meeting.joinUrl, /teams\.simulated\.invalid/);
    assert.equal(created.meeting.attempt, 1);

    const moved = await interviews.reschedule(h.ctx.hr, created.meeting.id, { start: future(240) });
    assert.equal(moved.meeting.status, 'rescheduled');
    assert.equal(moved.meeting.previousStart, created.meeting.scheduledStart);
    assert.equal(moved.meeting.attempt, 2);

    const noChange = await interviews.reschedule(h.ctx.hr, created.meeting.id, {
      start: moved.meeting.scheduledStart, end: moved.meeting.scheduledEnd
    });
    assert.equal(noChange.duplicate, true);

    const cancelled = await interviews.cancel(h.ctx.hr, created.meeting.id, { reason: 'Candidate unavailable' });
    assert.equal(cancelled.meeting.status, 'cancelled');
    assert.equal(cancelled.meeting.joinUrl, null);
    assert.equal(cancelled.meeting.cancelReason, 'Candidate unavailable');

    const again = await interviews.cancel(h.ctx.hr, created.meeting.id, { reason: 'Second attempt' });
    assert.equal(again.duplicate, true);

    const afterCancel = await capture(() => interviews.reschedule(h.ctx.hr, created.meeting.id, { start: future(300) }));
    assert.equal(afterCancel.status, 409);
  } finally { await h.close(); }
});

test('an identical scheduling request returns the existing meeting instead of a second one', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Duplicate Request Role');
    const start = future(180);
    const first = await interviews.schedule(h.ctx.hr, candidate.id, { start });
    const second = await interviews.schedule(h.ctx.hr, candidate.id, { start });

    assert.equal(second.duplicate, true);
    assert.equal(second.meeting.id, first.meeting.id);
    assert.match(second.note, /identical request was already processed/);

    const listed = await interviews.list(h.ctx.hr, candidate.id);
    assert.equal(listed.meetings.length, 1);

    // An explicit idempotency key behaves the same way.
    const keyed = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(200), requestKey: 'my-key-1' });
    const keyedAgain = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(260), requestKey: 'my-key-1' });
    assert.equal(keyedAgain.duplicate, true);
    assert.equal(keyedAgain.meeting.id, keyed.meeting.id);
    assert.equal(keyedAgain.meeting.scheduledStart, keyed.meeting.scheduledStart, 'the original booking is unchanged');
  } finally { await h.close(); }
});

test('provider failures are visible rather than silent', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Failure Role');

    const forced = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(120), simulateFailure: true });
    assert.equal(forced.meeting.status, 'failed');
    assert.equal(forced.meeting.failed, true);
    assert.equal(forced.error.code, 'provider_failure');
    assert.match(forced.meeting.failureReason, /organizer calendar is unavailable/);
    assert.equal(forced.meeting.joinUrl, null);

    // A failed attempt is recorded and does not satisfy the interview gate.
    const listed = await interviews.list(h.ctx.hr, candidate.id);
    assert.equal(listed.failedCount, 1);
    await recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'screening' });
    const gate = await capture(() => recruitment.advanceCandidate(h.ctx.hr, candidate.id, { stage: 'interview' }));
    assert.deepEqual(gate.detail.missing, ['scheduledInterview']);

    // A start time in the past is refused by the provider stand-in.
    const past = await interviews.schedule(h.ctx.hr, candidate.id, { start: new Date(Date.now() - 3600000).toISOString() });
    assert.equal(past.meeting.status, 'failed');
    assert.match(past.meeting.failureReason, /in the past/);

    // A previously failed meeting can be retried by rescheduling.
    const retried = await interviews.reschedule(h.ctx.hr, forced.meeting.id, { start: future(400) });
    assert.equal(retried.meeting.status, 'rescheduled');
    assert.equal(retried.meeting.failureReason, null);
  } finally { await h.close(); }
});

test('a configured provider outage is reported as degraded', async () => {
  const original = config.interviews.forceFailure;
  const h = await harness();
  try {
    config.interviews.forceFailure = true;
    assert.equal(interviews.providerStatus().state, 'degraded');
    const { candidate } = await openJobWithCandidate(h, 'Outage Role');
    const attempt = await interviews.schedule(h.ctx.hr, candidate.id, { start: future(120) });
    assert.equal(attempt.meeting.status, 'failed');
    assert.match(attempt.meeting.failureReason, /INTERVIEW_FORCE_FAILURE/);
  } finally {
    config.interviews.forceFailure = original;
    await h.close();
  }
});

test('scheduling windows are validated', async () => {
  const h = await harness();
  try {
    const { candidate } = await openJobWithCandidate(h, 'Window Role');
    const backwards = await capture(() => interviews.schedule(h.ctx.hr, candidate.id, { start: future(200), end: future(100) }));
    assert.equal(backwards.status, 400);
    assert.match(backwards.message, /end must be after start/);

    const tooLong = await capture(() => interviews.schedule(h.ctx.hr, candidate.id, { start: future(100), end: future(100 + 9 * 60) }));
    assert.equal(tooLong.status, 400);

    const notATime = await capture(() => interviews.schedule(h.ctx.hr, candidate.id, { start: 'tomorrow' }));
    assert.equal(notATime.status, 400);

    // Finance roles hold no interview permission.
    const refused = await capture(() => interviews.schedule(h.ctx.preparer, candidate.id, { start: future(120) }));
    assert.equal(refused.status, 403);
    assert.equal(clock.isIso(future(10)), true);
  } finally { await h.close(); }
});
