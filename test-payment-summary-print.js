// test-payment-summary-print.js — run:  node test-payment-summary-print.js
//
// User-reported: the printed payment summary should show over/under-paid amounts that
// were moved onto another invoice. It's worse than an omission — the sheet didn't ADD UP.
// Rows print each payment's RAW amount, while ชำระแล้ว uses getInvoicePaidAmount(), which
// subtracts whatever was allocated elsewhere and excludes un-cleared cheques. So an
// invoice whose overpayment was cut to another bill printed a ฿10,000 row above a ฿8,000
// "ชำระแล้ว" with ฿2,000 unexplained — on a document handed to the customer.
//
// Three things separate the rows from the net figure, each now its own summary line:
//   • allocated away to other invoices  (subtracts)
//   • carry-forward — the customer's OWN old debt moved to a new invoice, not money they
//     handed over, so it must not be counted as "รับเงิน"
//   • un-cleared cheques — printed in the rows but deliberately not yet counted as paid
//
// The load-bearing assertion is the identity cash + carryForward − allocated = paid, i.e.
// the printed column reconciles. Extracts the REAL breakdown from payments.html.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// The real accumulation loop out of printPaymentSummary().
const bStart = src.indexOf('  let cashReceived = 0, carryForwardTotal = 0');
const bEnd   = src.indexOf('  const isOverpaid', bStart);
if (bStart < 0 || bEnd < 0) throw new Error('breakdown block not found — update extraction markers');
const breakdownBlock = src.slice(bStart, bEnd);

// Real DB predicates, so the test can't drift from the app's own definitions.
const dbSrc = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
function loadDB(payments) {
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
  DB.getPayments = () => payments;
  DB.getInvoices = () => [];
  return DB;
}

function breakdown(payments) {
  const DB = loadDB(payments);
  const fn = new Function('payments', 'DB',
    `${breakdownBlock}\nreturn { cashReceived, carryForwardTotal, allocatedTotal, pendingCheque };`);
  const b = fn(payments, DB);
  // paid, exactly as the print computes it (DB.getInvoicePaidAmount → effectivePaymentAmount)
  const paid = payments.filter(p => !p.cancelled && !DB.isChequePending(p))
                       .reduce((s, p) => s + DB.effectivePaymentAmount(p), 0);
  return { ...b, paid };
}

const INV = '150869-004';
const cash = (amt, extra = {}) => ({ invoiceNumber: INV, customerId: 'c1', method: 'โอน', amount: amt, ...extra });

console.log('Reconciliation — the identity the printed column depends on');
{
  // The reported shape: ฿10,000 received, ฿2,000 of it cut to another invoice.
  const b = breakdown([cash(10000, { allocatedOut: 2000, allocations: [{ invoiceNumber: '030869-003', amount: 2000 }] })]);
  t('cash received is the full 10,000 (the row prints this)', b.cashReceived === 10000, String(b.cashReceived));
  t('2,000 recorded as allocated away', b.allocatedTotal === 2000, String(b.allocatedTotal));
  t('paid is the net 8,000', b.paid === 8000, String(b.paid));
  t('cash + carryForward − allocated === paid (the sheet adds up)',
    b.cashReceived + b.carryForwardTotal - b.allocatedTotal === b.paid,
    `${b.cashReceived} + ${b.carryForwardTotal} − ${b.allocatedTotal} = ${b.paid}`);
}

console.log('\nCarry-forward is NOT counted as money received');
{
  const b = breakdown([
    cash(10000),
    { invoiceNumber: INV, customerId: 'c1', method: 'ยกยอดไปใบใหม่', amount: 500,
      carryForward: true, carryForwardTo: '200869-011' },
  ]);
  t('cash received excludes the carry-forward', b.cashReceived === 10000, String(b.cashReceived));
  t('carry-forward tracked separately', b.carryForwardTotal === 500, String(b.carryForwardTotal));
  t('but it still counts toward paid (it does settle the invoice)', b.paid === 10500, String(b.paid));
  t('identity still holds', b.cashReceived + b.carryForwardTotal - b.allocatedTotal === b.paid);
}

console.log('\nUn-cleared cheques are printed but not counted');
{
  const b = breakdown([
    cash(3000),
    { invoiceNumber: INV, customerId: 'c1', method: 'เช็ค', amount: 1000, chequeCleared: false },
  ]);
  t('pending cheque tracked on its own line', b.pendingCheque === 1000, String(b.pendingCheque));
  t('excluded from cash received', b.cashReceived === 3000, String(b.cashReceived));
  t('excluded from paid', b.paid === 3000, String(b.paid));
  t('identity holds without the pending cheque',
    b.cashReceived + b.carryForwardTotal - b.allocatedTotal === b.paid);
}
{
  // A CLEARED cheque is ordinary money and must count.
  const b = breakdown([{ invoiceNumber: INV, customerId: 'c1', method: 'เช็ค', amount: 1000, chequeCleared: true }]);
  t('a cleared cheque counts as cash', b.cashReceived === 1000 && b.pendingCheque === 0 && b.paid === 1000,
    `cash=${b.cashReceived} pending=${b.pendingCheque} paid=${b.paid}`);
}

console.log('\nAll three at once — the worst case still reconciles');
{
  const b = breakdown([
    cash(10000, { allocatedOut: 2000, allocations: [{ invoiceNumber: '030869-003', amount: 2000 }] }),
    { invoiceNumber: INV, customerId: 'c1', method: 'ยกยอดไปใบใหม่', amount: 500, carryForward: true, carryForwardTo: '200869-011' },
    { invoiceNumber: INV, customerId: 'c1', method: 'เช็ค', amount: 700, chequeCleared: false },
  ]);
  t('cash 10,000 · carry 500 · allocated 2,000 · pending 700',
    b.cashReceived === 10000 && b.carryForwardTotal === 500 && b.allocatedTotal === 2000 && b.pendingCheque === 700,
    JSON.stringify(b));
  t('paid = 8,500', b.paid === 8500, String(b.paid));
  t('identity holds', b.cashReceived + b.carryForwardTotal - b.allocatedTotal === b.paid);
}

console.log('\nOrdinary invoice — nothing extra, unchanged from before');
{
  const b = breakdown([cash(5000)]);
  t('no allocations, carry-forward or pending',
    b.allocatedTotal === 0 && b.carryForwardTotal === 0 && b.pendingCheque === 0);
  t('cash equals paid', b.cashReceived === b.paid && b.paid === 5000, String(b.paid));
}

console.log('\nMultiple allocations from one payment accumulate');
{
  const b = breakdown([cash(9000, {
    allocatedOut: 3500,
    allocations: [{ invoiceNumber: 'A-1', amount: 1500 }, { invoiceNumber: 'A-2', amount: 2000 }],
  })]);
  t('both cuts counted', b.allocatedTotal === 3500, String(b.allocatedTotal));
  t('paid is 5,500', b.paid === 5500, String(b.paid));
  t('identity holds', b.cashReceived + b.carryForwardTotal - b.allocatedTotal === b.paid);
}

console.log('\nRendered output — lines appear only when they apply');
{
  t('หัก ตัดไปใบอื่น is conditional on allocatedTotal',
    /allocatedTotal > 0\.005 \? `[\s\S]{0,200}หัก ตัดไปใบอื่น/.test(src));
  t('ยกยอดไปใบใหม่ line is conditional on carryForwardTotal',
    /carryForwardTotal > 0\.005 \? `[\s\S]{0,200}ยกยอดไปใบใหม่/.test(src));
  t('เช็ครอขึ้นเงิน line is conditional on pendingCheque',
    /pendingCheque > 0\.005 \? `[\s\S]{0,200}เช็ครอขึ้นเงิน/.test(src));
  t('label switches to รวมรับเงินจริง only when a breakdown exists',
    src.includes("? 'รวมรับเงินจริง' : 'ชำระแล้วทั้งสิ้น'"));
  t('per-row allocation sub-line names the destination invoice',
    src.includes('↳ ตัดไปใบ ${a.invoiceNumber}'));
  t('carry-forward rows are marked as not-a-receipt on the row',
    src.includes('↳ ไม่ใช่การรับเงิน'));
  t('allocation sub-lines are built from the allocations audit trail',
    /const allocLines = \(p\.allocations \|\| \[\]\)/.test(src));
}

console.log('\nmethodDetail() no longer duplicates the notes column');
{
  // Pre-existing bug surfaced by this change: the fallback returned p.notes, and the
  // caller appends p.notes again, so any method outside เงินสด/โอน/เช็ค printed its note
  // twice — which in practice meant exactly the carry-forward rows:
  // "ยกยอดค้างชำระไปใบกำกับ X | ยกยอดค้างชำระไปใบกำกับ X".
  const s = src.indexOf('const methodDetail = p => {');
  const e = src.indexOf('};', s) + 2;
  const block = src.slice(s, e);
  const methodDetail = new Function('DB', '_bankCode', `${block}\nreturn methodDetail;`)(
    { isChequePending: p => p.method === 'เช็ค' && p.chequeCleared === false }, b => b || '');

  const cf = { method: 'ยกยอดไปใบใหม่', notes: 'ยกยอดค้างชำระไปใบกำกับ 200869-011' };
  t('carry-forward detail is empty so the note prints once', methodDetail(cf) === '',
    JSON.stringify(methodDetail(cf)));
  const joined = [methodDetail(cf), cf.notes].filter(Boolean).join(' | ');
  t('joined detail has no duplication', joined === 'ยกยอดค้างชำระไปใบกำกับ 200869-011', joined);
  t('known methods still return their own detail',
    methodDetail({ method: 'เงินสด', cashCollector: 'สมชาย' }) === 'สมชาย');
  t('transfer detail still built from bank + account',
    methodDetail({ method: 'โอน', destBank: 'KBANK', accountName: 'บัญชีหลัก' }) === 'KBANK · บัญชีหลัก');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
