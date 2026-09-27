/* Review cases. A case scopes records, payments, evidence, reports, agent runs
 * and access grants, which is what makes case-level restrictions enforceable. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const validate = require('../lib/validate');
const rbac = require('../auth/rbac');
const rules = require('../rules/registry');
const access = require('../auth/access');
const audit = require('./audit.service');

async function ensureRuleSet(store, config = {}) {
  const built = rules.buildRuleSet(config);
  const existing = await store.findOne('rule_sets', { version: built.version });
  if (existing) return existing;
  return store.insert('rule_sets', {
    id: id('rs'),
    version: built.version,
    label: built.label,
    disclaimer: built.disclaimer,
    config: built.config,
    created_at: built.createdAt
  });
}

async function create(ctx, input) {
  rbac.requirePermission(ctx.actor.role, 'case.create');
  const body = validate.only(input, ['title', 'period', 'ruleConfig'], 'Case');
  const title = validate.text(body.title, 'Case title', { max: 140 });
  const period = validate.period(body.period);
  const ruleSet = await ensureRuleSet(ctx.store, body.ruleConfig || {});
  const record = await ctx.store.insert('cases', {
    id: id('case'),
    title,
    period,
    status: 'open',
    data_revision: 1,
    rule_set_id: ruleSet.id,
    created_at: clock.now(),
    created_by: ctx.actor.id
  });
  await audit.record(ctx, 'case.created', { caseId: record.id, subjectType: 'case', subjectId: record.id, detail: { title, period } });
  return record;
}

/** Every write that changes reviewed data advances the revision, which is how
 *  stale checks, stale drafts and no-longer-applicable approvals are detected. */
async function bumpRevision(store, caseId) {
  const record = await store.get('cases', caseId);
  return store.update('cases', caseId, { data_revision: record.data_revision + 1 });
}

async function ruleSetFor(store, caseRecord) {
  const row = await store.get('rule_sets', caseRecord.rule_set_id);
  if (row) return row;
  return ensureRuleSet(store, {});
}

async function setRuleConfig(ctx, caseId, ruleConfig) {
  rbac.requirePermission(ctx.actor.role, 'case.create');
  const ruleSet = await ensureRuleSet(ctx.store, ruleConfig);
  const before = await ctx.store.get('cases', caseId);
  if (before.rule_set_id === ruleSet.id) return { case: before, ruleSet, changed: false };
  const updated = await ctx.store.update('cases', caseId, { rule_set_id: ruleSet.id });
  await audit.record(ctx, 'case.rules_changed', {
    caseId, subjectType: 'rule_set', subjectId: ruleSet.id,
    detail: { fromVersion: (await ctx.store.get('rule_sets', before.rule_set_id))?.version, toVersion: ruleSet.version }
  });
  return { case: updated, ruleSet, changed: true };
}

const view = (record, ruleSet) => ({
  id: record.id,
  title: record.title,
  period: record.period,
  status: record.status,
  dataRevision: record.data_revision,
  createdAt: record.created_at,
  ruleSet: ruleSet ? {
    id: ruleSet.id, version: ruleSet.version, label: ruleSet.label,
    disclaimer: ruleSet.disclaimer, rules: ruleSet.config.rules
  } : null
});

async function list(ctx) {
  const records = await access.visibleCases(ctx);
  const out = [];
  for (const record of records) out.push(view(record, await ctx.store.get('rule_sets', record.rule_set_id)));
  return out;
}

async function detail(ctx, caseId) {
  const { case: record, membership } = await access.requireCase(ctx, caseId, 'case.read');
  const ruleSet = await ruleSetFor(ctx.store, record);
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId, subjectType: 'case', subjectId: caseId, detail: { membershipExpiresAt: membership?.expires_at || null } });
  }
  return {
    ...view(record, ruleSet),
    membership: membership ? { caseRole: membership.case_role, expiresAt: membership.expires_at, grantedAt: membership.granted_at } : null,
    permissions: rbac.permissionsFor(ctx.actor.role)
  };
}

module.exports = { create, list, detail, view, bumpRevision, ensureRuleSet, ruleSetFor, setRuleConfig };
