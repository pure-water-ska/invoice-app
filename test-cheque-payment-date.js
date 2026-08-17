// test-cheque-payment-date.js — run:  node test-cheque-payment-date.js
//
// Covers the cheque payment-date redesign (v1.0.205): a cheque isn't real money until
// it clears, so there is no meaningful "payment date" at entry time. payDate is now left
// blank for a cheque (collectPaymentData / multiPaySave in payments.html) and only gets
// populated by markChequeCleared() (db.js), mirroring clearedDate into payDate — a
// single source of truth, so every EXISTING payDate reader (the before-invoice-date
// sanity check, the printed receipt, the payment-detail view) automatically shows the
// right date once cleared with no per-method branching at those call sites.
//
// Extracts the ACTUAL code from db.js and payments.html — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// ── db.js: markChequeCleared() ──────────────────────────────────────────────────────
console.log('markChequeCleared(): mirrors clearedDate into payDate');
{
  global.window = {};
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.LZString = { compressToUTF16: s => s, decompressFromUTF16: s => s };
  global.document = { addEventListener() {} };
  global.navigator = { onLine: true };
  const DB = new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();
  DB._cache[DB.K.PAYMENTS] = [
    { id: 'p1', method: 'เช็ค', amount: 500, chequeCleared: false, clearedDate: '', payDate: '' },
  ];
  DB._set = function (k, v) { this._cache[k] = v; };

  t('starts pending', DB.isChequePending(DB.getPayments()[0]) === true);
  DB.markChequeCleared('p1', '2026-08-20');
  const p = DB.getPayments()[0];
  t('chequeCleared flips to true', p.chequeCleared === true);
  t('clearedDate set', p.clearedDate === '2026-08-20');
  t('payDate mirrors clearedDate (the whole point)', p.payDate === '2026-08-20', `payDate=${p.payDate}`);
  t('no longer pending', DB.isChequePending(p) === false);
}

// ── payments.html: printed-receipt date cell ────────────────────────────────────────
console.log('\nprinted receipt date column');
{
  const src = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
  const start = src.indexOf('    const dateCell = DB.isChequePending(p)');
  const semi  = src.indexOf(': _printDateTimeFmt(p.createdAt);', start);
  const end   = src.indexOf(';', semi) + 1;
  if (start < 0 || end < start) throw new Error('payments.html structure changed — update this test\'s extraction markers');
  const block = src.slice(start, end);

  const DB = {
    isChequePending: p => p.method === 'เช็ค' && p.chequeCleared === false,
  };
  const Utils = {
    formatDateTH: d => 'TH:' + d,
  };
  const _printDateTimeFmt = d => 'DT:' + d;

  const evalFor = p => new Function('DB', 'Utils', '_printDateTimeFmt', 'p', `${block}\nreturn dateCell;`)(DB, Utils, _printDateTimeFmt, p);

  t('pending cheque shows "รอขึ้นเงิน", not createdAt',
    evalFor({ method: 'เช็ค', chequeCleared: false, createdAt: '2026-08-01T00:00:00Z', payDate: '' })
      .includes('รอขึ้นเงิน'));
  t('cleared cheque shows the cleared date (via payDate), not createdAt',
    evalFor({ method: 'เช็ค', chequeCleared: true, createdAt: '2026-08-01T00:00:00Z', payDate: '2026-08-20' })
      === 'TH:2026-08-20');
  t('cash payment is unaffected — still uses createdAt',
    evalFor({ method: 'เงินสด', chequeCleared: true, createdAt: '2026-08-01T00:00:00Z', payDate: '2026-08-01' })
      === 'DT:2026-08-01T00:00:00Z');
  t('transfer payment is unaffected — still uses createdAt',
    evalFor({ method: 'โอน', chequeCleared: true, createdAt: '2026-08-01T00:00:00Z', payDate: '2026-08-01' })
      === 'DT:2026-08-01T00:00:00Z');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
