// test-mass-delete-guard.js — v1.0.239
//
// Covers the two halves of the 23 Sep 2026 customer/pricing wipe:
//   1. Sync.massDeleteBlocked — the proportional guard itself, sliced out of sync.js
//      and driven for real.
//   2. The three call sites (collection-sync.js, customer-sync.js,
//      pricing-grouped-sync.js) actually consult it and drop the deletes.
//   3. _cpBuildPlan (settings.js) — the recovery planner, driven on synthetic data.
//
// Run: node test-mass-delete-guard.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ── Slice Sync.massDeleteBlocked out of sync.js and run it for real ──────────
function loadGuard(logSink) {
  const src = read('sync.js');
  const start = src.indexOf('  _MASS_DEL_MIN:');
  if (start < 0) throw new Error('guard block not found in sync.js');
  const end = src.indexOf('\n  },', src.indexOf('massDeleteBlocked(', start));
  if (end < 0) throw new Error('massDeleteBlocked end not found');
  const body = src.slice(start, end + '\n  },'.length);
  const DB = { logError: (type, msg, detail) => logSink.push({ type, msg, detail }) };
  const obj = new Function('DB', 'console', 'return {' + body + '};')(DB, { warn() {} });
  return obj;
}

section('Sync.massDeleteBlocked — proportional rule');
{
  const logs = [];
  const G = loadGuard(logs);

  // The real wipe: 98 of 99 customers.
  t('the 23 Sep customer wipe is blocked (98 of 99)', G.massDeleteBlocked('customers_v2', 98, 99) === true);
  // The real pricing wipe: 3,272 of 3,279.
  t('the pricing wipe is blocked (3,272 of 3,279)', G.massDeleteBlocked('pricing_byproduct', 3272, 3279) === true);

  // The ราคากลาง retirement (v1.0.235) must still go through.
  t('the ราคากลาง retirement passes (59 of 3,279 = 1.8%)',
    G.massDeleteBlocked('pricing_byproduct', 59, 3279) === false);

  // Ordinary deletes.
  t('deleting 1 customer of 99 passes', G.massDeleteBlocked('customers_v2', 1, 99) === false);
  t('deleting 20 of 99 passes (at the count floor)', G.massDeleteBlocked('customers_v2', 20, 99) === false);
  t('deleting 21 of 99 passes — over the count floor but only 21%, under the 30% fraction',
    G.massDeleteBlocked('customers_v2', 21, 99) === false);
  t('deleting 30 of 99 is blocked (21 over the floor AND 30%)',
    G.massDeleteBlocked('customers_v2', 30, 99) === true);

  // BOTH conditions are required — a small collection must not be over-guarded.
  t('deleting 21 of 1000 passes — over the count floor but only 2%',
    G.massDeleteBlocked('customers_v2', 21, 1000) === false);
  t('deleting 3 of 3 passes — 100% but under the count floor',
    G.massDeleteBlocked('customers_v2', 3, 3) === false);

  t('an empty server fingerprint never blocks (nothing to lose)',
    G.massDeleteBlocked('customers_v2', 500, 0) === false);

  // The admin override.
  G.allowMassDelete = true;
  t('allowMassDelete lets a deliberate wipe through', G.massDeleteBlocked('customers_v2', 98, 99) === false);
  G.allowMassDelete = false;
}

section('the block is logged, and throttled so it cannot flush wt_errors');
{
  const logs = [];
  const G = loadGuard(logs);
  G.massDeleteBlocked('customers_v2', 98, 99);
  t('logged once', logs.length === 1, logs.length);
  t('logged as SYNC-DEL-BLOCKED', logs[0].type === 'SYNC-DEL-BLOCKED');
  t('the message carries the real numbers', /98 of 99/.test(logs[0].msg), logs[0].msg.slice(0, 80));
  t('the detail carries the collection', logs[0].detail.collection === 'customers_v2');
  t('the detail carries the percentage', logs[0].detail.pct === 99, logs[0].detail.pct);

  for (let i = 0; i < 50; i++) G.massDeleteBlocked('customers_v2', 98, 99);
  t('50 more blocks in the same minute add no log entries', logs.length === 1, logs.length);
  t('…but they are still blocked', G.massDeleteBlocked('customers_v2', 98, 99) === true);

  // A different collection logs independently.
  G.massDeleteBlocked('pricing_byproduct', 3272, 3279);
  t('a different collection logs its own entry', logs.length === 2, logs.length);

  // Once the throttle window passes, it logs again.
  G._massDelLogged['customers_v2'] = Date.now() - 61000;
  G.massDeleteBlocked('customers_v2', 98, 99);
  t('after 60 s it logs again', logs.length === 3, logs.length);
}

// ── The call sites ──────────────────────────────────────────────────────────
section('collection-sync.js consults the guard and drops the deletes');
{
  const src = read('collection-sync.js');
  const i = src.indexOf('async _pushLocal(next)');
  const body = src.slice(i, src.indexOf('\n      },', i));
  t('deletes is no longer a const (it must be reassignable)', /let deletes =/.test(body));
  t('the guard is called with the collection name and fingerprint size',
    /Sync\.massDeleteBlocked\(this\.cfg\.col, deletes\.length, fp\.size\)/.test(body));
  t('the deletes are emptied when blocked', /deletes = \[\];/.test(body));
  t('the upserts are NOT dropped', !/upserts = \[\]/.test(body));
  t('the guard runs BEFORE the early return',
    body.indexOf('massDeleteBlocked') < body.indexOf('if (!upserts.length && !deletes.length) return;'));
  t('the guard runs BEFORE the commit', body.indexOf('massDeleteBlocked') < body.indexOf('_commit('));
  t('it is guarded on Sync existing (collection-sync loads without sync.js in tests)',
    /typeof Sync !== 'undefined'/.test(body));
}

section('customer-sync.js consults the guard');
{
  const src = read('customer-sync.js');
  const i = src.indexOf('const fp = this._serverFp || new Map();');
  const body = src.slice(i, src.indexOf('await this._commit(upserts, deletes);', i));
  t('deletes is reassignable', /let deletes =/.test(body));
  t('the guard is called with customers_v2', /massDeleteBlocked\('customers_v2', deletes\.length, fp\.size\)/.test(body));
  t('the deletes are emptied when blocked', /deletes = \[\];/.test(body));
  t('the un-acked bookkeeping runs AFTER the guard, so blocked ids are not cleared',
    body.indexOf('massDeleteBlocked') < body.indexOf('_loadUnacked()'));
}

section('pricing-grouped-sync.js consults the guard');
{
  const src = read('pricing-grouped-sync.js');
  const i = src.indexOf('onLocalChange(prev, next)');
  const body = src.slice(i, src.indexOf('\n    },', i));
  t('ops is reassignable', /let ops = diffRules/.test(body));
  t('only the delete ops are counted', /ops\.filter\(o => o\.rule === null\)\.length/.test(body));
  t('the guard is called with pricing_byproduct and the baseline size',
    /massDeleteBlocked\('pricing_byproduct', dels, Object\.keys\(base \|\| \{\}\)\.length\)/.test(body));
  t('blocked → the delete ops are filtered out, upserts kept',
    /ops = ops\.filter\(o => o\.rule !== null\)/.test(body));
  t('the guard runs BEFORE the queue is written',
    body.indexOf('massDeleteBlocked') < body.indexOf('_saveQueue('));
}

// ── The recovery planner ────────────────────────────────────────────────────
function loadPlanner() {
  const src = read('settings.js');
  const start = src.indexOf('const _CP_KEY =');
  const marker = 'let _cpPlan = null;';
  const end = src.indexOf(marker, start);
  if (start < 0 || end < 0) throw new Error('_cpBuildPlan block not found in settings.js');
  return new Function(src.slice(start, end) + '\nreturn _cpBuildPlan;')();
}

section('_cpBuildPlan — the recovery planner');
{
  const buildPlan = loadPlanner();
  const cut = '2026-09-04T15:49:57.706Z';
  const rp = {
    exportDate: cut,
    customers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    pricing: [
      { id: 'r1', customerId: 'a', productId: 'p1', shippingMethod: '', price: 10 },
      { id: 'r2', customerId: 'b', productId: 'p1', shippingMethod: 'จัดส่ง', price: 20 },
      { id: 'r3', customerId: '', productId: 'p1', shippingMethod: '', price: 99 },
    ],
  };
  const history = [
    // Before the cutoff — must be ignored.
    { id: 'h0', customerId: 'a', productId: 'p1', shippingMethod: '', price: 1, changedAt: '2026-08-01T00:00:00.000Z' },
    // After — updates an existing rule.
    { id: 'h1', customerId: 'a', productId: 'p1', shippingMethod: '', price: 11, changedAt: '2026-09-10T00:00:00.000Z' },
    // After — a newer change to the SAME combo must win.
    { id: 'h2', customerId: 'a', productId: 'p1', shippingMethod: '', price: 12, changedAt: '2026-09-20T00:00:00.000Z' },
    // After — a combo the restore point never had.
    { id: 'h3', customerId: 'b', productId: 'p2', shippingMethod: '', price: 30, changedAt: '2026-09-12T00:00:00.000Z' },
  ];
  const curCustomers = [{ id: 'C1', name: 'ร้านทดสอบ' }];
  const curPricing = [{ id: 'seed', customerId: 'C1', productId: 'p9', shippingMethod: '', price: 5 }];

  const plan = buildPlan(rp, history, curCustomers, curPricing);
  const byKey = k => plan.pricing.find(r => [r.customerId || '', r.productId || '', r.shippingMethod || ''].join('|') === k);

  t('every restore-point customer is present', plan.customers.filter(c => c.id === 'a' || c.id === 'b').length === 2);
  t('the current seed customer is kept, not silently dropped', !!plan.customers.find(c => c.id === 'C1'));
  t('customer count', plan.stats.custTo === 3, plan.stats.custTo);

  t('a pre-cutoff history entry is ignored', byKey('a|p1|').price !== 1);
  t('a post-cutoff change is replayed', byKey('a|p1|').price === 12, byKey('a|p1|').price);
  t('the NEWEST post-cutoff change wins, not the first seen', byKey('a|p1|').price === 12);
  t('an untouched rule keeps its restore-point value', byKey('b|p1|จัดส่ง').price === 20);
  t('a combo only in history is added', !!byKey('b|p2|') && byKey('b|p2|').price === 30);
  t('a current rule the replay did not cover is kept', !!byKey('C1|p9|'));
  t('ราคากลาง rules are counted', plan.stats.std === 1, plan.stats.std);

  t('stats: replayed counts only post-cutoff entries', plan.stats.replayed === 3, plan.stats.replayed);
  t('stats: updates vs adds', plan.stats.replayUpd === 2 && plan.stats.replayAdd === 1,
    [plan.stats.replayUpd, plan.stats.replayAdd]);
  t('stats: the before counts come from current local', plan.stats.custFrom === 1 && plan.stats.priceFrom === 1);
  t('stats: the cutoff is carried through', plan.stats.cutoff === cut);

  // Invoices/payments/products/users are never part of the plan.
  t('the plan writes ONLY customers and pricing',
    Object.keys(plan).sort().join(',') === 'customers,pricing,stats',
    Object.keys(plan).sort());

  // A bad file must be refused, not silently produce an empty wipe.
  let threw = false;
  try { buildPlan({}, [], [], []); } catch (e) { threw = true; }
  t('a file with no customers/pricing is refused', threw);
  threw = false;
  try { buildPlan(null, [], [], []); } catch (e) { threw = true; }
  t('a null file is refused', threw);

  // The planner must never return fewer customers than the restore point holds.
  t('the plan can never shrink below the restore point',
    plan.customers.length >= rp.customers.length);
}

section('the card is admin-gated and cannot be reached by a non-admin');
{
  const src = read('settings.js');
  const i = src.indexOf('async function renderCustPriceRestore()');
  const body = src.slice(i, src.indexOf('\nfunction _cpPaintPicker', i));
  t('render checks Auth.isAdmin (lowercase role, via the helper)', /Auth\.isAdmin\(\)/.test(body));
  t('render does NOT compare role to the capitalised "Admin"', !/'Admin'/.test(body));
  const j = src.indexOf('async function runCustPriceRestore()');
  const run = src.slice(j);
  t('the action re-checks admin, not just the render', /Auth\.isAdmin\(\)/.test(run));
  t('the action confirms before writing', run.indexOf('Utils.confirm') < run.indexOf('DB.saveCustomers'));
  t('the confirm is awaited (Tauri window.confirm returns a Promise)', /await Utils\.confirm\(/.test(run));
  t('it waits for the HDD writes before reporting success',
    run.indexOf('waitForHddWrites') < run.indexOf("showAlert('กู้คืนแล้ว"));
  t('and flushes to the server before reporting success',
    run.indexOf('Sync.flushNow') < run.indexOf("showAlert('กู้คืนแล้ว"));
  t('a failure is logged, not swallowed', /CUST-PRICE-RESTORE-FAIL/.test(run));
  t('it never touches invoices or payments',
    !/saveInvoices|savePayments|deleteInvoice/.test(run));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
