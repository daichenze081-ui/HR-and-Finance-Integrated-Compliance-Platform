/* Case-level access control.
 *
 * A global role says what kind of action an account may attempt. A membership row
 * says which cases it may touch. Both must pass. Auditor memberships carry an
 * expiry so read access is genuinely time limited. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const { forbidden, notFound, badRequest } = require('../lib/errors');
const rbac = require('./rbac');

function isActive(member, at = clock.now()) {
  if (!member || member.revoked_at) return false;
  if (member.expires_at && clock.isPast(member.expires_at, at)) return false;
  return true;
}

async function membershipFor(store, caseId, userId) {
  const rows = await store.find('case_members', { case_id: caseId, user_id: userId }, { order: [['granted_at', 'desc']] });
  return rows.find(row => isActive(row)) || null;
}

/** Resolves and authorises a case for the current actor. Throws, never returns null. */
async function requireCase(ctx, caseId, permission) {
  const record = await ctx.store.get('cases', caseId);
  if (!record) throw notFound(`Case not found: ${caseId}`);
  if (permission) rbac.requirePermission(ctx.actor.role, permission);
  if (ctx.actor.role === 'admin') return { case: record, membership: null };

  const membership = await membershipFor(ctx.store, caseId, ctx.actor.id);
  if (!membership) {
    const expired = await ctx.store.find('case_members', { case_id: caseId, user_id: ctx.actor.id });
    const hadAccess = expired.length > 0;
    throw forbidden(
      hadAccess
        ? 'Your access to this case has expired or been revoked'
        : 'You are not a member of this case',
      { caseId, expired: hadAccess }
    );
  }
  return { case: record, membership };
}

async function grant(ctx, { caseId, userId, caseRole, expiresAt = null }) {
  rbac.requirePermission(ctx.actor.role, 'access.grant');
  const target = await ctx.store.get('users', userId);
  if (!target) throw notFound(`User not found: ${userId}`);
  const record = await ctx.store.get('cases', caseId);
  if (!record) throw notFound(`Case not found: ${caseId}`);
  if (expiresAt && !clock.isIso(expiresAt)) throw badRequest('expiresAt must be an ISO-8601 timestamp');
  if (expiresAt && clock.isPast(expiresAt)) throw badRequest('expiresAt must be in the future');
  // Read-only auditor access must always be time limited.
  if (target.role === 'auditor' && !expiresAt) throw badRequest('Auditor access must specify an expiry timestamp');

  const row = await ctx.store.insert('case_members', {
    id: id('mem'),
    case_id: caseId,
    user_id: userId,
    case_role: caseRole || target.role,
    granted_by: ctx.actor.id,
    granted_at: clock.now(),
    expires_at: expiresAt,
    revoked_at: null
  });
  return row;
}

async function revoke(ctx, membershipId) {
  rbac.requirePermission(ctx.actor.role, 'access.grant');
  const row = await ctx.store.get('case_members', membershipId);
  if (!row) throw notFound('Membership not found');
  if (row.revoked_at) return row;
  return ctx.store.update('case_members', membershipId, { revoked_at: clock.now() });
}

async function listMembers(ctx, caseId) {
  const rows = await ctx.store.find('case_members', { case_id: caseId }, { order: [['granted_at', 'desc']] });
  const out = [];
  for (const row of rows) {
    const user = await ctx.store.get('users', row.user_id);
    out.push({
      id: row.id,
      userId: row.user_id,
      displayName: user?.display_name || row.user_id,
      role: user?.role || row.case_role,
      caseRole: row.case_role,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      active: isActive(row)
    });
  }
  return out;
}

/** Cases the actor may currently open. */
async function visibleCases(ctx) {
  if (ctx.actor.role === 'admin') return ctx.store.find('cases', {}, { order: [['created_at', 'desc']] });
  const memberships = await ctx.store.find('case_members', { user_id: ctx.actor.id });
  const active = memberships.filter(row => isActive(row));
  const out = [];
  for (const membership of active) {
    const record = await ctx.store.get('cases', membership.case_id);
    if (record && !out.some(c => c.id === record.id)) out.push(record);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

module.exports = { requireCase, grant, revoke, listMembers, membershipFor, visibleCases, isActive };
