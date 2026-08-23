// test-invoices-list-dedup.js — run:  node test-invoices-list-dedup.js
//
// Covers two bugs fixed together in invoices.html's list view:
//
//   1. paidMap was keyed by invoiceNumber ONLY. On a number shared by two different
//      customers (see DB._numberHasMultipleOwners in db.js), one customer's payment
//      showed as paid on BOTH rows — e.g. ทรัพย์มณี's ฿4,485.00 row on 180669-209 showed
//      paid=฿10,661.40 (that payment is ร้านอรวรรณ's), reading as fully settled when
//      ทรัพย์มณี had paid nothing. v1.0.198 fixed this class of bug via
//      DB.getInvoicePaidAmount(num, custId) everywhere EXCEPT here — invoices.html built
//      its own sum instead of going through that helper, so this one call site kept the
//      bug. Fix: key by invoiceNumber + '|' + customerId.
//
//   2. The `seen` map (one representative record per invoice number for the main row)
//      picked whichever record came first in array order. An invoice edit writes a new
//      page record and is supposed to explicitly delete the old one from Firestore —
//      that delete has occasionally failed to land (confirmed in production:
//      180769-001, 220769-007, 070869-001), leaving both. Array order then sometimes
//      showed the STALE pre-edit total, not the corrected one. Fix: prefer the higher
//      editCount when two records share the same customer AND page.
//
// Both fixes now live in db.js as DB.currentInvoiceRowMap() / DB.invoicePaidMap() +
// DB.paidForInvoice(), shared by invoices.html AND payments.html. They were previously
// inline in invoices.html only, which is exactly how payments.html kept showing pre-edit
// amounts for four releases after invoices.html was fixed (reported on 150869-004).
//
// Loads the REAL DB object out of db.js — not a reimplementation — and runs it against
// synthetic fixtures covering both bugs plus the cases that must NOT regress. The final
// section asserts both pages actually call the helpers, so the duplication can't return.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function loadDB(invoices, payments) {
  const src = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
  const start = src.indexOf('const DB = {');
  if (start < 0) throw new Error('DB literal not found — update extraction marker');
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const DB = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console',
    `return ${src.slice(src.indexOf('{', start), end)};`)(
    { uuid: () => 'x' }, {}, { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {} }, { log(){}, warn(){}, error(){} });
  DB.getInvoices = () => invoices;
  DB.getPayments = () => payments;
  return DB;
}

function run(invoices, payments) {
  const DB = loadDB(invoices, payments);
  const paidMap = DB.invoicePaidMap();
  return {
    seen: DB.currentInvoiceRowMap(invoices),
    paidFor: inv => DB.paidForInvoice(paidMap, inv),
  };
}

const CUST_A = 'A', CUST_B = 'B';
let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('paidFor(): cross-customer collision no longer leaks between rows');
{
  const invoices = [
    { id: 'i1', invoiceNumber: 'NUM-1', page: 1, customerId: CUST_A, totalAmount: 100 },
    { id: 'i2', invoiceNumber: 'NUM-1', page: 1, customerId: CUST_B, totalAmount: 50 },
  ];
  const payments = [{ invoiceNumber: 'NUM-1', customerId: CUST_A, amount: 100 }];
  const { paidFor } = run(invoices, payments);
  t('customer A shows their own payment', paidFor(invoices[0]) === 100);
  t('customer B shows NOTHING (the payment is not theirs)', paidFor(invoices[1]) === 0);
}

console.log('\npaidFor(): ordinary non-collided number is unaffected');
{
  const invoices = [{ id: 'i1', invoiceNumber: 'NUM-2', page: 1, customerId: CUST_A, totalAmount: 100 }];
  const payments = [{ invoiceNumber: 'NUM-2', customerId: CUST_A, amount: 60 }];
  const { paidFor } = run(invoices, payments);
  t('normal payment still resolves', paidFor(invoices[0]) === 60);
}

console.log('\nseen map: picks the higher editCount among same-customer, same-page duplicates');
{
  const invoices = [
    { id: 'old', invoiceNumber: 'NUM-3', page: 1, customerId: CUST_A, totalAmount: 900, editCount: 0 },
    { id: 'new', invoiceNumber: 'NUM-3', page: 1, customerId: CUST_A, totalAmount: 800, editCount: 1 },
  ];
  const { seen } = run(invoices, []);
  const rep = seen.get('NUM-3');
  t('picks the edited (higher editCount) record', rep.id === 'new', `picked ${rep.id}`);
  t('shows the corrected total', rep.totalAmount === 800);
}

console.log('\nseen map: old-record-first in array order must not win over a later edit');
{
  // Same fixture, OLD record appears first — this is the exact shape of the production
  // bug (array/sync order put the stale record first).
  const invoices = [
    { id: 'old', invoiceNumber: 'NUM-4', page: 1, customerId: CUST_A, totalAmount: 900, editCount: 0 },
    { id: 'new', invoiceNumber: 'NUM-4', page: 1, customerId: CUST_A, totalAmount: 800, editCount: 1 },
  ];
  const { seen } = run(invoices, []);
  t('still picks the edited record despite array order', seen.get('NUM-4').id === 'new');
}

console.log('\nseen map: a normal multi-page invoice (different page numbers) is unaffected');
{
  const invoices = [
    { id: 'p1', invoiceNumber: 'NUM-5', page: 1, customerId: CUST_A, totalAmount: 500, editCount: 0 },
    { id: 'p2', invoiceNumber: 'NUM-5', page: 2, customerId: CUST_A, totalAmount: 500, editCount: 0 },
    { id: 'p3', invoiceNumber: 'NUM-5', page: 3, customerId: CUST_A, totalAmount: 500, editCount: 0 },
  ];
  const { seen } = run(invoices, []);
  t('keeps the FIRST page seen (unchanged prior behaviour)', seen.get('NUM-5').id === 'p1');
}

console.log('\nseen map: two different customers on one number (collision) must NOT trigger the edit-pick logic');
{
  // Different customerId → the (cur.customerId === inv.customerId) guard must block this,
  // even if editCount happens to differ, or a collision could silently "correct itself"
  // by picking the wrong customer's invoice as if it were a newer edit.
  const invoices = [
    { id: 'a', invoiceNumber: 'NUM-6', page: 1, customerId: CUST_A, totalAmount: 100, editCount: 0 },
    { id: 'b', invoiceNumber: 'NUM-6', page: 1, customerId: CUST_B, totalAmount: 200, editCount: 5 },
  ];
  const { seen } = run(invoices, []);
  t('keeps the first customer\'s record (does not "correct" across customers)', seen.get('NUM-6').id === 'a');
}

console.log('\nseen map: equal editCount (plain re-import duplicate, no edit involved) — no change from prior behaviour');
{
  const invoices = [
    { id: 'x', invoiceNumber: 'NUM-7', page: 1, customerId: CUST_A, totalAmount: 700, editCount: 0 },
    { id: 'y', invoiceNumber: 'NUM-7', page: 1, customerId: CUST_A, totalAmount: 700, editCount: 0 },
  ];
  const { seen } = run(invoices, []);
  t('keeps array-first when editCount is tied (no signal to prefer either)', seen.get('NUM-7').id === 'x');
}

console.log('\npaidFor(): an overpayment already cut to another invoice stops counting in full');
{
  // payments.html summed raw p.amount, so an allocated-away overpayment still showed as
  // paid here — the same money counted on both the source and the target invoice.
  const invoices = [{ id: 'i1', invoiceNumber: 'NUM-8', page: 1, customerId: CUST_A, totalAmount: 500 }];
  const payments = [{ invoiceNumber: 'NUM-8', customerId: CUST_A, amount: 800, allocatedOut: 300 }];
  const { paidFor } = run(invoices, payments);
  t('counts 500 (800 − 300 allocated away), not 800', paidFor(invoices[0]) === 500, String(paidFor(invoices[0])));
}

console.log('\npaidFor(): cancelled payments and un-cleared cheques are excluded');
{
  const invoices = [{ id: 'i1', invoiceNumber: 'NUM-9', page: 1, customerId: CUST_A, totalAmount: 500 }];
  const payments = [
    { invoiceNumber: 'NUM-9', customerId: CUST_A, amount: 100 },
    { invoiceNumber: 'NUM-9', customerId: CUST_A, amount: 200, cancelled: true },
    { invoiceNumber: 'NUM-9', customerId: CUST_A, amount: 300, method: 'เช็ค', chequeCleared: false },
    { invoiceNumber: 'NUM-9', customerId: CUST_A, amount: 400, method: 'เช็ค', chequeCleared: true },
  ];
  const { paidFor } = run(invoices, payments);
  t('counts only the 100 cash + 400 cleared cheque', paidFor(invoices[0]) === 500, String(paidFor(invoices[0])));
}

console.log('\nBoth list pages actually call the shared helpers (guards against re-duplication)');
{
  const invSrc  = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
  const paySrc  = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
  t('invoices.html uses DB.currentInvoiceRowMap', invSrc.includes('DB.currentInvoiceRowMap('));
  t('payments.html uses DB.currentInvoiceRowMap', paySrc.includes('DB.currentInvoiceRowMap('));
  t('invoices.html uses DB.invoicePaidMap', invSrc.includes('DB.invoicePaidMap('));
  t('payments.html uses DB.invoicePaidMap', paySrc.includes('DB.invoicePaidMap('));
  // The exact shapes that caused the bug must not reappear on either page.
  t('payments.html no longer keys paid by invoiceNumber alone',
    !/paidMap\[p\.invoiceNumber\]/.test(paySrc));
  t('payments.html no longer has its own first-seen-wins seen map',
    !/if \(!seen\.has\(inv\.invoiceNumber\)\) seen\.set/.test(paySrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
