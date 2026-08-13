// test-carry-forward-owed.js — run:  node test-carry-forward-owed.js
//
// Covers DB.carryForwardOwedBalance() / DB.isCarryForwardPayment() in db.js — the mirror
// of the existing allocateOverpayCredit() mechanism, but for the OWED side.
//
// Why this exists: invoice-create.html's "เพิ่มที่เลือกลงใบใหม่" balance-bar button lets
// staff fold an old invoice's balance into a NEW invoice's total as a memo line. For an
// OVERPAID balance this already worked correctly — allocateOverpayCredit() moves the
// existing credit off the source invoice's payment so it stops recurring. For an OWED
// balance there was no equivalent: the memo line bills the customer again on the new
// invoice, but the OLD invoice just sat unpaid forever, with two real risks — (1) it
// permanently inflates every balance figure (dashboard, reports, customer balance card)
// even though the debt has been rebilled elsewhere, and (2) if someone later pays the old
// invoice directly too, the customer is charged twice for the same debt.
//
// The fix creates a payment record with NO real money behind it — carryForward:true,
// method 'ยกยอดไปใบใหม่' — against the OLD invoice. DB.getInvoicePaidAmount() counts it
// like any other payment (that's the point: it retires the old invoice's own balance),
// while being clearly distinguishable everywhere a payment method is shown (print,
// history, the per-method breakdown in reports.html, which groups payments by method
// dynamically — a carry-forward gets its own bucket, never polluting real เงินสด/โอน
// totals).
//
// Loads the real db.js and drives it with synthetic fixtures — no reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.LZString = { compressToUTF16: s => s, decompressFromUTF16: s => s };
global.document = { addEventListener() {}, getElementById: () => null };
global.navigator = { onLine: true };
global.Utils = { uuid: (() => { let n = 0; return () => 'uuid-' + (++n); })() };

function freshDB(invoices, payments, customers) {
  const DB = new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();
  DB._cache[DB.K.INVOICES] = invoices;
  DB._cache[DB.K.PAYMENTS] = payments;
  DB._cache[DB.K.CUSTOMERS] = customers || [];
  DB._set = function (k, v) { this._cache[k] = v; };
  return DB;
}

const CUST_A = 'custA';

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('carryForwardOwedBalance(): creates a well-formed, clearly-labeled payment');
{
  const DB = freshDB(
    [{ id: 'i1', invoiceNumber: 'OLD-1', page: 1, customerId: CUST_A, totalAmount: 1000 }],
    []
  );
  const p = DB.carryForwardOwedBalance('OLD-1', CUST_A, 'NEW-1', 300, 'joe', 'joe');
  t('returns the created payment', !!p);
  t('tagged carryForward:true', p.carryForward === true);
  t('records where it went', p.carryForwardTo === 'NEW-1');
  t('method reads as non-cash, not a real payment method', p.method === 'ยกยอดไปใบใหม่');
  t('amount matches the debt retired', p.amount === 300);
  t('was actually added to the payments store', DB.getPayments().some(x => x.id === p.id));
  t('isCarryForwardPayment() identifies it', DB.isCarryForwardPayment(p) === true);
  t('a normal cash payment is NOT flagged', DB.isCarryForwardPayment({ method: 'เงินสด', amount: 100 }) === false);
}

console.log('\ncarryForwardOwedBalance(): retires the SOURCE invoice\'s own balance');
{
  const DB = freshDB(
    [{ id: 'i1', invoiceNumber: 'OLD-2', page: 1, customerId: CUST_A, totalAmount: 1000 }],
    [{ id: 'p1', invoiceNumber: 'OLD-2', customerId: CUST_A, amount: 700, method: 'เงินสด' }]
  );
  t('before: owed 300', DB.getInvoicePaidAmount('OLD-2', CUST_A) === 700 &&
    1000 - DB.getInvoicePaidAmount('OLD-2', CUST_A) === 300);
  DB.carryForwardOwedBalance('OLD-2', CUST_A, 'NEW-2', 300, 'joe', 'joe');
  const paidAfter = DB.getInvoicePaidAmount('OLD-2', CUST_A);
  t('after: fully settled (real cash + carry-forward)', Math.abs(paidAfter - 1000) < 0.005, `paid=${paidAfter}`);
}

console.log('\ncarryForwardOwedBalance(): does not touch other customers or other invoices');
{
  const CUST_B = 'custB';
  const DB = freshDB(
    [
      { id: 'i1', invoiceNumber: 'OLD-3', page: 1, customerId: CUST_A, totalAmount: 500 },
      { id: 'i2', invoiceNumber: 'UNRELATED', page: 1, customerId: CUST_A, totalAmount: 200 },
      { id: 'i3', invoiceNumber: 'OLD-3-OTHER-CUST', page: 1, customerId: CUST_B, totalAmount: 500 },
    ],
    []
  );
  DB.carryForwardOwedBalance('OLD-3', CUST_A, 'NEW-3', 500, 'joe', 'joe');
  t('unrelated invoice, same customer, untouched', DB.getInvoicePaidAmount('UNRELATED', CUST_A) === 0);
  t('same-shaped number, different customer, untouched', DB.getInvoicePaidAmount('OLD-3-OTHER-CUST', CUST_B) === 0);
}

console.log('\ncarryForwardOwedBalance(): guards against non-positive amounts');
{
  const DB = freshDB([{ id: 'i1', invoiceNumber: 'OLD-4', page: 1, customerId: CUST_A, totalAmount: 100 }], []);
  t('zero amount → null, no payment created', DB.carryForwardOwedBalance('OLD-4', CUST_A, 'NEW-4', 0, 'joe', 'joe') === null
    && DB.getPayments().length === 0);
  t('negative amount → null, no payment created', DB.carryForwardOwedBalance('OLD-4', CUST_A, 'NEW-4', -50, 'joe', 'joe') === null
    && DB.getPayments().length === 0);
}

console.log('\nsystem-wide: total owed across BOTH invoices is unchanged by a carry-forward (just consolidated)');
{
  // Before: OLD invoice owed 300. NEW invoice doesn't exist yet.
  // After the carry-forward flow: OLD is settled (owed 0), NEW carries its own real
  // charges (500) PLUS the rolled debt (300) = owed 800. Combined owed before creating
  // NEW: 300. Combined owed after NEW exists with its own 500 in real charges: 300 (old,
  // unresolved) + 500 (new, not yet invoiced) would eventually total 800 regardless of
  // carry-forward — the mechanism only consolidates WHERE that 800 is tracked, it does
  // not manufacture new debt.
  const DB = freshDB(
    [
      { id: 'i1', invoiceNumber: 'OLD-5', page: 1, customerId: CUST_A, totalAmount: 1000 },
      { id: 'i2', invoiceNumber: 'NEW-5', page: 1, customerId: CUST_A, totalAmount: 800 }, // 500 real + 300 memo
    ],
    [{ id: 'p1', invoiceNumber: 'OLD-5', customerId: CUST_A, amount: 700, method: 'เงินสด' }]
  );
  DB.carryForwardOwedBalance('OLD-5', CUST_A, 'NEW-5', 300, 'joe', 'joe');
  const oldOwed = 1000 - DB.getInvoicePaidAmount('OLD-5', CUST_A);
  const newOwed = 800 - DB.getInvoicePaidAmount('NEW-5', CUST_A);
  t('old invoice settled', Math.abs(oldOwed) < 0.005, `owed=${oldOwed}`);
  t('new invoice owes exactly 500 (its own) + 300 (carried) = 800, none paid yet',
    Math.abs(newOwed - 800) < 0.005, `owed=${newOwed}`);
}

console.log('\nreports.html-style grouping: a carry-forward gets its OWN method bucket, never pollutes real cash/transfer totals');
{
  const DB = freshDB(
    [{ id: 'i1', invoiceNumber: 'OLD-6', page: 1, customerId: CUST_A, totalAmount: 1000 }],
    [{ id: 'p1', invoiceNumber: 'OLD-6', customerId: CUST_A, amount: 700, method: 'เงินสด' }]
  );
  DB.carryForwardOwedBalance('OLD-6', CUST_A, 'NEW-6', 300, 'joe', 'joe');
  const byMethod = {};
  DB.getPayments().forEach(p => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });
  t('real cash bucket unaffected', byMethod['เงินสด'] === 700, JSON.stringify(byMethod));
  t('carry-forward is its own separate bucket', byMethod['ยกยอดไปใบใหม่'] === 300);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
