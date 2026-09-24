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
  // v1.0.246: findSupersededPages calls this._recCreatedMs, so the helper has to come
  // along or the sliced object throws.
  const h = src.indexOf('  _recCreatedMs(rec) {');
  if (h < 0) throw new Error('_recCreatedMs not found in db.js');
  const he = src.indexOf('\n  },', h);
  const s = src.indexOf('  findSupersededPages(invoices) {');
  if (s < 0) throw new Error('findSupersededPages not found in db.js');
  const e = src.indexOf('\n  },', src.indexOf('return out;', s));
  if (e < 0) throw new Error('findSupersededPages end not found');
  const obj = new Function('return {' + src.slice(h, he + 5) + src.slice(s, e + 5) + '};')();
  return arr => obj.findSupersededPages(arr);
}

section('DB.findSupersededPages — what counts as superseded');
{
  const find = loadDetector();
  // v1.0.246: ids must decode to a creation time (Date.now().toString(36) + random) and
  // the keeper must carry an editHistory[].previous matching the dropped record's total.
  const NOW = Date.parse('2026-09-24T10:00:00.000Z');
  const T = ms => Math.round(ms).toString(36).padStart(8, '0');
  const hist = (...totals) => totals.map(x => ({ previous: { totalAmount: x } }));
  const mk = (o) => Object.assign({ invoiceNumber: 'A', customerId: 'c1', page: 1 }, o);
  const OLD = T(NOW - 86400000), NEW = T(NOW);

  // The reported case: 180769-001, stale 23,665 vs current 22,715 after an edit.
  const g = find([
    mk({ id: OLD, totalAmount: 23665 }),
    mk({ id: NEW, totalAmount: 22715, editCount: 1, editHistory: hist(23665) }),
  ]);
  t('an edit duplicate is found', g.length === 1, g.length);
  t('the newest record is kept', g[0] && g[0].keepId === NEW, g[0] && g[0].keepId);
  t('the pre-edit record is dropped', g[0] && g[0].dropIds.join() === OLD, g[0] && g[0].dropIds);
  t('the invoice number is reported', g[0] && g[0].invoiceNumber === 'A');

  // A duplicate CREATE (double save) has no safe automatic winner.
  t('equal editCount (duplicate CREATE) is left alone',
    find([mk({ id: OLD, totalAmount: 100 }), mk({ id: NEW, totalAmount: 100 })]).length === 0);
  t('equal NON-ZERO editCount is also left alone',
    find([mk({ id: OLD, editCount: 2 }), mk({ id: NEW, editCount: 2 })]).length === 0);

  // A genuine multi-page invoice must never be a candidate.
  t('a normal 2-page invoice is not touched',
    find([mk({ id: OLD, page: 1 }), mk({ id: NEW, page: 2 })]).length === 0);
  t('…even when the pages carry different editCounts',
    find([mk({ id: OLD, page: 1, editCount: 0 }),
          mk({ id: NEW, page: 2, editCount: 1, editHistory: hist(0) })]).length === 0);

  // Same number, two different customers — a split invoice number, not a duplicate.
  t('two customers on one invoice number are not merged',
    find([mk({ id: OLD, customerId: 'c1', totalAmount: 10 }),
          mk({ id: NEW, customerId: 'c2', editCount: 1, editHistory: hist(10) })]).length === 0);

  // Cancelled records are out of scope entirely.
  t('a cancelled record is ignored, so no group forms',
    find([mk({ id: OLD, cancelled: true, totalAmount: 10 }),
          mk({ id: NEW, editCount: 1, editHistory: hist(10) })]).length === 0);

  // Three versions: only the newest survives, and BOTH older ones must be provable.
  const V0 = T(NOW - 172800000), V1 = T(NOW - 86400000), V2 = T(NOW);
  const g3 = find([
    mk({ id: V0, totalAmount: 100 }),
    mk({ id: V1, totalAmount: 200, editCount: 1, editHistory: hist(100) }),
    mk({ id: V2, totalAmount: 300, editCount: 2, editHistory: hist(100, 200) }),
  ]);
  t('three versions → keep the newest, drop two',
    g3.length === 1 && g3[0].keepId === V2 && g3[0].dropIds.length === 2,
    g3[0] && g3[0].dropIds);

  // Junk must not crash or produce phantom groups.
  t('records with no id / no number are skipped',
    find([null, { id: 'z' }, mk({ totalAmount: 1 })]).length === 0);
  t('a single record is never a candidate', find([mk({ id: NEW, editCount: 3 })]).length === 0);
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

// v1.0.246: the detector now demands a decodable id (creation time) on both records and
// an editHistory[].previous on the keeper matching the dropped record's total.
const _NOW = Date.parse('2026-09-24T10:00:00.000Z');
const _T = ms => Math.round(ms).toString(36).padStart(8, '0');
const OLD_ID = _T(_NOW - 86400000), NEW_ID = _T(_NOW);
const PAIR = [
  { id: OLD_ID, invoiceNumber: 'A', customerId: 'c1', page: 1, totalAmount: 23665 },
  { id: NEW_ID, invoiceNumber: 'A', customerId: 'c1', page: 1, totalAmount: 22715, editCount: 1,
    editHistory: [{ previous: { totalAmount: 23665 } }] },
];

section('Sync.sweepSupersededPages — the repair');
{
  const env = makeEnv(PAIR);
  const sync = loadSweep(env);
  sync.sweepSupersededPages().then(r => {
    t('reports what it repaired', r && r.groups === 1 && r.deleted === 1, r);
    t('the stale record is removed from local', !env.local.some(i => i.id === OLD_ID), env.local.map(i => i.id));
    t('the current record is kept', env.local.some(i => i.id === NEW_ID));
    t('the stale id is tombstoned BEFORE the delete', env.tombstoned.join() === OLD_ID, env.tombstoned);
    t('exactly the stale doc is deleted from Firestore', env.deleted.join() === OLD_ID, env.deleted);
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
      many.push({ id: _T(_NOW - 86400000 - i), invoiceNumber: 'N' + i, customerId: 'c1', page: 1,
                  totalAmount: 100 + i });
      many.push({ id: _T(_NOW - i), invoiceNumber: 'N' + i, customerId: 'c1', page: 1, editCount: 1,
                  totalAmount: 200 + i, editHistory: [{ previous: { totalAmount: 100 + i } }] });
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
  section('the kill switch still exists and is honoured');
  {
  const src = read('sync.js');
  t('_SWEEP_ENABLED is on again (v1.0.246)', /_SWEEP_ENABLED:\s*true/.test(src),
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
    t('with the flag off it does nothing, even forced — the switch still works', r === null, r);
    t('no Firestore delete is issued', env.deleted.length === 0, env.deleted.length);
    t('no tombstone is written', env.tombstoned.length === 0);
    t('local invoices are untouched', env.local.length === PAIR.length, env.local.length);
    runHole();
  });
}

}

function runHole() {
  section('the v1.0.245 hole: a brand-new invoice misread as a stale page');
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
    const T = ms => Math.round(ms).toString(36).padStart(8, '0');
    const hist = tot => [{ previous: { totalAmount: tot } }];
    const NOW = Date.now();
    const editedEarlier = Object.assign(mk(T(NOW - 86400000)),
      { editCount: 1, totalAmount: 5000, editHistory: hist(4000) });
    const brandNew = Object.assign(mk(T(NOW)), { editCount: 0, totalAmount: 9999 });
    const g = find([editedEarlier, brandNew]);
    t('THE BUG IS CLOSED — a brand-new invoice is never dropped', g.length === 0, g);

    // Age alone must block it, even if the total happens to match a recorded version.
    const coincidence = Object.assign(mk(T(NOW + 60000)), { editCount: 0, totalAmount: 4000 });
    t('a NEWER record is refused even when its total matches a snapshot',
      find([coincidence, editedEarlier]).length === 0);

    // Provenance alone must block it, even when the record is older.
    const unrelatedOlder = Object.assign(mk(T(NOW - 172800000)), { editCount: 0, totalAmount: 7777 });
    t('an OLDER record whose total matches no recorded version is refused',
      find([unrelatedOlder, editedEarlier]).length === 0);

    // No proof at all → no delete. This is why pre-v1.0.185 edits no longer qualify.
    const noSnapshot = Object.assign(mk(T(NOW)), { editCount: 1, totalAmount: 5000 });
    // strictly older than editedEarlier (NOW - 86400000), or the age check refuses it
    const older = Object.assign(mk(T(NOW - 90000000)), { editCount: 0, totalAmount: 4000 });
    t('a keeper with no editHistory snapshot can delete nothing',
      find([older, noSnapshot]).length === 0);

    // An id that does not decode must be refused, not guessed at.
    t('an undecodable id is refused rather than ordered by assumption',
      find([Object.assign(mk('short'), { editCount: 0, totalAmount: 4000 }), editedEarlier]).length === 0);

    // An id CAN be 8 chars and still not be a timestamp — an imported or hand-made id
    // decoding to 1970, or far in the future, must not be trusted as a creation time.
    t('an 8-char id decoding to an implausible time is refused (epoch)',
      find([Object.assign(mk('00000000'), { editCount: 0, totalAmount: 4000 }), editedEarlier]).length === 0);
    t('…and one decoding far in the future is refused too',
      find([Object.assign(mk('zzzzzzzz'), { editCount: 0, totalAmount: 4000 }), editedEarlier]).length === 0);

    // …and the genuine case still works.
    const genuine = find([older, editedEarlier]);
    t('a genuine superseded page IS still cleaned',
      genuine.length === 1 && genuine[0].dropIds.length === 1, genuine[0] && genuine[0].dropIds);
    t('…keeping the edited record', genuine.length === 1 && genuine[0].keepId === editedEarlier.id);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

