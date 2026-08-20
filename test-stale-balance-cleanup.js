// test-stale-balance-cleanup.js — run:  node test-stale-balance-cleanup.js
//
// Covers the Settings cleanup tool (DB.findStaleFoldedBalances + settleStaleFoldedBalance)
// that retires balances folded onto a newer invoice back when no retirement mechanism
// existed for that type (overpaid: v1.0.194, owed: v1.0.203). Those left the source
// invoice permanently outstanding while the same money was billed again on the newer
// invoice — the user-reported "the overpaid and partial are stills on invoice created
// even it's already added to another invoice".
//
// The safety rule under test: settleAmount is min(|folded|, |current|), so a source that
// was partly paid directly after being folded can never be over-settled into a phantom
// credit. Sign disagreements are reported as `skipped`, never guessed at.
//
// Loads the REAL DB object out of db.js and drives it against in-memory storage — not a
// reimplementation of the scan.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// Load the real DB literal from db.js. db.js declares `const DB = {…}` (a lexical global,
// see the window.DB gotcha in CLAUDE.md) so we slice the object literal and eval it with
// the handful of globals its methods close over.
function loadDB(store) {
  const src = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
  const start = src.indexOf('const DB = {');
  if (start < 0) throw new Error('DB literal not found — update extraction marker');
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const literal = src.slice(src.indexOf('{', start), end);

  const Utils = { uuid: () => 'id-' + (Utils._n = (Utils._n || 0) + 1) };
  const stub = {
    _get: (k) => store[k] || [],
    _set: (k, v) => { store[k] = v; },
    K: { INVOICES: 'wt_invoices', PAYMENTS: 'wt_payments', CUSTOMERS: 'wt_customers' },
  };
  const fn = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console',
    `return ${literal};`);
  const real = fn(Utils, {}, { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {} }, { log(){}, warn(){}, error(){} });

  // Bind only the storage primitives to our in-memory store; every method under test
  // (findStaleFoldedBalances, settleStaleFoldedBalance, carryForwardOwedBalance,
  // allocateOverpayCredit, getInvoicePaidAmount, …) stays the REAL implementation.
  real._get = stub._get;
  real._set = stub._set;
  real.K = Object.assign({}, real.K, stub.K);
  return real;
}

function setup(invoices, payments, customers) {
  const store = { wt_invoices: invoices, wt_payments: payments, wt_customers: customers || [] };
  const DB = loadDB(store);
  return { DB, store };
}

const CUSTS = [{ id: 'c1', name: 'ร้านอรวรรณ' }, { id: 'c2', name: 'ทรัพย์มณี' }];

console.log('findStaleFoldedBalances(): the clean case — folded amount equals what is still owed');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '150569-004', page: 1, customerId: 'c1', totalAmount: 2500, createdAt: '2026-05-15', items: [] },
    { id: 'b', invoiceNumber: '020669-011', page: 1, customerId: 'c1', totalAmount: 500, createdAt: '2026-06-02',
      items: [{ name: 'ค้างชำระ 150569-004', total: 320 }] },
  ], [
    { id: 'p1', invoiceNumber: '150569-004', customerId: 'c1', amount: 2180 },
  ], CUSTS);

  const { rows, skipped } = DB.findStaleFoldedBalances();
  t('finds exactly one stale row', rows.length === 1, JSON.stringify(rows.map(r => r.sourceNum)));
  t('nothing skipped', skipped.length === 0);
  t('settles the full 320 (folded == current)', Math.abs(rows[0].settleAmount - 320) < 0.005, String(rows[0].settleAmount));
  t('flagged as owed', rows[0].isOwed === true);
  t('no mismatch flag', rows[0].mismatch === false);
  t('resolves the customer name', rows[0].custName === 'ร้านอรวรรณ', rows[0].custName);
  t('points at the target invoice', rows[0].targetNum === '020669-011');
}

console.log('\nfindStaleFoldedBalances(): NEVER overshoots when part was paid directly afterwards');
{
  // ฿880 was folded onto the newer invoice, but ฿480 has since been paid straight onto the
  // source — only ฿400 is genuinely still outstanding. Settling 880 would push the source
  // into a fake ฿480 credit.
  const { DB } = setup([
    { id: 'a', invoiceNumber: '090769-002', page: 1, customerId: 'c1', totalAmount: 3200, createdAt: '2026-07-09', items: [] },
    { id: 'b', invoiceNumber: '150769-006', page: 1, customerId: 'c1', totalAmount: 900, createdAt: '2026-07-15',
      items: [{ name: 'ค้างชำระ 090769-002', total: 880 }] },
  ], [
    { id: 'p1', invoiceNumber: '090769-002', customerId: 'c1', amount: 2320 },
    { id: 'p2', invoiceNumber: '090769-002', customerId: 'c1', amount: 480 },
  ], CUSTS);

  const { rows } = DB.findStaleFoldedBalances();
  t('caps the settle at the 400 still outstanding, not the 880 folded',
    Math.abs(rows[0].settleAmount - 400) < 0.005, String(rows[0].settleAmount));
  t('mismatch is flagged for the UI', rows[0].mismatch === true);
  t('still reports the original folded amount for display', Math.abs(rows[0].folded - 880) < 0.005);
}

console.log('\nfindStaleFoldedBalances(): an already-retired balance is NOT reported');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '180669-009', page: 1, customerId: 'c2', totalAmount: 1800, createdAt: '2026-06-18', items: [] },
    { id: 'b', invoiceNumber: '250669-002', page: 1, customerId: 'c2', totalAmount: 500, createdAt: '2026-06-25',
      items: [{ name: 'ค้างชำระ 180669-009', total: 300 }] },
  ], [
    { id: 'p1', invoiceNumber: '180669-009', customerId: 'c2', amount: 1500 },
    // the carry-forward that already retired it
    { id: 'p2', invoiceNumber: '180669-009', customerId: 'c2', amount: 300, carryForward: true, carryForwardTo: '250669-002' },
  ], CUSTS);

  const { rows } = DB.findStaleFoldedBalances();
  t('healthy (already settled) pairs produce no rows', rows.length === 0, JSON.stringify(rows));
}

console.log('\nfindStaleFoldedBalances(): sign disagreement goes to skipped, never guessed');
{
  // folded as owed, but the source now sits OVERPAID — settling would move money the
  // wrong direction, so it must be surfaced for a human rather than acted on.
  const { DB } = setup([
    { id: 'a', invoiceNumber: '010769-005', page: 1, customerId: 'c1', totalAmount: 1000, createdAt: '2026-07-01', items: [] },
    { id: 'b', invoiceNumber: '090769-001', page: 1, customerId: 'c1', totalAmount: 400, createdAt: '2026-07-09',
      items: [{ name: 'ค้างชำระ 010769-005', total: 200 }] },
  ], [
    { id: 'p1', invoiceNumber: '010769-005', customerId: 'c1', amount: 1250 },
  ], CUSTS);

  const { rows, skipped } = DB.findStaleFoldedBalances();
  t('not offered as an actionable row', rows.length === 0);
  t('reported in skipped instead of dropped silently', skipped.length === 1 && skipped[0].sourceNum === '010769-005');
}

console.log('\nfindStaleFoldedBalances(): same source folded onto TWO invoices settles only once');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '200669-003', page: 1, customerId: 'c1', totalAmount: 1000, createdAt: '2026-06-20', items: [] },
    { id: 'b', invoiceNumber: '210669-001', page: 1, customerId: 'c1', totalAmount: 300, createdAt: '2026-06-21',
      items: [{ name: 'ค้างชำระ 200669-003', total: 250 }] },
    { id: 'c', invoiceNumber: '220669-004', page: 1, customerId: 'c1', totalAmount: 300, createdAt: '2026-06-22',
      items: [{ name: 'ค้างชำระ 200669-003', total: 250 }] },
  ], [
    { id: 'p1', invoiceNumber: '200669-003', customerId: 'c1', amount: 750 },
  ], CUSTS);

  const { rows } = DB.findStaleFoldedBalances();
  t('one row, not two', rows.length === 1);
  t('settles the 250 actually owed, not the 500 double-folded',
    Math.abs(rows[0].settleAmount - 250) < 0.005, String(rows[0].settleAmount));
  t('attributes to the newest target', rows[0].targetNum === '220669-004', rows[0].targetNum);
  t('records both targets for display', rows[0].targets.length === 2);
}

console.log('\nfindStaleFoldedBalances(): cancelled and self-referencing invoices are ignored');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '010170-001', page: 1, customerId: 'c1', totalAmount: 1000, createdAt: '2026-01-01',
      items: [{ name: 'ค้างชำระ 010170-001', total: 100 }] },              // self-reference
    { id: 'b', invoiceNumber: '020170-002', page: 1, customerId: 'c1', totalAmount: 900, createdAt: '2026-01-02', items: [] },
    { id: 'c', invoiceNumber: '030170-003', page: 1, customerId: 'c1', totalAmount: 400, createdAt: '2026-01-03', cancelled: true,
      items: [{ name: 'ค้างชำระ 020170-002', total: 900 }] },              // reference lives on a CANCELLED invoice
  ], [], CUSTS);

  const { rows } = DB.findStaleFoldedBalances();
  t('neither the self-reference nor the cancelled reference is reported', rows.length === 0, JSON.stringify(rows.map(r => r.sourceNum)));
}

console.log('\nsettleStaleFoldedBalance(): owed side actually clears the source invoice');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '150569-004', page: 1, customerId: 'c1', totalAmount: 2500, createdAt: '2026-05-15', items: [] },
    { id: 'b', invoiceNumber: '020669-011', page: 1, customerId: 'c1', totalAmount: 500, createdAt: '2026-06-02',
      items: [{ name: 'ค้างชำระ 150569-004', total: 320 }] },
  ], [
    { id: 'p1', invoiceNumber: '150569-004', customerId: 'c1', amount: 2180 },
  ], CUSTS);

  const before = DB.findStaleFoldedBalances().rows;
  const settled = DB.settleStaleFoldedBalance(before[0], 'Joe', 'joe');
  t('reports 320 settled', Math.abs(settled - 320) < 0.005, String(settled));

  const pays = DB.getPaymentsByInvoice('150569-004');
  const cf = pays.find(p => p.carryForward);
  t('creates a carry-forward payment on the SOURCE invoice', !!cf);
  t('tagged as non-cash with the target recorded', cf && cf.carryForwardTo === '020669-011' && DB.isCarryForwardPayment(cf));
  t('source invoice is now fully settled',
    Math.abs(2500 - DB.getInvoicePaidAmount('150569-004', 'c1')) < 0.005,
    String(DB.getInvoicePaidAmount('150569-004', 'c1')));
  t('re-scanning finds nothing left — the fix is idempotent', DB.findStaleFoldedBalances().rows.length === 0);
}

console.log('\nsettleStaleFoldedBalance(): overpaid side allocates the credit away from the source');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '180669-009', page: 1, customerId: 'c2', totalAmount: 1800, createdAt: '2026-06-18', items: [] },
    { id: 'b', invoiceNumber: '250669-002', page: 1, customerId: 'c2', totalAmount: 500, createdAt: '2026-06-25',
      items: [{ name: 'ชำระเกิน 180669-009', total: -150.5 }] },
  ], [
    { id: 'p1', invoiceNumber: '180669-009', customerId: 'c2', amount: 1950.5 },
  ], CUSTS);

  const before = DB.findStaleFoldedBalances().rows;
  t('detected as an overpaid row', before.length === 1 && before[0].isOwed === false);
  const settled = DB.settleStaleFoldedBalance(before[0], 'Joe', 'joe');
  t('reports 150.50 settled', Math.abs(settled - 150.5) < 0.005, String(settled));
  t('source no longer shows a credit',
    Math.abs(1800 - DB.getInvoicePaidAmount('180669-009', 'c2')) < 0.005,
    String(DB.getInvoicePaidAmount('180669-009', 'c2')));
  t('re-scanning finds nothing left', DB.findStaleFoldedBalances().rows.length === 0);
}

console.log('\nsettleStaleFoldedBalance(): the capped case settles only the capped amount');
{
  const { DB } = setup([
    { id: 'a', invoiceNumber: '090769-002', page: 1, customerId: 'c1', totalAmount: 3200, createdAt: '2026-07-09', items: [] },
    { id: 'b', invoiceNumber: '150769-006', page: 1, customerId: 'c1', totalAmount: 900, createdAt: '2026-07-15',
      items: [{ name: 'ค้างชำระ 090769-002', total: 880 }] },
  ], [
    { id: 'p1', invoiceNumber: '090769-002', customerId: 'c1', amount: 2320 },
    { id: 'p2', invoiceNumber: '090769-002', customerId: 'c1', amount: 480 },
  ], CUSTS);

  const row = DB.findStaleFoldedBalances().rows[0];
  DB.settleStaleFoldedBalance(row, 'Joe', 'joe');
  const paid = DB.getInvoicePaidAmount('090769-002', 'c1');
  t('source lands exactly at its total — no phantom credit', Math.abs(paid - 3200) < 0.005, String(paid));
}

console.log('\nsettleStaleFoldedBalance(): refuses a zero/invalid row');
{
  const { DB } = setup([], [], CUSTS);
  t('zero settleAmount is a no-op', DB.settleStaleFoldedBalance({ settleAmount: 0, isOwed: true }, 'Joe', 'joe') === 0);
  t('null row is a no-op', DB.settleStaleFoldedBalance(null, 'Joe', 'joe') === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
