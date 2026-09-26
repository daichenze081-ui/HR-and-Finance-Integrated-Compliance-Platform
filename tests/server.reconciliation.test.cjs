/* Third-party bank statement import, three-way reconciliation, the workbook
 * reader, and the draft validation that refuses an overstated reconciliation. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, capture } = require('./helpers.cjs');

const zip = require('../server/lib/zip');
const xlsx = require('../server/lib/xlsx');
const csv = require('../server/lib/csv');
const draftModule = require('../server/agent/draft');
const casesService = require('../server/services/cases.service');
const checksService = require('../server/services/checks.service');
const recordsService = require('../server/services/records.service');
const paymentsService = require('../server/services/payments.service');
const reconciliationService = require('../server/services/reconciliation.service');
const evidenceService = require('../server/services/evidence.service');

const PAYMENT_CSV = [
  'employeeNo,period,amount,paymentRef,paidAt',
  'EMP-001,2026-09,7000.00,PAY-202609-001,2026-09-28T09:00:00.000Z',
  'EMP-002,2026-09,6000.00,PAY-202609-002,2026-09-28T09:00:00.000Z'
].join('\n');

const bankCsv = rows => ['txnRef,valueDate,direction,amount,counterparty,description', ...rows].join('\n');

/** Payments imported, and the two payroll rows they belong to made consistent. */
async function withPayments(h) {
  await paymentsService.importBatch(h.ctx.preparer, h.caseId, { csv: PAYMENT_CSV, filename: 'payments.csv' });
}

async function reconcileNow(h) {
  return reconciliationService.run(h.ctx.preparer, h.caseId);
}

// ---------------------------------------------------------------------------
// Workbook reader
// ---------------------------------------------------------------------------

/** Minimal but real .xlsx: two worksheets, shared strings and a date style. */
function workbook({ sheetName = 'Statement', rows, second = true } = {}) {
  const cell = (reference, value, style) => (/^-?\d+(\.\d+)?$/.test(String(value))
    ? `<c r="${reference}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`
    : `<c r="${reference}" t="inlineStr"><is><t>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`);
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const sheetXml = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + rows.map((cells, rowIndex) =>
      `<row r="${rowIndex + 1}">${cells.map((value, columnIndex) => cell(`${letters[columnIndex]}${rowIndex + 1}`, value)).join('')}</row>`).join('')
    + '</sheetData></worksheet>';
  const entries = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/>`
        + `${second ? '<sheet name="Notes" sheetId="2" r:id="rId2"/>' : ''}</sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'
    },
    { name: 'xl/styles.xml', data: '<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>internal note</t></is></c></row></sheetData></worksheet>'
    }
  ];
  return zip.create(entries);
}

test('the workbook reader produces the same objects as the CSV reader', () => {
  const headers = ['txnRef', 'valueDate', 'direction', 'amount', 'counterparty', 'description'];
  const rows = [
    headers,
    ['PAY-202609-001', '2026-09-28', 'out', '7000.00', 'Demo Company payroll', 'September net salary'],
    ['PAY-202609-002', '2026-09-28', 'out', '6000.00', 'Demo Company payroll', 'September net salary']
  ];
  const fromWorkbook = xlsx.parse(workbook({ rows }), headers);
  const fromCsv = csv.parse(rows.map(cells => cells.join(',')).join('\n'), headers);
  assert.deepEqual(fromWorkbook, fromCsv, 'both containers yield identical rows, including __line numbering');

  // Worksheet selection is explicit and a wrong name is refused, not guessed.
  const described = xlsx.describe(workbook({ rows }));
  assert.deepEqual(described.worksheets, ['Statement', 'Notes']);
  assert.equal(described.needsWorksheetChoice, true);
  assert.equal(described.rowCount, 2);
  assert.equal(xlsx.parseRows(workbook({ rows }), { sheet: 'Notes' }).rows[0][0], 'internal note');

  // One entry point serves both containers and reports which one it read.
  const asWorkbook = csv.readTable({ buffer: workbook({ rows }), worksheet: 'Statement' }, headers);
  assert.equal(asWorkbook.format, 'xlsx');
  assert.equal(asWorkbook.worksheet, 'Statement');
  const asText = csv.readTable({ text: rows.map(cells => cells.join(',')).join('\n') }, headers);
  assert.equal(asText.format, 'csv');
  assert.deepEqual(asWorkbook.rows, asText.rows);
});

test('a workbook with a formula, an unknown worksheet or a bad header is refused', () => {
  const headers = ['txnRef', 'valueDate', 'direction', 'amount', 'counterparty', 'description'];
  const rows = [headers, ['PAY-202609-001', '2026-09-28', 'out', '7000.00', 'x', 'y']];

  const unknownSheet = (() => { try { xlsx.parseRows(workbook({ rows }), { sheet: 'Missing' }); return null; } catch (error) { return error; } })();
  assert.equal(unknownSheet.status, 400);
  assert.match(unknownSheet.message, /Worksheet not found/);

  const shortHeader = (() => { try { xlsx.parse(workbook({ rows }), ['txnRef', 'amount']); return null; } catch (error) { return error; } })();
  assert.equal(shortHeader.status, 400);
  assert.match(shortHeader.message, /exactly these columns/);

  const notAWorkbook = (() => { try { xlsx.parseRows(Buffer.from('txnRef,amount\nX,1.00')); return null; } catch (error) { return error; } })();
  assert.match(notAWorkbook.message, /Not a readable \.xlsx workbook/);

  // A formula is refused rather than evaluated, so no cell can compute an amount.
  const withFormula = zip.create([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>amount</t></is></c></row>'
        + '<row r="2"><c r="A2"><f>SUM(B1:B9)</f><v>7000</v></c></row></sheetData></worksheet>'
    }
  ]);
  const formula = (() => { try { xlsx.parseRows(withFormula); return null; } catch (error) { return error; } })();
  assert.equal(formula.status, 400);
  assert.match(formula.message, /contains a formula/);
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

test('a bank statement preview writes nothing and the import is atomic', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    const statement = bankCsv([
      'PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,September net salary',
      'PAY-202609-002,2026-09-28,out,6000.00,Demo Company payroll,September net salary'
    ]);

    const preview = await reconciliationService.preview(h.ctx.preparer, h.caseId, { csv: statement, filename: 'bank.csv' });
    assert.equal(preview.acceptable, true);
    assert.equal(preview.rowCount, 2);
    assert.equal(preview.totalOut, '13000.00');
    assert.equal((await reconciliationService.list(h.ctx.preparer, h.caseId)).transactions.length, 0, 'preview wrote nothing');

    const before = (await h.store.get('cases', h.caseId)).data_revision;
    const imported = await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
      csv: statement, filename: 'bank.csv', expectedDigest: preview.fileDigest
    });
    assert.equal(imported.rowCount, 2);
    assert.equal(imported.sourceFormat, 'csv');
    assert.equal(imported.dataRevision, before + 1, 'a new statement advances the data revision');

    // A rejected row leaves the stored statement unchanged.
    const bad = bankCsv([
      'PAY-202609-003,2026-09-28,out,4750.00,Demo Company payroll,ok',
      'PAY-202609-004,2026-09-28,sideways,5100.00,Demo Company payroll,bad direction'
    ]);
    const rejected = await capture(() => reconciliationService.importBatch(h.ctx.preparer, h.caseId, { csv: bad, filename: 'bad.csv' }));
    assert.equal(rejected.status, 400);
    assert.match(rejected.message, /No rows were imported/);
    assert.equal((await reconciliationService.list(h.ctx.preparer, h.caseId)).transactions.length, 2);

    // The same file cannot be imported twice.
    const duplicate = await capture(() => reconciliationService.importBatch(h.ctx.preparer, h.caseId, { csv: statement, filename: 'bank.csv' }));
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.message, /already been imported/);
  } finally { await h.close(); }
});

test('a statement supplied as a workbook is accepted on the same terms as a CSV', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    const buffer = workbook({
      rows: [
        ['txnRef', 'valueDate', 'direction', 'amount', 'counterparty', 'description'],
        ['PAY-202609-001', '2026-09-28', 'out', '7000.00', 'Demo Company payroll', 'September net salary'],
        ['PAY-202609-002', '2026-09-28', 'out', '6000.00', 'Demo Company payroll', 'September net salary']
      ]
    });
    const imported = await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
      workbookBase64: buffer.toString('base64'), worksheet: 'Statement', filename: 'bank.xlsx'
    });
    assert.equal(imported.sourceFormat, 'xlsx');
    assert.equal(imported.worksheet, 'Statement');
    assert.equal(imported.rowCount, 2);
    assert.equal(imported.totalOut, '13000.00');
  } finally { await h.close(); }
});

test('the import is refused without the payments.import permission and outside the case', async () => {
  const h = await harness();
  try {
    const statement = bankCsv(['PAY-202609-001,2026-09-28,out,7000.00,x,y']);
    const wrongRole = await capture(() => reconciliationService.importBatch(h.ctx.hr, h.caseId, { csv: statement, filename: 'bank.csv' }));
    assert.equal(wrongRole.status, 403);
    assert.equal(wrongRole.detail.requiredPermission, 'payments.import');

    const otherCase = await casesService.create(h.ctx.admin, { title: 'Unrelated', period: '2026-09' });
    const notAMember = await capture(() => reconciliationService.importBatch(h.ctx.preparer, otherCase.id, { csv: statement, filename: 'bank.csv' }));
    assert.equal(notAMember.status, 403);
    assert.match(notAMember.message, /not a member of this case/);

    // Both refusals happened before anything was written.
    assert.equal((await h.store.find('bank_transactions', {})).length, 0);
  } finally { await h.close(); }
});

test('every bank import and reconciliation is written to the activity log', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    const statement = bankCsv(['PAY-202609-001,2026-09-28,out,7000.00,x,y']);
    await reconciliationService.preview(h.ctx.preparer, h.caseId, { csv: statement, filename: 'bank.csv' });
    await reconciliationService.importBatch(h.ctx.preparer, h.caseId, { csv: statement, filename: 'bank.csv' });
    await reconcileNow(h);

    const actions = (await h.store.find('audit_log', { case_id: h.caseId })).map(row => row.action);
    for (const action of ['bank.previewed', 'bank.imported', 'reconciliation.run']) {
      assert.ok(actions.includes(action), `${action} is logged`);
    }
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('matching is exact and one-to-one, yielding matched, unmatched and ambiguous', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
      filename: 'bank.csv',
      csv: bankCsv([
        // matches EMP-001 exactly
        'PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,net salary',
        // same reference and amount twice: neither side is unique
        'PAY-202609-002,2026-09-28,out,6000.00,Demo Company payroll,net salary',
        'PAY-202609-002,2026-09-29,out,6000.00,Demo Company payroll,duplicate advice',
        // in the account with no imported payment
        'REFUND-001,2026-09-30,in,120.00,Landlord,deposit returned'
      ])
    });

    const result = (await reconcileNow(h)).result;
    assert.equal(result.applicable, true);
    assert.deepEqual(result.matched.map(row => row.reference), ['PAY-202609-001']);
    assert.deepEqual(result.ambiguous.map(row => row.reference), ['PAY-202609-002']);
    assert.deepEqual(result.unmatchedBank.map(row => row.reference), ['REFUND-001']);
    assert.equal(result.counts.matched, 1);
    assert.equal(result.counts.ambiguous, 1);
    assert.equal(result.totals.bankIn, '120.00');
    assert.match(result.method, /Exact match on reference, amount in integer SGD cents and direction/);

    // A wrong amount or a wrong direction is never matched approximately.
    const amountOnly = reconciliationService.reconcile({
      payments: [{ id: 'p1', employee_no: 'EMP-001', period: '2026-09', payment_ref: 'R-1', amount_cents: 7000_00, paid_at: '2026-09-28T09:00:00.000Z' }],
      bank: [{ id: 'b1', txn_ref: 'R-1', direction: 'out', amount_cents: 6999_99, value_date: '2026-09-28' }],
      payrollRows: []
    });
    assert.equal(amountOnly.counts.matched, 0);
    assert.equal(amountOnly.counts.unmatched, 1);

    const directionOnly = reconciliationService.reconcile({
      payments: [{ id: 'p1', employee_no: 'EMP-001', period: '2026-09', payment_ref: 'R-1', amount_cents: 7000_00, paid_at: '2026-09-28T09:00:00.000Z' }],
      bank: [{ id: 'b1', txn_ref: 'R-1', direction: 'in', amount_cents: 7000_00, value_date: '2026-09-28' }],
      payrollRows: []
    });
    assert.equal(directionOnly.counts.matched, 0);
  } finally { await h.close(); }
});

test('with no statement imported nothing is reported as bank-confirmed and no bank rule fires', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    const reconciled = (await reconcileNow(h)).result;
    assert.equal(reconciled.applicable, false);
    assert.equal(reconciled.counts.matched, 0);
    assert.match(reconciled.note, /No bank statement has been imported/);

    const check = await checksService.run(h.ctx.preparer, h.caseId);
    assert.ok(!check.issues.some(issue => issue.rule.startsWith('BANK-')), 'a missing statement is not dozens of findings');
  } finally { await h.close(); }
});

test('the rules report unmatched, ambiguous and three-way disagreements', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
      filename: 'bank.csv',
      csv: bankCsv([
        'PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,net salary',
        'PAY-202609-002,2026-09-28,out,6000.00,Demo Company payroll,net salary',
        'PAY-202609-002,2026-09-29,out,6000.00,Demo Company payroll,duplicate advice',
        'REFUND-001,2026-09-30,in,120.00,Landlord,deposit returned'
      ])
    });
    const check = await checksService.run(h.ctx.preparer, h.caseId);
    const byRule = rule => check.issues.filter(issue => issue.rule === rule);

    assert.equal(byRule('BANK-002').length, 1, 'the unexplained bank credit is reported');
    assert.match(byRule('BANK-002')[0].detail, /REFUND-001/);
    assert.ok(byRule('BANK-003').length >= 1, 'the ambiguous pair is reported for human review');
    assert.equal(byRule('BANK-003')[0].severity, 'review');
    assert.ok(byRule('BANK-003').some(issue => /not reported as reconciled/.test(issue.detail)));
    // EMP-002's payment is only ambiguously evidenced, so the three sources do not agree.
    assert.ok(byRule('BANK-004').some(issue => issue.recordId === 'EMP-002'));

    // The reconciliation is stored against the same data revision as the check.
    const latest = await reconciliationService.latest(h.ctx.preparer, h.caseId);
    assert.equal(latest.current, true);
    assert.equal(latest.reconciliation.dataRevision, check.dataRevision);
  } finally { await h.close(); }
});

test('a reconciliation goes stale when the data or the rules change', async () => {
  const h = await harness();
  try {
    await withPayments(h);
    await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
      filename: 'bank.csv',
      csv: bankCsv(['PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,net salary'])
    });
    await checksService.run(h.ctx.preparer, h.caseId);
    assert.equal((await reconciliationService.latest(h.ctx.preparer, h.caseId)).current, true);

    await recordsService.update(h.ctx.hr, h.caseId, 'EMP-001', { changes: { basePay: '8600.00' }, note: 'Adjusted' });
    const afterEdit = await reconciliationService.latest(h.ctx.preparer, h.caseId);
    assert.equal(afterEdit.current, false);
    assert.match(afterEdit.reconciliation.staleReason, /Data has changed/);

    await checksService.run(h.ctx.preparer, h.caseId);
    await casesService.setRuleConfig(h.ctx.admin, h.caseId, { rules: [{ id: 'BANK-002', enabled: false }] });
    const afterRules = await reconciliationService.latest(h.ctx.preparer, h.caseId);
    assert.equal(afterRules.current, false);
    assert.match(afterRules.reconciliation.staleReason, /Rules have changed/);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

async function draftContext(h) {
  const caseRecord = await h.store.get('cases', h.caseId);
  const ruleSet = await casesService.ruleSetFor(h.store, caseRecord);
  const checkRow = await checksService.latestRow(h.store, h.caseId);
  const payrollRows = await recordsService.rawList(h.store, h.caseId);
  const payments = await h.store.find('payments', { case_id: h.caseId });
  const bank = await reconciliationService.rawBankList(h.store, h.caseId);
  return draftModule.buildContext({
    caseRecord,
    checkRow,
    payrollRows,
    payments,
    bank,
    reconciliation: reconciliationService.reconcile({ payments, bank, payrollRows }),
    evidence: await evidenceService.manifest(h.store, h.caseId),
    ruleSet
  });
}

/** A case with one matched, one ambiguous and one unexplained bank row. */
async function reconciledCase(h) {
  await withPayments(h);
  await reconciliationService.importBatch(h.ctx.preparer, h.caseId, {
    filename: 'bank.csv',
    csv: bankCsv([
      'PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,net salary',
      'PAY-202609-002,2026-09-28,out,6000.00,Demo Company payroll,net salary',
      'PAY-202609-002,2026-09-29,out,6000.00,Demo Company payroll,duplicate advice',
      'REFUND-001,2026-09-30,in,120.00,Landlord,deposit returned'
    ])
  });
  await checksService.run(h.ctx.preparer, h.caseId);
  return draftContext(h);
}

test('the deterministic template still validates against the hardened checks', async () => {
  const h = await harness();
  try {
    const context = await reconciledCase(h);
    const draft = draftModule.validate(draftModule.template(context), context);
    assert.equal(draft.financeTotals.paymentLedgerTotal, '13000.00');
    assert.equal(draft.financeTotals.bankIn, '120.00');
    assert.equal(draft.reconciliation.applicable, true);
    // The proved status travels with the report, not an assumed one.
    assert.deepEqual(
      draft.bankReferences.find(entry => entry.reference === 'PAY-202609-002'),
      { reference: 'PAY-202609-002', status: 'ambiguous' }
    );
    assert.equal(draft.bankReferences.find(entry => entry.reference === 'PAY-202609-001').status, 'matched');
  } finally { await h.close(); }
});

test('a draft citing a bank transaction that does not exist is refused', async () => {
  const h = await harness();
  try {
    const context = await reconciledCase(h);
    const good = draftModule.template(context);

    const invented = await capture(async () => draftModule.validate({
      ...good, bankReferences: [{ reference: 'BANK-999999' }]
    }, context));
    assert.equal(invented.status, 422);
    assert.match(invented.message, /does not exist in this case/);

    const inProse = await capture(async () => draftModule.validate({
      ...good, summary: `${good.summary} Payment BANK-999999 was traced to the statement.`
    }, context));
    assert.equal(inProse.status, 422);
    assert.match(inProse.message, /BANK-999999/);
  } finally { await h.close(); }
});

test('a draft that marks an unreconciled record as matched is refused', async () => {
  const h = await harness();
  try {
    const context = await reconciledCase(h);
    const good = draftModule.template(context);

    // Structured overstatement.
    const structured = await capture(async () => draftModule.validate({
      ...good,
      bankReferences: [{ reference: 'PAY-202609-002', status: 'matched' }]
    }, context));
    assert.equal(structured.status, 422);
    assert.match(structured.message, /recorded as "ambiguous"/);

    const perFinding = await capture(async () => draftModule.validate({
      ...good,
      findings: good.findings.map((finding, index) => (index === 0
        ? { ...finding, bankReference: 'REFUND-001', reconciliationStatus: 'matched' }
        : finding))
    }, context));
    assert.equal(perFinding.status, 422);
    assert.match(perFinding.message, /proved it is "unmatched"/);

    // Prose overstatement: the structured fields are untouched and still correct.
    const prose = await capture(async () => draftModule.validate({
      ...good,
      summary: `${good.summary} Payment PAY-202609-002 is fully reconciled against the bank statement.`
    }, context));
    assert.equal(prose.status, 422);
    assert.match(prose.message, /records it as ambiguous/);
    assert.equal(prose.detail.reference, 'PAY-202609-002');

    // Saying the opposite is allowed, because it is true.
    const honest = draftModule.validate({
      ...good,
      summary: `${good.summary} Payment PAY-202609-002 is not reconciled: the match is ambiguous.`
    }, context);
    assert.ok(honest.summary.includes('not reconciled'));
  } finally { await h.close(); }
});

test('free text is checked against the structured data, not merely alongside it', async () => {
  const h = await harness();
  try {
    const context = await reconciledCase(h);
    const good = draftModule.template(context);

    // Correct keyAmounts, invented amount in the prose.
    const invented = await capture(async () => draftModule.validate({
      ...good, summary: 'Total payments of SGD 9999.99 were reviewed for the period.'
    }, context));
    assert.equal(invented.status, 422);
    assert.match(invented.message, /not a figure the server computed/);
    assert.equal(invented.detail.amount, '9999.99');

    // An invented source identifier in a recommendation.
    const source = await capture(async () => draftModule.validate({
      ...good, recommendations: [...good.recommendations, 'Reconcile transaction LED-404 before submission.']
    }, context));
    assert.equal(source.status, 422);
    assert.match(source.message, /LED-404/);

    // A real server amount stated in prose passes.
    const truthful = draftModule.validate({
      ...good, summary: `The payment ledger totals SGD ${context.financeTotals.paymentLedgerTotal} for this period.`
    }, context);
    assert.ok(truthful.summary.includes('13000.00'));
  } finally { await h.close(); }
});

test('declared financial totals must equal the server figures to the cent', async () => {
  const h = await harness();
  try {
    const context = await reconciledCase(h);
    const good = draftModule.template(context);

    const wrong = await capture(async () => draftModule.validate({
      ...good, financeTotals: { ...good.financeTotals, bankOut: '1.00' }
    }, context));
    assert.equal(wrong.status, 422);
    assert.match(wrong.message, /financial totals do not match/);
    assert.deepEqual(wrong.detail.mismatchedFields, ['bankOut']);
  } finally { await h.close(); }
});

test('the agent can read the reconciliation but cannot change it', async () => {
  const h = await harness();
  try {
    await reconciledCase(h);
    const agentTools = require('../server/agent/tools');
    const run = { id: 'run_test', caseId: h.caseId, runKind: 'mock-model', allowedTools: Object.keys(agentTools.TOOLS) };

    const { output, mutates } = await agentTools.invoke(h.ctx.preparer, run, { name: 'get_reconciliation', input: {} });
    assert.equal(mutates, false);
    assert.equal(output.applicable, true);
    assert.equal(output.counts.matched, 1);
    assert.ok(output.payments.every(row => ['matched', 'unmatched', 'ambiguous'].includes(row.status)));

    const filtered = await agentTools.invoke(h.ctx.preparer, run, { name: 'get_reconciliation', input: { status: 'ambiguous' } });
    assert.ok(filtered.output.payments.every(row => row.status === 'ambiguous'));

    const badArgument = await capture(() => agentTools.invoke(h.ctx.preparer, run, { name: 'get_reconciliation', input: { caseId: 'case_other' } }));
    assert.equal(badArgument.status, 400);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------------------
// HTTP surface and the default document
// ---------------------------------------------------------------------------

test('the server root serves the workspace and the demo stays at its own path', async () => {
  const { httpHarness } = require('./helpers.cjs');
  const h = await httpHarness();
  try {
    const root = await h.call('GET', '/');
    assert.equal(root.status, 200);
    const rootHtml = root.body.toString('utf8');
    assert.match(rootHtml, /Server workspace/, 'the root document is the server-connected workspace');
    assert.match(rootHtml, /workspace\.js/);

    // The archived browser-local demo is reachable, but only where it now lives.
    const demo = await h.call('GET', '/demo/index.html');
    assert.equal(demo.status, 200);
    assert.match(demo.body.toString('utf8'), /Local demo mode/);
    assert.equal((await h.call('GET', '/demo/')).status, 200);

    // The old root paths no longer resolve.
    for (const path of ['/index.html', '/core.js', '/app.js']) {
      assert.equal((await h.call('GET', path)).status, 404, `${path} is no longer served from the root`);
    }
    assert.equal((await h.call('GET', '/demo/core.js')).status, 200);
  } finally { await h.close(); }
});

test('bank import and reconciliation are reachable over the API', async () => {
  const { httpHarness } = require('./helpers.cjs');
  const h = await httpHarness();
  try {
    const token = await h.login('preparer@peopleledger.demo');
    const caseId = h.caseId;

    await h.call('POST', `/api/v1/cases/${caseId}/payments/import`, { token, body: { csv: PAYMENT_CSV, filename: 'payments.csv' } });

    const statement = bankCsv([
      'PAY-202609-001,2026-09-28,out,7000.00,Demo Company payroll,net salary',
      'REFUND-001,2026-09-30,in,120.00,Landlord,deposit returned'
    ]);
    const preview = await h.call('POST', `/api/v1/cases/${caseId}/bank/preview`, { token, body: { csv: statement, filename: 'bank.csv' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.acceptable, true);

    const imported = await h.call('POST', `/api/v1/cases/${caseId}/bank/import`, {
      token, body: { csv: statement, filename: 'bank.csv', expectedDigest: preview.body.fileDigest }
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.rowCount, 2);

    const listed = await h.call('GET', `/api/v1/cases/${caseId}/bank`, { token });
    assert.equal(listed.body.transactions.length, 2);
    assert.equal(listed.body.totalIn, '120.00');

    const reconciled = await h.call('POST', `/api/v1/cases/${caseId}/reconciliation`, { token, body: {} });
    assert.equal(reconciled.status, 201);
    assert.equal(reconciled.body.result.counts.matched, 1);
    assert.equal(reconciled.body.result.counts.bankUnmatched, 1);

    const latest = await h.call('GET', `/api/v1/cases/${caseId}/reconciliation/latest`, { token });
    assert.equal(latest.body.current, true);

    const template = await h.call('GET', '/api/v1/templates/bank.csv', { token });
    assert.match(template.body.toString('utf8'), /txnRef/);
  } finally { await h.close(); }
});
