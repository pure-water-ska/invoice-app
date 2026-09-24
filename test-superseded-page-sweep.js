// test-superseded-page-sweep.js — v1.0.242
//
// Root cause (measured on live data, 2026-09-23): saveInvoiceEdit() deletes the
// pre-edit page docs with a bare batch.commit() that is never retried, and the
// tombstone hiding them expires after Sync._tombstoneTTL (30 MINUTES) — at which
// point _applyTombstones CLEARS the marker for every device (_fsClearDeletions)
// and RE-ADMITS the stale doc. One missed commit therefore leaves the old page
// live forever: 10 of 26 ever-edited invoice numbers, 8 of them AFTER the explicit
// delete shipped in v1.0.185 (a 47% failure rate).
//
// Covers:
//   1. DB.findSupersededPages — which records are safely superseded, and which are
//      deliberately left alone (duplicate CREATEs, multi-page invoices).
//   2. Sync.sweepSupersededPages — the repair: local removal, tombstone, batch
//      delete, the mass-delete cap, and the retry-next-session behaviour.
//   3. The INV-TRACE gating that keeps the error ring readable.
//
// Both functions are SLICED OUT of db.js / sync.js and driven for real.
//
// Run: node test-superseded-page-sweep.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ── Slice DB.findSupersededPages out of db.js ───────────────────────────────
function loadDetector() {
  const src = read('db.js');
  const s = src.indexOf('  findSupersededPages(invoices) {');
  if (s < 0) throw new Error('findSupersededPages not found in db.js');
  const e = src.indexOf('\n  },', src.indexOf('return out;', s));
  if (e < 0) throw new Error('findSupersededPages end not found');
  const obj = new Function('return {' + src.slice(s, e + 5) + '};')();
  return arr => obj.findSupersededPages(arr);
}

section('DB.findSupersededPages — what counts as superseded');
{
  const find = loadDetector();
  const mk = (o) => Object.assign({ invoiceNumber: 'A', customerId: 'c1', page: 1 }, o);

  // The reported case: 180769-001, stale 23,665 (no editCount) vs current 22,715.
  const g = find([mk({ id: 'old', totalAmount: 23665 }), mk({ id: 'new', totalAmount: 22715, editCount: 1 })]);
  t('an edit duplicate is found', g.length === 1, g.length);
  t('the newest record is kept', g[0] && g[0].keepId === 'new', g[0] && g[0].keepId);
  t('the pre-edit record is dropped', g[0] && g[0].dropIds.join() === 'old', g[0] && g[0].dropIds);
  t('the invoice number is reported', g[0] && g[0].invoiceNumber === 'A');

  // A duplicate CREATE (double save) has no safe automatic winner.
  t('equal editCount (duplicate CREATE) is left alone',
    find([mk({ id: 'x', totalAmount: 100 }), mk({ id: 'y', totalAmount: 100 })]).length === 0);
  t('equal NON-ZERO editCount is also left alone',
    find([mk({ id: 'x', editCount: 2 }), mk({ id: 'y', editCount: 2 })]).length === 0);

  // A genuine multi-page invoice must never be a candidate.
  t('a normal 2-page invoice is not touched',
    find([mk({ id: 'p1', page: 1 }), mk({ id: 'p2', page: 2 })]).length === 0);
  t('…even when the pages carry different editCounts',
    find([mk({ id: 'p1', page: 1, editCount: 0 }), mk({ id: 'p2', page: 2, editCount: 1 })]).length === 0);

  // Same number, two different customers — a split invoice number, not a duplicate.
  t('two customers on one invoice number are not merged',
    find([mk({ id: 'a', customerId: 'c1' }), mk({ id: 'b', customerId: 'c2', editCount: 1 })]).length === 0);

  // Cancelled records are out of scope entirely.
  t('a cancelled record is ignored, so no group forms',
    find([mk({ id: 'old', cancelled: true }), mk({ id: 'new', editCount: 1 })]).length === 0);

  // Three versions: only the newest survives.
  const g3 = find([mk({ id: 'v0' }), mk({ id: 'v1', editCount: 1 }), mk({ id: 'v2', editCount: 2 })]);
  t('three versions → keep the newest, drop two', g3.length === 1 && g3[0].keepId === 'v2' && g3[0].dropIds.length === 2,
    g3[0] && g3[0].dropIds);

  // Junk must not crash or produce phantom groups.
  t('records with no id / no number are skipped',
    find([null, { id: 'z' }, mk({ totalAmount: 1 })]).length === 0);
  t('a single record is never a candidate', find([mk({ id: 'solo', editCount: 3 })]).length === 0);
  t('an empty array is fine', find([]).length === 0);
}

// ── Slice Sync.sweepSupersededPages out of sync.js ──────────────────────────
function loadSweep(env) {
  const src = read('sync.js');
  const s = src.indexOf('  async sweepSupersededPages(force) {');
  if (s < 0) throw new Error('sweepSupersededPages not found in sync.js');
  const e = src.indexOf('\r\n  },', src.indexOf('return { groups: groups.length, deleted: 0, error:', s));
  if (e < 0) throw new Error('sweepSupersededPages end not found');
  const body = src.slice(s, e + 6).replace(/\r\n/g, '\n');
  // v1.0.245: the sweep is disabled in production by _SWEEP_ENABLED. These tests drive
  // the logic deliberately, so the harness turns it on.
  const extra = '  _SWEEP_MAX: 25,\n  _SWEEP_ENABLED: true,\n  _sweepKey: "wt_sweep_pages_done",\n';
  const obj = new Function('DB', 'sessionStorage', 'return {' + extra + body + '};')(env.DB, env.sessionStorage);
  return Object.assign(obj, env.sync);
}

function makeEnv(invoices, opts) {
  opts = opts || {};
  const logs = [], deleted = [], tombstoned = [];
  let local = invoices.slice();
  const store = {};
  const env = {
    sessionStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    DB: {
      K: { INVOICES: 'wt_invoices' },
      getInvoices: () => local,
      setLocalOnly: (k, v) => { local = v; },
      findSupersededPages: loadDetector().bind(null, invoices),
      logError: (type, msg, detail) => logs.push({ type, msg, detail }),
    },
    sync: {
      ready: opts.ready !== false,
      _db: { batch: () => ({ delete: ref => deleted.push(ref), commit: async () => { if (opts.commitFails) throw new Error('unavailable'); } }) },
      _orgRef: () => ({ collection: () => ({ doc: id => id }) }),
      _addTombstones: (col, ids) => tombstoned.push(...ids),
    },
    get local() { return local; },
    logs, deleted, tombstoned, store,
  };
  return env;
}

const PAIR = [
  { id: 'old', invoiceNumber: 'A', customerId: 'c1', page: 1, totalAmount: 23665 },
  { id: 'new', invoiceNumber: 'A', customerId: 'c1', page: 1, totalAmount: 22715, editCount: 1 },
];

section('Sync.sweepSupersededPages — the repair');
{
  const env = makeEnv(PAIR);
  const sync = loadSweep(env);
  sync.sweepSupersededPages().then(r => {
    t('reports what it repaired', r && r.groups === 1 && r.deleted === 1, r);
    t('the stale record is removed from local', !env.local.some(i => i.id === 'old'), env.local.map(i => i.id));
    t('the current record is kept', env.local.some(i => i.id === 'new'));
    t('the stale id is tombstoned BEFORE the delete', env.tombstoned.join() === 'old', env.tombstoned);
    t('exactly the stale doc is deleted from Firestore', env.deleted.join() === 'old', env.deleted);
    t('the repair is logged', env.logs.some(l => l.type === 'PAGE-SWEEP'), env.logs.map(l => l.type));
    t('the session flag is set so it runs once', env.store['wt_sweep_pages_done'] === '1');
    runRest();
  });
}

function runRest() {
  section('it refuses to run on a bad read (mass-delete cap)');
  {
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push({ id: 'o' + i, invoiceNumber: 'N' + i, customerId: 'c1', page: 1 });
      many.push({ id: 'n' + i, invoiceNumber: 'N' + i, customerId: 'c1', page: 1, editCount: 1 });
    }
    const env = makeEnv(many);
    loadSweep(env).sweepSupersededPages().then(r => {
      t('30 stale pages is over the cap → blocked', r && r.blocked === true && r.deleted === 0, r);
      t('nothing was deleted', env.deleted.length === 0, env.deleted.length);
      t('nothing was removed from local', env.local.length === many.length, env.local.length);
      t('and it is logged as blocked', env.logs.some(l => l.type === 'PAGE-SWEEP-BLOCKED'));
      t('the session flag is NOT set, so it can be re-examined', !env.store['wt_sweep_pages_done']);
      runFail();
    });
  }
}

function runFail() {
  section('a failed commit is retried next session, not lost');
  {
    const env = makeEnv(PAIR, { commitFails: true });
    loadSweep(env).sweepSupersededPages().then(r => {
      t('the failure is reported', r && r.deleted === 0 && !!r.error, r && r.error);
      t('logged as PAGE-SWEEP-FAILED', env.logs.some(l => l.type === 'PAGE-SWEEP-FAILED'));
      t('the session flag is NOT set — this is the durability the old delete lacked',
        !env.store['wt_sweep_pages_done']);
      runGuards();
    });
  }
}

function runGuards() {
  section('guards');
  {
    const env = makeEnv(PAIR, { ready: false });
    loadSweep(env).sweepSupersededPages().then(r => {
      t('does nothing when sync is not ready', r === null);
      t('and deletes nothing', env.deleted.length === 0);

      const env2 = makeEnv(PAIR);
      env2.store['wt_sweep_pages_done'] = '1';
      loadSweep(env2).sweepSupersededPages().then(r2 => {
        t('skips when already swept this session', r2 === null);
        const env3 = makeEnv(PAIR);
        env3.store['wt_sweep_pages_done'] = '1';
        loadSweep(env3).sweepSupersededPages(true).then(r3 => {
          t('force overrides the session flag', r3 && r3.deleted === 1, r3);
          const env4 = makeEnv([PAIR[1]]);
          loadSweep(env4).sweepSupersededPages().then(r4 => {
            t('a clean database reports zero and marks the session done',
              r4 && r4.groups === 0 && env4.store['wt_sweep_pages_done'] === '1', r4);
            t('and touches nothing', env4.deleted.length === 0 && env4.tombstoned.length === 0);
            runTrace();
          });
        });
      });
    });
  }
}

function runTrace() {
  section('INV-TRACE no longer floods the 200-entry error ring');
  {
    const src = read('db.js');
    t('a verbosity helper exists', /_traceVerbose\(\)\s*\{/.test(src));
    t('it is opt-in via localStorage.__invTrace', /__invTrace/.test(src));
    const okLine = src.split('\n').find(l => l.includes('_tauri.write OK'));
    t('the per-write SUCCESS trace is gated', okLine && okLine.includes('_traceVerbose()'), okLine && okLine.trim().slice(0, 70));
    const initLine = src.split('\n').find(l => l.includes('tauri.init HDD load'));
    t('the per-navigation HDD-load trace is gated', initLine && initLine.includes('_traceVerbose()'));

    // The valuable ones must stay unconditional — gating these would re-blind us.
    const failLine = src.split('\n').find(l => l.includes('_tauri.write FAILED'));
    t('write FAILURES are still always logged', failLine && !failLine.includes('_traceVerbose()'),
      failLine && failLine.trim().slice(0, 70));
    const blockedLine = src.split('\n').find(l => l.includes('_tauri.write BLOCKED'));
    t('blocked-empty writes are still always logged', blockedLine && !blockedLine.includes('_traceVerbose()'));
    const shrink = src.split('\n').find(l => l.includes("this.logError('INV-TRACE'") && l.includes('_ol'));
    t('the shrink trace is still always logged', shrink && !shrink.includes('_traceVerbose()'));

    runStop();
  }
}

function runStop() {
  section('EMERGENCY STOP (v1.0.245) — the sweep must not run in production');
  {
  const src = read('sync.js');
  t('_SWEEP_ENABLED exists and is false', /_SWEEP_ENABLED:\s*false/.test(src),
    (src.match(/_SWEEP_ENABLED:\s*\w+/) || [])[0]);
  const i = src.indexOf('async sweepSupersededPages(force) {');
  const head = src.slice(i, i + 400);
  t('the flag is checked FIRST, before anything else',
    head.indexOf('_SWEEP_ENABLED') < head.indexOf('this.ready'));
  t('it returns without touching Firestore', /if \(!this\._SWEEP_ENABLED\) return null;/.test(head));

  // Drive it for real with the flag off — nothing may be deleted.
  const src2 = read('sync.js');
  const s2 = src2.indexOf('  async sweepSupersededPages(force) {');
  const e2 = src2.indexOf('\r\n  },', src2.indexOf('return { groups: groups.length, deleted: 0, error:', s2));
  const body = src2.slice(s2, e2 + 6).replace(/\r\n/g, '\n');
  const env = makeEnv(PAIR);
  const off = Object.assign(
    new Function('DB', 'sessionStorage',
      'return {  _SWEEP_MAX: 25,\n  _SWEEP_ENABLED: false,\n  _sweepKey: "x",\n' + body + '};')(env.DB, env.sessionStorage),
    env.sync);
  off.sweepSupersededPages(true).then(r => {
    t('with the flag off it does nothing, even forced', r === null, r);
    t('no Firestore delete is issued', env.deleted.length === 0, env.deleted.length);
    t('no tombstone is written', env.tombstoned.length === 0);
    t('local invoices are untouched', env.local.length === PAIR.length, env.local.length);
    runHole();
  });
}

}

function runHole() {
  section('WHY it is disabled — a brand-new invoice is misread as a stale page');
  {
    // The rule orders records by editCount alone. A newly created invoice has
    // editCount 0, so against an existing EDITED invoice on the same
    // invoiceNumber+customerId+page it is classified as the superseded one and
    // deleted from Firestore. Reported live 24 Sep 2026: the creating device still
    // showed it (the invoices listener is union-only and never removes), every other
    // device never received it, and no upload bar appeared because the push had
    // already succeeded.
    const find = loadDetector();
    const mk = (id, o) => Object.assign({ id, invoiceNumber: '240969-001', customerId: 'c1', page: 1 }, o);
    const g = find([mk('existing_edited', { editCount: 1 }), mk('brand_new', { editCount: 0 })]);
    t('the hole is real and still present in the detector',
      g.length === 1 && g[0].dropIds.includes('brand_new'), g[0] && g[0].dropIds);
    t('…and it would keep the OLD edited record instead',
      g.length === 1 && g[0].keepId === 'existing_edited');
    // This assertion is the point: while the hole exists, the sweep stays off.
    t('so the sweep MUST remain disabled until the rule also compares age',
      /_SWEEP_ENABLED:\s*false/.test(read('sync.js')));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

