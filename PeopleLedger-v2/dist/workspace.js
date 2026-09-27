/* Server-connected workspace.
 *
 * Everything shown here is read from the API. The client holds no authoritative
 * state: it never computes money, never decides permissions and never advances a
 * workflow locally. Buttons are hidden or disabled from the permission list the
 * server returns, and the server refuses the action regardless.
 *
 * The browser-local demo in index.html is untouched and still works offline. */
(function () {
  'use strict';
  const api = window.PeopleLedgerApi;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  const VIEWS = {
    overview: 'Overview',
    payroll: 'People & payroll',
    payments: 'Payment ledger',
    reconciliation: 'Bank reconciliation',
    checks: 'Data checks',
    evidence: 'Evidence files',
    agent: 'Agent tasks',
    reports: 'Reports & approvals',
    recruitment: 'Recruitment',
    access: 'Access & activity',
    exports: 'Exports'
  };

  const STATUS_LABEL = {
    draft: ['Draft', 'blue'],
    submitted: ['Awaiting finance review', 'warning'],
    finance_reviewed: ['Awaiting management confirmation', 'warning'],
    management_confirmed: ['Awaiting director approval', 'warning'],
    approved: ['Approved', 'success'],
    sealed: ['Sealed', 'success'],
    rejected: ['Returned for remediation', 'danger']
  };

  const STAGE_LABEL = {
    submit: 'Submit for review',
    review: 'Record finance review',
    confirm: 'Record management confirmation',
    approve: 'Approve',
    seal: 'Seal report'
  };

  const RUN_STATUS = {
    running: ['Running', 'blue'],
    completed: ['Completed', 'success'],
    failed: ['Failed', 'danger'],
    timeout: ['Timed out', 'danger'],
    limit_exceeded: ['Stopped at the tool-call limit', 'warning'],
    blocked: ['Blocked by a guardrail', 'warning']
  };

  const STATE_BADGE = { live: 'success', simulated: 'blue', 'awaiting-configuration': 'warning', deferred: '' };

  const state = {
    me: null,
    meta: null,
    caseId: null,
    cases: [],
    caseDetail: null,
    data: {},
    selectedReport: null,
    selectedRun: null,
    selectedJob: null,
    selectedCandidate: null,
    auditScope: null,
    // Pending import sources, held only until the preparer confirms or discards.
    pending: {},
    busy: false
  };

  /* Reads a chosen file into the shape every import endpoint accepts: CSV as text,
   * anything else as base64 bytes so the server decides whether it is a workbook. */
  async function readImportFile(file, worksheet) {
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    if (isCsv) return { csv: await file.text(), filename: file.name };
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const source = { workbookBase64: btoa(binary), filename: file.name };
    if (worksheet) source.worksheet = worksheet;
    return source;
  }

  // ---------------------------------------------------------------------------
  // Shell helpers
  // ---------------------------------------------------------------------------

  let toastTimer;
  function toast(message, isError = false) {
    clearTimeout(toastTimer);
    $('#toast').textContent = message;
    $('#toast').className = `show${isError ? ' error' : ''}`;
    toastTimer = setTimeout(() => { $('#toast').className = ''; }, 5200);
  }

  const can = permission => !!state.me && state.me.permissions.includes(permission);
  const view = () => (VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview');

  function when(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-SG', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  const badge = (label, kind = '') => `<span class="badge ${kind}">${esc(label)}</span>`;
  const button = (label, action, extra = '', kind = '') => `<button type="button" class="btn ${kind}" data-action="${action}" ${extra}>${esc(label)}</button>`;
  const short = value => `<code class="mono">${esc(String(value ?? '').slice(0, 10))}…</code>`;

  function header(kicker, title, description, actions = '') {
    return `<div class="page-header"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="actions">${actions}</div></div>`;
  }

  const stat = (label, value, detail, kind = '', mark = '') =>
    `<div class="stat ${kind}"><div class="stat-label">${esc(label)}<span class="stat-mark" aria-hidden="true">${esc(mark)}</span></div>`
    + `<div class="stat-number${mark === 'S$' ? ' currency' : ''}">${esc(value)}</div><div class="stat-foot">${detail}</div></div>`;

  const empty = (icon, title, detail, action = '') =>
    `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><h2>${esc(title)}</h2><p>${esc(detail)}</p>${action}</div>`;

  const notice = (text, kind = '') => `<div class="intro-line ${kind}"><span>${text}</span></div>`;

  /* HTML builders that eliminate the repeated card/table concatenation. They
   * reproduce the previous markup exactly; only the boilerplate is factored out.
   *
   * cardHead(title, { sub, aside, wrap }) — the <div class="card-head"> block.
   *   sub   pre-built HTML for the subtitle <p> (caller escapes as needed);
   *         its presence wraps the heading in a <div> like the old markup.
   *   aside pre-built HTML placed after the heading (a badge or button).
   *   wrap  force the heading-in-<div> form even without a subtitle. */
  const cardHead = (title, { sub = '', aside = '', wrap = false } = {}) =>
    '<div class="card-head">'
    + (sub || wrap ? `<div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>` : `<h2>${esc(title)}</h2>`)
    + aside + '</div>';

  /* card(title, body, opts) — a full <section class="card"> … </section>.
   * body is placed verbatim after the head. opts are passed to cardHead. */
  const card = (title, body = '', opts = {}) =>
    `<section class="card">${cardHead(title, opts)}${body}</section>`;

  /* table(headers, bodyRows, opts) — the <div class="table-wrap"><table> block.
   *   headers  array of header cell HTML (already-safe strings).
   *   bodyRows the <tr>… string; when empty, the empty fallback is used.
   *   opts.empty  fallback HTML shown in place of an empty <tbody>. A plain
   *               string is wrapped as a single spanning row; pass a full
   *               <tr>…</tr> to control it, or use opts.colspan with a message.
   *   opts.colspan / opts.emptyText build the "<tr><td colspan=n>msg</td></tr>".
   *   opts.note   optional <div class="table-note"> appended after the table. */
  function table(headers, bodyRows, { empty: emptyHtml = '', colspan = 0, emptyText = '', note = '' } = {}) {
    const head = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
    let body = bodyRows;
    if (!body) {
      body = emptyHtml
        || (colspan ? `<tr><td colspan="${colspan}">${esc(emptyText)}</td></tr>` : '');
    }
    return `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`
      + (note ? `<div class="table-note">${note}</div>` : '');
  }

  /** Renders a server error consistently, including its structured detail. */
  function describeError(error) {
    if (!error || !error.message) return 'Unexpected error';
    let text = error.message;
    const detail = error.detail;
    if (detail && typeof detail === 'object') {
      if (Array.isArray(detail.missing) && detail.missing.length) text += ` Missing: ${detail.missing.join(', ')}.`;
      else if (Array.isArray(detail.errors) && detail.errors.length) text += ` ${detail.errors.slice(0, 3).join(' ')}`;
      else if (detail.requiredPermission) text += ` Required permission: ${detail.requiredPermission}.`;
    }
    return text;
  }

  async function guard(fn, { success } = {}) {
    if (state.busy) return null;
    state.busy = true;
    try {
      const result = await fn();
      if (success) toast(success);
      return result;
    } catch (error) {
      toast(describeError(error), true);
      return null;
    } finally {
      state.busy = false;
    }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const saveText = (filename, text, type) => saveBlob(new Blob([text], { type }), filename);

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------

  function modal(title, body, actions) {
    $('#modal').innerHTML = `<div class="modal-head"><h2 id="dialog-title">${esc(title)}</h2>`
      + '<button class="close" type="button" data-close aria-label="Close">×</button></div>'
      + body
      + `<div class="modal-actions">${button('Cancel', 'close')}${actions || ''}</div>`;
    $('#modal').showModal();
  }
  const closeModal = () => $('#modal').close();

  const field = (label, name, value = '', extra = '', hint = '') =>
    `<label class="field">${esc(label)}<input name="${name}" value="${esc(value)}" ${extra}>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;

  const area = (label, name, value = '', extra = '', hint = '') =>
    `<label class="field full">${esc(label)}<textarea name="${name}" ${extra}>${esc(value)}</textarea>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;

  const select = (label, name, options, value = '') =>
    `<label class="field">${esc(label)}<select name="${name}">`
    + options.map(option => {
      const [key, text] = Array.isArray(option) ? option : [option, option];
      return `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(text)}</option>`;
    }).join('')
    + '</select></label>';

  const formValues = form => Object.fromEntries(new FormData(form).entries());

  /** A modal form whose submit handler receives the field values. */
  function formModal(title, description, fields, submitLabel, onSubmit) {
    modal(title,
      `<form id="ws-form" class="modal-body">${description ? `<p>${description}</p>` : ''}`
      + `<div class="form-grid">${fields}</div><div id="form-error" class="form-error" role="alert"></div></form>`,
      `<button type="submit" form="ws-form" class="btn primary">${esc(submitLabel)}</button>`);
    $('#ws-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      if (!form.reportValidity()) return;
      try {
        await onSubmit(formValues(form), form);
        closeModal();
      } catch (error) {
        $('#form-error').textContent = describeError(error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Sign in
  // ---------------------------------------------------------------------------

  function signInView() {
    const accounts = (state.meta?.roles || []).filter(role => role.id !== 'admin');
    return header('SESSION', 'Sign in to the workspace',
      'Separate accounts with server-enforced permissions. Enterprise single sign-on is not part of this stage.')
      + '<div class="columns">'
      + card('Sign in',
        '<div class="card-body">'
        + '<form id="signin-form" class="form-grid">'
        + field('Email', 'email', 'preparer@peopleledger.demo', 'type="email" required autocomplete="username"')
        + field('Password', 'password', '', 'type="password" required autocomplete="current-password"')
        + '<div class="field full"><button class="btn primary" type="submit">Sign in</button></div>'
        + '<div id="form-error" class="form-error" role="alert"></div>'
        + '</form>'
        + '<p class="footnote">The seeded demonstration accounts use the password from <code class="mono">SEED_PASSWORD</code>'
        + ' (<code class="mono">Demo!Passw0rd</code> unless changed). Run <code class="mono">npm run seed</code> if sign-in fails.</p>'
        + '</div>',
        { aside: badge(state.meta ? `API ${state.meta.version}` : 'Connecting', 'blue') })
      + card('Roles and separation of duties',
        '<div class="card-body">'
        + accounts.map(role => `<div class="progress-flow"><span class="step-num">${esc(role.label.slice(0, 1))}</span><div>`
          + `<h3>${esc(role.label)}</h3><p>${esc(role.description)}</p>`
          + `<small class="mono">${esc(role.id)}@peopleledger.demo</small></div></div>`).join('')
        + '</div>')
      + '</div>'
      + integrationCard();
  }

  function integrationCard() {
    const integrations = state.meta?.integrations || {};
    const rows = Object.entries(integrations).map(([name, entry]) => {
      const label = name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
      return `<tr><td><strong>${esc(label)}</strong></td><td>${badge(entry.state, STATE_BADGE[entry.state] ?? '')}</td>`
        + `<td class="wrap">${esc(entry.detail)}</td></tr>`;
    }).join('');
    return card('Integration status',
      table(['Integration', 'State', 'Detail'], rows, {
        note: 'live = a real call is made · simulated = deliberately stood in for, and labelled · '
          + 'awaiting-configuration = implemented but not configured · deferred = out of scope for this stage.'
      }),
      { sub: 'Reported by the server. Nothing here is inferred by the browser.' });
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  function overviewView() {
    const detail = state.caseDetail;
    const records = state.data.records;
    const check = state.data.check;
    const summary = state.data.reportSummary;
    const latest = summary?.latest;
    const fresh = !!check?.current;
    const issues = fresh ? check.check.issues : [];
    const blocking = fresh ? check.check.blockingCount : 0;

    const steps = [
      ['Source records loaded', `${count(records?.records.length || 0, 'record')} · data v${detail.dataRevision}`, (records?.records.length || 0) > 0],
      ['Deterministic checks', fresh ? `${count(issues.length, 'finding')}, ${blocking} blocking` : 'Run the checks against the current data', fresh],
      ['Draft prepared', latest ? `${latest.id} · ${latest.draftSource}` : 'Prepare a template draft or request an agent draft', !!latest],
      ['Finance review', latest && ['finance_reviewed', 'management_confirmed', 'approved', 'sealed'].includes(latest.status) ? 'Recorded' : 'Awaiting a finance reviewer', !!latest && ['finance_reviewed', 'management_confirmed', 'approved', 'sealed'].includes(latest.status)],
      ['Management confirmation', latest && ['management_confirmed', 'approved', 'sealed'].includes(latest.status) ? 'Recorded' : 'Awaiting management', !!latest && ['management_confirmed', 'approved', 'sealed'].includes(latest.status)],
      ['Director approval and sealing', latest?.status === 'sealed' ? 'Sealed; the evidence package can be exported' : latest?.status === 'approved' ? 'Approved; awaiting sealing' : 'Awaiting a director', latest?.status === 'sealed']
    ];

    const actions = (can('checks.run') ? button('Run data checks', 'run-checks', '', 'primary') : '')
      + (can('agent.run') ? button('Request agent draft', 'agent-run') : '');

    return header('WORKSPACE / OVERVIEW', detail.title,
      `Review period ${detail.period} · data version v${detail.dataRevision} · rule set ${detail.ruleSet.version}`, actions)
      + (detail.membership?.expiresAt
        ? notice(`Your access to this case expires at <strong>${esc(when(detail.membership.expiresAt))}</strong>.`, 'amber') : '')
      + `<div class="stats">${stat('Employee records', records?.records.length ?? '—', 'Held by the server', '', '#')}`
      + stat('Gross payroll · SGD', check?.check ? check.check.totalsFormatted.gross : '—', 'Base pay + allowances', '', 'S$')
      + stat('Blocking findings', fresh ? blocking : '—', fresh ? `Checked ${esc(when(check.check.createdAt))}` : 'Current data has not been checked',
        fresh && blocking ? 'warning' : '', '!')
      + stat('Report status', latest ? (STATUS_LABEL[latest.status] || [latest.status])[0] : 'Not started',
        latest ? `${esc(latest.id)} · ${latest.applicable ? 'current inputs' : 'historical version'}` : 'Prepare a draft after checking', '', '▧')
      + '</div>'
      + '<div class="overview-guide"><strong>Workflow</strong><p>Records and payments → deterministic checks → draft (template or agent) → '
      + 'finance review → management confirmation → director approval → sealing → evidence package.</p></div>'
      + '<div class="columns">'
      + card('Progress',
        '<div class="card-body">'
        + steps.map(([title, note, done], index) => `<div class="progress-flow"><span class="step-num ${done ? 'complete' : ''}">${done ? '✓' : index + 1}</span>`
          + `<div><h3>${esc(title)}</h3><p>${esc(note)}</p></div></div>`).join('')
        + '</div>',
        { aside: badge(`Data v${detail.dataRevision}`, 'blue') })
      + card('Your session',
        '<div class="card-body">'
        + `<p class="footnote">Signed in as <strong>${esc(state.me.user.displayName)}</strong> (${esc(state.me.roleLabel)}).`
        + ` Session expires ${esc(when(state.me.sessionExpiresAt))}.</p>`
        + `<div class="chips">${state.me.permissions.map(permission => `<span class="chip">${esc(permission)}</span>`).join('')}</div>`
        + '<p class="footnote">Permissions are enforced on the server for every request. This list is shown so it is clear which actions are available.</p>'
        + '</div>')
      + '</div>'
      + card('Active rule set',
        `<div class="card-body"><p class="footnote">${esc(detail.ruleSet.disclaimer)}</p></div>`,
        {
          sub: `${esc(detail.ruleSet.label)} · ${esc(detail.ruleSet.version)}`,
          aside: badge(`${count(detail.ruleSet.rules.filter(rule => rule.enabled).length, 'rule')} enabled`, 'blue')
        })
      + integrationCard();
  }

  // ---------------------------------------------------------------------------
  // People and payroll
  // ---------------------------------------------------------------------------

  function payrollView() {
    const listing = state.data.records;
    const check = state.data.check;
    const flagged = new Set(check?.current ? check.check.issues.map(issue => issue.recordId) : []);
    const editable = can('records.write');

    const actions = (can('records.import') ? button('Import payroll CSV', 'import-records', '', 'primary') : '')
      + button('Download records CSV', 'export-records');

    const rows = listing.records.map(record => `<tr>
      <td><div class="cell-person"><span class="person-icon" aria-hidden="true">${esc(record.name.slice(0, 1))}</span>
        <div><strong>${esc(record.name)}</strong><small>${esc(record.employeeNo)}</small></div></div></td>
      <td>${esc(record.department)}<div class="issue-rule ${record.costCenter ? '' : 'missing'}">${esc(record.costCenter || 'Missing')}</div></td>
      <td>${esc(record.period)}</td>
      <td class="money">${esc(record.basePay)}</td>
      <td class="money">${esc(record.allowances)}</td>
      <td class="money">${esc(record.deductions)}</td>
      <td class="money">${esc(record.expectedNet)}</td>
      <td class="money">${esc(record.netPaid)}</td>
      <td class="${record.evidenceRef ? '' : 'missing'}">${esc(record.evidenceRef || 'Missing')}</td>
      <td>${!check?.current ? badge('Not checked') : flagged.has(record.employeeNo) ? badge('Findings', 'warning') : badge('No findings', 'success')}</td>
      <td>${button('Edit', 'edit-record', `data-id="${esc(record.employeeNo)}" ${editable ? '' : 'disabled title="Your role cannot edit records"'}`, 'small')}</td>
    </tr>`).join('');

    return header('PEOPLE / PAYROLL', 'People & payroll',
      'The server holds the authoritative records. All amounts are exact cents in SGD.', actions)
      + notice(`Data version <strong>v${listing.dataRevision}</strong> · ${count(listing.records.length, 'record')}.`
        + ' After any change the checks must be run again and a new report version prepared.')
      + card('Payroll records',
        table(['Employee', 'Department / cost center', 'Period', 'Base pay', 'Allowances', 'Deductions',
          'Expected net', 'Recorded paid', 'Evidence reference', 'Check status', 'Action'], rows, {
          colspan: 11, emptyText: 'No records have been imported for this case.',
          note: 'Expected net = base pay + allowances − recorded deductions. CPF, income tax and other statutory'
            + ' amounts are not calculated anywhere in this system.'
        }),
        { aside: badge(editable ? 'Editable by your role' : 'Read-only for your role') })
      + employeesCard();
  }

  function employeesCard() {
    const employees = state.data.employees || [];
    if (!employees.length) return '';
    const withheld = employees.some(employee => employee.recruitmentDetail === 'withheld');
    return card('Employee directory',
      table(['Employee', 'Name', 'Department', 'Cost center', 'Start date', 'Source'],
        employees.map(employee => `<tr><td>${esc(employee.employeeNo)}</td><td>${esc(employee.displayName)}</td>`
          + `<td>${esc(employee.department)}</td><td>${esc(employee.costCenter || '—')}</td>`
          + `<td>${esc(employee.startDate ? when(employee.startDate) : '—')}</td><td>${esc(employee.source)}</td></tr>`).join(''), {
        note: withheld
          ? 'Your role receives the identifier, name, department, cost center and start date only.'
          + ' Candidate contact details, interview notes and scorecards are not exposed to finance-side roles.'
          : ''
      }),
      {
        sub: 'Onboarded employees and their cost centers.',
        aside: badge(withheld ? 'Recruitment detail withheld' : 'Full recruitment link visible', withheld ? '' : 'blue')
      });
  }

  // ---------------------------------------------------------------------------
  // Payment ledger
  // ---------------------------------------------------------------------------

  function paymentsView() {
    const ledger = state.data.payments;
    const preview = state.data.paymentPreview;
    const actions = (can('payments.preview') ? button('Import CSV / Excel', 'preview-payments', '', 'primary') : '')
      + button('Download template', 'payments-template');

    return header('FINANCE / LEDGER', 'Financial ledger',
      'Import a payroll payment file or a v2 financial ledger (payroll, income and expenses), in CSV or Excel. Duplicates and period errors are detected before anything is written.', actions)
      + (preview ? previewCard(preview) : '')
      + card('Imported batches',
        ledger.batches.length
          ? table(['Batch', 'File', 'Rows', 'Total', 'Imported', 'File digest'],
            ledger.batches.map(batch => `<tr><td>${esc(batch.id)}</td><td>${esc(batch.filename)}</td><td>${batch.rowCount}</td>`
              + `<td class="money">${esc(batch.totalAmount)}</td><td>${esc(when(batch.createdAt))}</td><td>${short(batch.digest)}</td></tr>`).join(''))
          : empty('≡', 'No payment file has been imported', 'Import a payment CSV so recorded payments can be reconciled against payroll.'),
        { aside: badge(`Income SGD ${ledger.income} · Expense SGD ${ledger.expense}`, 'blue') })
      + (ledger.payments.length
        ? card('Ledger entries',
          table(['Employee / category', 'Period', 'Direction', 'Amount', 'Reference', 'Value date'],
            ledger.payments.map(payment => `<tr><td>${esc(payment.employeeNo)}</td><td>${esc(payment.period)}</td>`
              + `<td>${payment.direction === 'in' ? 'Income' : 'Expense'}</td><td class="money">${esc(payment.amount)}</td><td>${esc(payment.paymentRef)}</td>`
              + `<td>${esc(when(payment.paidAt))}</td></tr>`).join('')),
          { aside: badge(count(ledger.payments.length, 'entry')) })
        : '');
  }

  function previewCard(preview) {
    const list = (title, items, render) => (items.length
      ? `<h3>${esc(title)}</h3><ul class="hint-list">${items.map(render).join('')}</ul>` : '');
    return card('Payment file preview',
      '<div class="card-body">'
      + `<p class="footnote">${count(preview.rowCount, 'row')} · total SGD ${esc(preview.totalAmount)} · `
      + `case period ${esc(preview.casePeriod)} · file digest ${short(preview.fileDigest)}</p>`
      + list('Rejections', preview.errors, message => `<li>${esc(message)}</li>`)
      + list('Duplicate payments detected', preview.duplicatePayments, item =>
        `<li><strong>${esc(item.employeeNo)}</strong> ${esc(item.period)}: ${count(item.count, 'payment')}`
        + ` (${esc(item.references.join(', '))}) totalling SGD ${esc(item.totalAmount)}. ${esc(item.detail)}</li>`)
      + list('Reconciliation differences', preview.reconciliation, item =>
        `<li><strong>${esc(item.employeeNo)}</strong>: ${esc(item.detail)}`
        + (item.difference ? ` Payments SGD ${esc(item.paymentsTotal)} against recorded SGD ${esc(item.recordedPaid)}, difference SGD ${esc(item.difference)}.` : '') + '</li>')
      + list('Payment references without an evidence file', preview.missingEvidence, item =>
        `<li><strong>${esc(item.paymentRef)}</strong> (${esc(item.employeeNo)}): ${esc(item.detail)}</li>`)
      + '</div>'
      + '<div class="modal-actions">'
      + button('Discard preview', 'discard-preview')
      + (preview.acceptable && can('payments.import')
        ? button('Import this file', 'confirm-payments', '', 'primary')
        : button('Import this file', 'confirm-payments', 'disabled title="The file must pass validation and your role must hold payments.import"', 'primary'))
      + '</div>',
      {
        sub: esc(preview.note),
        aside: badge(preview.acceptable ? 'Ready to import' : 'Rejected', preview.acceptable ? 'success' : 'danger')
      });
  }

  // ---------------------------------------------------------------------------
  // Bank reconciliation
  // ---------------------------------------------------------------------------

  const STATUS_TONE = { matched: 'success', ambiguous: 'warning', unmatched: 'danger' };

  function reconciliationView() {
    const ledger = state.data.bank;
    const latest = state.data.reconciliation;
    const preview = state.data.bankPreview;
    const result = latest?.reconciliation?.result;

    const actions = (can('payments.import') ? button('Import bank statement', 'preview-bank', '', 'primary') : '')
      + (can('checks.run') ? button('Reconcile now', 'run-reconciliation') : '')
      + button('Download template', 'bank-template');

    return header('FINANCE / RECONCILIATION', 'Bank reconciliation',
      'Three-way check: payroll records against the payment ledger against the imported bank statement. '
      + 'A match is claimed only when the reference, amount and direction identify exactly one row on each side.', actions)
      + (latest?.reconciliation && !latest.current ? notice(esc(latest.reconciliation.staleReason), 'amber') : '')
      + (preview ? bankPreviewCard(preview) : '')
      + card('Reconciliation result',
        !result
          ? empty('⇄', 'No reconciliation yet',
            'Import a bank statement, then run the checks. Reconciliation is recomputed from the stored files every time.', actions)
          : !result.applicable
            ? empty('⇄', 'No bank statement imported',
              'Until a statement is imported no payment can be described as confirmed by a bank, and the report will say so.', actions)
            : `<div class="stats">${stat('Matched', result.counts.matched, 'Exact one-to-one pairs', 'success', '✓')}`
              + stat('Unmatched', result.counts.unmatched + result.counts.bankUnmatched, 'No counterpart at all',
                result.counts.unmatched + result.counts.bankUnmatched ? 'warning' : '', '!')
              + stat('Ambiguous', result.counts.ambiguous + result.counts.bankAmbiguous, 'Key is not unique; needs a person',
                result.counts.ambiguous + result.counts.bankAmbiguous ? 'warning' : '', '?')
              + stat('Bank movement · SGD', result.totals.bankNetMovement, `In ${esc(result.totals.bankIn)} · out ${esc(result.totals.bankOut)}`, '', 'S$')
              + '</div>'
              + reconciliationTables(result)
              + `<div class="table-note">${esc(result.method)}</div>`,
        {
          sub: esc(latest?.reconciliation
            ? `Produced ${when(latest.reconciliation.createdAt)} · data v${latest.reconciliation.dataRevision}`
            : 'Run the data checks, or reconcile now, to produce a result.'),
          aside: result ? badge(result.applicable ? 'Statement imported' : 'No statement', result.applicable ? 'success' : 'warning') : badge('Not reconciled')
        })
      + bankStatementCard(ledger);
  }

  function reconciliationTables(result) {
    const rows = (result.ledgerRows || []).map(row => `<tr>
        <td><strong>${esc(row.reference || 'Missing reference')}</strong><div class="issue-rule">${esc(row.employeeNo)} · ${esc(row.period)}</div></td>
        <td class="money">${esc(row.amount)}</td>
        <td>${esc(row.direction)}</td>
        <td>${badge(row.status, STATUS_TONE[row.status] || '')}</td>
        <td class="wrap">${esc(row.detail)}</td>
      </tr>`).join('');

    const bankRows = (result.bankRows || []).map(row => `<tr>
        <td><strong>${esc(row.reference || 'Missing reference')}</strong><div class="issue-rule">${esc(row.valueDate)}</div></td>
        <td class="money">${esc(row.amount)}</td>
        <td>${esc(row.direction)}</td>
        <td>${badge(row.status, STATUS_TONE[row.status] || '')}</td>
        <td class="wrap">${esc(row.counterparty || row.description || '')}</td>
      </tr>`).join('');

    const threeWay = (result.threeWay || []).map(row => `<tr>
        <td><strong>${esc(row.employeeNo)}</strong><div class="issue-rule">${esc(row.name || '')}</div></td>
        <td class="money">${esc(row.recordedPaid)}</td>
        <td class="money">${esc(row.paymentsTotal)}</td>
        <td class="money">${esc(row.bankMatchedTotal)}</td>
        <td class="wrap">${esc(row.detail)}</td>
      </tr>`).join('');

    return '<div class="card-body"><h3>Payment ledger against the statement</h3></div>'
      + table(['Reference', 'Amount', 'Direction', 'Status', 'Detail'], rows,
        { colspan: 5, emptyText: 'No payments have been imported for this case.' })
      + '<div class="card-body"><h3>Statement against the payment ledger</h3></div>'
      + table(['Bank reference', 'Amount', 'Direction', 'Status', 'Counterparty'], bankRows,
        { colspan: 5, emptyText: 'No bank transactions have been imported.' })
      + (threeWay.length
        ? '<div class="card-body"><h3>Payroll, ledger and bank do not agree</h3></div>'
        + table(['Employee', 'Recorded paid', 'Payment ledger', 'Bank confirmed', 'Detail'], threeWay)
        : '<div class="card-body"><p class="muted">Payroll, the payment ledger and the bank statement agree for every employee with a payment.</p></div>');
  }

  function bankStatementCard(ledger) {
    if (!ledger) return '';
    return card('Imported statements',
      ledger.batches.length
        ? table(['Batch', 'File', 'Container', 'Rows', 'In', 'Out', 'Imported', 'File digest'],
          ledger.batches.map(batch => `<tr><td>${esc(batch.id)}</td>`
            + `<td>${esc(batch.filename)}${batch.worksheet ? `<div class="issue-rule">worksheet ${esc(batch.worksheet)}</div>` : ''}</td>`
            + `<td>${badge(batch.sourceFormat)}</td><td>${batch.rowCount}</td>`
            + `<td class="money">${esc(batch.totalIn)}</td><td class="money">${esc(batch.totalOut)}</td>`
            + `<td>${esc(when(batch.createdAt))}</td><td>${short(batch.digest)}</td></tr>`).join(''), {
          note: 'A statement is external evidence and is kept separate from the payment ledger. '
            + 'Importing one advances the data version, so checks and reports must be produced again.'
        })
        : empty('⇄', 'No bank statement imported',
          'Import a CSV or .xlsx statement with columns txnRef, valueDate, direction, amount, counterparty, description.'),
      { aside: badge(`In ${ledger.totalIn} · out ${ledger.totalOut} SGD`, 'blue') });
  }

  function bankPreviewCard(preview) {
    const list = (title, items, render) => (items.length
      ? `<h3>${esc(title)}</h3><ul class="hint-list">${items.map(render).join('')}</ul>` : '');
    const projected = preview.projectedReconciliation || { counts: {}, unmatched: [], ambiguous: [], unmatchedBank: [], threeWay: [] };
    return card('Bank statement preview',
      '<div class="card-body">'
      + `<p class="footnote">${count(preview.rowCount, 'row')} · in SGD ${esc(preview.totalIn)} · out SGD ${esc(preview.totalOut)} · `
      + `${esc(preview.sourceFormat)}${preview.worksheet ? ` worksheet ${esc(preview.worksheet)}` : ''} · `
      + `case period ${esc(preview.casePeriod)} · file digest ${short(preview.fileDigest)}</p>`
      + (preview.worksheets?.length > 1
        ? notice(`The workbook has ${count(preview.worksheets.length, 'worksheet')}: `
          + `${preview.worksheets.map(esc).join(', ')}. Reading <strong>${esc(preview.worksheet)}</strong>. `
          + 'Choose another worksheet and preview again to switch.', 'amber')
        : '')
      + list('Rejections', preview.errors, message => `<li>${esc(message)}</li>`)
      + list('Payments that would stay unmatched', projected.unmatched, item =>
        `<li><strong>${esc(item.reference || 'Missing reference')}</strong> (${esc(item.employeeNo)}) SGD ${esc(item.amount)}: ${esc(item.detail)}</li>`)
      + list('Matches that would be ambiguous', projected.ambiguous, item =>
        `<li><strong>${esc(item.reference || 'Missing reference')}</strong> (${esc(item.employeeNo)}) SGD ${esc(item.amount)}: ${esc(item.detail)}</li>`)
      + list('Bank rows with no imported payment', projected.unmatchedBank, item =>
        `<li><strong>${esc(item.reference || 'Missing reference')}</strong> ${esc(item.direction)} SGD ${esc(item.amount)}: ${esc(item.detail)}</li>`)
      + list('Payroll, ledger and bank would disagree', projected.threeWay, item =>
        `<li><strong>${esc(item.employeeNo)}</strong>: ${esc(item.detail)}</li>`)
      + '</div>'
      + '<div class="modal-actions">'
      + button('Discard preview', 'discard-bank-preview')
      + (preview.acceptable && can('payments.import')
        ? button('Import this statement', 'confirm-bank', '', 'primary')
        : button('Import this statement', 'confirm-bank', 'disabled title="The file must pass validation and your role must hold payments.import"', 'primary'))
      + '</div>',
      {
        sub: esc(preview.note),
        aside: badge(preview.acceptable ? 'Ready to import' : 'Rejected', preview.acceptable ? 'success' : 'danger')
      });
  }

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  function checksView() {
    const latest = state.data.check;
    const check = latest?.check;
    const detail = state.caseDetail;
    const actions = can('checks.run') ? button('Run data checks', 'run-checks', '', 'primary') : '';

    const issueRows = (check?.issues || []).map(issue => `<tr>
      <td><div class="issue-title">${esc(issue.title)}</div><div class="issue-detail">${esc(issue.detail)}</div>
        <div class="issue-rule">${esc(issue.rule)} · ${esc(issue.ruleVersion)} · ${esc(issue.engine || 'server')}</div></td>
      <td><strong>${esc(issue.name)}</strong><div class="issue-rule">${esc(issue.recordId)}</div></td>
      <td>${issue.severity === 'blocking' ? badge('Blocking', 'danger') : badge('Manual review', 'warning')}</td>
      <td>${button('Edit record', 'edit-record', `data-id="${esc(issue.recordId)}" ${can('records.write') ? '' : 'disabled'}`, 'small')}</td>
    </tr>`).join('');

    return header('CONTROL / CHECKS', 'Data checks',
      'Deterministic, versioned rules executed on the server. The model never computes these results.', actions)
      + (check && !latest.current ? notice(esc(check.staleReason), 'amber') : '')
      + card(check ? (check.blockingCount ? `${count(check.blockingCount, 'blocking finding')}` : 'No blocking findings') : 'Check results',
        !check
          ? empty('✓', 'No checks have been run', 'Checks cover reconciliation, completeness, evidence presence, duplicate payments and period alignment.', actions)
          : check.issues.length
            ? table(['Finding', 'Record', 'Severity', 'Action'], issueRows, { note: esc(check.disclaimer) })
            : empty('✓', 'No findings under the configured rules', check.disclaimer),
        {
          sub: check ? `Checked ${esc(when(check.createdAt))} · rules ${esc(check.ruleVersion)} · data v${check.dataRevision}`
            : 'Run the checks, then resolve any findings.',
          aside: check ? badge(check.blockingCount ? 'Action needed' : 'Clear', check.blockingCount ? 'warning' : 'success') : badge('Not checked')
        })
      + card('Configurable demonstration rules',
        `<div class="card-body rules">${detail.ruleSet.rules.map(rule => `<div class="rule"><code>${esc(rule.id)}</code>`
          + `${rule.enabled ? badge('enabled', 'success') : badge('disabled')}`
          + `<h3>${esc(rule.title)}</h3><p>${esc(rule.description)}</p>`
          + `<small class="muted">severity: ${esc(rule.severity)} · engine: ${esc(rule.engine)}</small></div>`).join('')}</div>`
        + `<div class="table-note">${esc(detail.ruleSet.disclaimer)}</div>`,
        {
          sub: `${esc(detail.ruleSet.label)} · ${esc(detail.ruleSet.version)}`,
          aside: can('case.create') ? button('Change rule configuration', 'edit-rules', '', 'small') : ''
        });
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  function evidenceView() {
    const files = state.data.evidence || [];
    const actions = can('evidence.upload') ? button('Upload evidence file', 'upload-evidence', '', 'primary') : '';
    const unreadable = files.filter(file => file.reviewRequired && !file.supersededBy).length;

    return header('EVIDENCE / FILES', 'Evidence files',
      'Uploaded documents with source, uploader, timestamp, version and SHA-256. Files are never deleted; a correction adds a version.', actions)
      + (unreadable
        ? notice(`${count(unreadable, 'file')} could not be read by the system and ${unreadable === 1 ? 'is' : 'are'} marked as requiring manual review.`
          + ' Such content is never reported as verified. Optical character recognition and document parsing are out of scope for this stage.', 'amber')
        : '')
      + card('Stored files',
        files.length
          ? table(['File', 'Subject', 'Source', 'Version', 'SHA-256', 'Content', 'Uploaded', 'Action'],
            files.map(file => `<tr class="${file.supersededBy ? 'superseded' : ''}">
            <td><strong>${esc(file.filename)}</strong><div class="issue-rule">${esc(file.mediaType)} · ${file.sizeBytes} bytes</div></td>
            <td>${esc(file.subjectType)}<div class="issue-rule">${esc(file.subjectId)}</div></td>
            <td>${esc(file.source)}</td>
            <td>v${file.version}${file.supersededBy ? badge('superseded', 'warning') : ''}</td>
            <td>${short(file.sha256)}</td>
            <td>${file.readable ? badge('readable', 'success') : badge('manual review', 'warning')}
              ${file.reviewReason ? `<div class="issue-detail">${esc(file.reviewReason)}</div>` : ''}</td>
            <td>${esc(when(file.uploadedAt))}<div class="issue-rule">${esc(file.uploadedBy)}</div></td>
            <td>${button('Download', 'download-evidence', `data-id="${esc(file.id)}" ${can('evidence.download') ? '' : 'disabled'}`, 'small')}</td>
          </tr>`).join(''), {
            note: 'A matching SHA-256 shows the stored bytes are unchanged. It does not authenticate the original document.'
              + ' Downloads are re-hashed before they are returned and are recorded in the activity log.'
          })
          : empty('🗎', 'No evidence files yet', 'Upload payslips, bank advices or advertisement evidence so references can be traced to files.', actions),
        { aside: badge(count(files.length, 'file')) });
  }

  // ---------------------------------------------------------------------------
  // Agent tasks
  // ---------------------------------------------------------------------------

  function agentView() {
    const runs = state.data.runs || [];
    const tools = state.data.tools;
    const selected = runs.find(run => run.id === state.selectedRun) || runs[0];
    const actions = can('agent.run')
      ? button('Run agent draft', 'agent-run', '', 'primary') + button('Run with template fallback', 'agent-run-fallback')
      : '';

    return header('AGENT / TASKS', 'Agent tasks',
      'The model requests tools, the server validates and executes them, and the results go back to the model until it finishes.', actions)
      + (state.meta.integrations.model.state !== 'live'
        ? notice(`<strong>${esc(state.meta.integrations.model.state)}</strong>: ${esc(state.meta.integrations.model.detail)}`
          + ' Tool execution is still real: tools run server-side against the stored data.', 'amber')
        : notice(`Live Amazon Bedrock model: ${esc(state.meta.integrations.model.detail)}.`))
      + toolsCard(tools)
      + (runs.length
        ? '<div class="report-layout"><div class="report-list">'
        + runs.map(run => {
          const status = RUN_STATUS[run.status] || [run.status, ''];
          return `<button class="report-item ${run.id === selected.id ? 'active' : ''}" data-action="select-run" data-id="${esc(run.id)}">`
            + `<strong>${esc(run.id.slice(-8))}</strong><small>${esc(when(run.startedAt))} · ${count(run.toolCalls, 'tool call')}</small>`
            + badge(status[0], status[1]) + `<small>${esc(run.runKind)}</small></button>`;
        }).join('')
        + `</div><div>${runDetail(selected)}</div></div>`
        : `<section class="card">${empty('◍', 'No agent run yet',
          'An agent run needs a current check. Run the checks first, then request a draft.',
          actions)}</section>`);
  }

  function toolsCard(tools) {
    if (!tools) return '';
    return card('Tools available to the model',
      '<div class="card-body rules">'
      + tools.tools.map(tool => `<div class="rule"><code>${esc(tool.name)}</code><p>${esc(tool.description)}</p></div>`).join('')
      + '</div>'
      + '<div class="card-body"><h3>Operations the model cannot perform</h3><ul class="hint-list">'
      + tools.deniedOperations.map(entry => `<li><code class="mono">${esc(entry.operation)}</code> — ${esc(entry.reason)}</li>`).join('')
      + `</ul><p class="footnote">${esc(tools.note)}</p></div>`,
      {
        sub: `Prompt version ${esc(tools.promptVersion)} · limits: ${tools.limits.maxToolCalls} tool calls, `
          + `${tools.limits.stepTimeoutMs} ms per step, ${tools.limits.runTimeoutMs} ms per run, ${tools.limits.maxRetries} retries.`
      });
  }

  function runDetail(run) {
    if (!run) return '';
    const status = RUN_STATUS[run.status] || [run.status, ''];
    const steps = run.steps || [];
    return card(`Run ${run.id.slice(-8)}`,
      '<div class="card-body">'
      + '<div class="kv">'
      + kv('Model execution', run.labels.modelExecution)
      + kv('Tool execution', run.labels.toolExecution)
      + kv('Draft origin', run.labels.draftOrigin)
      + kv('Model identifier', run.modelId)
      + kv('Prompt version', run.promptVersion)
      + kv('Guardrail', run.guardrailId || 'none configured (application validation still applies)')
      + kv('Tool calls', `${run.toolCalls} of ${run.limits.maxToolCalls}`)
      + kv('Output hash', run.outputHash || 'no draft saved')
      + kv('Input references', `case ${run.inputRefs.caseId}, check ${run.inputRefs.checkId}, `
        + `${count(run.inputRefs.recordIds.length, 'record')}, ${count(run.inputRefs.evidenceIds.length, 'evidence file')}`)
      + '</div>'
      + (run.error ? `<div class="form-error">${esc(run.failureStage ? `${run.failureStage}: ` : '')}${esc(run.error)}</div>` : '')
      + '</div>'
      + cardHead('Execution trace', { aside: badge(count(steps.length, 'step')) })
      + '<div class="card-body steps">'
      + steps.map(step => stepRow(step)).join('')
      + '</div>'
      + (run.reportId
        ? `<div class="modal-actions">${button('Open the resulting draft', 'open-report', `data-id="${esc(run.reportId)}"`, 'primary')}</div>`
        : ''),
      {
        sub: `Started ${esc(when(run.startedAt))} · finished ${esc(when(run.finishedAt))}`,
        aside: badge(status[0], status[1])
      });
  }

  const kv = (label, value) => `<div class="kv-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

  function stepRow(step) {
    if (step.kind === 'model') {
      const failed = !!step.error;
      return `<div class="step ${failed ? 'step-error' : ''}"><span class="step-tag">${step.n}</span><div>`
        + `<strong>Model turn ${step.turn}${step.attempt > 1 ? ` (attempt ${step.attempt})` : ''}</strong>`
        + (failed ? badge(step.retryable ? 'retryable error' : 'error', 'danger') : badge(step.stopReason || 'reply', 'blue'))
        + `<small>${step.durationMs} ms${step.usage?.inputTokens ? ` · ${step.usage.inputTokens} in / ${step.usage.outputTokens} out tokens` : ''}</small>`
        + (failed ? `<div class="issue-detail">${esc(step.error)}</div>` : '')
        + (step.guardrail?.intervened ? `<div class="issue-detail">Guardrail: ${esc(step.guardrail.actionReason || 'intervened')}</div>` : '')
        + '</div></div>';
    }
    if (step.kind === 'fallback') {
      return `<div class="step"><span class="step-tag">${step.n}</span><div><strong>Template fallback</strong>`
        + badge('not a model result', 'warning')
        + `<div class="issue-detail">${esc(step.note || step.error || '')}</div></div></div>`;
    }
    const summary = step.summary ? Object.entries(step.summary).map(([key, value]) => `${key}: ${value}`).join(' · ') : '';
    return `<div class="step ${step.ok ? '' : 'step-error'}"><span class="step-tag">${step.n}</span><div>`
      + `<strong>Tool <code class="mono">${esc(step.tool)}</code></strong>`
      + (step.ok ? badge('executed', 'success') : badge(esc(step.errorCode || 'refused'), 'danger'))
      + `<small>${step.durationMs} ms · arguments ${esc(String(step.argumentDigest).slice(0, 10))}…</small>`
      + (step.ok ? `<div class="issue-detail">${esc(summary)}</div>` : `<div class="issue-detail">${esc(step.error)}</div>`)
      + '</div></div>';
  }

  // ---------------------------------------------------------------------------
  // Reports and approvals
  // ---------------------------------------------------------------------------

  function reportsView() {
    const reports = state.data.reports || [];
    const summary = state.data.reportSummary;
    const actions = (can('reports.create')
      ? button('Prepare template draft', 'create-report', summary?.canPrepare ? '' : 'disabled title="Run the checks on the current data first"', 'primary')
      : '')
      + (can('agent.run') ? button('Request agent draft', 'agent-run') : '');

    if (!reports.length) {
      return header('REPORTS / APPROVALS', 'Reports & approvals',
        'Each version keeps a snapshot of its inputs and the decisions taken against them.', actions)
        + `<section class="card">${empty('▧', 'No report version yet',
          'Prepare a deterministic template draft, or request an agent draft, once the current data has been checked.', actions)}</section>`;
    }

    const selected = reports.find(report => report.id === state.selectedReport) || reports[0];
    state.selectedReport = selected.id;

    return header('REPORTS / APPROVALS', 'Reports & approvals',
      'Each version keeps a snapshot of its inputs and the decisions taken against them.', actions)
      + '<div class="report-layout"><div class="report-list">'
      + reports.map(report => {
        const status = STATUS_LABEL[report.status] || [report.status, ''];
        return `<button class="report-item ${report.id === selected.id ? 'active' : ''}" data-action="select-report" data-id="${esc(report.id)}">`
          + `<strong>${esc(report.id)}</strong><small>v${report.version} · ${esc(when(report.createdAt))} · data v${report.dataRevision}</small>`
          + badge(status[0], status[1])
          + (report.applicable ? '' : '<small>Historical version</small>')
          + `<small>${esc(report.draftSource)}</small></button>`;
      }).join('')
      + `</div><div>${reportActions(selected)}${reportPaper(selected)}</div></div>`;
  }

  function reportActions(report) {
    const next = report.nextStage;
    const parts = [];
    if (next && can(next.permission)) {
      parts.push(button(STAGE_LABEL[next.stage] || next.stage, 'advance', `data-id="${esc(report.id)}" data-stage="${esc(next.stage)}"`, 'primary'));
    } else if (next) {
      parts.push(button(STAGE_LABEL[next.stage] || next.stage, 'advance',
        `disabled title="This step needs the ${esc(next.permission)} permission"`, 'primary'));
    }
    if (report.applicable && ['submitted', 'finance_reviewed', 'management_confirmed'].includes(report.status)
      && next && can(next.permission)) {
      parts.push(button('Return for remediation', 'reject', `data-id="${esc(report.id)}"`, 'danger'));
    }
    if (report.status === 'sealed' && can('reports.amend')) {
      parts.push(button('Amend into a new version', 'amend', `data-id="${esc(report.id)}"`));
    }
    if (can('export.package')) {
      parts.push(button('Export evidence package', 'export-package', `data-id="${esc(report.id)}"`));
    }
    parts.push(button('Print / Save PDF', 'print-report', `data-id="${esc(report.id)}"`));

    const message = !report.applicable ? report.staleReason
      : report.status === 'sealed' ? 'Sealed. Corrections require a new version prepared as an amendment.'
        : report.status === 'rejected' ? 'Returned. A preparer creates a new version after remediation.'
          : next ? `Next step: ${next.label}.` : '';

    return `<div class="report-actionbar">${parts.join('')}<span class="muted">${esc(message)}</span></div>`;
  }

  function reportPaper(report) {
    const draft = report.draft || {};
    const status = STATUS_LABEL[report.status] || [report.status, ''];
    const amounts = draft.keyAmounts || {};
    const snapshot = report.snapshot || {};

    return '<article class="paper"><div class="paper-kicker">PEOPLELEDGER / REVIEW DOCUMENT</div>'
      + '<h2>HR &amp; Finance Review Draft</h2>'
      + `<div class="paper-meta"><span>${esc(report.id)} · version ${report.version}</span>`
      + `<span>data v${report.dataRevision}</span><span>${esc(when(report.createdAt))}</span>`
      + `<span>${esc(report.draftSource === 'model' ? 'Model draft, server validated'
        : report.draftSource === 'template-fallback' ? 'Deterministic template after a failed model run'
          : 'Deterministic server template')}</span>`
      + badge(status[0], status[1])
      + (report.applicable ? '' : badge('inputs changed', 'warning'))
      + (report.amendsReportId ? badge(`amends ${report.amendsReportId}`, 'blue') : '')
      + '</div>'
      + `<p>${esc(draft.summary || 'No draft content recorded.')}</p>`
      + '<div class="paper-summary">'
      + `<div><small>Gross pay / SGD</small><strong>${esc(amounts.grossPay || '—')}</strong></div>`
      + `<div><small>Expected net / SGD</small><strong>${esc(amounts.expectedNet || '—')}</strong></div>`
      + `<div><small>Recorded paid / SGD</small><strong>${esc(amounts.recordedPaid || '—')}</strong></div>`
      + '</div>'
      + (draft.financeTotals
        ? '<div class="paper-summary">'
        + `<div><small>Payment ledger / SGD</small><strong>${esc(draft.financeTotals.paymentLedgerTotal)}</strong></div>`
        + `<div><small>Bank in / SGD</small><strong>${esc(draft.financeTotals.bankIn)}</strong></div>`
        + `<div><small>Bank out / SGD</small><strong>${esc(draft.financeTotals.bankOut)}</strong></div>`
        + '</div>'
        : '')
      + (draft.reconciliation
        ? '<h3>Bank reconciliation</h3>'
        + (draft.reconciliation.applicable
          ? `<p>${count(draft.reconciliation.counts.matched, 'payment')} matched one-to-one; `
          + `${draft.reconciliation.counts.unmatched + draft.reconciliation.counts.bankUnmatched} unmatched; `
          + `${draft.reconciliation.counts.ambiguous + draft.reconciliation.counts.bankAmbiguous} ambiguous.</p>`
          + (draft.reconciliation.unresolvedReferences?.length
            ? '<ul class="hint-list">'
            + draft.reconciliation.unresolvedReferences.map(entry =>
              `<li><strong>${esc(entry.reference)}</strong> ${badge(entry.status, STATUS_TONE[entry.status] || 'warning')} — not reported as reconciled.</li>`).join('')
            + '</ul>'
            : '<p class="muted">Every imported payment and bank transaction is matched one-to-one.</p>')
          + `<p class="footnote">${esc(draft.reconciliation.method)}</p>`
          : '<p class="muted">No bank statement was imported for this data version, so no payment is reported as confirmed by a bank.</p>')
        : '')
      + `<h3>Findings</h3><p>Rule set ${esc((draft.ruleVersions || []).join(', '))} produced `
      + `<strong>${count((draft.findings || []).length, 'finding')}</strong>.</p>`
      + ((draft.findings || []).map(finding => `<div class="decision"><p><strong>${esc(finding.ruleId)} · ${esc(finding.recordId)}</strong>`
        + ` ${finding.severity === 'blocking' ? badge('blocking', 'danger') : badge(esc(finding.severity), 'warning')}</p>`
        + `<p>${esc(finding.explanation)}</p><p><em>Risk:</em> ${esc(finding.riskExplanation)}</p>`
        + (finding.evidenceRefs?.length ? `<small>Evidence: ${esc(finding.evidenceRefs.join(', '))}</small>` : '')
        + '</div>').join('') || '<p class="muted">No findings were produced under the configured rules.</p>')
      + '<h3>Requires human review</h3>'
      + ((draft.itemsRequiringHumanReview || []).map(item => `<div class="decision"><p><strong>${esc(item.item)}</strong></p>`
        + `<p>${esc(item.reason)}</p></div>`).join('') || '<p class="muted">Nothing was flagged for manual review.</p>')
      + '<h3>Recommendations</h3>'
      + `<ul class="hint-list">${(draft.recommendations || []).map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
      + '<h3>Evidence referenced</h3>'
      + ((draft.evidenceReferences || []).length
        ? table(['Evidence', 'File', 'SHA-256', 'Content'],
          draft.evidenceReferences.map(reference => `<tr><td>${esc(reference.evidenceId)}</td><td>${esc(reference.filename)} v${reference.version}</td>`
            + `<td>${short(reference.sha256)}</td>`
            + `<td>${reference.reviewRequired ? badge('requires manual review', 'warning') : badge('readable', 'success')}</td></tr>`).join(''))
        : '<p class="muted">No evidence files are attached to this case.</p>')
      + '<h3>Source data snapshot</h3>'
      + table(['Employee', 'Expected net', 'Recorded paid', 'Evidence reference'],
        (snapshot.records || []).map(record => `<tr><td>${esc(record.employeeNo)} / ${esc(record.name)}</td>`
          + `<td class="money">${esc(record.expectedNet)}</td><td class="money">${esc(record.netPaid)}</td>`
          + `<td>${esc(record.evidenceRef || 'Not provided')}</td></tr>`).join(''))
      + '<h3>Decisions</h3>'
      + ((report.decisions || []).length
        ? report.decisions.map(decision => `<div class="decision"><p><strong>${esc(decision.stage)} · ${esc(decision.actorRole)}</strong>`
          + ` ${decision.decision === 'rejected' ? badge('returned', 'danger') : badge(esc(decision.decision), 'success')}`
          + `${decision.appliesToCurrentInputs ? '' : badge('no longer applicable', 'warning')}</p>`
          + `<p>${esc(decision.note)}</p><small>${esc(when(decision.at))} · ${esc(decision.actorId)} · inputs ${esc(String(decision.inputDigest).slice(0, 10))}…</small></div>`).join('')
        : '<p class="muted">No decisions have been recorded for this version.</p>')
      + (report.sealManifest
        ? `<h3>Seal</h3><p>Sealed ${esc(when(report.sealManifest.sealedAt))} by ${esc(report.sealManifest.sealedBy)}.`
        + ` Manifest digest <code class="mono">${esc(report.sealManifest.manifestDigest)}</code> over `
        + `${count(report.sealManifest.entries.length, 'entry')}.</p><p class="footnote">${esc(report.sealManifest.note)}</p>`
        : '')
      + `<p class="scope">${(draft.limitations || []).map(esc).join(' ')}</p></article>`;
  }

  // ---------------------------------------------------------------------------
  // Recruitment
  // ---------------------------------------------------------------------------

  function recruitmentView() {
    const jobs = state.data.jobs || [];
    const actions = can('recruitment.write') ? button('Create job', 'create-job', '', 'primary') : '';
    const selectedJob = jobs.find(job => job.id === state.selectedJob) || jobs[0];

    return header('HIRING / RECRUITMENT', 'Recruitment',
      'A job cannot open without advertisement evidence, and a candidate cannot progress while required information is missing.', actions)
      + (jobs.length
        ? card('Jobs',
          table(['Job', 'Department / cost center', 'Salary range', 'Status', 'Advertisements', 'Blocked by', 'Candidates', 'Actions'],
            jobs.map(job => `<tr>
            <td><strong>${esc(job.title)}</strong><div class="issue-rule">${esc(job.id)}</div></td>
            <td>${esc(job.department)}<div class="issue-rule ${job.costCenter ? '' : 'missing'}">${esc(job.costCenter || 'Missing')}</div></td>
            <td class="money">${esc(job.salaryMin && job.salaryMax ? `${job.salaryMin} – ${job.salaryMax}` : 'Not set')}</td>
            <td>${badge(job.status, job.status === 'open' ? 'success' : job.status === 'closed' ? '' : 'warning')}</td>
            <td>${job.advertisementsWithEvidence} of ${job.advertisementCount} with evidence</td>
            <td>${job.blockedBy.length ? job.blockedBy.map(item => badge(item, 'warning')).join(' ') : badge('nothing', 'success')}</td>
            <td>${job.candidateCount} (${job.hiredCount} hired)</td>
            <td>${button('Advertisement', 'add-advert', `data-id="${esc(job.id)}" ${can('recruitment.write') ? '' : 'disabled'}`, 'small')}
              ${job.status === 'draft' ? button('Open', 'open-job', `data-id="${esc(job.id)}" ${can('recruitment.write') ? '' : 'disabled'}`, 'small') : ''}
              ${job.status === 'open' ? button('Add candidate', 'add-candidate', `data-id="${esc(job.id)}" ${can('recruitment.write') ? '' : 'disabled'}`, 'small') : ''}
              ${button('Candidates', 'select-job', `data-id="${esc(job.id)}"`, 'small')}</td>
          </tr>`).join(''), {
            note: 'Advertisement evidence must be uploaded with subject type <code class="mono">job_advertisement</code>'
              + ' and linked to the job before the job can open.'
          }),
          { aside: badge(count(jobs.length, 'job')) })
        : `<section class="card">${empty('◑', 'No jobs yet', 'Create a job, attach advertisement evidence, then open it.', actions)}</section>`)
      + (selectedJob ? candidatesCard(selectedJob) : '');
  }

  function candidatesCard(job) {
    const candidates = state.data.candidates || [];
    const interviews = state.data.interviews;
    const scorecards = state.data.scorecards || [];
    const selected = candidates.find(candidate => candidate.id === state.selectedCandidate) || candidates[0];

    return card(`Candidates · ${job.title}`,
      (candidates.length
        ? table(['Candidate', 'Stage', 'Next stage', 'Blocked by', 'Scorecards', 'Interviews', 'Actions'],
          candidates.map(candidate => `<tr class="${candidate.id === selected?.id ? 'selected-row' : ''}">
            <td><strong>${esc(candidate.fullName)}</strong><div class="issue-rule">${esc(candidate.candidateRef)}</div>
              ${candidate.personalDataWithheld ? badge('personal data withheld') : ''}</td>
            <td>${badge(candidate.stage, candidate.stage === 'hired' ? 'success' : candidate.stage === 'rejected' ? 'danger' : 'blue')}</td>
            <td>${esc(candidate.nextStage || '—')}</td>
            <td>${candidate.blockedBy.length ? candidate.blockedBy.map(item => badge(item, 'warning')).join(' ') : badge('nothing', 'success')}</td>
            <td>${candidate.scorecardCount} (latest r${candidate.latestScorecardRevision})</td>
            <td>${candidate.interviewCount}</td>
            <td>${button('Open', 'select-candidate', `data-id="${esc(candidate.id)}"`, 'small')}
              ${can('interviews.write') ? button('Schedule', 'schedule-interview', `data-id="${esc(candidate.id)}"`, 'small') : ''}
              ${can('recruitment.write') ? button('Scorecard', 'add-scorecard', `data-id="${esc(candidate.id)}"`, 'small') : ''}
              ${can('recruitment.advance') && candidate.nextStage ? button(`→ ${candidate.nextStage}`, 'advance-candidate', `data-id="${esc(candidate.id)}" data-stage="${esc(candidate.nextStage)}"`, 'small') : ''}
              ${can('recruitment.advance') && candidate.stage === 'hired' ? button('Onboard', 'onboard', `data-id="${esc(candidate.id)}"`, 'small') : ''}</td>
          </tr>`).join(''))
        : empty('◑', 'No candidates for this job', 'Open the job first, then add a candidate.'))
      + (selected ? scorecardsCard(selected, scorecards) + interviewsCard(selected, interviews) : ''),
      { sub: esc(job.id), aside: badge(count(candidates.length, 'candidate')) });
  }

  function scorecardsCard(candidate, scorecards) {
    if (!scorecards.length) return '';
    return cardHead(`Scorecard revisions · ${candidate.candidateRef}`,
      { aside: badge(`${count(scorecards.length, 'revision')} retained`, 'blue') })
      + table(['Revision', 'Recommendation', 'Criteria', 'Note', 'Recorded'],
        scorecards.map(sc => `<tr><td>r${sc.revision} ${sc.current ? badge('current', 'success') : badge('superseded')}</td>
          <td>${esc(sc.recommendation)}</td>
          <td class="wrap">${sc.criteria.map(item => `${esc(item.name)} ${item.score}/5`).join(' · ')}</td>
          <td class="wrap">${esc(sc.note || '—')}</td>
          <td>${esc(when(sc.createdAt))}</td></tr>`).join(''), {
        note: 'Scorecards are append-only. A corrected assessment creates a new revision and the previous one stays readable.'
      });
  }

  function interviewsCard(candidate, interviews) {
    if (!interviews) return '';
    return cardHead(`Interviews · ${candidate.candidateRef}`, {
      sub: esc(interviews.providerNote),
      aside: badge(interviews.providerState, 'blue')
        + (interviews.failedCount ? badge(`${count(interviews.failedCount, 'failed attempt')}`, 'danger') : '')
    })
      + (interviews.meetings.length
        ? table(['Meeting', 'Status', 'Scheduled', 'Attempts', 'Join link', 'Actions'],
          interviews.meetings.map(meeting => `<tr>
            <td>${esc(meeting.id.slice(-8))}<div class="issue-rule">key ${esc(meeting.requestKey.slice(-10))}</div></td>
            <td>${badge(meeting.status, meeting.status === 'failed' ? 'danger' : meeting.status === 'cancelled' ? '' : 'success')}
              ${meeting.failureReason ? `<div class="issue-detail">${esc(meeting.failureReason)}</div>` : ''}
              ${meeting.cancelReason ? `<div class="issue-detail">${esc(meeting.cancelReason)}</div>` : ''}</td>
            <td>${esc(when(meeting.scheduledStart))}${meeting.previousStart ? `<div class="issue-rule">was ${esc(when(meeting.previousStart))}</div>` : ''}</td>
            <td>${meeting.attempt}</td>
            <td>${meeting.joinUrl ? `<code class="mono">${esc(meeting.joinUrl.slice(0, 34))}…</code>` : '—'}</td>
            <td>${can('interviews.write') && meeting.status !== 'cancelled'
    ? button('Reschedule', 'reschedule-interview', `data-id="${esc(meeting.id)}"`, 'small')
      + button('Cancel', 'cancel-interview', `data-id="${esc(meeting.id)}"`, 'small')
    : ''}</td></tr>`).join(''), {
            note: 'Scheduling is simulated: no Microsoft Graph request is made and the join link is not a live meeting.'
              + ' An identical repeated request returns the existing meeting instead of creating a second one, and failed attempts stay visible.'
          })
        : empty('◷', 'No interview scheduled', 'Scheduling is simulated but records creation, rescheduling, cancellation and failures.'));
  }

  // ---------------------------------------------------------------------------
  // Access and activity
  // ---------------------------------------------------------------------------

  function accessView() {
    const members = state.data.members || [];
    const entries = state.data.audit || [];
    const actions = can('access.grant') ? button('Grant case access', 'grant-access', '', 'primary') : '';

    return header('GOVERNANCE / ACCESS', 'Access & activity',
      'Case membership controls who can open this case. Auditor access is always time limited, and reads and exports are logged.', actions)
      + card('Case members',
        table(['Account', 'Role', 'Granted', 'Expires', 'State', 'Action'],
          members.map(member => `<tr><td><strong>${esc(member.displayName)}</strong><div class="issue-rule">${esc(member.userId)}</div></td>
          <td>${esc(member.role)}</td><td>${esc(when(member.grantedAt))}</td>
          <td>${member.expiresAt ? esc(when(member.expiresAt)) : 'no expiry'}</td>
          <td>${member.active ? badge('active', 'success') : badge(member.revokedAt ? 'revoked' : 'expired', 'warning')}</td>
          <td>${member.active && can('access.grant')
    ? button('Revoke', 'revoke-access', `data-id="${esc(member.id)}"`, 'small')
    : ''}</td></tr>`).join('')),
        { aside: badge(count(members.length, 'grant')) })
      + (can('audit.read')
        ? card('Activity log',
          `<div class="card-body timeline">${entries.map(entry => `<div class="timeline-item">
            <time datetime="${esc(entry.at)}">${esc(when(entry.at))}<br><small>${esc(entry.actor_role)}</small></time>
            <div><p><strong>${esc(entry.action)}</strong> ${badge(esc(entry.subject_type || 'case'))}</p>
              <small>${esc(entry.subject_id || '')}</small>
              <small>${esc(entry.detail ? JSON.stringify(entry.detail).slice(0, 320) : '')}</small></div></div>`).join('')
          || empty('◷', 'No activity recorded yet', 'Actions appear here as they are performed.')}</div>`,
          {
            sub: 'Server-side record of changes, access and exports.',
            aside: button('Show access and exports only', 'audit-access', '', 'small') + button('Show everything', 'audit-all', '', 'small')
          })
        : notice('Your role cannot read the activity log. Directors and auditors can.'));
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  function exportsView() {
    const summary = state.data.reportSummary;
    const sealed = summary?.latest?.status === 'sealed';
    return header('EVIDENCE / EXPORTS', 'Exports',
      'The evidence package contains the report, its linked evidence files, rule results, the approval history and a hash manifest.',
      '')
      + (can('export.package') ? '' : notice('Your role cannot export from this case.', 'amber'))
      + (summary?.latest ? '' : notice('There is no report version to export yet.', 'amber'))
      + (summary?.latest && !sealed
        ? notice('The latest version is not sealed yet. The package can still be exported and will state the current status.', 'amber')
        : '')
      + '<div class="export-grid">'
      + '<section class="export-card"><h2>Evidence package (.zip)</h2>'
      + '<p>Report, evidence files re-hashed on the way out, deterministic rule results, the full approval history, '
      + 'the agent run trace, the activity log and a SHA-256 manifest covering every entry.</p>'
      + button('Download evidence package', 'export-package', can('export.package') && summary?.latest ? '' : 'disabled', 'primary')
      + '</section>'
      + '<section class="export-card"><h2>Evidence JSON</h2>'
      + '<p>The retained machine-readable export: records, checks, evidence index, report versions, approvals and activity.</p>'
      + button('Download evidence JSON', 'export-json', can('export.package') ? '' : 'disabled')
      + '</section>'
      + '<section class="export-card"><h2>Payroll CSV</h2>'
      + '<p>The authoritative server records in the original import schema, with spreadsheet-safe quoting.</p>'
      + button('Download payroll CSV', 'export-records', can('records.read') ? '' : 'disabled')
      + '</section>'
      + '<section class="export-card"><h2>Printable report</h2>'
      + '<p>Open the latest version and use your browser print dialog to save a PDF.</p>'
      + button('Open the latest report', 'goto-reports')
      + '</section>'
      + '</div>'
      + notice('Every export is written to the activity log with the identity of the requester. '
        + 'Hashes show stored bytes are unchanged; they do not authenticate original documents.');
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async function loadCaseContext() {
    const listing = await api.cases();
    state.cases = listing.cases;
    if (!state.cases.length) { state.caseDetail = null; return; }
    if (!state.caseId || !state.cases.some(item => item.id === state.caseId)) state.caseId = state.cases[0].id;
    state.caseDetail = await api.caseDetail(state.caseId);
  }

  const settle = async (key, promise) => {
    try { state.data[key] = await promise; } catch { state.data[key] = null; }
  };

  async function loadView(name) {
    const id = state.caseId;
    if (!id) return;
    if (name === 'overview') {
      await Promise.all([
        settle('records', api.records(id)),
        settle('check', api.latestCheck(id)),
        settle('reportSummary', api.reportSummary(id))
      ]);
    } else if (name === 'payroll') {
      await Promise.all([settle('records', api.records(id)), settle('check', api.latestCheck(id)), settle('employees', api.employees(id).then(r => r.employees))]);
    } else if (name === 'payments') {
      await settle('payments', api.payments(id));
    } else if (name === 'reconciliation') {
      await Promise.all([
        settle('bank', api.bank(id)),
        settle('reconciliation', api.latestReconciliation(id)),
        settle('payments', api.payments(id))
      ]);
    } else if (name === 'checks') {
      await settle('check', api.latestCheck(id));
    } else if (name === 'evidence') {
      await settle('evidence', api.evidence(id).then(r => r.files));
    } else if (name === 'agent') {
      await Promise.all([settle('runs', api.agentRuns(id).then(r => r.runs)), settle('tools', api.agentTools())]);
    } else if (name === 'reports') {
      await Promise.all([settle('reports', api.reports(id).then(r => r.reports)), settle('reportSummary', api.reportSummary(id))]);
    } else if (name === 'recruitment') {
      await settle('jobs', api.jobs().then(r => r.jobs));
      const jobs = state.data.jobs || [];
      if (jobs.length) {
        if (!state.selectedJob || !jobs.some(job => job.id === state.selectedJob)) state.selectedJob = jobs[0].id;
        await settle('candidates', api.candidates(state.selectedJob).then(r => r.candidates));
        const candidates = state.data.candidates || [];
        if (candidates.length) {
          if (!state.selectedCandidate || !candidates.some(candidate => candidate.id === state.selectedCandidate)) {
            state.selectedCandidate = candidates[0].id;
          }
          await Promise.all([
            settle('scorecards', api.scorecards(state.selectedCandidate).then(r => r.scorecards)),
            settle('interviews', api.interviews(state.selectedCandidate))
          ]);
        } else {
          state.data.scorecards = [];
          state.data.interviews = null;
        }
      }
    } else if (name === 'access') {
      await Promise.all([settle('members', api.members(id).then(r => r.members)), settle('audit', api.audit(id, state.auditScope).then(r => r.entries))]);
    } else if (name === 'exports') {
      await settle('reportSummary', api.reportSummary(id));
    }
  }

  const RENDERERS = {
    overview: overviewView,
    payroll: payrollView,
    payments: paymentsView,
    reconciliation: reconciliationView,
    checks: checksView,
    evidence: evidenceView,
    agent: agentView,
    reports: reportsView,
    recruitment: recruitmentView,
    access: accessView,
    exports: exportsView
  };

  function chrome() {
    const signedIn = !!state.me;
    $('#session-label').textContent = signedIn ? `${state.me.user.displayName} · ${state.me.roleLabel}` : 'Not signed in';
    $('#avatar').textContent = signedIn ? state.me.user.displayName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : '–';
    $('#signout').hidden = !signedIn;
    $('#case-label').firstChild.textContent = state.caseDetail ? state.caseDetail.title : (signedIn ? 'No case available' : 'Sign in required');
    $('#case-sub').textContent = state.caseDetail ? `${state.caseDetail.period} · data v${state.caseDetail.dataRevision}` : 'Synthetic data only';
    $('#db-tag').textContent = state.meta ? (({ postgres: 'PG', sqlite: 'SQLITE', memory: 'MEM' }[state.meta.storage.database] || 'DB')) : 'API';
    $('#db-tag').title = state.meta ? state.meta.storage.databaseLabel : '';
    const findings = state.data.check?.current ? state.data.check.check.blockingCount : 0;
    $('#nav-count').textContent = findings || '';
  }

  async function render({ reload = true } = {}) {
    const name = view();
    $('#crumb').textContent = VIEWS[name];
    document.title = `${VIEWS[name]} · PeopleLedger workspace`;
    document.querySelectorAll('nav a').forEach(anchor => {
      const active = anchor.dataset.view === name;
      anchor.classList.toggle('active', active);
      if (active) anchor.setAttribute('aria-current', 'page'); else anchor.removeAttribute('aria-current');
    });

    if (!state.me) {
      $('#main').innerHTML = signInView();
      chrome();
      const form = $('#signin-form');
      if (form) form.addEventListener('submit', signIn);
      return;
    }
    if (!state.caseDetail) {
      $('#main').innerHTML = header('WORKSPACE', 'No case is available to you',
        'Your account is signed in but is not a member of any case. A director or administrator can grant access.')
        + `<section class="card">${empty('◷', 'No case access',
          'Ask a director to grant your account access to a review case, or run the seed script to create the demonstration case.')}</section>`
        + integrationCard();
      chrome();
      return;
    }
    if (reload) await loadView(name);
    $('#main').innerHTML = RENDERERS[name]();
    chrome();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function signIn(event) {
    event.preventDefault();
    const values = formValues(event.target);
    try {
      await api.login(values.email, values.password);
      await boot();
      toast('Signed in');
    } catch (error) {
      const target = $('#form-error');
      if (target) target.textContent = describeError(error);
    }
  }

  async function signOut() {
    await guard(() => api.logout());
    state.me = null;
    state.caseDetail = null;
    state.data = {};
    await render({ reload: false });
    toast('Signed out');
  }

  function noteModal(title, description, label, onSubmit) {
    formModal(title, description, area(label, 'note', '', 'required maxlength="1000" placeholder="Record your reasoning"'),
      'Confirm', values => onSubmit(values.note));
  }

  async function refresh(message) {
    await render();
    if (message) toast(message);
  }

  function editRecordModal(employeeNo) {
    const record = (state.data.records?.records || []).find(item => item.employeeNo === employeeNo);
    if (!record) return toast('That record is not loaded in this view', true);
    formModal(`Edit ${employeeNo}`,
      'A change creates a new data version. Existing checks become stale and recorded approvals stop applying.',
      field('Name', 'name', record.name, 'required maxlength="80"')
      + field('Department', 'department', record.department, 'required maxlength="80"')
      + field('Cost center', 'costCenter', record.costCenter, 'maxlength="80"')
      + field('Payroll month', 'period', record.period, 'required pattern="\\d{4}-\\d{2}"')
      + field('Base pay · SGD', 'basePay', record.basePay, 'required inputmode="decimal"')
      + field('Allowances · SGD', 'allowances', record.allowances, 'required inputmode="decimal"')
      + field('Deductions · SGD', 'deductions', record.deductions, 'required inputmode="decimal"')
      + field('Recorded paid · SGD', 'netPaid', record.netPaid, 'required inputmode="decimal"')
      + field('Evidence reference', 'evidence', record.evidenceRef, 'maxlength="240"')
      + area('Change explanation', 'note', '', 'required maxlength="500" placeholder="For example: corrected the recorded payment against the payslip."'),
      'Save changes',
      async values => {
        const { note, ...changes } = values;
        await api.updateRecord(state.caseId, employeeNo, { changes, note });
        await refresh('Saved. Run the checks again.');
      });
  }

  // ---------------------------------------------------------------------------
  // Imports: payroll, payments and bank statements
  //
  // Every import is two-phase. The preview is produced by the server from the
  // exact bytes chosen here, and the confirm step sends the digest of the file
  // that was previewed, so a file swapped in between the two steps is refused.
  // ---------------------------------------------------------------------------

  const FILE_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const worksheetField = () => field('Worksheet (optional)', 'worksheet', '', 'maxlength="120"',
    'Only used for .xlsx files. Leave blank to read the first worksheet with content.');

  function importRecordsModal() {
    modal('Import payroll file',
      '<div class="modal-body"><p>The file replaces every payroll record in this case. CSV or .xlsx are accepted on identical terms, '
      + 'and a rejected row leaves the stored data unchanged.</p>'
      + `<label class="field">Payroll file<input type="file" name="file" accept="${FILE_ACCEPT}" id="records-file"></label>`
      + worksheetField()
      + area('Import note', 'note', '', 'maxlength="500" placeholder="Reason for this replacement import"')
      + '<div id="import-preview"></div><div id="form-error" class="form-error" role="alert"></div></div>',
      button('Preview', 'preview-records', '', 'primary'));
  }

  async function previewRecords() {
    const input = $('#records-file');
    if (!input?.files?.length) { $('#form-error').textContent = 'Choose a CSV or .xlsx file first.'; return; }
    try {
      const source = await readImportFile(input.files[0], $('#modal [name="worksheet"]')?.value.trim());
      const result = await api.previewRecords(state.caseId, source);
      const preview = result.preview;
      $('#import-preview').innerHTML = `<p class="footnote">${count(preview.rowCount, 'row')} parsed from `
        + `${esc(preview.sourceFormat)}${preview.worksheet ? ` worksheet ${esc(preview.worksheet)}` : ''}. `
        + `Gross SGD ${(preview.totals.gross / 100).toFixed(2)}, recorded paid SGD ${(preview.totals.paid / 100).toFixed(2)}.</p>`
        + (preview.worksheets?.length > 1
          ? `<p class="footnote">Worksheets in this workbook: ${preview.worksheets.map(esc).join(', ')}.</p>` : '')
        + table(['Employee', 'Name', 'Period', 'Recorded paid'],
          preview.sample.map(row => `<tr><td>${esc(row.employeeNo)}</td><td>${esc(row.name)}</td>`
            + `<td>${esc(row.period)}</td><td class="money">${esc(row.netPaid)}</td></tr>`).join(''));
      $('#modal .modal-actions').innerHTML = button('Cancel', 'close')
        + button('Replace all records', 'confirm-records', '', 'primary');
      state.pending.records = source;
    } catch (error) {
      $('#form-error').textContent = describeError(error);
    }
  }

  async function confirmRecords() {
    const note = $('#modal [name="note"]').value || 'Replacement import';
    const result = await guard(() => api.replaceRecords(state.caseId, { ...state.pending.records, note }));
    if (!result) return;
    state.pending.records = null;
    closeModal();
    state.caseDetail = await api.caseDetail(state.caseId);
    await refresh(`Replaced with ${count(result.rowCount, 'record')}. Run the checks again.`);
  }

  function previewPaymentsModal() {
    modal('Preview payment file',
      '<div class="modal-body"><p>Columns: <code class="mono">employeeNo, period, amount, paymentRef, paidAt</code>. '
      + 'CSV or .xlsx are accepted. Nothing is written until you confirm the import.</p>'
      + `<label class="field">Payment file<input type="file" name="file" accept="${FILE_ACCEPT}" id="payments-file"></label>`
      + worksheetField()
      + '<div id="form-error" class="form-error" role="alert"></div></div>',
      button('Preview', 'do-preview-payments', '', 'primary'));
  }

  async function doPreviewPayments() {
    const input = $('#payments-file');
    if (!input?.files?.length) { $('#form-error').textContent = 'Choose a CSV or .xlsx file first.'; return; }
    try {
      const source = await readImportFile(input.files[0], $('#modal [name="worksheet"]')?.value.trim());
      state.data.paymentPreview = await api.previewPayments(state.caseId, source);
      state.pending.payments = source;
      closeModal();
      await render({ reload: false });
    } catch (error) {
      $('#form-error').textContent = describeError(error);
    }
  }

  async function confirmPayments() {
    const preview = state.data.paymentPreview;
    const result = await guard(() => api.importPayments(state.caseId, {
      ...state.pending.payments,
      filename: state.pending.payments?.filename || 'payments.csv',
      expectedDigest: preview.fileDigest
    }));
    if (!result) return;
    state.data.paymentPreview = null;
    state.pending.payments = null;
    state.caseDetail = await api.caseDetail(state.caseId);
    await refresh(`Imported ${count(result.rowCount, 'payment')}. Run the checks again.`);
  }

  function discardPaymentPreview() {
    state.data.paymentPreview = null;
    state.pending.payments = null;
    render({ reload: false });
  }

  function previewBankModal() {
    modal('Import bank statement',
      '<div class="modal-body"><p>Columns: <code class="mono">txnRef, valueDate, direction, amount, counterparty, description</code>. '
      + 'Direction is <code class="mono">in</code> or <code class="mono">out</code>. CSV or .xlsx are accepted, and a workbook is read '
      + 'without evaluating anything: formulas and error cells are refused.</p>'
      + `<label class="field">Statement file<input type="file" name="file" accept="${FILE_ACCEPT}" id="bank-file"></label>`
      + worksheetField()
      + '<div id="form-error" class="form-error" role="alert"></div></div>',
      button('Preview', 'do-preview-bank', '', 'primary'));
  }

  async function doPreviewBank() {
    const input = $('#bank-file');
    if (!input?.files?.length) { $('#form-error').textContent = 'Choose a CSV or .xlsx file first.'; return; }
    try {
      const source = await readImportFile(input.files[0], $('#modal [name="worksheet"]')?.value.trim());
      state.data.bankPreview = await api.previewBank(state.caseId, source);
      state.pending.bank = source;
      closeModal();
      await render({ reload: false });
    } catch (error) {
      $('#form-error').textContent = describeError(error);
    }
  }

  async function confirmBank() {
    const preview = state.data.bankPreview;
    const result = await guard(() => api.importBank(state.caseId, {
      ...state.pending.bank,
      filename: state.pending.bank?.filename || 'bank-statement.csv',
      expectedDigest: preview.fileDigest
    }));
    if (!result) return;
    state.data.bankPreview = null;
    state.pending.bank = null;
    state.caseDetail = await api.caseDetail(state.caseId);
    await refresh(`Imported ${count(result.rowCount, 'bank transaction')}. Run the checks again.`);
  }

  function discardBankPreview() {
    state.data.bankPreview = null;
    state.pending.bank = null;
    render({ reload: false });
  }

  async function runReconciliation() {
    const result = await guard(() => api.runReconciliation(state.caseId));
    if (!result) return;
    const counts = result.result?.counts || {};
    await refresh(result.result?.applicable
      ? `Reconciled: ${counts.matched} matched, ${counts.unmatched + counts.bankUnmatched} unmatched, `
        + `${counts.ambiguous + counts.bankAmbiguous} ambiguous.`
      : 'No bank statement is imported, so nothing is reported as bank-confirmed.');
  }

  function uploadEvidenceModal() {
    formModal('Upload evidence file',
      'The bytes are stored, hashed and versioned. Content that cannot be read as text is marked as requiring manual review.',
      '<label class="field full">File<input type="file" name="file" required id="evidence-file"></label>'
      + select('Subject type', 'subjectType', ['payroll_record', 'payment_reference', 'job_advertisement', 'candidate', 'case', 'report'], 'payroll_record')
      + field('Subject identifier', 'subjectId', 'EMP-001', 'required maxlength="120"', 'For example an employee number, a payment reference or a job identifier.')
      + select('Source', 'source', ['upload', 'payroll_system_export', 'bank_statement', 'job_board', 'interview', 'other'], 'payroll_system_export'),
      'Upload',
      async (values, form) => {
        const file = form.querySelector('#evidence-file').files[0];
        if (!file) throw new Error('Choose a file first.');
        const result = await api.uploadEvidence(state.caseId, {
          filename: file.name,
          subjectType: values.subjectType,
          subjectId: values.subjectId,
          source: values.source,
          mediaType: file.type || 'application/octet-stream'
        }, file);
        await refresh(result.duplicate
          ? 'Identical content is already stored for this subject; no new version was created.'
          : `Stored as version ${result.file.version}. SHA-256 ${result.file.sha256.slice(0, 12)}…`);
      });
  }

  // ---------------------------------------------------------------------------
  // Checks, rules and the agent
  // ---------------------------------------------------------------------------

  async function runChecks() {
    const result = await guard(() => api.runChecks(state.caseId));
    if (!result) return;
    await refresh(result.blockingCount
      ? `${count(result.blockingCount, 'blocking finding')} to resolve.`
      : 'No blocking findings under the configured rules.');
  }

  function editRulesModal() {
    const rules = state.caseDetail?.ruleSet?.rules || [];
    modal('Change rule configuration',
      '<form id="ws-form" class="modal-body"><p>Switching a rule off changes the rule version. Existing checks and reports become '
      + 'stale and recorded approvals no longer apply.</p>'
      + `<div class="rules">${rules.map(rule => '<div class="rule">'
        + `<label class="field"><input type="checkbox" name="${esc(rule.id)}" ${rule.enabled ? 'checked' : ''}> `
        + `<code>${esc(rule.id)}</code> ${esc(rule.title)}</label>`
        + `<p>${esc(rule.description)}</p><small class="muted">severity: ${esc(rule.severity)} · engine: ${esc(rule.engine)}</small>`
        + '</div>').join('')}</div>`
      + '<div id="form-error" class="form-error" role="alert"></div></form>',
      '<button type="submit" form="ws-form" class="btn primary">Save configuration</button>');
    $('#ws-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const config = { rules: rules.map(rule => ({ id: rule.id, enabled: form.elements[rule.id]?.checked === true })) };
      try {
        const result = await api.setRules(state.caseId, config);
        closeModal();
        state.caseDetail = await api.caseDetail(state.caseId);
        await refresh(result.note);
      } catch (error) {
        $('#form-error').textContent = describeError(error);
      }
    });
  }

  async function startAgentRun(allowTemplateFallback) {
    const result = await guard(() => api.startAgentRun(state.caseId, { allowTemplateFallback }));
    if (!result) return;
    state.selectedRun = result.id;
    if (result.status === 'completed') {
      await refresh(`Agent run completed. Draft ${result.reportId} is awaiting human review.`);
    } else if (result.reportId) {
      await refresh(`The model run ${result.status}. A deterministic template draft was prepared instead and is labelled as such.`);
    } else {
      await refresh(`The agent run ${result.status}: ${result.error || 'no draft was saved'}.`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Reports and approvals
  // ---------------------------------------------------------------------------

  async function createReport() {
    const result = await guard(() => api.createReport(state.caseId, {}));
    if (!result) return;
    state.selectedReport = result.id;
    await refresh(`Prepared ${result.id} as a deterministic template draft.`);
  }

  function advanceReport(reportId, stage) {
    noteModal(STAGE_LABEL[stage] || stage,
      'The decision is recorded against the exact inputs shown in this version. If the data or the rules change afterwards, '
      + 'the decision stays on file but no longer applies.',
      'Your note', async note => {
        const result = await guard(() => api.advanceReport(reportId, stage, note));
        if (!result) return;
        await refresh(`Recorded. Status is now ${(STATUS_LABEL[result.status] || [result.status])[0].toLowerCase()}.`);
      });
  }

  function rejectReport(reportId) {
    noteModal('Return for remediation',
      'The version is returned to the preparer. Explain what must be corrected; the note is part of the record.',
      'Reason for returning', async note => {
        const result = await guard(() => api.rejectReport(reportId, note));
        if (!result) return;
        await refresh('Returned for remediation.');
      });
  }

  function amendReport(reportId) {
    noteModal('Amend into a new version',
      'A sealed version is never edited. This prepares a new version that records which report it amends.',
      'Reason for the amendment', async note => {
        const result = await guard(() => api.createReport(state.caseId, { amendsReportId: reportId, note }));
        if (!result) return;
        state.selectedReport = result.id;
        await refresh(`Prepared ${result.id} as an amendment of ${reportId}.`);
      });
  }

  async function printReport(reportId) {
    const report = await guard(() => api.report(reportId));
    if (!report) return;
    $('#print-area').innerHTML = reportPaper(report);
    window.print();
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  async function exportPackage(reportId) {
    const summary = state.data.reportSummary;
    const target = reportId || summary?.latest?.id || null;
    const result = await guard(() => api.exportPackage(state.caseId, target));
    if (!result) return;
    saveBlob(result.blob, result.filename);
    toast(`Package downloaded. Manifest digest ${String(result.headers.get('X-Manifest-Digest') || '').slice(0, 12)}…`);
  }

  async function exportJson() {
    const result = await guard(() => api.exportEvidenceJson(state.caseId));
    if (!result) return;
    saveText(`people-ledger-evidence-${state.caseId}.json`, JSON.stringify(result, null, 2), 'application/json');
    toast('Evidence JSON downloaded');
  }

  async function exportRecords() {
    const result = await guard(() => api.exportRecordsCsv(state.caseId));
    if (!result) return;
    saveBlob(result.blob, result.filename);
    toast('Payroll CSV downloaded');
  }

  async function downloadTemplate(which) {
    const result = await guard(() => (which === 'bank' ? api.bankTemplate() : api.paymentsTemplate()));
    if (!result) return;
    saveBlob(result.blob, result.filename);
  }

  async function downloadEvidence(evidenceId) {
    const result = await guard(() => api.downloadEvidence(evidenceId));
    if (!result) return;
    saveBlob(result.blob, result.filename);
    toast(`Downloaded. SHA-256 ${String(result.headers.get('X-Evidence-Sha256') || '').slice(0, 12)}… The download is recorded in the activity log.`);
  }

  // ---------------------------------------------------------------------------
  // Recruitment
  // ---------------------------------------------------------------------------

  function createJobModal() {
    formModal('Create job', 'A job starts as a draft. It cannot open until advertisement evidence is attached.',
      field('Title', 'title', '', 'required maxlength="140"')
      + field('Department', 'department', '', 'required maxlength="80"')
      + field('Cost center', 'costCenter', '', 'maxlength="80"')
      + field('Headcount', 'headcount', '1', 'required inputmode="numeric"')
      + field('Salary minimum · SGD', 'salaryMin', '', 'inputmode="decimal"')
      + field('Salary maximum · SGD', 'salaryMax', '', 'inputmode="decimal"')
      + area('Description', 'description', '', 'maxlength="2000"'),
      'Create',
      async values => {
        const job = await api.createJob(values);
        state.selectedJob = job.id;
        await refresh(`Created ${job.id}. Attach advertisement evidence, then open it.`);
      });
  }

  function addAdvertModal(jobId) {
    formModal('Record an advertisement',
      'Link the uploaded evidence file for this advertisement. Upload it first with subject type job_advertisement.',
      field('Channel', 'channel', 'company-website', 'required maxlength="80"')
      + field('Reference', 'reference', '', 'required maxlength="160"')
      + field('Posted at', 'postedAt', new Date().toISOString(), 'required maxlength="40"')
      + field('Evidence identifier', 'evidenceId', '', 'maxlength="80"', 'The identifier of the uploaded advertisement file.'),
      'Record',
      async values => {
        await api.addAdvertisement(jobId, values);
        await refresh('Advertisement recorded.');
      });
  }

  async function openJob(jobId) {
    const result = await guard(() => api.openJob(jobId));
    if (!result) return;
    await refresh('Job opened.');
  }

  function addCandidateModal(jobId) {
    formModal('Add candidate', 'Personal data is visible to HR only. Other roles see the candidate reference.',
      field('Candidate reference', 'candidateRef', '', 'required maxlength="60"')
      + field('Full name', 'fullName', '', 'required maxlength="120"')
      + field('Contact email', 'contactEmail', '', 'type="email" maxlength="160"')
      + field('Expected start', 'expectedStart', '', 'maxlength="40"')
      + field('Offer amount · SGD', 'offerAmount', '', 'inputmode="decimal"'),
      'Add',
      async values => {
        const candidate = await api.createCandidate(jobId, values);
        state.selectedJob = jobId;
        state.selectedCandidate = candidate.id;
        await refresh('Candidate added.');
      });
  }

  function advanceCandidateModal(candidateId, stage) {
    formModal(`Move candidate to ${stage}`,
      'A candidate cannot progress while required information is missing. The server refuses the change if anything is outstanding.',
      select('Stage', 'stage', ['screening', 'interview', 'offer', 'hired', 'rejected'], stage || 'screening')
      + area('Reason', 'reason', '', 'maxlength="500"'),
      'Move',
      async values => {
        await api.advanceCandidate(candidateId, { stage: values.stage, reason: values.reason });
        await refresh(`Candidate moved to ${values.stage}.`);
      });
  }

  function addScorecardModal(candidateId) {
    formModal('Record a scorecard',
      'Scorecards are append-only. A corrected assessment creates a new revision and the previous one stays readable.',
      field('Criterion 1 name', 'c1name', 'Technical depth', 'required maxlength="80"')
      + field('Criterion 1 score (1–5)', 'c1score', '4', 'required inputmode="numeric"')
      + field('Criterion 2 name', 'c2name', 'Collaboration', 'required maxlength="80"')
      + field('Criterion 2 score (1–5)', 'c2score', '4', 'required inputmode="numeric"')
      + select('Recommendation', 'recommendation', ['hire', 'no_hire', 'hold'], 'hire')
      + area('Note', 'note', '', 'maxlength="1000"'),
      'Record',
      async values => {
        await api.addScorecard(candidateId, {
          criteria: [
            { name: values.c1name, score: Number(values.c1score) },
            { name: values.c2name, score: Number(values.c2score) }
          ],
          recommendation: values.recommendation,
          note: values.note
        });
        await refresh('Scorecard recorded as a new revision.');
      });
  }

  function onboardModal(candidateId) {
    formModal('Onboard as an employee',
      'Creates the employee record used by payroll. Recruitment detail stays with HR; finance-side roles receive the projection only.',
      field('Employee number', 'employeeNo', '', 'required maxlength="40"')
      + field('Department', 'department', '', 'required maxlength="80"')
      + field('Cost center', 'costCenter', '', 'required maxlength="80"')
      + field('Start date', 'startDate', '', 'maxlength="40"'),
      'Onboard',
      async values => {
        await api.onboard(candidateId, { ...values, caseId: state.caseId });
        await refresh('Employee record created.');
      });
  }

  function scheduleInterviewModal(candidateId) {
    formModal('Schedule an interview',
      'Scheduling is simulated: no Microsoft Graph request is made and the join link is not a live meeting. '
      + 'An identical repeated request returns the existing meeting instead of creating a second one.',
      field('Start', 'scheduledStart', new Date(Date.now() + 86400000).toISOString(), 'required maxlength="40"')
      + field('Duration in minutes', 'durationMinutes', '45', 'required inputmode="numeric"')
      + field('Subject', 'subject', 'Interview', 'maxlength="160"'),
      'Schedule',
      async values => {
        const result = await api.scheduleInterview(candidateId, {
          scheduledStart: values.scheduledStart,
          durationMinutes: Number(values.durationMinutes),
          subject: values.subject
        });
        await refresh(result.error
          ? `The simulated provider reported a failure: ${result.error}. The attempt stays visible.`
          : result.duplicate ? 'An identical request already created this meeting; it was returned unchanged.' : 'Interview scheduled.');
      });
  }

  function rescheduleInterviewModal(meetingId) {
    formModal('Reschedule the interview', 'The previous start time is retained on the record.',
      field('New start', 'scheduledStart', new Date(Date.now() + 172800000).toISOString(), 'required maxlength="40"')
      + area('Reason', 'reason', '', 'maxlength="500"'),
      'Reschedule',
      async values => {
        await api.rescheduleInterview(meetingId, values);
        await refresh('Interview rescheduled.');
      });
  }

  function cancelInterviewModal(meetingId) {
    noteModal('Cancel the interview', 'The meeting stays on the record as cancelled, with the reason.',
      'Reason for cancelling', async note => {
        await guard(() => api.cancelInterview(meetingId, { reason: note }));
        await refresh('Interview cancelled.');
      });
  }

  // ---------------------------------------------------------------------------
  // Access and activity
  // ---------------------------------------------------------------------------

  async function grantAccessModal() {
    const listing = await guard(() => api.users());
    if (!listing) return;
    const options = listing.users.map(user => [user.id, `${user.displayName} · ${user.role}`]);
    formModal('Grant case access',
      'Access is per case. Read-only auditor access must always carry an expiry, which the server enforces.',
      select('Account', 'userId', options, options[0]?.[0] || '')
      + field('Case role', 'caseRole', '', 'maxlength="60"', 'Leave blank to use the account role.')
      + field('Expires at', 'expiresAt', '', 'maxlength="40"', 'ISO-8601 timestamp. Required for auditor accounts.'),
      'Grant',
      async values => {
        const result = await api.grantAccess(state.caseId, {
          userId: values.userId,
          caseRole: values.caseRole || undefined,
          expiresAt: values.expiresAt || null
        });
        await refresh(result.note);
      });
  }

  function revokeAccessModal(memberId) {
    noteModal('Revoke case access', 'The grant stays on the record as revoked. Past activity is never removed.',
      'Reason', async () => {
        await guard(() => api.revokeAccess(state.caseId, memberId));
        await refresh('Access revoked.');
      });
  }

  async function setAuditScope(scope) {
    state.auditScope = scope;
    await refresh(scope === 'access' ? 'Showing access and export events only.' : 'Showing all recorded activity.');
  }

  // ---------------------------------------------------------------------------
  // Action dispatch
  //
  // Every button carries a data-action name resolved here. Buttons are only
  // rendered or enabled from the permission list the server returned, and the
  // server refuses the request regardless of what the browser shows.
  // ---------------------------------------------------------------------------

  const ACTIONS = {
    close: () => closeModal(),

    // Payroll
    'import-records': () => importRecordsModal(),
    'preview-records': () => previewRecords(),
    'confirm-records': () => confirmRecords(),
    'edit-record': element => editRecordModal(element.dataset.id),
    'export-records': () => exportRecords(),

    // Payments
    'preview-payments': () => previewPaymentsModal(),
    'do-preview-payments': () => doPreviewPayments(),
    'confirm-payments': () => confirmPayments(),
    'discard-preview': () => discardPaymentPreview(),
    'payments-template': () => downloadTemplate('payments'),

    // Bank reconciliation
    'preview-bank': () => previewBankModal(),
    'do-preview-bank': () => doPreviewBank(),
    'confirm-bank': () => confirmBank(),
    'discard-bank-preview': () => discardBankPreview(),
    'run-reconciliation': () => runReconciliation(),
    'bank-template': () => downloadTemplate('bank'),

    // Checks, rules and agent
    'run-checks': () => runChecks(),
    'edit-rules': () => editRulesModal(),
    'agent-run': () => startAgentRun(false),
    'agent-run-fallback': () => startAgentRun(true),
    'select-run': element => { state.selectedRun = element.dataset.id; render({ reload: false }); },

    // Evidence
    'upload-evidence': () => uploadEvidenceModal(),
    'download-evidence': element => downloadEvidence(element.dataset.id),

    // Reports and approvals
    'create-report': () => createReport(),
    'select-report': element => { state.selectedReport = element.dataset.id; render({ reload: false }); },
    'open-report': element => { state.selectedReport = element.dataset.id; location.hash = '#reports'; },
    advance: element => advanceReport(element.dataset.id, element.dataset.stage),
    reject: element => rejectReport(element.dataset.id),
    amend: element => amendReport(element.dataset.id),
    'print-report': element => printReport(element.dataset.id || state.selectedReport),

    // Exports
    'export-package': element => exportPackage(element.dataset.id || null),
    'export-json': () => exportJson(),
    'goto-reports': () => { location.hash = '#reports'; },

    // Recruitment
    'create-job': () => createJobModal(),
    'add-advert': element => addAdvertModal(element.dataset.id),
    'open-job': element => openJob(element.dataset.id),
    'add-candidate': element => addCandidateModal(element.dataset.id),
    'select-job': element => { state.selectedJob = element.dataset.id; state.selectedCandidate = null; render(); },
    'select-candidate': element => { state.selectedCandidate = element.dataset.id; render(); },
    'advance-candidate': element => advanceCandidateModal(element.dataset.id, element.dataset.stage),
    'add-scorecard': element => addScorecardModal(element.dataset.id),
    onboard: element => onboardModal(element.dataset.id),
    'schedule-interview': element => scheduleInterviewModal(element.dataset.id),
    'reschedule-interview': element => rescheduleInterviewModal(element.dataset.id),
    'cancel-interview': element => cancelInterviewModal(element.dataset.id),

    // Access and activity
    'grant-access': () => grantAccessModal(),
    'revoke-access': element => revokeAccessModal(element.dataset.id),
    'audit-access': () => setAuditScope('access'),
    'audit-all': () => setAuditScope(null)
  };

  // ---------------------------------------------------------------------------
  // Boot and event wiring
  // ---------------------------------------------------------------------------

  /** Loads the session and the case context, then renders the current view. */
  async function boot() {
    try { state.meta = await api.meta(); } catch { state.meta = null; }
    try {
      state.me = await api.me();
    } catch {
      state.me = null;
      state.caseDetail = null;
    }
    state.data = {};
    if (state.me) {
      try { await loadCaseContext(); } catch { state.caseDetail = null; }
    }
    await render();
  }

  document.addEventListener('click', event => {
    if (event.target.closest('[data-close]')) return closeModal();
    const trigger = event.target.closest('[data-action]');
    if (!trigger || trigger.disabled) return;
    const handler = ACTIONS[trigger.dataset.action];
    if (!handler) return;
    event.preventDefault();
    Promise.resolve(handler(trigger)).catch(error => toast(describeError(error), true));
  });

  document.addEventListener('submit', event => {
    // Modal forms register their own handler; the sign-in form is bound on render.
    if (event.target.id === 'ws-form' || event.target.id === 'signin-form') return;
    event.preventDefault();
  });

  $('#signout').addEventListener('click', () => { signOut(); });

  window.addEventListener('hashchange', () => { render(); });

  document.addEventListener('DOMContentLoaded', () => { boot(); });
  if (document.readyState !== 'loading') boot();
})();
