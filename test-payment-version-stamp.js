// test-payment-version-stamp.js — run:  node test-payment-version-stamp.js
//
// Covers DB.addPayment()'s invoiceEditCount stamp, DB.totalAtEditCount() and
// DB.explainInvoiceDiff() (db.js).
//
// Why: payments are recorded against an invoice NUMBER, so editing an invoice's total
// after it was paid leaves a non-zero balance that looks identical to a customer
// genuinely under/overpaying. These helpers let the UI tell the two apart. They are
// DESCRIPTIVE ONLY — getInvoicePaidAmount() still counts every payment regardless of
// version, because the money really did change hands. A regression that made this
// filter payments would silently erase real money from every balance in the app.
//
// The editHistory indexing is the subtle part: saveInvoiceEdit() APPENDS an entry whose
// `previous.totalAmount` is the total BEFORE that edit. So editHistory[i] holds the
// total AT version i, and the record itself holds the total at the latest version.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function loadDB() {
  return new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();
}

function withData(invoices, payments) {
  const DB = loadDB();
  global.window = {};
  DB._cache[DB.K.INVOICES] = invoices;
  DB._cache[DB.K.PAYMENTS] = payments || [];
  DB._set = function (k, v) { this._cache[k] = v; };
  return DB;
}

// An invoice edited twice: 1,000 → 1,200 → 1,500
const twiceEdited = (over = {}) => ({
  id: 'p1', invoiceNumber: 'INV-1', customerId: 'CUST-A', page: 1,
  totalAmount: 1500, editCount: 2,
  editHistory: [
    { at: '2026-01-01T00:00:00Z', previous: { totalAmount: 1000 } },
    { at: '2026-02-01T00:00:00Z', previous: { totalAmount: 1200 } },
  ],
  ...over,
});

let pass = 0, fail = 0;
const t = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
};

console.log('totalAtEditCount — editHistory[i] is the total AT version i');
{
  const DB = withData([twiceEdited()]);
  const inv = twiceEdited();
  t('version 0 → original total', DB.totalAtEditCount(inv, 0) === 1000, String(DB.totalAtEditCount(inv, 0)));
  t('version 1 → middle total',   DB.totalAtEditCount(inv, 1) === 1200, String(DB.totalAtEditCount(inv, 1)));
  t('version 2 → current total',  DB.totalAtEditCount(inv, 2) === 1500, String(DB.totalAtEditCount(inv, 2)));
  t('version past the end falls back to current', DB.totalAtEditCount(inv, 9) === 1500);
  t('never-edited invoice → its own total',
    DB.totalAtEditCount({ totalAmount: 800, editCount: 0 }, 0) === 800);
  t('null invoice → 0', DB.totalAtEditCount(null, 0) === 0);
}

console.log('\nexplainInvoiceDiff — paid in full against the version it was billed at');
{
  // Paid 1,000 against version 0, then the invoice was edited up to 1,500.
  const DB = withData([twiceEdited()], [
    { id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 1000, invoiceEditCount: 0 },
  ]);
  const e = DB.explainInvoiceDiff('INV-1', 'CUST-A');
  t('returns an explanation', !!e);
  t('editCaused true — payment exactly settled version 0', e && e.editCaused === true);
  t('oldTotal is version 0', e && e.oldTotal === 1000, e && String(e.oldTotal));
  t('currentTotal is the latest', e && e.currentTotal === 1500, e && String(e.currentTotal));
  t('diff is the edit delta', e && Math.abs(e.diff - 500) < 0.005, e && String(e.diff));
  t('paidVersion is 0', e && e.paidVersion === 0);
  t('money math is UNTOUCHED — paid still counts in full',
    DB.getInvoicePaidAmount('INV-1', 'CUST-A') === 1000);
}

console.log('\nexplainInvoiceDiff — cases that must return null (a genuine balance)');
{
  const never = { id: 'p1', invoiceNumber: 'INV-2', customerId: 'CUST-A', page: 1, totalAmount: 1000, editCount: 0 };
  let DB = withData([never], [{ id: 'y1', invoiceNumber: 'INV-2', customerId: 'CUST-A', amount: 600, invoiceEditCount: 0 }]);
  t('never edited → null (customer really underpaid)', DB.explainInvoiceDiff('INV-2', 'CUST-A') === null);

  DB = withData([twiceEdited()], [{ id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 1500, invoiceEditCount: 0 }]);
  t('balance settled → null', DB.explainInvoiceDiff('INV-1', 'CUST-A') === null);

  DB = withData([twiceEdited()], []);
  t('nothing paid at all → null', DB.explainInvoiceDiff('INV-1', 'CUST-A') === null);

  // Edited, but the total landed back where it started — nothing to explain.
  const roundTrip = twiceEdited({
    totalAmount: 1000,
    editHistory: [{ at: 'x', previous: { totalAmount: 1000 } }, { at: 'y', previous: { totalAmount: 1200 } }],
  });
  DB = withData([roundTrip], [{ id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 400, invoiceEditCount: 0 }]);
  t('total unchanged across edits → null', DB.explainInvoiceDiff('INV-1', 'CUST-A') === null);

  DB = withData([twiceEdited()], [
    { id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 1000, invoiceEditCount: 0, cancelled: true },
  ]);
  t('only a cancelled payment → null', DB.explainInvoiceDiff('INV-1', 'CUST-A') === null);
}

console.log('\nexplainInvoiceDiff — partly explained (edit AND a real shortfall)');
{
  // Only 900 paid against version 0's total of 1,000 — short by 100 even then.
  const DB = withData([twiceEdited()], [
    { id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 900, invoiceEditCount: 0 },
  ]);
  const e = DB.explainInvoiceDiff('INV-1', 'CUST-A');
  t('returns an explanation', !!e);
  t('editCaused false — a genuine shortfall existed at version 0', e && e.editCaused === false);
  t('full diff is still reported', e && Math.abs(e.diff - 600) < 0.005, e && String(e.diff));
}

console.log('\nunstamped (pre-feature) payments read as version 0');
{
  const DB = withData([twiceEdited()], [
    { id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 1000 },   // no invoiceEditCount
  ]);
  const e = DB.explainInvoiceDiff('INV-1', 'CUST-A');
  t('treated as the original version', e && e.paidVersion === 0);
  t('and compared against the original total', e && e.oldTotal === 1000);
}

console.log('\naddPayment stamps the invoice\'s current editCount');
{
  const DB = withData([twiceEdited()], []);
  DB.addPayment({ id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 50 });
  t('stamped with the live editCount (2)', DB.getPayments()[0].invoiceEditCount === 2,
    String(DB.getPayments()[0].invoiceEditCount));

  DB.addPayment({ id: 'y2', invoiceNumber: 'INV-1', customerId: 'CUST-A', amount: 10, invoiceEditCount: 1 });
  t('an explicit value is preserved', DB.getPayments()[0].invoiceEditCount === 1);

  DB.addPayment({ id: 'y3', invoiceNumber: 'NOPE', customerId: 'CUST-A', amount: 10 });
  t('unknown invoice number → left unstamped, no crash',
    DB.getPayments()[0].invoiceEditCount === undefined);

  const before = DB.getPayments().length;
  DB.addPayment({ id: 'y4', amount: 10 });
  t('payment with no invoiceNumber still saves', DB.getPayments().length === before + 1);
}

console.log('\nstamp picks the right customer on a collided invoice number');
{
  const a = twiceEdited();
  const b = { id: 'p2', invoiceNumber: 'INV-1', customerId: 'CUST-B', page: 1, totalAmount: 700, editCount: 0 };
  const DB = withData([a, b], []);
  DB.addPayment({ id: 'y1', invoiceNumber: 'INV-1', customerId: 'CUST-B', amount: 700 });
  t('uses CUST-B\'s editCount (0), not CUST-A\'s (2)', DB.getPayments()[0].invoiceEditCount === 0,
    String(DB.getPayments()[0].invoiceEditCount));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
