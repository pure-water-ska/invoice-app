// test-reports-payment-filter.js — run:  node test-reports-payment-filter.js
//
// Covers reports.html's paymentsInRange filter (feeds only the "รายการชำระ"
// payment-methods tab, renderByPayment()).
//
// Before this fix it filtered by date only — no exclusion of cancelled payments or
// still-pending cheques. Every other paid-amount figure in the app already excludes
// both (DB.getInvoicePaidAmount/effectivePaymentAmount), so this report was the one
// place a still-uncleared cheque showed at full face value, and a cancelled payment
// counted as money received.
//
// Extracts the ACTUAL filter block from reports.html and drives it with a stub DB —
// not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'reports.html'), 'utf8');
const start = src.indexOf('  const paymentsInRange = allPayments.filter(p => {');
const end   = src.indexOf('\n\n', start);
if (start < 0 || end < start) throw new Error('reports.html structure changed — update this test\'s extraction markers');
const block = src.slice(start, end);

function filterWith(allPayments, from, to) {
  const DB = {
    isChequePending: p => p.method === 'เช็ค' && p.chequeCleared === false,
    // Added when write-offs landed: a non-cash entry settles an invoice without money
    // changing hands, so it must never appear in a report of what was received.
    isNonCashPayment: p => !!p.carryForward || !!p.writeOff,
  };
  const fn = new Function('DB', 'allPayments', 'from', 'to', `${block}\nreturn paymentsInRange;`);
  return fn(DB, allPayments, from, to);
}

const FROM = new Date('2026-01-01T00:00:00');
const TO   = new Date('2026-12-31T23:59:59');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('excludes a still-pending cheque');
{
  const payments = [
    { id: 'p1', method: 'เช็ค', chequeCleared: false, amount: 1000, createdAt: '2026-06-01T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('pending cheque is excluded', out.length === 0, JSON.stringify(out));
}

console.log('\nincludes a CLEARED cheque');
{
  const payments = [
    { id: 'p1', method: 'เช็ค', chequeCleared: true, amount: 1000, createdAt: '2026-06-01T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('cleared cheque is included', out.length === 1 && out[0].id === 'p1');
}

console.log('\nexcludes a cancelled payment (any method)');
{
  const payments = [
    { id: 'p1', method: 'เงินสด', cancelled: true, amount: 500, createdAt: '2026-06-01T00:00:00' },
    { id: 'p2', method: 'โอน', cancelled: true, amount: 500, createdAt: '2026-06-01T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('both cancelled payments excluded', out.length === 0, JSON.stringify(out));
}

console.log('\na cancelled cheque payment is excluded (not double-flagged, just excluded)');
{
  const payments = [
    { id: 'p1', method: 'เช็ค', cancelled: true, chequeCleared: true, amount: 500, createdAt: '2026-06-01T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('excluded via the cancelled check', out.length === 0);
}

console.log('\nnormal cash/transfer payments are unaffected');
{
  const payments = [
    { id: 'p1', method: 'เงินสด', amount: 300, createdAt: '2026-06-01T00:00:00' },
    { id: 'p2', method: 'โอน', amount: 700, createdAt: '2026-06-15T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('both included', out.length === 2);
}

console.log('\ndate range still applies on top of the new exclusions');
{
  const payments = [
    { id: 'p1', method: 'เงินสด', amount: 300, createdAt: '2025-12-31T00:00:00' }, // before range
    { id: 'p2', method: 'เงินสด', amount: 300, createdAt: '2026-06-01T00:00:00' }, // in range
  ];
  const out = filterWith(payments, FROM, TO);
  t('out-of-range payment excluded', out.length === 1 && out[0].id === 'p2');
}

console.log('\nlegacy cheque payments (predates chequeCleared field entirely) are NOT excluded');
{
  // isChequePending requires chequeCleared === false STRICTLY — a legacy record with
  // no such field at all must not be silently treated as pending (see db.js's own
  // comment on isChequePending: chequeCleared !== true would wrongly exclude every
  // legacy cheque AND every non-cheque payment).
  const payments = [
    { id: 'p1', method: 'เช็ค', amount: 500, createdAt: '2026-06-01T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('legacy cheque (no chequeCleared field) is included', out.length === 1);
}

console.log('excludes non-cash settlements (write-off / carry-forward)');
{
  // These settle an invoice but no money was received, so a report of takings must not
  // list them. Before write-offs existed, `carryForward` appeared only in db.js and
  // invoice-create.html — nothing in reports excluded it, so every carry-forward was
  // silently counted as revenue.
  const payments = [
    { id: 'w', writeOff: true, amount: 0.45, createdAt: '2026-06-01T00:00:00' },
    { id: 'c', carryForward: true, amount: 0.5, createdAt: '2026-06-02T00:00:00' },
    { id: 'r', method: 'โอน', amount: 900, createdAt: '2026-06-03T00:00:00' },
  ];
  const out = filterWith(payments, FROM, TO);
  t('write-off excluded', !out.some(p => p.id === 'w'));
  t('carry-forward excluded', !out.some(p => p.id === 'c'));
  t('the real transfer is kept', out.length === 1 && out[0].id === 'r', JSON.stringify(out.map(p => p.id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
