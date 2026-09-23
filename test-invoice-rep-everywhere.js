// test-invoice-rep-everywhere.js — v1.0.243
//
// "The amount of any invoice version will be used the latest one, right?"
//
// It was true only by luck: the v1.0.242 sweep had removed every duplicate, so every
// reader happened to land on the one remaining record. Seven places still chose the
// representative with `find(i => i.page === 1)`, which picks by ARRAY order — i.e. by
// sync/load order — so the moment a superseded page existed again they would report the
// STALE pre-edit total. Four of them move money or print for customers:
//   payments.html _overpayOutstanding   — where overpaid credit is cut
//   payments.html showOutstandingPreview— the statement printed for the customer
//   payments.html openMultiPayModal / onMultiCustChange — multi-invoice payment amounts
//   invoice-create.html payment-terms violation check
//   customers.html render, db.js findStaleFoldedBalances
//
// DB._isBetterInvoiceRep is the single deterministic rule (page 1 wins, then highest
// editCount). This suite asserts the rule itself, and that NO live file reintroduces the
// naive pattern.
//
// Run: node test-invoice-rep-everywhere.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ── The rule itself ────────────────────────────────────────────────────────
function loadRule() {
  const src = read('db.js');
  const s = src.indexOf('  _isBetterInvoiceRep(cur, cand) {');
  if (s < 0) throw new Error('_isBetterInvoiceRep not found');
  const e = src.indexOf('\n  },', s);
  return new Function('return {' + src.slice(s, e + 5) + '};')();
}

section('DB._isBetterInvoiceRep — the one rule');
{
  const R = loadRule();
  const rep = recs => { let c = null; for (const r of recs) if (R._isBetterInvoiceRep(c, r)) c = r; return c; };
  const mk = (id, o) => Object.assign({ id, page: 1 }, o);

  t('the only record wins', rep([mk('a')]).id === 'a');
  t('the edited record wins over the pre-edit one',
    rep([mk('old'), mk('new', { editCount: 1 })]).id === 'new');
  t('…and order does not matter',
    rep([mk('new', { editCount: 1 }), mk('old')]).id === 'new');
  t('undefined editCount counts as 0',
    rep([mk('old', { editCount: undefined }), mk('new', { editCount: 1 })]).id === 'new');
  t('the highest editCount of three wins',
    rep([mk('v1', { editCount: 1 }), mk('v0'), mk('v2', { editCount: 2 })]).id === 'v2');
  t('page 1 beats page 2 regardless of editCount',
    rep([mk('p2', { page: 2, editCount: 9 }), mk('p1', { page: 1 })]).id === 'p1');
  t('…and in the other order too',
    rep([mk('p1', { page: 1 }), mk('p2', { page: 2, editCount: 9 })]).id === 'p1');
  t('a tie keeps the incumbent — deterministic, not array-order-dependent',
    rep([mk('first', { editCount: 1 }), mk('second', { editCount: 1 })]).id === 'first');

  // The live case this came from: 180769-001, stale 23,665 vs current 22,715.
  const live = rep([mk('stale', { totalAmount: 23665 }), mk('current', { totalAmount: 22715, editCount: 1 })]);
  t('180769-001: the LATEST amount is chosen, not the higher one', live.totalAmount === 22715, live.totalAmount);
  // And the reverse — an edit that RAISED the total (290869-006).
  const up = rep([mk('stale', { totalAmount: 30021.6 }), mk('current', { totalAmount: 31491.6, editCount: 1 })]);
  t('290869-006: an upward edit also uses the latest', up.totalAmount === 31491.6, up.totalAmount);
}

// ── No live file may reintroduce the naive pattern ─────────────────────────
section('no live file picks the representative by array order');
{
  const FILES = ['db.js', 'payments.html', 'invoice-create.html', 'customers.html',
                 'invoices.html', 'reports.html', 'dashboard.html'];
  // `find(... page === 1)` used to choose ONE record per invoice NUMBER. Comment lines
  // are allowed (the gotcha is documented in several places).
  const naive = /\.find\(\s*\w+\s*=>\s*\w+\.invoiceNumber\s*===\s*\w+\s*&&\s*\w+\.page\s*===\s*1\s*\)/;
  for (const f of FILES) {
    let src;
    try { src = read(f); } catch (e) { continue; }
    const hits = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(x => !x.l.trim().startsWith('//') && !x.l.trim().startsWith('*') && naive.test(x.l));
    t(f + ' has no naive page-1 representative pick', hits.length === 0,
      hits.length ? hits.map(h => f + ':' + h.n) : undefined);
  }
}

section('the seven former sites now use the rule');
{
  const expect = [
    ['customers.html', 'render', 1],
    ['invoice-create.html', 'checkCustomerBalance + payTerms', 2],
    ['payments.html', '_overpayOutstanding, showOutstandingPreview, multi-pay x2', 4],
    ['db.js', 'findStaleFoldedBalances + getCustomerBalance', 2],
  ];
  for (const [f, what, atLeast] of expect) {
    const n = (read(f).match(/_isBetterInvoiceRep\(/g) || []).length;
    t(f + ' calls _isBetterInvoiceRep (' + what + ')', n >= atLeast, n);
  }
  // db.js must still DEFINE it exactly once.
  t('_isBetterInvoiceRep is defined once in db.js',
    (read('db.js').match(/_isBetterInvoiceRep\(cur, cand\) \{/g) || []).length === 1);
}

section('the sweep cleans every duplicate again (snapshot guard removed)');
{
  const src = read('db.js');
  const s = src.indexOf('  findSupersededPages(invoices) {');
  const e = src.indexOf('\n  },', src.indexOf('return out;', s));
  const fn = new Function('return {' + src.slice(s, e + 5) + '};')();
  const mk = (id, o) => Object.assign({ id, invoiceNumber: 'A', customerId: 'c1', page: 1 }, o);

  // The user does not need old versions, so a missing editHistory snapshot must NOT
  // stop the cleanup — leaving a duplicate would re-expose the readers above.
  const noSnap = fn.findSupersededPages([mk('old'), mk('new', { editCount: 1 })]);
  t('a pair with NO editHistory snapshot is still cleaned', noSnap.length === 1, noSnap.length);
  t('…keeping the newest', noSnap[0] && noSnap[0].keepId === 'new');

  const withSnap = fn.findSupersededPages([
    mk('old'), mk('new', { editCount: 1, editHistory: [{ previous: { totalAmount: 1 } }] })]);
  t('a pair WITH a snapshot is cleaned too', withSnap.length === 1);

  // Still must not touch duplicate CREATEs or real multi-page invoices.
  t('a tie is still left alone', fn.findSupersededPages([mk('x'), mk('y')]).length === 0);
  t('a real multi-page invoice is still left alone',
    fn.findSupersededPages([mk('p1', { page: 1 }), mk('p2', { page: 2 })]).length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
