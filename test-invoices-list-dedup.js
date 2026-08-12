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
// Extracts the ACTUAL code from invoices.html — not a reimplementation — and runs it
// against synthetic fixtures covering both bugs plus the cases that must NOT regress.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
const paidBlockStart = src.indexOf('  const paidMap = {};');
const paidBlockEnd   = src.indexOf('for (const inv of allInvoices) pageCountMap');
const seenBlockStart = src.indexOf('  const seen = new Map();');
const seenBlockEnd   = src.indexOf('  let list = [...seen.values()];');
if (paidBlockStart < 0 || seenBlockStart < 0) throw new Error('invoices.html structure changed — update this test\'s extraction markers');
const paidBlock = src.slice(paidBlockStart, paidBlockEnd);
const seenBlock = src.slice(seenBlockStart, seenBlockEnd);

// Minimal DB stub: only what the extracted blocks call.
function run(invoices, payments) {
  const DB = {
    getInvoices: () => invoices,
    getPayments: () => payments,
    isChequePending: p => p.method === 'เช็ค' && p.chequeCleared === false,
    effectivePaymentAmount: p => Math.max(0, (parseFloat(p.amount) || 0) - (parseFloat(p.allocatedOut) || 0)),
  };
  const fn = new Function('DB', `
    const allInvoices = DB.getInvoices();
    ${paidBlock}
    ${seenBlock}
    return { paidFor, seen };
  `);
  return fn(DB);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
