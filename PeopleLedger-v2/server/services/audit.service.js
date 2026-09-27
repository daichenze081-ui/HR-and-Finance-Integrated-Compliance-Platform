/* Append-only activity record. Reads that expose data (auditor access, evidence
 * downloads, package exports) are logged as well as writes, because the
 * requirement is to be able to show who saw what and when. */
'use strict';
const { id } = require('../lib/ids');
const clock = require('../lib/clock');
const logger = require('../lib/logger');

const SENSITIVE = /(password|secret|token|contact_email|full_name)/i;

/** Detail payloads are shaped for the log: references and counts, not content. */
function safeDetail(detail) {
  if (detail === undefined || detail === null) return null;
  const scrubbed = logger.scrub(detail);
  return JSON.parse(JSON.stringify(scrubbed, (key, value) => (SENSITIVE.test(key) ? '[redacted]' : value)));
}

async function record(ctx, action, { caseId = null, subjectType = null, subjectId = null, detail = null } = {}) {
  const row = {
    id: id('aud'),
    at: clock.now(),
    actor_id: ctx.actor?.id || 'system',
    actor_role: ctx.actor?.role || 'system',
    case_id: caseId ?? ctx.caseId ?? null,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    detail: safeDetail(detail),
    ip: ctx.ip || null
  };
  await ctx.store.insert('audit_log', row);
  return row;
}

async function list(ctx, { caseId, limit = 200, actions = null } = {}) {
  const where = {};
  if (caseId) where.case_id = caseId;
  if (actions?.length) where.action = { in: actions };
  return ctx.store.find('audit_log', where, { order: [['at', 'desc'], ['id', 'desc']], limit });
}

/** Access and export events, which auditors and directors review most often. */
const ACCESS_ACTIONS = [
  'auditor.access.read', 'evidence.download', 'export.package', 'export.records_csv',
  'export.evidence_json', 'access.granted', 'access.revoked', 'auth.login', 'auth.login_failed'
];

module.exports = { record, list, ACCESS_ACTIONS };
