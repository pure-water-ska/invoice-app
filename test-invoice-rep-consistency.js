// test-invoice-rep-consistency.js — run:  node test-invoice-rep-consistency.js
//
// The user chose to KEEP stale pre-edit records as history rather than delete them (they
// exist because an edit's Firestore delete of the old page repeatedly fails to land —
// 180769-001, 220769-007, 070869-001, 150869-004). That only works if every money
// calculation resolves an invoice number to the SAME record regardless of array order.
//
// Before this fix two of them disagreed on identical data:
//   getCustomerBalance  used invs.find(page === 1)                → the FIRST record won
//   reports.html        used if (!cur || inv.page === 1)          → the LAST page-1 won
// so with a stale ฿12,500 record beside a corrected ฿9,800 one, the customer balance and
// the revenue report could each land on either amount and contradict each other, since
// array order follows sync/load order and isn't stable.
//
// Both now go through DB._isBetterInvoiceRep: prefer page 1, then the highest editCount,
// incumbent stays on a tie. Loads the REAL DB from db.js and applies the REAL reports rule
// extracted from reports.html.

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
  const DB = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console',
    `return ${dbSrc.slice(dbSrc.indexOf('{', start), end)};`)(
    { uuid: () => 'x' }, {}, { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {} }, { log(){}, warn(){}, error(){} });
  DB.getInvoices = () => invoices;
  DB.getPayments = () => payments || [];
  return DB;
}

// The REAL grouping rule out of reports.html, not a copy of it.
const repSrc = fs.readFileSync(path.join(DIR, 'reports.html'), 'utf8');
function reportsTotal(DB, invoices) {
  const line = repSrc.split('\n').find(l => l.includes('DB._isBetterInvoiceRep(invByNum[key], inv)'));
  if (!line) throw new Error('reports.html grouping rule not found — update extraction marker');
  const invByNum = {};
  const apply = new Function('DB', 'invByNum', 'inv', 'key', line.trim());
  for (const inv of invoices) apply(DB, invByNum, inv, inv.invoiceNumber + '|' + (inv.customerId || ''));
  return Object.values(invByNum).reduce((s, i) => s + (parseFloat(i.totalAmount) || 0), 0);
}

const STALE = { id: 'stale', invoiceNumber: '150869-004', page: 1, customerId: 'c1', totalAmount: 12500, editCount: 0 };
const FIXED = { id: 'fixed', invoiceNumber: '150869-004', page: 1, customerId: 'c1', totalAmount: 9800,  editCount: 1 };

console.log('_isBetterInvoiceRep() — the shared rule');
{
  const DB = loadDB([]);
  t('anything beats nothing', DB._isBetterInvoiceRep(null, STALE) === true);
  t('higher editCount wins', DB._isBetterInvoiceRep(STALE, FIXED) === true);
  t('lower editCount loses', DB._isBetterInvoiceRep(FIXED, STALE) === false);
  t('equal editCount keeps the incumbent (deterministic)',
    DB._isBetterInvoiceRep(STALE, { ...STALE, id: 'other' }) === false);
  t('page 1 beats page 2 regardless of order',
    DB._isBetterInvoiceRep({ page: 2, editCount: 9 }, { page: 1, editCount: 0 }) === true);
  t('page 2 never displaces page 1, even with a higher editCount',
    DB._isBetterInvoiceRep({ page: 1, editCount: 0 }, { page: 2, editCount: 9 }) === false);
}

console.log('\ngetCustomerBalance() — same answer whichever order the records load in');
{
  const a = loadDB([STALE, FIXED]).getCustomerBalance('c1').owed;
  const b = loadDB([FIXED, STALE]).getCustomerBalance('c1').owed;
  t('stale-first gives the CORRECTED total', Math.abs(a - 9800) < 0.005, String(a));
  t('fixed-first gives the same', Math.abs(b - 9800) < 0.005, String(b));
  t('order-independent', a === b);
}

console.log('\nreports grouping — same answer whichever order, and agrees with the balance');
{
  const DB = loadDB([]);
  const a = reportsTotal(DB, [STALE, FIXED]);
  const b = reportsTotal(DB, [FIXED, STALE]);
  t('stale-first reports the CORRECTED total', Math.abs(a - 9800) < 0.005, String(a));
  t('fixed-first reports the same', Math.abs(b - 9800) < 0.005, String(b));
  t('agrees with getCustomerBalance (they used to contradict each other)',
    Math.abs(a - loadDB([STALE, FIXED]).getCustomerBalance('c1').owed) < 0.005);
  t('the stale record is never double-counted', a < 12500 + 9800);
}

console.log('\nRegression: an ordinary multi-page invoice is unaffected');
{
  const p1 = { invoiceNumber: 'X', page: 1, customerId: 'c2', totalAmount: 500, editCount: 0 };
  const p2 = { invoiceNumber: 'X', page: 2, customerId: 'c2', totalAmount: 500, editCount: 0 };
  const p3 = { invoiceNumber: 'X', page: 3, customerId: 'c2', totalAmount: 500, editCount: 0 };
  // Every page carries the whole-invoice total, so the answer must be 500 — not 1500 —
  // even when the pages arrive out of order.
  t('page-1-first → 500', Math.abs(loadDB([p1, p2, p3]).getCustomerBalance('c2').owed - 500) < 0.005);
  t('page-3-first → still 500', Math.abs(loadDB([p3, p2, p1]).getCustomerBalance('c2').owed - 500) < 0.005);
  t('reports also 500, not 1500', Math.abs(reportsTotal(loadDB([]), [p3, p2, p1]) - 500) < 0.005,
    String(reportsTotal(loadDB([]), [p3, p2, p1])));
}

console.log('\nRegression: an invoice with NO page-1 record still resolves');
{
  // Deleting page 1 by hand leaves only page 2 — it must still represent the invoice
  // rather than dropping out of the balance entirely.
  const only2 = { invoiceNumber: 'Y', page: 2, customerId: 'c3', totalAmount: 700, editCount: 0 };
  t('falls back to the surviving page', Math.abs(loadDB([only2]).getCustomerBalance('c3').owed - 700) < 0.005);
}

console.log('\nRegression: a cross-customer collision keeps the two customers separate');
{
  const a = { invoiceNumber: 'Z', page: 1, customerId: 'cA', totalAmount: 9640, editCount: 0 };
  const b = { invoiceNumber: 'Z', page: 1, customerId: 'cB', totalAmount: 9112, editCount: 0 };
  t('customer A owes only their own amount',
    Math.abs(loadDB([a, b]).getCustomerBalance('cA').owed - 9640) < 0.005);
  t('customer B owes only their own amount',
    Math.abs(loadDB([a, b]).getCustomerBalance('cB').owed - 9112) < 0.005);
  t('reports counts BOTH (different customers, keyed separately)',
    Math.abs(reportsTotal(loadDB([]), [a, b]) - (9640 + 9112)) < 0.005);
}

console.log('\nKept stale record does not disturb payment matching');
{
  // The corrected invoice is ฿9,800 and ฿9,800 has been paid → settled. The stale ฿12,500
  // must not make it look like ฿2,700 is still owed.
  const pays = [{ invoiceNumber: '150869-004', customerId: 'c1', amount: 9800 }];
  const bal = loadDB([STALE, FIXED], pays).getCustomerBalance('c1');
  t('reads as fully settled', Math.abs(bal.owed) < 0.005 && Math.abs(bal.over) < 0.005,
    `owed=${bal.owed} over=${bal.over}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
