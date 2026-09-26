/* Monetary arithmetic. Every amount is carried as an integer number of cents
 * (SGD minor units). The parser is the one already proven by the browser core so
 * server and client agree on validation and totals to the cent. */
'use strict';
const core = require('../../dist/demo/core.js');
const { badRequest } = require('./errors');

/** Decimal string -> integer cents. Throws on anything outside the accepted grammar. */
function toCents(value, label = 'Amount') {
  try { return core.cents(value); } catch (error) { throw badRequest(`${label}: ${error.message}`); }
}

/** Integer cents -> canonical two-decimal string. */
function toAmount(cents) {
  if (!Number.isSafeInteger(cents)) throw badRequest('Amounts must be exact integer cents');
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const sum = list => list.reduce((total, n) => {
  if (!Number.isSafeInteger(n)) throw badRequest('Amounts must be exact integer cents');
  return total + n;
}, 0);

/** gross = base + allowances; expected net = gross - deductions. No statutory inference. */
const gross = row => row.base_pay_cents + row.allowances_cents;
const expectedNet = row => gross(row) - row.deductions_cents;

function totals(rows) {
  return rows.reduce((t, r) => ({
    gross: t.gross + gross(r),
    deductions: t.deductions + r.deductions_cents,
    expected: t.expected + expectedNet(r),
    paid: t.paid + r.net_paid_cents
  }), { gross: 0, deductions: 0, expected: 0, paid: 0 });
}

module.exports = { toCents, toAmount, sum, gross, expectedNet, totals };
