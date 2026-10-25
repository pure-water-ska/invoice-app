// test-paid-epsilon.js — v1.0.252
//
// Reported: customer หจก.อารีย์ทรัพย์มั่นคง still showed invoice 080969-005 as unpaid
// after it was paid in full. Measured on live data:
//
//   stored totalAmount : 11426.740000000002   (8057.14 + 16*156*1.35, summed in floats)
//   payment recorded   : 11426.74             (the DISPLAYED figure)
//   gap                : 1.8e-12 baht
//
// `paid < total` is true by that gap, so the invoice was unpaid forever. 17 fully
// settled invoice numbers were in this state across the dataset, gaps 2e-13 … 1.2e-10.
// reports.html even printed a red "ค้าง ฿0.00" badge, and customers.html disagreed with
// itself — the card COUNT used a bare `<` while the chips under it used `rem > 0.01`.
//
// The money paths (getCustomerBalance, payments.html, dashboard) already compared
// against 0.005. The fix is one pair of helpers every screen asks instead of each site
// inventing its own tolerance. This suite drives the REAL db.js.
//
// Run: node test-paid-epsilon.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

// ── load the real db.js ────────────────────────────────────────────────────
// Same loader the other suites use. `DB` is a top-level const and never lands on
// `window`, so it has to be returned explicitly — see the window.DB gotcha in CLAUDE.md.
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.LZString = { compressToUTF16: s => s, decompressFromUTF16: s => s };
global.document = { addEventListener() {}, getElementById: () => null };
global.navigator = { onLine: true };
global.Utils = { uuid: (() => { let n = 0; return () => 'uuid-' + (++n); })() };

const DB = new Function(fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8') + '\n;return DB;')();
DB._set = function (k, v) { this._cache[k] = v; };

const seed = (invoices, payments) => {
  DB._cache[DB.K.INVOICES] = invoices;
  DB._cache[DB.K.PAYMENTS] = payments;
  DB._cache[DB.K.CUSTOMERS] = [];
};
const inv = (o) => Object.assign({
  id: 'i' + Math.random().toString(36).slice(2), invoiceNumber: 'A-1', customerId: 'C1',
  page: 1, totalAmount: 100, editCount: 0, cancelled: false, createdAt: '2026-09-08T00:00:00.000Z',
}, o);
const pay = (o) => Object.assign({
  id: 'p' + Math.random().toString(36).slice(2), invoiceNumber: 'A-1', customerId: 'C1',
  amount: 100, method: 'โอน', cancelled: false,
}, o);

section('the exact live case: 080969-005');
{
  // Reproduced from the real record, not an invented number.
  const total = 8057.14 + (16 * 156 * 1.35);
  seed([inv({ invoiceNumber: '080969-005', totalAmount: total })],
       [pay({ invoiceNumber: '080969-005', amount: 11426.74 })]);

  t('the float residue is real, not a typo in this test',
    total !== 11426.74 && total.toFixed(2) === '11426.74', total);
  t('a bare `paid < total` calls it unpaid — the reported bug',
    11426.74 < total);
  t('DB.isInvoiceUnpaid says it is settled', DB.isInvoiceUnpaid('080969-005', 'C1') === false);
  t('…and the remainder rounds to zero satang',
    Math.abs(DB.invoiceDue('080969-005', 'C1')) < 0.005, DB.invoiceDue('080969-005', 'C1'));
}

section('a real debt is still a debt');
{
  seed([inv({ invoiceNumber: 'B-1', totalAmount: 9278.40 })], []);
  t('nothing paid → unpaid', DB.isInvoiceUnpaid('B-1', 'C1') === true);
  t('…and the full amount is due', DB.invoiceDue('B-1', 'C1') === 9278.40);

  // One satang is the smallest real debt. The tolerance must sit BELOW it, or the app
  // would start forgiving money that is genuinely owed.
  seed([inv({ invoiceNumber: 'B-2', totalAmount: 100 })], [pay({ invoiceNumber: 'B-2', amount: 99.99 })]);
  t('a one-satang shortfall is still unpaid', DB.isInvoiceUnpaid('B-2', 'C1') === true);
  t('_PAID_EPS is below one satang', DB._PAID_EPS < 0.01, DB._PAID_EPS);
  t('…and far above float noise at invoice magnitudes', DB._PAID_EPS > 1e-6);

  seed([inv({ invoiceNumber: 'B-3', totalAmount: 100 })], [pay({ invoiceNumber: 'B-3', amount: 40 })]);
  t('a part payment leaves the rest due', DB.invoiceDue('B-3', 'C1') === 60);
}

section('overpayment is not "unpaid"');
{
  seed([inv({ invoiceNumber: 'D-1', totalAmount: 100 })], [pay({ invoiceNumber: 'D-1', amount: 150 })]);
  t('an overpaid invoice is not listed as unpaid', DB.isInvoiceUnpaid('D-1', 'C1') === false);
  t('…and its due is negative, so callers can tell credit from settled',
    DB.invoiceDue('D-1', 'C1') === -50);
}

section('it picks the right record for the number');
{
  // A failed post-edit delete leaves two live page-1 records. find(page===1) returns
  // whichever sync loaded first — possibly the STALE pre-edit total.
  seed([
    inv({ id: 'stale', invoiceNumber: 'E-1', totalAmount: 950, editCount: 0 }),
    inv({ id: 'fresh', invoiceNumber: 'E-1', totalAmount: 500, editCount: 1 }),
  ], [pay({ invoiceNumber: 'E-1', amount: 500 })]);
  t('the edited total wins, so a settled invoice is not shown owing',
    DB.isInvoiceUnpaid('E-1', 'C1') === false, DB.invoiceDue('E-1', 'C1'));

  // Cancelled invoices are excluded everywhere money is summed.
  seed([inv({ invoiceNumber: 'E-2', totalAmount: 400, cancelled: true })], []);
  t('a cancelled invoice is never unpaid', DB.isInvoiceUnpaid('E-2', 'C1') === false);

  seed([
    inv({ invoiceNumber: 'E-3', customerId: 'C1', totalAmount: 100 }),
    inv({ invoiceNumber: 'E-3', customerId: 'C2', totalAmount: 700 }),
  ], [pay({ invoiceNumber: 'E-3', customerId: 'C1', amount: 100 })]);
  t('a number shared by two customers is judged per customer',
    DB.isInvoiceUnpaid('E-3', 'C1') === false && DB.isInvoiceUnpaid('E-3', 'C2') === true);

  seed([], []);
  t('an unknown invoice number is not reported as unpaid', DB.isInvoiceUnpaid('NOPE', 'C1') === false);
  t('…and its due is 0, not NaN', DB.invoiceDue('NOPE', 'C1') === 0);
}

section('every screen now asks the same question');
{
  const files = {
    'customers.html': fs.readFileSync(path.join(__dirname, 'customers.html'), 'utf8'),
    'nav.js': fs.readFileSync(path.join(__dirname, 'nav.js'), 'utf8'),
    'invoice-create.html': fs.readFileSync(path.join(__dirname, 'invoice-create.html'), 'utf8'),
    'reports.html': fs.readFileSync(path.join(__dirname, 'reports.html'), 'utf8'),
    'excel-import.html': fs.readFileSync(path.join(__dirname, 'excel-import.html'), 'utf8'),
    'payments.html': fs.readFileSync(path.join(__dirname, 'payments.html'), 'utf8'),
  };
  // The bug was a comparison with no tolerance. Any new one is the same bug again.
  const BARE = /getInvoicePaidAmount\([^;]*?\)\s*<\s*\(?parseFloat/;
  Object.entries(files).forEach(([name, src]) => {
    t(name + ' has no bare paid<total comparison left', !BARE.test(src));
  });
  t('customers.html uses the helper', /DB\.isInvoiceUnpaid\(/.test(files['customers.html']));
  t('nav.js uses the helper', /DB\.isInvoiceUnpaid\(/.test(files['nav.js']));
  t('invoice-create.html uses the helper', /DB\.isInvoiceUnpaid\(/.test(files['invoice-create.html']));
  t('excel-import.html uses the helper', /DB\.isInvoiceUnpaid\(/.test(files['excel-import.html']));
  t('reports.html compares its badge against _PAID_EPS',
    /u <= DB\._PAID_EPS/.test(files['reports.html']));
  t('the customer card COUNT and its chip list use one rule',
    /uniqNums\.filter\(num => DB\.isInvoiceUnpaid\(num, c\.id\)\)/.test(files['customers.html']) &&
    /rem > DB\._PAID_EPS \? \{ num, rem \}/.test(files['customers.html']));
  t('the printed statement drops settled invoices',
    /rem > DB\._PAID_EPS\n/.test(files['customers.html']) || /rem > DB\._PAID_EPS$/m.test(files['customers.html']));
  t('payments.html no longer paints a red ฿0.00',
    /rem > DB\._PAID_EPS \? 'text-danger'/.test(files['payments.html']));
}

section('the residue is no longer written down (v1.0.252 part 2)');
{
  // The tolerance above makes every READER safe. This stops the bad value being STORED,
  // so the gap stops being created at all.
  const utilsSrc = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const U = {};
  new Function('Utils', utilsSrc.slice(utilsSrc.indexOf('Utils.round2'), utilsSrc.indexOf('// Usage:')))(U);

  t('Utils.round2 kills the line-total residue', U.round2(16 * 156 * 1.35) === 3369.6,
    16 * 156 * 1.35);
  t('…and the sum residue — the exact 080969-005 total',
    U.round2(8057.14 + 16 * 156 * 1.35) === 11426.74);
  // Return lines are stored as NEGATIVE totals, and Math.round(-0.5) is -0.
  t('a negative (return) line rounds as the mirror of its magnitude',
    U.round2(-3369.6000000000004) === -3369.6 && U.round2(-1.005) === -U.round2(1.005));
  t('a half-satang rounds up, not down to the float below it', U.round2(1.005) === 1.01);
  t('garbage in gives 0, never NaN into a money field',
    U.round2(NaN) === 0 && U.round2(Infinity) === 0 && U.round2(undefined) === 0);
  t('a numeric string is accepted', U.round2('12.345') === 12.35);
  t('an already-round value is untouched', U.round2(9278.40) === 9278.40);

  const ic = fs.readFileSync(path.join(__dirname, 'invoice-create.html'), 'utf8');
  t('calcTotal rounds each line', /return Utils\.round2\(\(qty \* unitSize \+ rem\) \* price\);/.test(ic));
  // Summing exact 2-decimal values in floats can reintroduce a residue, so the SUM is
  // rounded too — rounding only the lines would not have fixed 080969-005.
  const sums = (ic.match(/Utils\.round2\(activeItems\.reduce\(\(s, item\) => s \+ calcTotal\(item\), 0\)\)/g) || []).length;
  t('all three totalAmount sites round the sum (preview, save, edit)', sums === 3, sums);
  t('no unrounded sum survives',
    !/const totalAmount = activeItems\.reduce/.test(ic));

  // End to end: the stored total now equals what the payment would be recorded as.
  const stored = U.round2(U.round2(8057.14) + U.round2(16 * 156 * 1.35));
  seed([inv({ invoiceNumber: 'G-1', totalAmount: stored })],
       [pay({ invoiceNumber: 'G-1', amount: 11426.74 })]);
  t('a NEW invoice settles exactly, with no tolerance needed',
    stored === 11426.74 && DB.invoiceDue('G-1', 'C1') === 0);
}

section('the helpers agree with getCustomerBalance');
{
  // These two must never contradict each other — that disagreement is what the user saw.
  const total = 8057.14 + (16 * 156 * 1.35);
  seed([
    inv({ invoiceNumber: 'F-1', totalAmount: total }),
    inv({ invoiceNumber: 'F-2', totalAmount: 9278.40 }),
  ], [pay({ invoiceNumber: 'F-1', amount: 11426.74 })]);
  const bal = DB.getCustomerBalance('C1');
  const unpaid = ['F-1', 'F-2'].filter(n => DB.isInvoiceUnpaid(n, 'C1'));
  t('getCustomerBalance counts one outstanding invoice', bal.owedCount === 1, bal);
  t('…and the helper names that same one', unpaid.length === 1 && unpaid[0] === 'F-2', unpaid);
  t('…with the same amount', Math.abs(bal.owed - DB.invoiceDue('F-2', 'C1')) < 0.005);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
