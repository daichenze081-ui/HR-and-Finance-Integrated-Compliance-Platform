/* Browser API client for the PeopleLedger server.
 *
 * The session lives in an HttpOnly, SameSite=Strict cookie set by the server, so
 * no token is ever held in JavaScript or in browser storage. Every call is
 * same-origin and carries that cookie automatically.
 *
 * This file is the only place the client talks to the backend. A different backend
 * implementation behind the same /api/v1 contract needs no change above this line. */
(function (root) {
  'use strict';
  const BASE = '/api/v1';

  class ApiError extends Error {
    constructor(status, payload) {
      const body = payload && payload.error ? payload.error : {};
      super(body.message || `Request failed with status ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = body.code || 'request_failed';
      this.detail = body.detail;
    }
  }

  function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  async function request(method, path, options = {}) {
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    };
    if (options.raw !== undefined) {
      init.body = options.raw;
      init.headers['Content-Type'] = options.contentType || 'application/octet-stream';
    } else if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(`${BASE}${path}${query(options.query)}`, init);
    } catch (error) {
      throw new ApiError(0, { error: { code: 'network_error', message: `The server could not be reached (${error.message}).` } });
    }

    const type = response.headers.get('content-type') || '';
    if (options.binary) {
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { /* non-JSON error */ }
        throw new ApiError(response.status, payload);
      }
      return {
        blob: await response.blob(),
        filename: filenameFrom(response.headers.get('content-disposition')) || 'download',
        headers: response.headers
      };
    }

    const payload = type.includes('application/json') ? await response.json() : { raw: await response.text() };
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  }

  function filenameFrom(header) {
    const match = /filename="([^"]+)"/.exec(header || '');
    return match ? match[1] : null;
  }

  const api = {
    ApiError,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    del: (path, options) => request('DELETE', path, options),

    // --- session ------------------------------------------------------------
    meta: () => request('GET', '/meta'),
    me: () => request('GET', '/auth/me'),
    login: (email, password) => request('POST', '/auth/login', { body: { email, password } }),
    logout: () => request('POST', '/auth/logout', { body: {} }),

    // --- cases --------------------------------------------------------------
    cases: () => request('GET', '/cases'),
    caseDetail: id => request('GET', `/cases/${id}`),
    setRules: (id, ruleConfig) => request('PUT', `/cases/${id}/rules`, { body: { ruleConfig } }),
    members: id => request('GET', `/cases/${id}/members`),
    grantAccess: (id, body) => request('POST', `/cases/${id}/members`, { body }),
    revokeAccess: (id, memberId) => request('DELETE', `/cases/${id}/members/${memberId}`),
    users: () => request('GET', '/users'),
    audit: (id, scope) => request('GET', `/cases/${id}/audit`, { query: { scope } }),

    // --- payroll ------------------------------------------------------------
    records: id => request('GET', `/cases/${id}/records`),
    employees: id => request('GET', `/cases/${id}/employees`),
    previewRecords: (id, source) => request('POST', `/cases/${id}/records/preview`, { body: source }),
    replaceRecords: (id, body) => request('POST', `/cases/${id}/records`, { body }),
    updateRecord: (id, employeeNo, body) => request('PATCH', `/cases/${id}/records/${encodeURIComponent(employeeNo)}`, { body }),
    recordHistory: id => request('GET', `/cases/${id}/records/history`),

    // --- checks and rules ---------------------------------------------------
    runChecks: id => request('POST', `/cases/${id}/checks`, { body: {} }),
    latestCheck: id => request('GET', `/cases/${id}/checks/latest`),
    rules: () => request('GET', '/rules'),

    // --- payments -----------------------------------------------------------
    payments: id => request('GET', `/cases/${id}/payments`),
    // A file is sent either as csv text or as workbookBase64 plus a worksheet name.
    previewPayments: (id, source) => request('POST', `/cases/${id}/payments/preview`, { body: source }),
    importPayments: (id, body) => request('POST', `/cases/${id}/payments/import`, { body }),

    // --- bank statements and three-way reconciliation -----------------------
    bank: id => request('GET', `/cases/${id}/bank`),
    previewBank: (id, source) => request('POST', `/cases/${id}/bank/preview`, { body: source }),
    importBank: (id, body) => request('POST', `/cases/${id}/bank/import`, { body }),
    runReconciliation: id => request('POST', `/cases/${id}/reconciliation`, { body: {} }),
    latestReconciliation: id => request('GET', `/cases/${id}/reconciliation/latest`),

    // --- evidence -----------------------------------------------------------
    evidence: (id, filters) => request('GET', `/cases/${id}/evidence`, { query: filters }),
    uploadEvidence: (id, meta, file) => request('POST', `/cases/${id}/evidence`, {
      query: meta, raw: file, contentType: meta.mediaType || file.type || 'application/octet-stream'
    }),
    evidenceFile: evidenceId => request('GET', `/evidence/${evidenceId}`),
    downloadEvidence: evidenceId => request('GET', `/evidence/${evidenceId}/download`, { binary: true }),

    // --- reports ------------------------------------------------------------
    reports: id => request('GET', `/cases/${id}/reports`),
    reportSummary: id => request('GET', `/cases/${id}/reports/summary`),
    report: reportId => request('GET', `/reports/${reportId}`),
    createReport: (id, body) => request('POST', `/cases/${id}/reports`, { body: body || {} }),
    advanceReport: (reportId, stage, note) => request('POST', `/reports/${reportId}/${stage}`, { body: { note } }),
    rejectReport: (reportId, note) => request('POST', `/reports/${reportId}/reject`, { body: { note } }),

    // --- agent --------------------------------------------------------------
    agentTools: () => request('GET', '/agent/tools'),
    agentRuns: id => request('GET', `/cases/${id}/agent/runs`),
    agentRun: runId => request('GET', `/agent/runs/${runId}`),
    startAgentRun: (id, body) => request('POST', `/cases/${id}/agent/runs`, { body: body || {} }),

    // --- recruitment --------------------------------------------------------
    jobs: () => request('GET', '/jobs'),
    createJob: body => request('POST', '/jobs', { body }),
    openJob: jobId => request('POST', `/jobs/${jobId}/open`, { body: {} }),
    closeJob: jobId => request('POST', `/jobs/${jobId}/close`, { body: {} }),
    addAdvertisement: (jobId, body) => request('POST', `/jobs/${jobId}/advertisements`, { body }),
    candidates: jobId => request('GET', `/jobs/${jobId}/candidates`),
    createCandidate: (jobId, body) => request('POST', `/jobs/${jobId}/candidates`, { body }),
    advanceCandidate: (candidateId, body) => request('POST', `/candidates/${candidateId}/stage`, { body }),
    scorecards: candidateId => request('GET', `/candidates/${candidateId}/scorecards`),
    addScorecard: (candidateId, body) => request('POST', `/candidates/${candidateId}/scorecards`, { body }),
    onboard: (candidateId, body) => request('POST', `/candidates/${candidateId}/onboard`, { body }),
    interviews: candidateId => request('GET', `/candidates/${candidateId}/interviews`),
    scheduleInterview: (candidateId, body) => request('POST', `/candidates/${candidateId}/interviews`, { body }),
    rescheduleInterview: (meetingId, body) => request('POST', `/interviews/${meetingId}/reschedule`, { body }),
    cancelInterview: (meetingId, body) => request('POST', `/interviews/${meetingId}/cancel`, { body }),

    // --- exports ------------------------------------------------------------
    exportPackage: (id, reportId) => request('GET', `/cases/${id}/export/package`, { binary: true, query: { reportId } }),
    exportRecordsCsv: id => request('GET', `/cases/${id}/export/records.csv`, { binary: true }),
    exportEvidenceJson: id => request('GET', `/cases/${id}/export/evidence.json`),
    paymentsTemplate: () => request('GET', '/templates/payments.csv', { binary: true }),
    bankTemplate: () => request('GET', '/templates/bank.csv', { binary: true })
  };

  root.PeopleLedgerApi = api;
})(window);
