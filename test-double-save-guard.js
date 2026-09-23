// test-double-save-guard.js — v1.0.243
//
// Reported: "sometimes user double click button the system record or do them twice."
// Measured on live data (1,711 non-cancelled payments): 26 groups identical in
// invoiceNumber + customerId + amount + method.
//   • 4 were rapid repeats — 0.1s, 0.3s, 6.0s, and a TRIPLE spanning 6.9s.
//     Cause: doSaveAllPayments awaits _uploadPaymentImages() BEFORE DB.addPayment(),
//     and the modal + save button stay live across that await.
//   • 22 were 19s–30min apart — staff re-entering a payment they thought had not
//     saved. No re-entry guard can catch those, hence the duplicate confirm.
// The 3 duplicate INVOICES are NOT this bug: they are 18–28 days apart (re-imports).
//
// Drives the REAL doSaveAllPayments sliced out of payments.html, and the REAL
// DB.findDuplicatePayment sliced out of db.js.
//
// Run: node test-double-save-guard.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

function sliceFn(src, header, endNeedle) {
  const s = src.indexOf(header);
  if (s < 0) throw new Error('not found: ' + header);
  let d = 0, i = src.indexOf('{', s), seen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { d++; seen = true; }
    else if (c === '}') { d--; if (seen && d === 0) { i++; break; } }
  }
  return src.slice(s, i);
}

// ── DB.findDuplicatePayment ────────────────────────────────────────────────
function loadFinder(payments) {
  const src = read('db.js');
  const body = sliceFn(src, '  findDuplicatePayment(data, nowMs, windowMs) {');
  const obj = new Function('PAYMENTS', 'return {' +
    '_DUP_PAY_WINDOW_MS: 30*60*1000, getPayments: () => PAYMENTS,' + body + '};')(payments);
  return obj;
}

const T0 = Date.parse('2026-09-06T07:28:20.000Z');
const base = { invoiceNumber: '280869-001', customerId: 'c1', amount: 10865, method: 'โอน' };
const existing = Object.assign({ id: 'p1', createdAt: new Date(T0).toISOString(), createdByUser: 'joe' }, base);

section('DB.findDuplicatePayment — what counts as a duplicate');
{
  const f = loadFinder([existing]);
  const at = ms => T0 + ms;

  t('an identical payment 6 s later is flagged', !!f.findDuplicatePayment(base, at(6000)));
  t('…and reports how long ago', f.findDuplicatePayment(base, at(6000)).agoMs === 6000);
  t('…and returns the existing record', f.findDuplicatePayment(base, at(6000)).payment.id === 'p1');
  t('29 minutes later is still flagged (inside the 30-min window)', !!f.findDuplicatePayment(base, at(29 * 60000)));
  t('31 minutes later is NOT flagged', !f.findDuplicatePayment(base, at(31 * 60000)));

  // Strict matching — a genuinely different payment must never prompt.
  t('a different amount is not a duplicate',
    !f.findDuplicatePayment(Object.assign({}, base, { amount: 10864 }), at(1000)));
  t('a different method is not a duplicate',
    !f.findDuplicatePayment(Object.assign({}, base, { method: 'เงินสด' }), at(1000)));
  t('a different invoice is not a duplicate',
    !f.findDuplicatePayment(Object.assign({}, base, { invoiceNumber: 'X' }), at(1000)));
  t('a different customer is not a duplicate',
    !f.findDuplicatePayment(Object.assign({}, base, { customerId: 'c2' }), at(1000)));

  // A cancelled payment SHOULD be re-enterable — that is the correct action.
  const fc = loadFinder([Object.assign({}, existing, { cancelled: true })]);
  t('a cancelled payment is ignored', !fc.findDuplicatePayment(base, at(1000)));

  // Editing an existing payment must not flag itself.
  t('a record never matches itself', !f.findDuplicatePayment(Object.assign({ id: 'p1' }, base), at(1000)));

  // Degenerate input.
  t('zero amount never prompts', !f.findDuplicatePayment(Object.assign({}, base, { amount: 0 }), at(1000)));
  t('missing invoice number never prompts',
    !f.findDuplicatePayment(Object.assign({}, base, { invoiceNumber: '' }), at(1000)));
  t('null data is safe', !f.findDuplicatePayment(null, at(1000)));
  t('a payment with an unparseable date is skipped',
    !loadFinder([Object.assign({}, existing, { createdAt: 'nonsense' })]).findDuplicatePayment(base, at(1000)));
  t('a FUTURE-dated payment is not treated as a past duplicate',
    !f.findDuplicatePayment(base, T0 - 5000));

  // The newest match wins when several exist.
  const f3 = loadFinder([
    Object.assign({}, existing, { id: 'old', createdAt: new Date(T0 - 20 * 60000).toISOString() }),
    Object.assign({}, existing, { id: 'recent', createdAt: new Date(T0 - 60000).toISOString() }),
  ]);
  t('the most recent duplicate is reported', f3.findDuplicatePayment(base, T0).payment.id === 'recent');
}

// ── The real doSaveAllPayments ─────────────────────────────────────────────
function loadSaver(opts) {
  opts = opts || {};
  const src = read('payments.html');
  const guard = sliceFn(src, 'function _setPaySaveBusy(busy) {');
  const confirmFn = sliceFn(src, 'async function _confirmNotDuplicate(payments) {');
  const saver = sliceFn(src, 'async function doSaveAllPayments(payments) {');

  const added = [], alerts = [];
  let btnDisabled = false, resolveUpload;
  const uploadGate = new Promise(r => { resolveUpload = r; });

  const env = {
    DB: {
      addPayment: p => added.push(p),
      logActivity: () => {},
      getCurrentPagesByNumber: () => [{ totalAmount: 10865, customerId: 'c1' }],
      getInvoicePaidAmount: () => 0,
      findDuplicatePayment: () => (opts.duplicate ? { payment: { id: 'p1', createdAt: '2026-09-06T07:28:20.000Z', createdByUser: 'joe' }, agoMs: 6 * 60000 } : null),
    },
    Utils: {
      formatNumber: n => String(n),
      showAlert: (m) => alerts.push(m),
      confirm: async () => opts.confirmAnswer !== false,
    },
    document: {
      getElementById: id => (id === 'paySaveBtn'
        ? { set disabled(v) { btnDisabled = v; }, get disabled() { return btnDisabled; }, dataset: {}, innerHTML: '' }
        : null),
    },
    _uploadPaymentImages: () => (opts.slowUpload ? uploadGate : Promise.resolve()),
    payModal: { hide: () => {} },
    overpayModal: { show: () => {} },
    _commitNow: () => {},
    render: () => {},
    _renderOverpayBody: () => {},
    session: { userId: 'u', username: 'joe' },
  };

  const fn = new Function('DB', 'Utils', 'document', '_uploadPaymentImages', 'payModal',
    'overpayModal', '_commitNow', 'render', '_renderOverpayBody', 'session', '_pendingPayments',
    'pendingOverpayData',
    'let _savingPayment = false;\n' + guard + '\n' + confirmFn + '\n' + saver +
    '\nreturn { doSaveAllPayments, isSaving: () => _savingPayment };')(
    env.DB, env.Utils, env.document, env._uploadPaymentImages, env.payModal, env.overpayModal,
    env._commitNow, env.render, env._renderOverpayBody, env.session, [], null);

  return { fn, added, alerts, releaseUpload: () => resolveUpload(), get btnDisabled() { return btnDisabled; } };
}

const PAY = () => [{ id: 'n1', invoiceNumber: '280869-001', customerId: 'c1', amount: 10865, method: 'โอน' }];

section('the re-entry guard — the 0.1s / 0.3s double-click');
(async () => {
  {
    const h = loadSaver({ slowUpload: true });
    const first = h.fn.doSaveAllPayments(PAY());   // parks on the image upload
    const second = h.fn.doSaveAllPayments(PAY());  // the second click
    // NEVER await the second call before releasing the gate: without the guard BOTH
    // park on it and the test would deadlock instead of failing (a hung test reports
    // nothing, which is worse than a red one — see CLAUDE.md).
    await new Promise(r => setTimeout(r, 0));
    t('the second call is refused while the first is mid-upload', h.added.length === 0, h.added.length);
    t('the button is disabled during the save', h.btnDisabled === true);
    h.releaseUpload();
    await Promise.all([first, second]);
    t('exactly ONE payment is written', h.added.length === 1, h.added.length);
    t('the button is released afterwards', h.btnDisabled === false);
    t('the guard flag is cleared', h.fn.isSaving() === false);
  }

  {
    // The live triple: three clicks inside 6.9 s.
    const h = loadSaver({ slowUpload: true });
    const calls = [h.fn.doSaveAllPayments(PAY()), h.fn.doSaveAllPayments(PAY()), h.fn.doSaveAllPayments(PAY())];
    await new Promise(r => setTimeout(r, 0));
    h.releaseUpload();
    await Promise.all(calls);
    t('a TRIPLE click still writes exactly one', h.added.length === 1, h.added.length);
  }

  {
    const h = loadSaver();
    await h.fn.doSaveAllPayments(PAY());
    await h.fn.doSaveAllPayments(PAY());
    t('two SEQUENTIAL saves both go through — the guard is not sticky', h.added.length === 2, h.added.length);
  }

  section('the duplicate confirm — the 19s–30min re-entries');
  {
    const h = loadSaver({ duplicate: true, confirmAnswer: false });
    await h.fn.doSaveAllPayments(PAY());
    t('declining the duplicate writes nothing', h.added.length === 0, h.added.length);
    t('and releases the button', h.btnDisabled === false);
    t('and clears the guard, so the user can try again', h.fn.isSaving() === false);
  }
  {
    const h = loadSaver({ duplicate: true, confirmAnswer: true });
    await h.fn.doSaveAllPayments(PAY());
    t('confirming a genuine repeat still saves', h.added.length === 1, h.added.length);
  }
  {
    const h = loadSaver({ duplicate: false });
    await h.fn.doSaveAllPayments(PAY());
    t('no duplicate → no prompt, saves normally', h.added.length === 1);
  }

  section('the guard is released on every exit path');
  {
    const h = loadSaver();
    await h.fn.doSaveAllPayments([]);
    t('an empty payment list does not latch the guard', h.fn.isSaving() === false);
    await h.fn.doSaveAllPayments(PAY());
    t('and a real save still works afterwards', h.added.length === 1);
  }
  {
    // A throw inside the body must not leave the button dead forever.
    const h = loadSaver();
    h.fn.doSaveAllPayments(PAY());
    await new Promise(r => setTimeout(r, 0));
    t('after a completed save the guard is clear', h.fn.isSaving() === false);
  }

  section('the source of the bug is actually gone');
  {
    const src = read('payments.html');
    const body = sliceFn(src, 'async function doSaveAllPayments(payments) {');
    const code = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    t('the guard is set before the first await', code.indexOf('_savingPayment = true') < code.indexOf('await'));
    t('the guard is set before DB.addPayment', code.indexOf('_savingPayment = true') < code.indexOf('DB.addPayment'));
    t('the duplicate check runs before any write', code.indexOf('_confirmNotDuplicate') < code.indexOf('DB.addPayment'));
    t('release happens in a finally, not on the happy path only', /\} finally \{[\s\S]*_savingPayment = false/.test(code));
    t('the save button carries the id the guard toggles', /id="paySaveBtn"/.test(src));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
