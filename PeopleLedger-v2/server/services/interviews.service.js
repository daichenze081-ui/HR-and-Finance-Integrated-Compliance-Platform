/* Interview scheduling — simulated Microsoft Teams.
 *
 * No Microsoft Graph call is made and the join URL is not a real meeting. What is
 * real is the behaviour around it: create, reschedule and cancel are recorded,
 * an identical repeated request returns the original meeting instead of creating a
 * second one, and provider failures are stored and shown rather than swallowed.
 *
 * Every response is labelled with provider = simulated-teams so the state of this
 * integration is never ambiguous. */
'use strict';
const config = require('../config');
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const { sha256 } = require('../lib/hash');
const validate = require('../lib/validate');
const { badRequest, notFound, conflict, failedDependency } = require('../lib/errors');
const rbac = require('../auth/rbac');
const audit = require('./audit.service');

const PROVIDER_LABEL = 'Simulated Teams scheduling. No Microsoft Graph request is made and the join link is not a live meeting.';

const view = row => ({
  id: row.id,
  candidateId: row.candidate_id,
  requestKey: row.request_key,
  organizerId: row.organizer_id,
  provider: row.provider,
  providerState: 'simulated',
  providerNote: PROVIDER_LABEL,
  status: row.status,
  scheduledStart: row.scheduled_start,
  scheduledEnd: row.scheduled_end,
  previousStart: row.previous_start || null,
  joinUrl: row.join_url || null,
  attempt: row.attempt,
  failureReason: row.failure_reason || null,
  cancelReason: row.cancel_reason || null,
  failed: row.status === 'failed',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/** Stable key so a retried request is recognised as the same request. */
const requestKeyFor = (candidateId, start, end) => `req_${sha256(`${candidateId}|${start}|${end}`).slice(0, 32)}`;

/** Stand-in for the provider call. Failures are deliberate and visible. */
function callProvider({ candidateId, start, forceFailure }) {
  if (forceFailure) {
    return { ok: false, reason: 'Simulated provider rejection: the organizer calendar is unavailable (INTERVIEW_FORCE_FAILURE is set).' };
  }
  if (clock.isPast(start)) {
    return { ok: false, reason: 'The requested start time is in the past, so the provider refused the meeting.' };
  }
  return {
    ok: true,
    joinUrl: `https://teams.simulated.invalid/meet/${sha256(`${candidateId}|${start}`).slice(0, 20)}`
  };
}

function readWindow(body) {
  const start = validate.isoTimestamp(body.start, 'start');
  const end = body.end
    ? validate.isoTimestamp(body.end, 'end')
    : new Date(Date.parse(start) + 45 * 60000).toISOString();
  if (Date.parse(end) <= Date.parse(start)) throw badRequest('end must be after start');
  if (Date.parse(end) - Date.parse(start) > 8 * 3600000) throw badRequest('An interview must be shorter than 8 hours');
  return { start, end };
}

async function schedule(ctx, candidateId, input) {
  rbac.requirePermission(ctx.actor.role, 'interviews.write');
  const candidate = await ctx.store.get('candidates', candidateId);
  if (!candidate) throw notFound(`Candidate not found: ${candidateId}`);
  if (['hired', 'rejected'].includes(candidate.stage)) {
    throw conflict(`A candidate at stage ${candidate.stage} cannot have a new interview scheduled`);
  }
  const body = validate.only(input, ['start', 'end', 'requestKey', 'simulateFailure'], 'Interview');
  const { start, end } = readWindow(body);
  const requestKey = body.requestKey
    ? validate.text(body.requestKey, 'requestKey', { max: 80, pattern: /^[A-Za-z0-9_-]{1,80}$/ })
    : requestKeyFor(candidateId, start, end);

  // Duplicate-request protection: the same request returns the same meeting.
  const existing = await ctx.store.findOne('interviews', { request_key: requestKey });
  if (existing) {
    await audit.record(ctx, 'interview.duplicate_request', {
      subjectType: 'interview', subjectId: existing.id, detail: { candidateId, requestKey }
    });
    return { meeting: view(existing), duplicate: true, note: 'An identical request was already processed. The existing meeting is returned unchanged.' };
  }

  const forceFailure = body.simulateFailure === true || config.interviews.forceFailure;
  const outcome = callProvider({ candidateId, start, forceFailure });
  const now = clock.now();
  const row = await ctx.store.insert('interviews', {
    id: id('int'),
    candidate_id: candidateId,
    request_key: requestKey,
    organizer_id: ctx.actor.id,
    provider: config.interviews.provider,
    status: outcome.ok ? 'scheduled' : 'failed',
    scheduled_start: outcome.ok ? start : null,
    scheduled_end: outcome.ok ? end : null,
    previous_start: null,
    join_url: outcome.ok ? outcome.joinUrl : null,
    attempt: 1,
    failure_reason: outcome.ok ? null : outcome.reason,
    cancel_reason: null,
    created_at: now,
    updated_at: now
  });

  await audit.record(ctx, outcome.ok ? 'interview.scheduled' : 'interview.failed', {
    subjectType: 'interview', subjectId: row.id,
    detail: { candidateId, requestKey, provider: row.provider, status: row.status, failureReason: row.failure_reason }
  });
  if (!outcome.ok) {
    // Surfaced as a failure state, not hidden: the record exists and is visible.
    return {
      meeting: view(row),
      duplicate: false,
      error: { code: 'provider_failure', message: outcome.reason },
      note: 'The scheduling attempt failed. The failed attempt is recorded and shown in the interview list.'
    };
  }
  return { meeting: view(row), duplicate: false };
}

async function reschedule(ctx, meetingId, input) {
  rbac.requirePermission(ctx.actor.role, 'interviews.write');
  const row = await ctx.store.get('interviews', meetingId);
  if (!row) throw notFound(`Interview not found: ${meetingId}`);
  if (row.status === 'cancelled') throw conflict('A cancelled interview cannot be rescheduled. Schedule a new one.');
  const body = validate.only(input, ['start', 'end', 'simulateFailure'], 'Reschedule');
  const { start, end } = readWindow(body);
  if (start === row.scheduled_start && end === row.scheduled_end) {
    return { meeting: view(row), duplicate: true, note: 'The requested time matches the current booking. No change was made.' };
  }

  const forceFailure = body.simulateFailure === true || config.interviews.forceFailure;
  const outcome = callProvider({ candidateId: row.candidate_id, start, forceFailure });
  const patch = {
    attempt: row.attempt + 1,
    updated_at: clock.now(),
    previous_start: row.scheduled_start
  };
  if (outcome.ok) {
    patch.status = 'rescheduled';
    patch.scheduled_start = start;
    patch.scheduled_end = end;
    patch.join_url = outcome.joinUrl;
    patch.failure_reason = null;
  } else {
    patch.status = 'failed';
    patch.failure_reason = outcome.reason;
  }
  const updated = await ctx.store.update('interviews', meetingId, patch);
  await audit.record(ctx, outcome.ok ? 'interview.rescheduled' : 'interview.failed', {
    subjectType: 'interview', subjectId: meetingId,
    detail: { candidateId: row.candidate_id, from: row.scheduled_start, to: outcome.ok ? start : null, failureReason: patch.failure_reason }
  });
  return outcome.ok
    ? { meeting: view(updated), duplicate: false }
    : { meeting: view(updated), duplicate: false, error: { code: 'provider_failure', message: outcome.reason } };
}

async function cancel(ctx, meetingId, input) {
  rbac.requirePermission(ctx.actor.role, 'interviews.write');
  const row = await ctx.store.get('interviews', meetingId);
  if (!row) throw notFound(`Interview not found: ${meetingId}`);
  const body = validate.only(input, ['reason'], 'Cancellation');
  const reason = validate.text(body.reason, 'Cancellation reason', { max: 400, multiline: true });
  if (row.status === 'cancelled') {
    return { meeting: view(row), duplicate: true, note: 'This interview was already cancelled.' };
  }
  const updated = await ctx.store.update('interviews', meetingId, {
    status: 'cancelled',
    cancel_reason: reason,
    join_url: null,
    updated_at: clock.now()
  });
  await audit.record(ctx, 'interview.cancelled', {
    subjectType: 'interview', subjectId: meetingId, detail: { candidateId: row.candidate_id }
  });
  return { meeting: view(updated), duplicate: false };
}

async function list(ctx, candidateId) {
  rbac.requirePermission(ctx.actor.role, 'recruitment.read');
  const where = candidateId ? { candidate_id: candidateId } : {};
  const rows = await ctx.store.find('interviews', where, { order: [['created_at', 'desc']] });
  return {
    provider: config.interviews.provider,
    providerState: 'simulated',
    providerNote: PROVIDER_LABEL,
    meetings: rows.map(view),
    failedCount: rows.filter(row => row.status === 'failed').length
  };
}

/** Exposed so the API can report a provider outage explicitly if one is configured. */
function providerStatus() {
  return config.interviews.forceFailure
    ? { state: 'degraded', detail: 'INTERVIEW_FORCE_FAILURE is set: all scheduling attempts will fail visibly.' }
    : { state: 'simulated', detail: PROVIDER_LABEL };
}

module.exports = { schedule, reschedule, cancel, list, requestKeyFor, providerStatus, view, PROVIDER_LABEL, failedDependency };
