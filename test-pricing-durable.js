// test-pricing-durable.js — run:  node test-pricing-durable.js
//
// User report: "prices.html shows prices the old one not updated (maybe common prices)".
//
// Measured on live data: 67 prices differed from the last value saved for them on
// pricing.html (41 saves never reached the server, 26 overwritten later — almost all
// aing's, 6 Jun → 12 Sep; e.g. 12 Sep 13:49 ฝาขวด PET for จรัส จันทมณี saved 0.17,
// still 0.18). Three causes in pricing-grouped-sync.js, fixed in v1.0.234:
//   1. a change made while sync wasn't ready waited in MEMORY, and a rejected commit
//      was only logged → lost on leaving the page
//   2. a server snapshot replaced local wholesale → the unsent price flipped back
//   3. every save wrote the product's WHOLE rule map → a stale device reverted every
//      other customer's newer price for that product
//
// Drives the REAL pricing-grouped-sync.js — its exported pure helpers under node, and
// the REAL stateful PricingSync evaluated against a fake Firestore/DB/Sync — plus the
// REAL sync.js pending-bar methods that now include price changes.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const H = require('./pricing-grouped-sync.js');
const src = fs.readFileSync(path.join(DIR, 'pricing-grouped-sync.js'), 'utf8');

// ── fake environment for the stateful module ───────────────────────────────────
const DEL = { __delete: true };
function makeEnv({ ready = true, online = true, store, deviceId = 'devA' } = {}) {
  const cache = store || {};                       // persisted across "reloads" when passed in
  const logs = [], commits = [];
  let failNext = null, hold = null;
  const DB = {
    K: { PRICING: 'wt_pricing' },
    ready: Promise.resolve(),
    _getObj: (k, d) => (Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : d),
    setLocalOnly: (k, v) => { cache[k] = JSON.parse(JSON.stringify(v)); },   // simulate persistence
    getPricing: () => cache.wt_pricing || [],
    _set: (k, v) => { cache[k] = v; },
    logError: (type, msg) => logs.push({ type, msg }),
  };
  const db = {
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push({ pid: ref.id, data, opts }); },
        delete(ref) { ops.push({ pid: ref.id, deleted: true }); },
        commit() {
          if (failNext) { const e = failNext; failNext = null; return Promise.reject(e); }
          if (hold) { const h = hold; hold = null; return h.promise.then(() => { commits.push(ops); }); }
          commits.push(ops); return Promise.resolve();
        },
      };
    },
  };
  let listener = null;
  const colRef = { doc: id => ({ id }), onSnapshot: (opts, cb) => { listener = cb; return () => {}; } };
  const Sync = {
    ready, _online: online, _db: db, _deviceId: deviceId, _orgId: 'main',
    _orgRef: () => ({ collection: () => colRef }),
    _deviceName: () => 'PC-' + deviceId,
    emits: 0, _emitUploadState() { this.emits++; },
    _reasonFromError: e => ({ kind: 'error', code: String(e.code || ''), message: String(e.message || ''), at: new Date(Date.now()).toISOString() }),
  };
  const firebase = { firestore: { FieldValue: { delete: () => DEL, serverTimestamp: () => 'SERVER_TS' } } };
  const ss = {}; const sessionStorage = { getItem: k => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); } };
  const window = { addEventListener() {}, dispatchEvent() {}, Sync, firebase };
  class CustomEvent { constructor(n, o) { this.type = n; this.detail = o && o.detail; } }
  new Function('window', 'module', 'DB', 'Sync', 'firebase', 'sessionStorage', 'console', 'CustomEvent', src)(
    window, undefined, DB, Sync, firebase, sessionStorage, { log() {}, warn() {}, error() {} }, CustomEvent);
  const PS = window.PricingSync;
  return {
    PS, DB, Sync, cache, logs, commits,
    failWith(e) { failNext = e; },
    holdCommit() { let release; const promise = new Promise(r => { release = r; }); hold = { promise }; return () => release(); },
    // simulate the user saving on pricing.html: DB._set → onLocalChange(prev, next) with
    // prev === next (the in-place-mutation reality described in CLAUDE.md)
    edit(mutator) { const arr = DB.getPricing(); mutator(arr); cache.wt_pricing = arr; PS.onLocalChange(arr, arr); },
    snapshot(rules, { fromCache = false, pendingPids = [] } = {}) {
      const groups = H.groupByProduct(rules);
      const docs = [...groups.entries()].map(([pid, r]) => ({ id: pid, data: () => ({ productId: pid, rules: r }), metadata: { hasPendingWrites: pendingPids.includes(pid) } }));
      listener({ metadata: { fromCache }, empty: docs.length === 0, size: docs.length, docs, docChanges: () => [] });
    },
  };
}
const rule = (id, productId, customerId, price, ship = 'จัดส่ง') => ({ id, productId, customerId, shippingMethod: ship, price });
const clone = a => JSON.parse(JSON.stringify(a));
const lastCommit = env => env.commits[env.commits.length - 1] || [];

(async () => {
  // ── pure helpers ────────────────────────────────────────────────────────────
  console.log('pure helpers');
  {
    t('hashRule ignores field order', H.hashRule({ id: 'a', price: 1, productId: 'P' }) === H.hashRule({ productId: 'P', price: 1, id: 'a' }));
    t('hashRule ignores _by/_ts metadata', H.hashRule({ id: 'a', price: 1 }) === H.hashRule({ id: 'a', price: 1, _by: 'd', _ts: 5 }));
    t('hashRule sees a price change', H.hashRule({ id: 'a', price: 1 }) !== H.hashRule({ id: 'a', price: 1.05 }));
    t('hashRule sees a nested change', H.hashRule({ id: 'a', x: { y: 1 } }) !== H.hashRule({ id: 'a', x: { y: 2 } }));

    const server = [rule('r1', 'P1', 'C1', 1.3), rule('r2', 'P1', 'C2', 1.5), rule('r3', 'P2', 'C1', 3)];
    const base = H.baselineFromRules(server);
    t('no change → no ops', H.diffRules(base, clone(server)).length === 0);
    const edited = clone(server); edited[0].price = 1.4;
    const ops = H.diffRules(base, edited);
    t('one edit → exactly one op, for that rule', ops.length === 1 && ops[0].ruleId === 'r1' && ops[0].pid === 'P1' && ops[0].rule.price === 1.4);
    const deleted = server.filter(r => r.id !== 'r2');
    const d = H.diffRules(base, deleted);
    t('a deleted rule → one delete op', d.length === 1 && d[0].ruleId === 'r2' && d[0].rule === null);
    const added = clone(server).concat([rule('r9', 'P2', 'C9', 7)]);
    t('a new rule → one upsert op', H.diffRules(base, added).map(o => o.ruleId).join() === 'r9');
    const moved = clone(server); moved[2].productId = 'P5';
    const m = H.diffRules(base, moved);
    t('a rule moved to another product → delete old + upsert new',
      m.length === 2 && m.some(o => o.pid === 'P2' && o.rule === null) && m.some(o => o.pid === 'P5' && o.rule && o.rule.id === 'r3'));

    const q1 = H.reconcileQueue({}, ops, 100, null);
    t('queue holds the op with since/at', Object.values(q1)[0].since === 100 && Object.values(q1)[0].at === 100);
    const q2 = H.reconcileQueue(q1, H.diffRules(base, edited), 200, null);
    t('the same pending change is kept untouched (same at)', Object.values(q2)[0].at === 100);
    const again = clone(edited); again[0].price = 1.45;
    const q3 = H.reconcileQueue(q1, H.diffRules(base, again), 300, null);
    t('a newer value keeps when it FIRST started waiting', Object.values(q3)[0].since === 100 && Object.values(q3)[0].at === 300 && Object.values(q3)[0].rule.price === 1.45);
    t('edited back to the server value → dropped from the queue', Object.keys(H.reconcileQueue(q1, H.diffRules(base, clone(server)), 400, null)).length === 0);

    const shown = H.applyQueue(server, q1);
    t('overlay: unsent price wins over the server copy', shown.find(r => r.id === 'r1').price === 1.4 && shown.length === 3);
    const qd = H.reconcileQueue({}, d, 1, null);
    t('overlay: unsent delete hides the rule', !H.applyQueue(server, qd).some(r => r.id === 'r2'));
    const pay = H.queueToPayloads(Object.assign({}, q1, qd));
    t('payload: one entry per product, only the changed rules', pay.size === 1 && Object.keys(pay.get('P1')).sort().join() === 'r1,r2' && pay.get('P1').r2 === null);
  }

  // ── cause 1: saved while not connected, survives a reload ─────────────────────
  console.log('\ncause 1 — a change made while sync is not ready is kept and uploaded later');
  {
    const store = { wt_pricing: [rule('r1', 'P1', 'C1', 1.3), rule('r2', 'P1', 'C2', 1.5)] };
    const a = makeEnv({ ready: false, store });
    await tick();
    a.edit(arr => { arr[0].price = 1.4; });
    await tick();
    const q = a.cache.wt_price_pending;
    t('the change is written to the durable queue', q && Object.keys(q).length === 1);
    t('reason recorded: not connected', Object.values(q)[0].reason && Object.values(q)[0].reason.kind === 'not-ready');
    t('nothing was sent yet', a.commits.length === 0);
    t('the pending bar can see it', a.PS.pendingSummary() && a.PS.pendingSummary().count === 1);

    // "reload": a new page with the same persisted storage, now connected
    const b = makeEnv({ ready: true, store: a.cache });
    b.PS.init();
    await tick();
    const c = lastCommit(b);
    t('after reload it is uploaded', b.commits.length === 1);
    t('only that rule is sent', c.length === 1 && Object.keys(c[0].data.rules).join() === 'r1' && c[0].data.rules.r1.price === 1.4);
    t('as a field-level merge', c[0].opts && c[0].opts.merge === true);
    t('the queue is empty afterwards', Object.keys(b.cache.wt_price_pending || {}).length === 0);
    t('the baseline now matches what was sent', b.cache.wt_price_baseline.r1[1] === H.hashRule(rule('r1', 'P1', 'C1', 1.4)));
  }

  console.log('\ncause 1 — a refused upload is kept, explained and retried');
  {
    const e = makeEnv({ store: { wt_pricing: [rule('r1', 'P1', 'C1', 1.3)] } });
    e.PS.init(); await tick();
    e.failWith(Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' }));
    e.edit(arr => { arr[0].price = 1.4; });
    await tick();
    const op = Object.values(e.cache.wt_price_pending || {})[0];
    t('still queued after the refusal', !!op);
    t('with the Firebase reason', op && op.reason && op.reason.code === 'resource-exhausted');
    t('and a failure count', op && op.attempts === 1);
    t('logged to Troubleshoot as PRICE-SYNC-FAIL', e.logs.some(l => l.type === 'PRICE-SYNC-FAIL'));
    await e.PS._flushPending(); await tick();
    t('the retry uploads it', e.commits.length === 1 && lastCommit(e)[0].data.rules.r1.price === 1.4);
    t('and clears the queue', Object.keys(e.cache.wt_price_pending || {}).length === 0);
  }

  // ── cause 2: the server copy no longer undoes an unsent change ───────────────
  console.log('\ncause 2 — a server snapshot with the old price does not undo the unsent one');
  {
    const e = makeEnv({ ready: false, store: { wt_pricing: [rule('r1', 'P1', 'C1', 0.18), rule('r2', 'P1', 'C2', 0.16)] } });
    await tick();
    e.edit(arr => { arr[0].price = 0.17; });           // aing, 12 Sep: 0.18 → 0.17
    // the upload is refused (set up BEFORE init, which starts it immediately) …
    e.failWith(Object.assign(new Error('x'), { code: 'unavailable' }));
    e.Sync.ready = true; e.PS.init();
    await tick();
    // … and still refused when the snapshot's arrival triggers a retry
    e.failWith(Object.assign(new Error('x'), { code: 'unavailable' }));
    e.snapshot([rule('r1', 'P1', 'C1', 0.18), rule('r2', 'P1', 'C2', 0.16)]);   // server still 0.18
    await tick();
    const shown = e.cache.wt_pricing.find(r => r.id === 'r1');
    t('the screen keeps the saved 0.17', shown && shown.price === 0.17, shown && shown.price);
    t('the other customer is untouched', e.cache.wt_pricing.find(r => r.id === 'r2').price === 0.16);
    t('the change is still queued', Object.keys(e.cache.wt_price_pending || {}).length === 1);
    t('the baseline is the server (0.18), so it stays a difference', e.cache.wt_price_baseline.r1[1] === H.hashRule(rule('r1', 'P1', 'C1', 0.18)));
    t('the snapshot triggered a retry', Object.values(e.cache.wt_price_pending)[0].attempts === 2);
    // once the server accepts writes again, the next retry lands 0.17
    await e.PS._flushPending(); await tick();
    t('when the refusal clears, 0.17 is uploaded', lastCommit(e)[0] && lastCommit(e)[0].data.rules.r1.price === 0.17);
    t('and nothing is left pending', Object.keys(e.cache.wt_price_pending || {}).length === 0);
  }

  // ── cause 3: a stale device cannot overwrite other customers ─────────────────
  console.log('\ncause 3 — a device with old prices uploads only the price it changed');
  {
    // server already has C1 = 12 (set elsewhere); this device still has C1 = 10
    const e = makeEnv({ store: { wt_pricing: [rule('rA', 'P1', 'C1', 10), rule('rB', 'P1', 'C2', 5)] } });
    await tick();
    e.PS._ready = false;                                 // no snapshot has arrived here yet
    e.edit(arr => { arr[1].price = 6; });                // edits C2 only
    e.PS._ready = true; e.PS._db = e.Sync._db;
    await e.PS._flushPending(); await tick();
    const c = lastCommit(e)[0];
    t('the write contains ONLY the edited rule', c && Object.keys(c.data.rules).join() === 'rB', c && Object.keys(c.data.rules).join());
    t('C1\'s stale 10 is never sent', !JSON.stringify(c).includes('"price":10'));
    t('merge: true, so the rest of the product document is left alone', c.opts.merge === true);
  }

  // ── deletes, moves, edit-back, first run ──────────────────────────────────────
  console.log('\nother changes');
  {
    const e = makeEnv({ store: { wt_pricing: [rule('r1', 'P1', 'C1', 1), rule('r2', 'P1', 'C2', 2)] } });
    e.PS.init(); await tick();
    e.edit(arr => { arr.splice(1, 1); });
    await tick();
    const c = lastCommit(e)[0];
    t('a deleted rule is removed with FieldValue.delete()', c && c.data.rules.r2 === DEL && c.opts.merge === true);
    t('and dropped from the baseline', !e.cache.wt_price_baseline.r2);

    const f = makeEnv({ ready: false, store: { wt_pricing: [rule('r1', 'P1', 'C1', 1)] } });
    await tick();
    f.edit(arr => { arr[0].price = 2; });
    f.edit(arr => { arr[0].price = 1; });               // changed back before it was sent
    t('edited back before sending → nothing pending', Object.keys(f.cache.wt_price_pending || {}).length === 0);

    const g = makeEnv({ store: { wt_pricing: [rule('r3', 'P2', 'C1', 3)] } });
    g.PS.init(); await tick();
    g.edit(arr => { arr[0].productId = 'P5'; });
    await tick();
    const all = g.commits.flat();
    t('moving a rule to another product deletes it from the old document',
      all.some(o => o.pid === 'P2' && o.data.rules.r3 === DEL));
    t('…and writes it to the new one', all.some(o => o.pid === 'P5' && o.data.rules.r3 && o.data.rules.r3.productId === 'P5'));
  }

  console.log('\nfirst run after upgrading: no mass re-upload');
  {
    const many = Array.from({ length: 120 }, (_, i) => rule('r' + i, 'P' + (i % 7), 'C' + i, i));
    const e = makeEnv({ store: { wt_pricing: many } });  // no wt_price_baseline stored yet
    await tick();
    t('a baseline is created from local at load', e.cache.wt_price_baseline && Object.keys(e.cache.wt_price_baseline).length === 120);
    e.PS.init(); await tick();
    t('nothing is uploaded just for loading', e.commits.length === 0);
    e.edit(arr => { arr[5].price = 999; });
    await tick();
    const rulesSent = e.commits.flat().reduce((n, o) => n + Object.keys(o.data.rules).length, 0);
    t('one edit uploads exactly one rule, not 120', rulesSent === 1, String(rulesSent));
  }

  console.log('\nre-edited while uploading');
  {
    const e = makeEnv({ store: { wt_pricing: [rule('r1', 'P1', 'C1', 1)] } });
    e.PS.init(); await tick();
    const release = e.holdCommit();
    e.edit(arr => { arr[0].price = 2; });                // commit starts, held
    await tick();
    e.edit(arr => { arr[0].price = 3; });                // re-edited mid-flight
    release(); await tick(8);
    const prices = e.commits.flat().map(o => o.data.rules.r1 && o.data.rules.r1.price);
    t('the in-flight value is sent', prices.includes(2));
    t('the newer value is sent afterwards, not lost', prices[prices.length - 1] === 3, JSON.stringify(prices));
    t('nothing left pending', Object.keys(e.cache.wt_price_pending || {}).length === 0);
  }

  console.log('\nconcurrency and snapshots');
  {
    const e = makeEnv({ store: { wt_pricing: [rule('r1', 'P1', 'C1', 1)] } });
    e.PS.init(); await tick();
    const release = e.holdCommit();
    e.edit(arr => { arr[0].price = 2; });
    await e.PS._flushPending();                          // second call while the first is running
    release(); await tick(8);
    t('a second flush while one is running sends nothing extra', e.commits.length === 1);

    const s = makeEnv({ store: { wt_pricing: [rule('r1', 'P1', 'C1', 1), rule('r2', 'P2', 'C1', 5)] } });
    s.PS.init(); await tick();
    s.snapshot([rule('r1', 'P1', 'C1', 9), rule('r2', 'P2', 'C1', 7)], { pendingPids: ['P1'] });
    t('a doc carrying an un-acked local write keeps its old baseline',
      s.cache.wt_price_baseline.r1[1] === H.hashRule(rule('r1', 'P1', 'C1', 1)));
    t('other docs take the server value', s.cache.wt_price_baseline.r2[1] === H.hashRule(rule('r2', 'P2', 'C1', 7)));
    s.snapshot([rule('r1', 'P1', 'C1', 9)], { fromCache: true });
    t('a from-cache snapshot never rewrites the baseline', !!s.cache.wt_price_baseline.r2);
  }

  // ── the pending-upload bar (sync.js) ──────────────────────────────────────────
  console.log('\nthe pending-upload bar shows price changes');
  {
    const syncSrc = fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8');
    const slice = marker => {
      const start = syncSrc.indexOf(marker); if (start < 0) throw new Error('marker ' + marker);
      let depth = 0, i = syncSrc.indexOf('{', start), end = -1;
      for (; i < syncSrc.length; i++) { if (syncSrc[i] === '{') depth++; else if (syncSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
      return syncSrc.slice(start, end);
    };
    const M = ['_extraPending() {', '_queuedCount() {', '_uploadActiveCount() {', '_getQueue() {', '_UPLOAD_KEY_NAMES: {',
      '_uploadKeyName(k) {', '_fmtTime(ms, now) {', '_uploadInfoRows(now) {', '_escHtml(s) {', '_describeReason(r, ctx) {',
      '_quotaResetAt(nowMs) {', '_uploadHeadline(ctx) {'].map(slice).join(',\n');
    const fakePS = { _flushing: false, pendingSummary() { return this._s; }, _s: null };
    const ls = {};
    const S = new Function('window', 'PricingSync', 'localStorage', 'Utils', `return { ${M} };`)(
      { PricingSync: fakePS }, fakePS, { getItem: k => ls[k] || null }, { formatDateTH: s => s });
    Object.assign(S, { _pendingLsKey: 'wt_sync_pending', _pendingWrite: {}, _pushDebounce: {}, _docDebounce: {}, _online: true, ready: true });
    t('no pending prices → nothing extra', S._queuedCount() === 0 && S._extraPending().length === 0);
    const now = Date.now();
    fakePS._s = { key: 'wt_pricing', ts: now - 60000, since: now - 60000, count: 3, flushing: false,
      reason: { kind: 'error', code: 'resource-exhausted', message: 'Quota exceeded.', at: new Date(now).toISOString() } };
    t('pending prices count as one waiting data type', S._queuedCount() === 1);
    const rows = S._uploadInfoRows(now);
    t('listed as ราคาสินค้า (3 รายการ)', rows.some(r => r.name === 'ราคาสินค้า (3 รายการ)'), JSON.stringify(rows));
    t('with when it started waiting and the failed try', rows.some(r => /ค้างตั้งแต่/.test(r.detail) && /ไม่สำเร็จ/.test(r.detail)));
    t('the headline explains the price upload failure', /resource-exhausted/.test(S._uploadHeadline({})));
    fakePS._s.flushing = true; fakePS._flushing = true;
    t('while being sent it counts as uploading, not waiting', S._queuedCount() === 0 && S._uploadActiveCount() === 1);
    t('retry also sends price changes', /PricingSync\._flushPending\(\)/.test(slice('async retryPendingUploads() {')));
    t('logout (flushNow) also sends price changes', /PricingSync\._flushPending\(\)/.test(slice('async flushNow() {')));
  }

  console.log('\nnever mirrored to the backup folder');
  {
    const lfs = fs.readFileSync(path.join(DIR, 'local-folder-sync.js'), 'utf8');
    const keys = (lfs.match(/DEVICE_LOCAL_KEYS = (\[[^\]]*\])/) || [])[1] || '';
    t('the queue and baseline are excluded like the device id', /wt_price_pending/.test(keys) && /wt_price_baseline/.test(keys), keys);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
