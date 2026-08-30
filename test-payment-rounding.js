// test-payment-rounding.js — run:  node test-payment-rounding.js
//
// User request: a way to clear the penny remainders customers never pay, "without record
// as income". Their data is full of them, and they had been (mis)using the carry-forward
// feature to shuffle ฿0.05–฿1.20 crumbs between invoices.
//
// The two directions are deliberately ASYMMETRIC, because the money differs:
//   down (ตัดเศษ)  — the shortfall was NEVER received. Forgiving it settles the invoice
//                    but must NOT create income → DB.writeOffRemainder writes a non-cash
//                    payment excluded from every revenue figure.
//   up   (ปัดขึ้น) — the excess WAS received and is already a real payment, so it stays
//                    income. DB.roundUpInvoice writes NO payment; the invoice total rises
//                    to meet what was actually paid.
//
// Also covers the gap this exposed: `carryForward` appeared only in db.js and
// invoice-create.html, so nothing in reports excluded it — every non-cash carry-forward
// was silently counted as revenue. isNonCashPayment/getInvoiceCashReceived fix both kinds.
//
// Loads the REAL DB from db.js.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

const dbSrc = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
function loadDB(invoices, payments) {
  const start = dbSrc.indexOf('const DB = {');
  let depth = 0, i = dbSrc.indexOf('{', start), end = -1;
  for (; i < dbSrc.length; i++) {
    if (dbSrc[i] === '{') depth++;
    else if (dbSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  let seq = 0;
  const DB = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console',
    `return ${dbSrc.slice(dbSrc.indexOf('{', start), end)};`)(
    { uuid: () => 'gen-' + (++seq) }, {}, { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {} }, { log(){}, warn(){}, error(){} });
  const store = { wt_invoices: invoices, wt_payments: payments };
  DB._get = k => store[k] || [];
  DB._set = (k, v) => { store[k] = v; };
  DB.K = Object.assign({}, DB.K, { INVOICES: 'wt_invoices', PAYMENTS: 'wt_payments' });
  return DB;
}
const inv = (o = {}) => Object.assign({ id: 'i1', invoiceNumber: 'A-1', page: 1, customerId: 'c1',
  totalAmount: 100, createdAt: '2026-08-01', editCount: 0 }, o);
let pseq = 0;
const pay = (o = {}) => Object.assign({ id: 'p' + (++pseq), invoiceNumber: 'A-1',
  customerId: 'c1', method: 'โอน', amount: 0 }, o);

console.log('isNonCashPayment — both kinds recognised');
{
  const DB = loadDB([], []);
  t('write-off is non-cash', DB.isNonCashPayment({ writeOff: true }) === true);
  t('carry-forward is non-cash', DB.isNonCashPayment({ carryForward: true }) === true);
  t('an ordinary payment is not', DB.isNonCashPayment({ amount: 500 }) === false);
  t('isWriteOffPayment is specific to write-offs',
    DB.isWriteOffPayment({ writeOff: true }) === true && DB.isWriteOffPayment({ carryForward: true }) === false);
}

console.log('\nwriteOffRemainder — settles the invoice but is NOT income');
{
  const DB = loadDB([inv()], [pay({ amount: 99.55 })]);
  t('starts ฿0.45 short', Math.abs(DB.getInvoicePaidAmount('A-1', 'c1') - 99.55) < 0.005);
  const w = DB.writeOffRemainder('A-1', 'c1', 0.45, { by: 'Joe', byUser: 'joe', reason: 'เศษสตางค์' });
  t('a payment record is created', !!w && w.writeOff === true);
  t('tagged with the reason', w.writeOffReason === 'เศษสตางค์');
  t('SETTLES the invoice — paid now equals the total',
    Math.abs(DB.getInvoicePaidAmount('A-1', 'c1') - 100) < 0.005, String(DB.getInvoicePaidAmount('A-1','c1')));
  t('but cash received stays 99.55 — the 0.45 is NOT income',
    Math.abs(DB.getInvoiceCashReceived('A-1', 'c1') - 99.55) < 0.005, String(DB.getInvoiceCashReceived('A-1','c1')));
  t('customer balance reads settled', Math.abs(DB.getCustomerBalance('c1').owed) < 0.005);
  t('refuses a zero amount', DB.writeOffRemainder('A-1', 'c1', 0) === null);
}

console.log('\nroundUpInvoice — keeps the money as income, writes NO payment');
{
  const DB = loadDB([inv()], [pay({ amount: 100.45 })]);
  t('starts 0.45 over', Math.abs(DB.getInvoicePaidAmount('A-1', 'c1') - 100.45) < 0.005);
  const before = DB.getPayments().length;
  DB.roundUpInvoice('A-1', 'c1', 0.45, { by: 'Joe', byUser: 'joe', reason: 'ปัดขึ้น' });
  t('no payment record was added', DB.getPayments().length === before, String(DB.getPayments().length));
  const i2 = DB.getInvoices()[0];
  t('invoice total rose to 100.45', Math.abs(i2.totalAmount - 100.45) < 0.005, String(i2.totalAmount));
  t('adjustment recorded for audit', Math.abs(i2.roundUpAdjust - 0.45) < 0.005 && i2.roundUpBy === 'joe');
  t('balance now closes',
    Math.abs(DB.getCustomerBalance('c1').over) < 0.005 && Math.abs(DB.getCustomerBalance('c1').owed) < 0.005);
  t('the 100.45 REMAINS income — cash received unchanged',
    Math.abs(DB.getInvoiceCashReceived('A-1', 'c1') - 100.45) < 0.005, String(DB.getInvoiceCashReceived('A-1','c1')));
}

console.log('\nroundUpInvoice — every page of a multi-page invoice is updated');
{
  // Each page carries the same whole-invoice total, so updating only page 1 would leave
  // the pages disagreeing about what the invoice is worth.
  const DB = loadDB([inv({ id: 'a', page: 1 }), inv({ id: 'b', page: 2 })], [pay({ amount: 100.5 })]);
  DB.roundUpInvoice('A-1', 'c1', 0.5, { by: 'Joe', byUser: 'joe' });
  const totals = DB.getInvoices().map(i => i.totalAmount);
  t('both pages now read 100.50', totals.every(x => Math.abs(x - 100.5) < 0.005), JSON.stringify(totals));
}

console.log('\nroundUpInvoice — a stale duplicate page is left alone');
{
  // A failed-delete leftover (lower editCount) must not be adjusted; only current pages.
  const DB = loadDB([inv({ id: 'stale', editCount: 0, totalAmount: 100 }),
                     inv({ id: 'live',  editCount: 1, totalAmount: 100 })], [pay({ amount: 100.4 })]);
  DB.roundUpInvoice('A-1', 'c1', 0.4, { by: 'Joe', byUser: 'joe' });
  const byId = Object.fromEntries(DB.getInvoices().map(i => [i.id, i.totalAmount]));
  t('the current page was adjusted', Math.abs(byId.live - 100.4) < 0.005, String(byId.live));
  t('the stale page was untouched', Math.abs(byId.stale - 100) < 0.005, String(byId.stale));
}

console.log('\ngetInvoiceCashReceived — the income/settlement split, all combinations');
{
  const DB = loadDB([inv({ totalAmount: 1000 })], [
    pay({ amount: 600 }),                                       // real money
    pay({ amount: 200, carryForward: true }),                   // non-cash (pre-existing kind)
    pay({ amount: 150, writeOff: true }),                       // non-cash (new kind)
    pay({ amount: 300, cancelled: true }),                      // cancelled
    pay({ amount: 400, method: 'เช็ค', chequeCleared: false }), // un-cleared cheque
  ]);
  t('settlement counts cash + both non-cash kinds = 950',
    Math.abs(DB.getInvoicePaidAmount('A-1', 'c1') - 950) < 0.005, String(DB.getInvoicePaidAmount('A-1','c1')));
  t('income counts ONLY the 600 of real money',
    Math.abs(DB.getInvoiceCashReceived('A-1', 'c1') - 600) < 0.005, String(DB.getInvoiceCashReceived('A-1','c1')));
}

console.log('\ngetInvoiceCashReceived — allocated-away overpayment still deducted');
{
  const DB = loadDB([inv({ totalAmount: 500 })], [pay({ amount: 800, allocatedOut: 300 })]);
  t('income is the effective 500, not the raw 800',
    Math.abs(DB.getInvoiceCashReceived('A-1', 'c1') - 500) < 0.005, String(DB.getInvoiceCashReceived('A-1','c1')));
}

console.log('\nReports use the income figure, not the settlement figure');
{
  const src = fs.readFileSync(path.join(DIR, 'reports.html'), 'utf8');
  t('headline total uses getInvoiceCashReceived',
    /totalPaid\s*\+=\s*DB\.getInvoiceCashReceived/.test(src));
  t('per-group total uses getInvoiceCashReceived',
    /map\[k\]\.paid\s*\+=\s*DB\.getInvoiceCashReceived/.test(src));
  t('payment-method report excludes non-cash entries', src.includes('DB.isNonCashPayment(p)'));
  // The drill-down detail view is INVOICE-status oriented: its per-row badges ask "is this
  // invoice closed?", so its summary keeps settlement or the two would contradict. Instead
  // the non-cash portion is broken out, so it is never presented as money received.
  t('detail view still totals settlement (matches its per-row badges)',
    /totalPaid \+= DB\.getInvoicePaidAmount/.test(src));
  t('detail view also tracks cash separately', /totalCash \+= DB\.getInvoiceCashReceived/.test(src));
  t('detail view breaks out the non-cash portion', /const nonCash = totalPaid-totalCash/.test(src));
  t('non-cash badge only shows when there is some', /nonCash>0\.005 \?/.test(src));
}

console.log('\nDashboard is settlement-only, so must be UNCHANGED');
{
  const src = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');
  t('still uses getInvoicePaidAmount for status/remaining, not the income figure',
    src.includes('getInvoicePaidAmount') && !src.includes('getInvoiceCashReceived'));
}

console.log('\nUI wiring');
{
  const src = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
  // Rounding is for an invoice that HAS been paid but doesn't match — partial or over.
  // `total - paid > 0.005` alone is also true of a WHOLLY UNPAID invoice, so the first
  // cut offered to write off a ฿28,477 pending bill in full. With no threshold cap that
  // is the worst thing the button could do, hence the paid > 0 requirement.
  t('round-down requires money actually paid, not just a shortfall',
    /paid > 0\.005 && \(total - paid\) > 0\.005/.test(src));
  t('round-up button appears only when over-paid', /\(paid - total\) > 0\.005/.test(src));
  t('the modal re-checks it too (defense in depth)',
    /dir === 'down' && !\(paid > 0\.005\)/.test(src));
  t('permission gated on payment_edit', src.includes("Auth.can('payment_edit')"));
  t('confirm button disabled on click (no double-round)', src.includes('btn.disabled = true;   // re-entrancy'));
  t('write-off path calls the DB helper', src.includes('DB.writeOffRemainder('));
  t('round-up path calls the DB helper', src.includes('DB.roundUpInvoice('));
  t('both actions are logged', src.includes('ตัดเศษใบกำกับ') && src.includes('ปัดขึ้นใบกำกับ'));
  t('a cancelled invoice is refused', src.includes('ใบกำกับนี้ถูกยกเลิกแล้ว'));
  t('failures are recorded, not swallowed', src.includes("'ROUND-FAILED'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
