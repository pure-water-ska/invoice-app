// test-print-detail-dedup.js — run:  node test-print-detail-dedup.js
//
// User report: "in summary print at payment if customers amount were round, why there are
// double reason in detail of payment".
//
// printPaymentSummary() builds the รายละเอียด cell as
//     [methodDetail(p), p.notes].filter(Boolean).join(' | ')
// so methodDetail() must return the METHOD-SPECIFIC part only — the caller supplies the
// note. Its fallback branch returned p.notes, so any method outside โอน / เช็ค / เงินสด
// had its note printed twice. Both non-cash methods fall in that gap:
//     ตัดเศษ          (DB.writeOffRemainder)      — the rounding write-off the user saw
//     ยกยอดไปใบใหม่   (DB.carryForwardOwedBalance) — same bug, not yet reported
//
// This drives the REAL methodDetail + the REAL join expression, both sliced out of
// payments.html, against payment records built by the REAL db.js — so a future method
// rename in db.js, or a change to the join, is caught here rather than in print.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// ── extract the real render code out of payments.html ────────────────────────────────
const payHtml = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');

function sliceBalanced(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('marker not found: ' + startMarker);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced: ' + startMarker);
  return src.slice(start, end);
}

const methodDetailSrc = sliceBalanced(payHtml, 'const methodDetail = p => {');
t('methodDetail was found in payments.html', /p\.method === 'โอน'/.test(methodDetailSrc));

// the join that assembles the cell — taken verbatim, not restated
const joinMatch = payHtml.match(/const detail\s*=\s*(\[methodDetail\(p\)[^\n]*?);/);
t('the detail-cell join was found in payments.html', !!joinMatch,
  joinMatch ? joinMatch[1] : 'NOT FOUND');

const stubDB = { isChequePending: p => !!p.chequePending };
const methodDetail = new Function('DB', '_bankCode', 'Utils',
  `${methodDetailSrc}; return methodDetail;`)(
  stubDB, v => v || '', { BANKS: [] });
const detailCell = new Function('methodDetail', 'p', `return ${joinMatch[1]};`)
  .bind(null, methodDetail);

// ── build the payment records with the real db.js ────────────────────────────────────
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
const inv = (o = {}) => Object.assign({ id: 'i1', invoiceNumber: 'A-1', page: 1,
  customerId: 'c1', totalAmount: 100, createdAt: '2026-08-01', editCount: 0 }, o);

// ── the reported bug: the rounding write-off ─────────────────────────────────────────
console.log('ตัดเศษ (rounding write-off) — the reported double reason');
{
  const DB = loadDB([inv()], []);
  const w = DB.writeOffRemainder('A-1', 'c1', 0.45,
    { by: 'Joe', byUser: 'joe', reason: 'ลูกค้าไม่จ่ายเศษ' });
  t('the write-off carries a note', !!w.notes, w.notes);
  t('its method is outside the three handled branches',
    w.method !== 'โอน' && w.method !== 'เช็ค' && w.method !== 'เงินสด', w.method);

  const cell = detailCell(w);
  t('methodDetail contributes nothing of its own', methodDetail(w) === '',
    JSON.stringify(methodDetail(w)));
  t('the note appears EXACTLY ONCE', cell.split(w.notes).length - 1 === 1, cell);
  t('no leftover " | " separator', !cell.includes(' | '), cell);
  t('the cell is just the note', cell === w.notes, cell);
}

console.log('\nตัดเศษ with no reason typed — the default note');
{
  const DB = loadDB([inv()], []);
  const w = DB.writeOffRemainder('A-1', 'c1', 0.45, { by: 'Joe', byUser: 'joe' });
  const cell = detailCell(w);
  t('falls back to the default note', !!w.notes, w.notes);
  t('printed once, not twice', cell.split(w.notes).length - 1 === 1, cell);
}

// ── the same bug on the other non-cash method ────────────────────────────────────────
console.log('\nยกยอดไปใบใหม่ (carry-forward) — same gap, was never reported');
{
  const DB = loadDB([inv()], []);
  const c = DB.carryForwardOwedBalance('A-1', 'c1', 'B-2', 50, 'Joe', 'joe');
  t('its method is outside the three handled branches',
    c.method !== 'โอน' && c.method !== 'เช็ค' && c.method !== 'เงินสด', c.method);
  const cell = detailCell(c);
  t('the target invoice number is named once', cell.split('B-2').length - 1 === 1, cell);
  t('the cell is just the note', cell === c.notes, cell);
}

// ── the three real methods must be unaffected ────────────────────────────────────────
console.log('\nเงินสด / โอน / เช็ค — unchanged, method detail AND note both shown');
{
  const cash = { method: 'เงินสด', cashCollector: 'สมชาย', notes: 'รับตอนเย็น' };
  t('cash shows collector then note', detailCell(cash) === 'สมชาย | รับตอนเย็น', detailCell(cash));

  const cashNoNote = { method: 'เงินสด', cashCollector: 'สมชาย', notes: '' };
  t('cash with no note shows just the collector', detailCell(cashNoNote) === 'สมชาย',
    detailCell(cashNoNote));

  const cashNoCollector = { method: 'เงินสด', cashCollector: '', notes: 'รับตอนเย็น' };
  t('cash with no collector shows just the note — no dangling separator',
    detailCell(cashNoCollector) === 'รับตอนเย็น', detailCell(cashNoCollector));

  const xfer = { method: 'โอน', destBank: 'KBANK', accountName: 'บัญชีหลัก', notes: 'งวดแรก' };
  t('transfer shows bank · account then note',
    detailCell(xfer) === 'KBANK · บัญชีหลัก | งวดแรก', detailCell(xfer));

  const chq = { method: 'เช็ค', chequeBank: 'SCB', chequeNo: '112233', notes: 'เช็คลงวันที่' };
  t('cheque shows bank · number then note',
    detailCell(chq) === 'SCB · #112233 | เช็คลงวันที่', detailCell(chq));

  const pend = { method: 'เช็ค', chequeBank: 'SCB', chequeNo: '112233',
    chequePending: true, notes: '' };
  t('a pending cheque still says รอขึ้นเงิน', detailCell(pend).includes('(รอขึ้นเงิน)'),
    detailCell(pend));
}

// ── a method nobody has written yet ──────────────────────────────────────────────────
console.log('\nan unknown future method — must not resurrect the bug');
{
  const future = { method: 'บัตรเครดิต', notes: 'ผ่านเครื่อง EDC' };
  const cell = detailCell(future);
  t('its note is printed once', cell.split('ผ่านเครื่อง EDC').length - 1 === 1, cell);
  t('a method with no note at all yields an empty cell',
    detailCell({ method: 'บัตรเครดิต', notes: '' }) === '');
}

// ── guard the invariant itself ───────────────────────────────────────────────────────
console.log('\nthe invariant: methodDetail must never return p.notes');
{
  t('the fallback branch no longer returns p.notes',
    !/return p\.notes/.test(methodDetailSrc), 'found `return p.notes` in methodDetail');
  const probe = { method: 'อะไรก็ไม่รู้', notes: 'UNIQUE-NOTE-TOKEN' };
  t('driven for real: the fallback returns nothing', methodDetail(probe) === '',
    JSON.stringify(methodDetail(probe)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
