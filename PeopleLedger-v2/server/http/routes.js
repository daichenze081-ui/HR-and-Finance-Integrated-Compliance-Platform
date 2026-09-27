/* Versioned REST surface under /api/v1.
 *
 * Routes only translate HTTP into service calls. All authorisation, validation and
 * state transitions live in the services, so a different backend implementation can
 * be put behind the same paths without changing the browser client or the agent. */
'use strict';
const config = require('../config');
const { badRequest, notFound } = require('../lib/errors');
const rbac = require('../auth/rbac');
const access = require('../auth/access');
const sessions = require('../auth/sessions');
const http = require('../lib/http');
const csvLib = require('../lib/csv');

const casesService = require('../services/cases.service');
const recordsService = require('../services/records.service');
const checksService = require('../services/checks.service');
const paymentsService = require('../services/payments.service');
const reconciliationService = require('../services/reconciliation.service');
const evidenceService = require('../services/evidence.service');
const reportsService = require('../services/reports.service');
const recruitmentService = require('../services/recruitment.service');
const interviewsService = require('../services/interviews.service');
const exportService = require('../services/export.service');
const auditService = require('../services/audit.service');
const agentLoop = require('../agent/loop');
const agentTools = require('../agent/tools');
const rules = require('../rules/registry');
const prompt = require('../agent/prompt');

const PUBLIC = new Set(['POST /api/v1/auth/login', 'GET /api/v1/meta']);

const created = body => ({ status: 201, body });

// ---------------------------------------------------------------------------
// Metadata and authentication
// ---------------------------------------------------------------------------

const meta = {
  'GET /api/v1/meta': async ctx => ({
    api: 'people-ledger',
    version: 'v1',
    serverAuthoritative: true,
    storage: { database: ctx.store.driver, databaseLabel: ctx.store.label },
    integrations: config.integrationStatus(),
    agent: {
      promptVersion: prompt.PROMPT_VERSION,
      tools: agentTools.declarations().map(tool => ({ name: tool.name, description: tool.description })),
      deniedOperations: agentTools.DENIED_OPERATIONS,
      limits: config.agent
    },
    roles: Object.entries(rbac.ROLES).map(([id, role]) => ({ id, ...role, permissions: rbac.permissionsFor(id) })),
    approvalChain: rbac.APPROVAL_CHAIN,
    rules: {
      label: rules.LABEL,
      disclaimer: rules.DISCLAIMER,
      baseVersion: rules.BASE_VERSION,
      catalogue: rules.DEFAULT_RULES
    },
    imports: {
      // One validation path accepts both containers for every dataset.
      containers: ['csv', 'xlsx'],
      payments: paymentsService.HEADERS,
      bank: reconciliationService.HEADERS,
      reconciliationMethod: reconciliationService.METHOD,
      note: 'Workbook imports are read server-side without executing anything: formulas, error cells and macros are refused, not evaluated.'
    },
    notice: 'Demonstration system. Use synthetic data only. Rule results are not legal compliance determinations.'
  }),

  'POST /api/v1/auth/login': async ctx => {
    const body = await ctx.json();
    const result = await sessions.login(ctx.store, {
      email: body.email,
      password: body.password,
      userAgent: ctx.req.headers['user-agent'] || ''
    });
    await auditService.record(
      { ...ctx, actor: { id: result.user.id, role: result.user.role } },
      'auth.login',
      { subjectType: 'user', subjectId: result.user.id, detail: { role: result.user.role } }
    );
    return {
      status: 200,
      body: {
        user: sessions.publicUser(result.user),
        permissions: rbac.permissionsFor(result.user.role),
        expiresAt: result.session.expires_at,
        token: result.token
      },
      headers: {
        'Set-Cookie': http.cookie(config.session.cookie, result.token, {
          maxAgeSeconds: config.session.ttlMinutes * 60,
          secure: false
        })
      }
    };
  },

  'POST /api/v1/auth/logout': async ctx => {
    ctx.requireActor();
    await sessions.logout(ctx.store, ctx.token);
    return {
      status: 200,
      body: { signedOut: true },
      headers: { 'Set-Cookie': http.cookie(config.session.cookie, '', { maxAgeSeconds: 0 }) }
    };
  },

  'GET /api/v1/auth/me': async ctx => {
    const actor = ctx.requireActor();
    return {
      user: { id: actor.id, email: actor.email, displayName: actor.displayName, role: actor.role },
      roleLabel: rbac.ROLES[actor.role]?.label || actor.role,
      permissions: actor.permissions,
      sessionExpiresAt: ctx.session?.expires_at || null
    };
  }
};

// ---------------------------------------------------------------------------
// Cases and access
// ---------------------------------------------------------------------------

const cases = {
  'GET /api/v1/cases': async ctx => { ctx.requireActor(); return { cases: await casesService.list(ctx) }; },
  'POST /api/v1/cases': async ctx => { ctx.requireActor(); return created(await casesService.create(ctx, await ctx.json())); },
  'GET /api/v1/cases/:caseId': async ctx => { ctx.requireActor(); return casesService.detail(ctx, ctx.param('caseId')); },

  'PUT /api/v1/cases/:caseId/rules': async ctx => {
    ctx.requireActor();
    await access.requireCase(ctx, ctx.param('caseId'), 'case.read');
    const body = await ctx.json();
    const result = await casesService.setRuleConfig(ctx, ctx.param('caseId'), body.ruleConfig || body);
    return {
      changed: result.changed,
      ruleSet: { version: result.ruleSet.version, label: result.ruleSet.label, disclaimer: result.ruleSet.disclaimer, rules: result.ruleSet.config.rules },
      note: result.changed
        ? 'Rule version changed. Existing checks and reports are now stale and recorded approvals no longer apply.'
        : 'No change: the requested configuration matches the active rule set.'
    };
  },

  'GET /api/v1/cases/:caseId/members': async ctx => {
    ctx.requireActor();
    await access.requireCase(ctx, ctx.param('caseId'), 'case.read');
    return { members: await access.listMembers(ctx, ctx.param('caseId')) };
  },

  'POST /api/v1/cases/:caseId/members': async ctx => {
    ctx.requireActor();
    const body = await ctx.json();
    const member = await access.grant(ctx, {
      caseId: ctx.param('caseId'),
      userId: body.userId,
      caseRole: body.caseRole,
      expiresAt: body.expiresAt || null
    });
    await auditService.record(ctx, 'access.granted', {
      caseId: ctx.param('caseId'), subjectType: 'case_member', subjectId: member.id,
      detail: { userId: body.userId, caseRole: member.case_role, expiresAt: member.expires_at }
    });
    return created({ member, note: member.expires_at ? `Access expires at ${member.expires_at}.` : 'Access does not expire.' });
  },

  'DELETE /api/v1/cases/:caseId/members/:memberId': async ctx => {
    ctx.requireActor();
    const member = await access.revoke(ctx, ctx.param('memberId'));
    await auditService.record(ctx, 'access.revoked', {
      caseId: ctx.param('caseId'), subjectType: 'case_member', subjectId: member.id, detail: { userId: member.user_id }
    });
    return { member };
  },

  'GET /api/v1/cases/:caseId/audit': async ctx => {
    ctx.requireActor();
    await access.requireCase(ctx, ctx.param('caseId'), 'audit.read');
    const onlyAccess = ctx.query.scope === 'access';
    return {
      entries: await auditService.list(ctx, {
        caseId: ctx.param('caseId'),
        limit: Math.min(Number(ctx.query.limit) || 200, 500),
        actions: onlyAccess ? auditService.ACCESS_ACTIONS : null
      })
    };
  },

  'GET /api/v1/users': async ctx => {
    ctx.requirePermission('access.grant');
    const users = await ctx.store.find('users', {}, { order: [['role', 'asc']] });
    return { users: users.map(sessions.publicUser) };
  }
};

// ---------------------------------------------------------------------------
// Records, checks and payments
// ---------------------------------------------------------------------------

const payroll = {
  'GET /api/v1/cases/:caseId/records': async ctx => { ctx.requireActor(); return recordsService.list(ctx, ctx.param('caseId')); },

  'POST /api/v1/cases/:caseId/records/preview': async ctx => {
    ctx.requirePermission('records.import');
    await access.requireCase(ctx, ctx.param('caseId'), 'records.import');
    const body = await ctx.json();
    return {
      preview: recordsService.preview(csvLib.requestSource(body)),
      note: 'Preview only. Nothing has been written.'
    };
  },

  'POST /api/v1/cases/:caseId/records': async ctx => {
    ctx.requireActor();
    return recordsService.replaceAll(ctx, ctx.param('caseId'), await ctx.json());
  },

  'PATCH /api/v1/cases/:caseId/records/:employeeNo': async ctx => {
    ctx.requireActor();
    return recordsService.update(ctx, ctx.param('caseId'), ctx.param('employeeNo'), await ctx.json());
  },

  'GET /api/v1/cases/:caseId/records/history': async ctx => {
    ctx.requireActor();
    return { changes: await recordsService.history(ctx, ctx.param('caseId')) };
  },

  'GET /api/v1/cases/:caseId/employees': async ctx => {
    ctx.requireActor();
    return { employees: await recordsService.employees(ctx, ctx.param('caseId')) };
  },

  'POST /api/v1/cases/:caseId/checks': async ctx => { ctx.requireActor(); return created(await checksService.run(ctx, ctx.param('caseId'))); },
  'GET /api/v1/cases/:caseId/checks/latest': async ctx => { ctx.requireActor(); return checksService.latest(ctx, ctx.param('caseId')); },

  'GET /api/v1/cases/:caseId/payments': async ctx => { ctx.requireActor(); return paymentsService.list(ctx, ctx.param('caseId')); },
  'POST /api/v1/cases/:caseId/payments/preview': async ctx => { ctx.requireActor(); return paymentsService.preview(ctx, ctx.param('caseId'), await ctx.json()); },
  'POST /api/v1/cases/:caseId/payments/import': async ctx => { ctx.requireActor(); return created(await paymentsService.importBatch(ctx, ctx.param('caseId'), await ctx.json())); },

  // --- bank statements and three-way reconciliation -------------------------
  'GET /api/v1/cases/:caseId/bank': async ctx => { ctx.requireActor(); return reconciliationService.list(ctx, ctx.param('caseId')); },
  'POST /api/v1/cases/:caseId/bank/preview': async ctx => { ctx.requireActor(); return reconciliationService.preview(ctx, ctx.param('caseId'), await ctx.json()); },
  'POST /api/v1/cases/:caseId/bank/import': async ctx => { ctx.requireActor(); return created(await reconciliationService.importBatch(ctx, ctx.param('caseId'), await ctx.json())); },
  'POST /api/v1/cases/:caseId/reconciliation': async ctx => { ctx.requireActor(); return created(await reconciliationService.run(ctx, ctx.param('caseId'))); },
  'GET /api/v1/cases/:caseId/reconciliation/latest': async ctx => { ctx.requireActor(); return reconciliationService.latest(ctx, ctx.param('caseId')); },

  'GET /api/v1/templates/payments.csv': async ctx => {
    ctx.requireActor();
    return { __binary: { buffer: Buffer.from(paymentsService.template(), 'utf8'), type: 'text/csv; charset=utf-8', filename: 'payments-template.csv' } };
  },

  'GET /api/v1/templates/bank.csv': async ctx => {
    ctx.requireActor();
    return { __binary: { buffer: Buffer.from(reconciliationService.template(), 'utf8'), type: 'text/csv; charset=utf-8', filename: 'bank-statement-template.csv' } };
  },

  'GET /api/v1/rules': async ctx => {
    ctx.requirePermission('rules.read');
    return { label: rules.LABEL, disclaimer: rules.DISCLAIMER, baseVersion: rules.BASE_VERSION, rules: rules.DEFAULT_RULES };
  }
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const evidence = {
  'GET /api/v1/cases/:caseId/evidence': async ctx => {
    ctx.requireActor();
    return { files: await evidenceService.list(ctx, ctx.param('caseId'), { subjectType: ctx.query.subjectType, subjectId: ctx.query.subjectId }) };
  },

  /* Raw-body upload: metadata travels in the query string, bytes in the body. The
   * bytes are stored and hashed, never parsed or executed. */
  'POST /api/v1/cases/:caseId/evidence': async ctx => {
    ctx.requireActor();
    const buffer = await ctx.raw();
    const result = await evidenceService.upload(ctx, ctx.param('caseId'), {
      filename: ctx.query.filename,
      subjectType: ctx.query.subjectType,
      subjectId: ctx.query.subjectId,
      source: ctx.query.source,
      mediaType: ctx.query.mediaType || ctx.req.headers['content-type']
    }, buffer);
    return result.duplicate ? { status: 200, body: result } : created(result);
  },

  'GET /api/v1/evidence/:evidenceId': async ctx => { ctx.requireActor(); return evidenceService.get(ctx, ctx.param('evidenceId')); },

  'GET /api/v1/evidence/:evidenceId/download': async ctx => {
    ctx.requireActor();
    const { buffer, file } = await evidenceService.download(ctx, ctx.param('evidenceId'));
    return {
      __binary: {
        buffer,
        type: file.mediaType,
        filename: file.filename,
        headers: { 'X-Evidence-Sha256': file.sha256, 'X-Evidence-Version': String(file.version) }
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Reports, approvals and exports
// ---------------------------------------------------------------------------

const reports = {
  'GET /api/v1/cases/:caseId/reports': async ctx => { ctx.requireActor(); return { reports: await reportsService.list(ctx, ctx.param('caseId')) }; },
  'GET /api/v1/cases/:caseId/reports/summary': async ctx => { ctx.requireActor(); return reportsService.summary(ctx, ctx.param('caseId')); },
  'POST /api/v1/cases/:caseId/reports': async ctx => {
    ctx.requireActor();
    const body = await ctx.json();
    // A draft supplied over HTTP is not accepted: model drafts only arrive through
    // the agent tool, which binds them to a recorded run.
    if (body.draft) throw badRequest('Drafts are produced by the server template or by an agent run. Use POST /agent/runs to request a model draft.');
    return created(await reportsService.create(ctx, ctx.param('caseId'), { amendsReportId: body.amendsReportId }));
  },
  'GET /api/v1/reports/:reportId': async ctx => { ctx.requireActor(); return reportsService.detail(ctx, ctx.param('reportId')); },
  'POST /api/v1/reports/:reportId/submit': async ctx => { ctx.requireActor(); return reportsService.advance(ctx, ctx.param('reportId'), 'submit', await ctx.json()); },
  'POST /api/v1/reports/:reportId/review': async ctx => { ctx.requireActor(); return reportsService.advance(ctx, ctx.param('reportId'), 'review', await ctx.json()); },
  'POST /api/v1/reports/:reportId/confirm': async ctx => { ctx.requireActor(); return reportsService.advance(ctx, ctx.param('reportId'), 'confirm', await ctx.json()); },
  'POST /api/v1/reports/:reportId/approve': async ctx => { ctx.requireActor(); return reportsService.advance(ctx, ctx.param('reportId'), 'approve', await ctx.json()); },
  'POST /api/v1/reports/:reportId/seal': async ctx => { ctx.requireActor(); return reportsService.advance(ctx, ctx.param('reportId'), 'seal', await ctx.json()); },
  'POST /api/v1/reports/:reportId/reject': async ctx => { ctx.requireActor(); return reportsService.reject(ctx, ctx.param('reportId'), await ctx.json()); },

  'GET /api/v1/cases/:caseId/export/package': async ctx => {
    ctx.requireActor();
    const built = await exportService.buildPackage(ctx, ctx.param('caseId'), { reportId: ctx.query.reportId || null });
    return {
      __binary: {
        buffer: built.archive,
        type: 'application/zip',
        filename: built.filename,
        headers: { 'X-Package-Sha256': built.archiveSha256, 'X-Manifest-Digest': built.manifest.manifestDigest }
      }
    };
  },

  'GET /api/v1/cases/:caseId/export/evidence.json': async ctx => { ctx.requireActor(); return exportService.evidenceJson(ctx, ctx.param('caseId')); },

  'GET /api/v1/cases/:caseId/export/records.csv': async ctx => {
    ctx.requireActor();
    const csv = await exportService.recordsCsv(ctx, ctx.param('caseId'));
    return { __binary: { buffer: Buffer.from(csv, 'utf8'), type: 'text/csv; charset=utf-8', filename: `people-ledger-records-${ctx.param('caseId')}.csv` } };
  }
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = {
  'POST /api/v1/cases/:caseId/agent/runs': async ctx => {
    ctx.requireActor();
    return created(await agentLoop.run(ctx, ctx.param('caseId'), await ctx.json()));
  },
  'GET /api/v1/cases/:caseId/agent/runs': async ctx => { ctx.requireActor(); return { runs: await agentLoop.list(ctx, ctx.param('caseId')) }; },
  'GET /api/v1/agent/runs/:runId': async ctx => { ctx.requireActor(); return agentLoop.detail(ctx, ctx.param('runId')); },
  'GET /api/v1/agent/tools': async ctx => {
    ctx.requireActor();
    return {
      promptVersion: prompt.PROMPT_VERSION,
      tools: agentTools.declarations(),
      deniedOperations: agentTools.DENIED_OPERATIONS,
      limits: config.agent,
      note: 'Tool authorisation is bound to the signed-in account and the case on the server. Model input cannot widen it.'
    };
  }
};

// ---------------------------------------------------------------------------
// Recruitment and simulated interviews
// ---------------------------------------------------------------------------

const recruitment = {
  'GET /api/v1/jobs': async ctx => { ctx.requireActor(); return { jobs: await recruitmentService.listJobs(ctx) }; },
  'POST /api/v1/jobs': async ctx => { ctx.requireActor(); return created(await recruitmentService.createJob(ctx, await ctx.json())); },
  'POST /api/v1/jobs/:jobId/open': async ctx => { ctx.requireActor(); return recruitmentService.openJob(ctx, ctx.param('jobId')); },
  'POST /api/v1/jobs/:jobId/close': async ctx => { ctx.requireActor(); return recruitmentService.closeJob(ctx, ctx.param('jobId')); },
  'POST /api/v1/jobs/:jobId/advertisements': async ctx => { ctx.requireActor(); return created(await recruitmentService.addAdvertisement(ctx, ctx.param('jobId'), await ctx.json())); },
  'GET /api/v1/jobs/:jobId/candidates': async ctx => { ctx.requireActor(); return { candidates: await recruitmentService.listCandidates(ctx, ctx.param('jobId')) }; },
  'POST /api/v1/jobs/:jobId/candidates': async ctx => { ctx.requireActor(); return created(await recruitmentService.createCandidate(ctx, ctx.param('jobId'), await ctx.json())); },
  'POST /api/v1/candidates/:candidateId/stage': async ctx => { ctx.requireActor(); return recruitmentService.advanceCandidate(ctx, ctx.param('candidateId'), await ctx.json()); },
  'GET /api/v1/candidates/:candidateId/scorecards': async ctx => { ctx.requireActor(); return { scorecards: await recruitmentService.listScorecards(ctx, ctx.param('candidateId')) }; },
  'POST /api/v1/candidates/:candidateId/scorecards': async ctx => { ctx.requireActor(); return created(await recruitmentService.addScorecard(ctx, ctx.param('candidateId'), await ctx.json())); },
  'POST /api/v1/candidates/:candidateId/onboard': async ctx => { ctx.requireActor(); return created(await recruitmentService.onboard(ctx, ctx.param('candidateId'), await ctx.json())); },

  'GET /api/v1/candidates/:candidateId/interviews': async ctx => { ctx.requireActor(); return interviewsService.list(ctx, ctx.param('candidateId')); },
  'POST /api/v1/candidates/:candidateId/interviews': async ctx => {
    ctx.requireActor();
    const result = await interviewsService.schedule(ctx, ctx.param('candidateId'), await ctx.json());
    return { status: result.duplicate ? 200 : (result.error ? 502 : 201), body: result };
  },
  'POST /api/v1/interviews/:meetingId/reschedule': async ctx => {
    ctx.requireActor();
    const result = await interviewsService.reschedule(ctx, ctx.param('meetingId'), await ctx.json());
    return { status: result.error ? 502 : 200, body: result };
  },
  'POST /api/v1/interviews/:meetingId/cancel': async ctx => { ctx.requireActor(); return interviewsService.cancel(ctx, ctx.param('meetingId'), await ctx.json()); },
  'GET /api/v1/interviews': async ctx => { ctx.requireActor(); return interviewsService.list(ctx, ctx.query.candidateId || null); }
};

const TABLES = [meta, cases, payroll, evidence, reports, agent, recruitment];

function mountAll(router) {
  for (const table of TABLES) router.mount(table);
  return router;
}

module.exports = { TABLES, mountAll, PUBLIC, notFound };
