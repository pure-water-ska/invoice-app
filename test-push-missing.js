// test-push-missing.js — v1.0.247
//
// Reported: the compare panel said "ค้าง 2" for invoices, and pressing "อัปโหลดที่ค้าง"
// did nothing while reporting success.
//
// Cause — a capability gap, not a crash. Those 2 invoices HAD uploaded successfully;
// the v1.0.242 sweep then deleted them from Firestore. The device still considers them
// synced, so nothing can resend them:
//   • _writeKey's diff skips any record whose content matches _lastSyncedRecs
//     ("unchanged (skipped)") — it uploaded fine once and has not changed since.
//   • Sync.flushNow only drains the PENDING queue; a lost record is not pending.
//   • recoverCollectionMissing / recoverCollectionFull only pull DOWN from the server.
// There was no push-up path anywhere in the app.
//
// Sync.pushRecordsByIds is that path: it clears the stale fingerprint and any tombstone,
// then writes the records directly. Ids come from checkSyncStatus, which already reads
// every document to count them — so identifying them costs no extra reads, and covers
// the whole collection rather than just the archive window.
//
// Run: node test-push-missing.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ── Slice Sync.pushRecordsByIds out of sync.js and drive it ────────────────
function load(env) {
  const src = read('sync.js');
  const s = src.indexOf('  async pushRecordsByIds(colName, ids, onProgress) {');
  if (s < 0) throw new Error('pushRecordsByIds not found');
  const e = src.indexOf('\r\n  },', src.indexOf('return { pushed, requested: ids.length, notFound };', s));
  if (e < 0) throw new Error('end not found');
  const body = src.slice(s, e + 6).replace(/\r\n/g, '\n');
  const obj = new Function('DB', 'firebase', 'console',
    'return {' + body + '};')(env.DB, env.firebase, { log() {} });
  return Object.assign(obj, env.sync);
}

function makeEnv(localArr, opts) {
  opts = opts || {};
  const written = [], tombClears = [], logs = [];
  const fpMap = new Map(opts.fingerprints || []);
  const serverIds = new Set(opts.serverIds || []);
  const env = {
    DB: { logError: (type, msg, detail) => logs.push({ type, msg, detail }) },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
    sync: {
      ready: opts.ready !== false,
      _db: { batch: () => ({
        // fpAtWrite records whether the stale fingerprint was still present when the
        // write was issued — the ordering is the whole point of this function.
        set: (ref, data) => written.push({ ref, data, fpAtWrite: fpMap.get(ref) }),
        commit: async () => { if (opts.commitFails) throw new Error('unavailable'); },
      }) },
      COLLECTIONS: { wt_invoices: 'invoices' },
      _localRead: () => JSON.stringify(localArr),
      _orgRef: () => ({ collection: () => ({ doc: id => id }) }),
      _lastSyncedRecs: { invoices: fpMap },
      _serverIds: { invoices: serverIds },
      _saveServerIds: () => {},
      _clearTombstones: (col, ids) => tombClears.push(...ids),
      _deviceId: 'dev1',
      _deviceName: () => 'PC-1',
    },
    written, tombClears, logs, fpMap, serverIds,
  };
  return env;
}

const REC = (id, o) => Object.assign({ id, invoiceNumber: 'N' + id, customerId: 'c1', totalAmount: 100 }, o);
const LOCAL = [REC('a'), REC('b'), REC('c')];

section('Sync.pushRecordsByIds — the push-up path that did not exist');
(async () => {
  {
    // The exact reported state: 'a' and 'b' were uploaded fine, so their fingerprints
    // are present — which is why the normal diff refuses to resend them.
    const env = makeEnv(LOCAL, { fingerprints: [['a', JSON.stringify(REC('a'))], ['b', JSON.stringify(REC('b'))]] });
    const sync = load(env);
    const r = await sync.pushRecordsByIds('invoices', ['a', 'b']);
    t('both records are written', env.written.length === 2, env.written.length);
    t('written to their own ids', env.written.map(w => w.ref).sort().join() === 'a,b', env.written.map(w => w.ref));
    t('the result reports what was pushed', r.pushed === 2 && r.requested === 2, r);
    // Tautological check removed: the fingerprint is re-seeded after the push, so
    // comparing it afterwards passes whether or not the clear happened. What matters is
    // that it was ALREADY gone when the write was issued.
    t('the stale fingerprint was cleared BEFORE the write was issued',
      env.written.every(w => w.fpAtWrite === undefined),
      env.written.map(w => w.fpAtWrite));
    t('tombstones are cleared so the doc is not re-suppressed',
      env.tombClears.sort().join() === 'a,b', env.tombClears);
    t('device metadata is stamped', env.written[0].data._by === 'dev1' && env.written[0].data._byName === 'PC-1');
    t('a server timestamp is set', env.written[0].data._ts === 'TS');
    t('the action is logged', env.logs.some(l => l.type === 'PUSH-MISSING'));

    // After a successful push the record must be marked present, or the next status
    // check would report it missing again and the next diff would resend it.
    t('the id is added to _serverIds', env.serverIds.has('a') && env.serverIds.has('b'));
    t('the fingerprint is re-seeded so the next diff skips it',
      env.fpMap.has('a') && env.fpMap.has('b'));
    runRest();
  }
})();

function runRest() {
  section('it only touches what was asked for');
  (async () => {
    {
      const env = makeEnv(LOCAL);
      const r = await load(env).pushRecordsByIds('invoices', ['b']);
      t('one id → one write', env.written.length === 1 && env.written[0].ref === 'b', env.written.map(w => w.ref));
      t('untouched records keep their place', r.pushed === 1);
    }
    {
      // An id the device no longer has must be reported, not silently dropped —
      // otherwise "pushed 1 of 2" would read as success.
      const env = makeEnv(LOCAL);
      const r = await load(env).pushRecordsByIds('invoices', ['a', 'gone']);
      t('a missing-locally id is counted as notFound', r.notFound === 1 && r.pushed === 1, r);
      t('and nothing is written for it', env.written.length === 1);
    }
    {
      const env = makeEnv(LOCAL);
      const r = await load(env).pushRecordsByIds('invoices', ['x', 'y']);
      t('all ids unknown → nothing written, reported honestly',
        r.pushed === 0 && r.notFound === 2 && env.written.length === 0, r);
    }
    {
      const env = makeEnv(LOCAL);
      const r = await load(env).pushRecordsByIds('invoices', ['a', 'a', 'a']);
      t('duplicate ids are de-duplicated', r.pushed === 1 && env.written.length === 1, r);
    }
    {
      const env = makeEnv(LOCAL);
      const r = await load(env).pushRecordsByIds('invoices', []);
      t('an empty list does nothing', r.pushed === 0 && env.written.length === 0);
      t('…and clears no tombstones', env.tombClears.length === 0);
    }
    {
      const env = makeEnv(LOCAL, { ready: false });
      let threw = false;
      try { await load(env).pushRecordsByIds('invoices', ['a']); } catch (e) { threw = true; }
      t('it refuses when sync is not ready', threw);
      t('and writes nothing', env.written.length === 0);
    }
    {
      const env = makeEnv(LOCAL, { commitFails: true });
      let threw = false;
      try { await load(env).pushRecordsByIds('invoices', ['a']); } catch (e) { threw = true; }
      t('a failed commit propagates rather than reporting success', threw);
      t('and the id is NOT marked present on the server', !env.serverIds.has('a'));
    }
    runWiring();
  })();
}

function runWiring() {
  section('the UI wiring');
  {
    const js = read('settings.js');
    t('checkSyncStatus collects server ids for invoices', /serverInfo\('invoices', true\)/.test(js));
    t('…and for payments', /serverInfo\('payments', true\)/.test(js));
    t('master-data collections do NOT pay for id collection',
      /serverInfo\('customers_v2', false\)/.test(js) && /serverInfo\('products_v2', false\)/.test(js));
    t('the missing ids are stored for the push button', /_syncMissing = \{ invoices:/.test(js));
    t('pushMissingToServer calls the new API', /Sync\.pushRecordsByIds\(colName, ids/.test(js));
    t('it refuses when nothing is missing', /ไม่มีรายการที่ต้องดันขึ้น/.test(js));
    t('quota exhaustion is reported in plain Thai', /โควต้า Firestore หมด/.test(js));
    t('the panel names the records, not just a count', /ที่ไม่มีบน server/.test(js));
    t('a long list is truncated rather than rendering thousands of chips', /slice\(0, 30\)/.test(js));

    // The misleading success message was the reason this looked like a failure.
    // A comment may still MENTION the old wording (it documents why it changed) —
    // what matters is that no showAlert CALL uses it.
    const codeLines = js.split('\n').filter(l => !l.trim().startsWith('//'));
    t('"อัปโหลดที่ค้าง" no longer claims อัปโหลดเสร็จ',
      !codeLines.some(l => l.includes('อัปโหลดเสร็จ')),
      (codeLines.find(l => l.includes('อัปโหลดเสร็จ')) || '').trim().slice(0, 60));
    t('…it says what it actually did', /ส่งข้อมูลที่ค้างในคิวแล้ว/.test(js));

    const html = read('settings.html');
    t('the read-cost warning replaced the false "ไม่เปลืองโควต้า" claim',
      !/ไม่เปลืองโควต้า/.test(html) && /ไม่ควรกดบ่อย/.test(html));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
