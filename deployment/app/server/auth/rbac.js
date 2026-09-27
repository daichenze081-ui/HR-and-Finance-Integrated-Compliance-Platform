/* Server-side permission model.
 *
 * The browser never decides what is allowed. Every route declares the permission
 * it needs, and every case-scoped route additionally requires an active
 * membership row for that case. Roles here are separate accounts, not a
 * client-side role selector. */
'use strict';
const { forbidden } = require('../lib/errors');

const ROLES = {
  hr: {
    label: 'HR specialist',
    description: 'Maintains people and payroll source records, runs recruitment and schedules interviews.'
  },
  finance_preparer: {
    label: 'Finance preparer',
    description: 'Imports payments, runs checks, requests agent drafts and submits reports for review.'
  },
  reviewer: {
    label: 'Finance reviewer',
    description: 'Reviews a submitted report. Cannot review a report they prepared.'
  },
  management: {
    label: 'Management',
    description: 'Confirms a finance-reviewed report before it reaches a director.'
  },
  director: {
    label: 'Director',
    description: 'Approves, rejects and seals reports. Grants time-limited auditor access.'
  },
  auditor: {
    label: 'Read-only auditor',
    description: 'Case-scoped, time-limited read access. Every read and export is logged.'
  },
  admin: {
    label: 'Platform administrator',
    description: 'Operational account used for seeding and access administration.'
  }
};

const PERMISSIONS = [
  'case.read', 'case.create', 'access.grant',
  'records.read', 'records.write', 'records.import',
  'checks.run', 'rules.read',
  'payments.preview', 'payments.import',
  'evidence.upload', 'evidence.read', 'evidence.download',
  'reports.read', 'reports.create', 'reports.submit', 'reports.review',
  'reports.confirm', 'reports.approve', 'reports.seal', 'reports.amend',
  'agent.run',
  'recruitment.read', 'recruitment.write', 'recruitment.advance', 'interviews.write',
  'export.package', 'audit.read'
];

const GRANTS = {
  hr: [
    'case.read', 'records.read', 'records.write', 'records.import', 'checks.run', 'rules.read',
    'evidence.upload', 'evidence.read', 'evidence.download', 'reports.read',
    'recruitment.read', 'recruitment.write', 'recruitment.advance', 'interviews.write'
  ],
  finance_preparer: [
    'case.read', 'records.read', 'checks.run', 'rules.read',
    'payments.preview', 'payments.import',
    'evidence.upload', 'evidence.read', 'evidence.download',
    'reports.read', 'reports.create', 'reports.submit', 'reports.amend',
    'agent.run', 'export.package'
  ],
  reviewer: [
    'case.read', 'records.read', 'checks.run', 'rules.read',
    'evidence.read', 'evidence.download',
    'reports.read', 'reports.review', 'export.package'
  ],
  management: [
    'case.read', 'records.read', 'rules.read',
    'evidence.read', 'evidence.download',
    'reports.read', 'reports.confirm', 'export.package'
  ],
  director: [
    'case.read', 'records.read', 'rules.read',
    'evidence.read', 'evidence.download',
    'reports.read', 'reports.approve', 'reports.seal',
    'recruitment.read', 'export.package', 'audit.read', 'access.grant'
  ],
  auditor: [
    'case.read', 'records.read', 'rules.read',
    'evidence.read', 'evidence.download',
    'reports.read', 'recruitment.read', 'export.package', 'audit.read'
  ],
  admin: [...PERMISSIONS]
};

for (const [role, granted] of Object.entries(GRANTS)) {
  const unknown = granted.filter(p => !PERMISSIONS.includes(p));
  if (unknown.length) throw new Error(`Role ${role} grants unknown permission: ${unknown.join(', ')}`);
}

/** Approval stages in order. Each stage names the permission that advances it. */
const APPROVAL_CHAIN = [
  { stage: 'submit', from: 'draft', to: 'submitted', permission: 'reports.submit', label: 'Draft submitted by finance preparer' },
  { stage: 'review', from: 'submitted', to: 'finance_reviewed', permission: 'reports.review', label: 'Finance review completed' },
  { stage: 'confirm', from: 'finance_reviewed', to: 'management_confirmed', permission: 'reports.confirm', label: 'Management confirmation recorded' },
  { stage: 'approve', from: 'management_confirmed', to: 'approved', permission: 'reports.approve', label: 'Director approved' },
  { stage: 'seal', from: 'approved', to: 'sealed', permission: 'reports.seal', label: 'Report sealed' }
];

const can = (role, permission) => (GRANTS[role] || []).includes(permission);

function require_(role, permission) {
  if (!can(role, permission)) {
    throw forbidden(`The ${ROLES[role]?.label || role} role cannot perform this action`, { requiredPermission: permission, role });
  }
  return true;
}

/** Recruitment personal data is only visible to HR. Everyone else sees references. */
const seesCandidateIdentity = role => role === 'hr' || role === 'admin';

/** Finance-side roles receive the payroll projection, not recruitment detail. */
const isFinanceSide = role => ['finance_preparer', 'reviewer', 'management', 'director'].includes(role);

module.exports = {
  ROLES, PERMISSIONS, GRANTS, APPROVAL_CHAIN,
  roleNames: Object.keys(ROLES),
  can,
  requirePermission: require_,
  permissionsFor: role => [...(GRANTS[role] || [])],
  seesCandidateIdentity,
  isFinanceSide
};
