'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, config } = require('./helpers.cjs');
const { SqliteStore } = require('../server/adapters/db/sqlite');
const reports = require('../server/services/reports.service');
const records = require('../server/services/records.service');
const exportsService = require('../server/services/export.service');
const checks = require('../server/services/checks.service');
const ledger = require('../server/services/ledger-source');
const zip = require('../server/lib/zip');
const sessions = require('../server/auth/sessions');
const fixture = name => fs.readFileSync(path.join(__dirname, '../examples', name));

test('v2 default data matches all eight transactions and survives a database restart with approvals and sessions', async () => {
  const h = await harness({ driver: 'sqlite', dataset: 'v2' });
  try {
    const current = await checks.latest(h.ctx.preparer, h.caseId);
    assert.equal(current.check.blockingCount, 0);
    const result = (await h.store.find('reconciliations', { case_id: h.caseId }))[0].result;
    assert.equal(result.counts.matched, 8);
    assert.equal(result.counts.bankUnmatched, 0);
    assert.equal(result.totals.bankIn, '50000.00');
    assert.equal(result.totals.bankOut, '39100.00');
    assert.equal(result.totals.bankNetMovement, '10900.00');
    const report = await reports.create(h.ctx.preparer, h.caseId, {});
    for (const [role, stage] of [['preparer','submit'], ['reviewer','review'], ['management','confirm'], ['director','approve'], ['director','seal']]) {
      await reports.advance(h.ctx[role], report.id, stage, { note: 'Reviewed v2 synthetic records' });
    }
    const login = await sessions.login(h.store, { email: h.users.preparer.email, password: config.seed.password, userAgent: 'test' });
    const filename = h.store.filename;
    await h.store.close();
    const reopened = await new SqliteStore({ filename }).init();
    try {
      assert.equal((await reopened.get('reports', report.id)).status, 'sealed');
      assert.equal((await reopened.find('approvals', { report_id: report.id })).length, 5);
      assert.equal((await reopened.find('payments', { case_id: h.caseId })).length, 6);
      assert.equal((await reopened.find('ledger_entries', { case_id: h.caseId })).length, 2);
      assert.ok(await sessions.resolve(reopened, login.token));
      const seededAgain = await require('../server/db/seed').seed(reopened, { quiet: true });
      assert.equal(seededAgain.alreadySeeded, true);
      assert.equal((await reopened.find('bank_transactions', { case_id: h.caseId })).length, 8);
    } finally { await reopened.close(); }
  } finally { await h.close(); }
});

test('old report exports use frozen payroll, ledger, bank and evidence, not current records', async () => {
  const h = await harness({ driver: 'sqlite', dataset: 'v2' });
  try {
    const report = await reports.create(h.ctx.preparer, h.caseId, {});
    await records.update(h.ctx.hr, h.caseId, 'EMP-001', { changes: { allowances: '400.00' }, note: 'Changed after report' });
    const bank = (await h.store.find('bank_transactions', { case_id: h.caseId }))[0];
    await h.store.update('bank_transactions', bank.id, { amount_cents: 1 });
    const built = await exportsService.buildPackage(h.ctx.director, h.caseId, { reportId: report.id });
    const entries = zip.listEntries(built.archive);
    const read = name => JSON.parse(entries.find(e => e.name === name).data.toString());
    assert.equal(read('records.json').find(r => r.employeeNo === 'EMP-001').allowances, '300.00');
    assert.deepEqual(read('records.json'), read('report.json').report.snapshot.records);
    assert.equal(read('payments.json').length, 8);
    assert.equal(read('bank-transactions.json').find(r => r.id === bank.id).amount_cents, bank.amount_cents);
    assert.equal(read('reconciliation.json').counts.matched, 8);
    assert.equal(read('payment-imports.json')[0].source_rows.length, 8);
    assert.equal(read('manifest.json').case.dataRevision, report.dataRevision);
  } finally { await h.close(); }
});

test('SQLite rolls back all entity writes and isolates an unrelated concurrent request', async () => {
  const store = await new SqliteStore({ filename: ':memory:' }).init();
  try {
    let entered, release;
    const ready = new Promise(r => { entered = r; });
    const gate = new Promise(r => { release = r; });
    const transaction = store.tx(async s => {
      await s.insert('counters', { id: 'rolled-back', value: 1 });
      entered(); await gate; throw new Error('rollback');
    });
    await ready;
    let finished = false;
    const outside = store.insert('counters', { id: 'outside', value: 2 }).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await assert.rejects(transaction, /rollback/);
    await outside;
    assert.equal(await store.get('counters', 'rolled-back'), null);
    assert.equal((await store.get('counters', 'outside')).value, 2);
    assert.deepEqual(await Promise.all([store.nextValue('sequence'), store.nextValue('sequence')]), [1, 2]);
  } finally { await store.close(); }
});

test('v2 CSV and Excel ledger/bank imports share the same normalization and reject foreign currencies', async () => {
  const h = await harness({ dataset: 'v2' });
  try {
    const payments = require('../server/services/payments.service');
    const reconciliation = require('../server/services/reconciliation.service');
    const csv = await ledger.paymentTable(h.store, h.caseId, { buffer: fixture('ledger-demo.csv') }, payments.HEADERS);
    const xlsx = await ledger.paymentTable(h.store, h.caseId, { buffer: fixture('ledger.xlsx') }, payments.HEADERS);
    assert.deepEqual(xlsx.rows, csv.rows);
    const bank = ledger.bankTable({ buffer: fixture('bank.xlsx') }, reconciliation.HEADERS);
    assert.deepEqual(bank.rows, ledger.bankTable({ buffer: fixture('bank-demo.csv') }, reconciliation.HEADERS).rows);
    assert.throws(() => ledger.bankTable({ text: fixture('bank-demo.csv').toString().replace('SGD','USD') }, reconciliation.HEADERS), /only SGD/);
  } finally { await h.close(); }
});
