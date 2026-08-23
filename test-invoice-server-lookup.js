// test-invoice-server-lookup.js — run:  node test-invoice-server-lookup.js
//
// User-reported: invoice 300669-209 is not in the list and search can't find it, yet
// importing it reports "มีอยู่บนเซิร์ฟเวอร์แล้ว" naming BOTH customers — so the server
// still holds the whole cross-customer collision while this device holds none of it.
//
// Two causes are indistinguishable from local state alone: (a) the explicit Firestore
// delete silently failed, or (b) another device holding a stale copy re-uploaded the
// records after they were deleted here. Firestore stamps `_by` (device) and `_ts` (when)
// on every write, which separates them — so the lookup surfaces both.
//
// It also matters that this query carries NO .where('createdAt') clause: _pullAll, the
// real-time listener and loadArchive all do, and Firestore silently excludes a doc whose
// createdAt is missing or malformed from any range query on that field — such a doc is
// invisible on every device while still occupying the number. This tool can see it.
//
// Extracts the REAL Sync methods from sync.js and drives them against a fake Firestore.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// Pull one method's source straight out of the Sync literal.
function extractMethod(name) {
  const src = fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8');
  const start = src.indexOf(`  async ${name}(`);
  if (start < 0) throw new Error(`${name} not found — update extraction marker`);
  let depth = 0, i = src.indexOf('{', start), seen = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Minimal Sync host carrying only what these three methods touch — every method under
// test is the real extracted source, spliced onto it.
function makeSync(serverDocs, localArr, opts = {}) {
  const state = {
    written: null, tombstoned: [], cleared: [], deleted: [],
    savedServerIds: 0, savedPullIds: 0, invalidated: false, queriedField: null,
  };
  const sync = {
    ready: opts.ready !== false,
    _db: opts.ready === false ? null : {
      batch: () => ({
        delete: (ref) => { state.deleted.push(ref._id); },
        commit: () => opts.commitFails ? Promise.reject(new Error('permission-denied')) : Promise.resolve(),
      }),
    },
    _deviceId: 'THIS-PC',
    _serverIds: {}, _pullIds: {}, _lastSyncedRecs: {},
    _orgRef: () => ({
      collection: (n) => ({
        doc: (id) => ({ _col: n, _id: id }),
        where: (field, op, val) => {
          state.queriedField = field;
          return { get: () => Promise.resolve({
            docs: serverDocs.filter(d => d.data[field] === val)
              .map(d => ({ id: d.id, data: () => d.data })),
          }) };
        },
      }),
    }),
    _localRead: () => JSON.stringify(localArr),
    _lsWrite: (k, v) => { state.written = v; },
    _clearTombstones: (col, ids) => { state.cleared.push(...ids); },
    _addTombstones: (col, ids) => { state.tombstoned.push(...ids); },
    _saveServerIds: () => { state.savedServerIds++; },
    _savePullIds: () => { state.savedPullIds++; },
  };
  const body = [extractMethod('invoiceNumberServerDetail'),
                extractMethod('pullInvoiceNumberToLocal'),
                extractMethod('deleteInvoiceDocsFromServer')].join(',\n');
  const methods = new Function('DB', `return { ${body} };`)({ invalidate: () => { state.invalidated = true; } });
  Object.assign(sync, methods);
  return { sync, state };
}

// The reported shape: server holds both sides of the collision, this device holds neither,
// and both were written by ANOTHER device — i.e. resurrection, not a failed delete.
const SERVER_DOCS = [
  { id: 'srv-A', data: { invoiceNumber: '300669-209', customerId: 'cust-tsm', page: 1,
      totalAmount: 9640, createdAt: '2026-06-30T07:00:00.000Z', _by: 'OTHER-PC', _ts: 1755000000000 } },
  { id: 'srv-B', data: { invoiceNumber: '300669-209', customerId: 'cust-orw', page: 1,
      totalAmount: 9112.5, createdAt: '2026-06-30T07:00:00.000Z', _by: 'OTHER-PC', _ts: 1755000000000 } },
  { id: 'srv-C', data: { invoiceNumber: '999999-001', customerId: 'cust-tsm', page: 1,
      totalAmount: 100, createdAt: '2026-07-01T07:00:00.000Z', _by: 'THIS-PC', _ts: 1755000000001 } },
];

console.log('invoiceNumberServerDetail() — the date-unfiltered server query');
{
  const { sync, state } = makeSync(SERVER_DOCS, []);
  return (async () => {
    const docs = await sync.invoiceNumberServerDetail('300669-209');
    t('finds both collided docs', docs.length === 2, docs.map(d => d.id).join(','));
    t('queries by invoiceNumber, NOT createdAt (the whole point)', state.queriedField === 'invoiceNumber', String(state.queriedField));
    t('surfaces _by so the writing device is identifiable', docs.every(d => d.by === 'OTHER-PC'));
    t('surfaces _ts so the write time is identifiable', docs.every(d => d.ts === 1755000000000));
    t('strips _by/_ts out of the record payload itself',
      docs.every(d => d.rec._by === undefined && d.rec._ts === undefined));
    t('keeps the real fields on the record', docs[0].rec.invoiceNumber === '300669-209' && docs[0].rec.page === 1);
    t('does not return other invoice numbers', !docs.some(d => d.rec.invoiceNumber === '999999-001'));

    console.log('\ninvoiceNumberServerDetail() — offline returns null, never a misleading empty list');
    {
      const { sync: s2 } = makeSync(SERVER_DOCS, [], { ready: false });
      const r = await s2.invoiceNumberServerDetail('300669-209');
      t('null (unknown), not [] (which would read as "the number is free")', r === null, JSON.stringify(r));
    }

    console.log('\ninvoiceNumberServerDetail() — a doc with NO createdAt is still found');
    {
      // This is the case every date-ranged pull silently drops. If the lookup could not
      // see it either, such a doc would be undiagnosable from inside the app.
      const undated = [{ id: 'srv-X', data: { invoiceNumber: '300669-209', customerId: 'cust-tsm',
        page: 1, totalAmount: 500, _by: 'OTHER-PC', _ts: 1 } }];
      const { sync: s3 } = makeSync(undated, []);
      const r = await s3.invoiceNumberServerDetail('300669-209');
      t('undated doc is returned', r.length === 1);
      t('its missing createdAt is visible to the caller', r[0].rec.createdAt === undefined);
    }

    console.log('\npullInvoiceNumberToLocal() — repairs this device WITHOUT touching the server');
    {
      const { sync: s4, state: st4 } = makeSync(SERVER_DOCS, []);
      const r = await s4.pullInvoiceNumberToLocal('300669-209');
      t('reports 2 added', r.added === 2, JSON.stringify(r));
      t('writes both records into local', st4.written && st4.written.length === 2);
      t('never deletes anything on the server', st4.deleted.length === 0);
      t('never tombstones (that would re-hide them)', st4.tombstoned.length === 0);
      t('clears any existing tombstone on those ids first', st4.cleared.join(',') === 'srv-A,srv-B', st4.cleared.join(','));
      t('registers ids in _serverIds so the next save cannot infer a delete',
        s4._serverIds.invoices.has('srv-A') && s4._serverIds.invoices.has('srv-B'));
      t('registers ids in _pullIds so the listener treats them as server-known',
        s4._pullIds.invoices.has('srv-A') && s4._pullIds.invoices.has('srv-B'));
      t('seeds the write fingerprint so they are not re-pushed', s4._lastSyncedRecs.invoices.size === 2);
      t('invalidates the DB cache so the list re-reads', st4.invalidated === true);
      t('the stored records carry no _by/_ts pollution',
        st4.written.every(rec => rec._by === undefined && rec._ts === undefined));
    }

    console.log('\npullInvoiceNumberToLocal() — preserves records this device already has');
    {
      const local = [{ id: 'srv-A', invoiceNumber: '300669-209', customerId: 'cust-tsm', page: 1, totalAmount: 9640 },
                     { id: 'local-only', invoiceNumber: '010170-005', customerId: 'cust-x', page: 1, totalAmount: 42 }];
      const { sync: s5, state: st5 } = makeSync(SERVER_DOCS, local);
      const r = await s5.pullInvoiceNumberToLocal('300669-209');
      t('adds only the 1 genuinely missing record', r.added === 1, JSON.stringify(r));
      t('reports the 1 it already had', r.already === 1);
      t('local total goes 2 → 3, nothing dropped', st5.written.length === 3, String(st5.written.length));
      t('the unrelated local-only invoice survives', st5.written.some(x => x.id === 'local-only'));
    }

    console.log('\npullInvoiceNumberToLocal() — nothing to do is a clean no-op');
    {
      const local = [{ id: 'srv-A', invoiceNumber: '300669-209' }, { id: 'srv-B', invoiceNumber: '300669-209' }];
      const { sync: s6, state: st6 } = makeSync(SERVER_DOCS, local);
      const r = await s6.pullInvoiceNumberToLocal('300669-209');
      t('added 0', r.added === 0 && r.already === 2, JSON.stringify(r));
      t('no local write at all', st6.written === null);
    }

    console.log('\ndeleteInvoiceDocsFromServer() — tombstones first so the delete propagates');
    {
      const { sync: s7, state: st7 } = makeSync(SERVER_DOCS, []);
      const n = await s7.deleteInvoiceDocsFromServer(['srv-A', 'srv-B']);
      t('reports 2 deleted', n === 2);
      t('tombstoned BEFORE deleting, so other devices get the signal',
        st7.tombstoned.join(',') === 'srv-A,srv-B', st7.tombstoned.join(','));
      t('both docs deleted from the server', st7.deleted.join(',') === 'srv-A,srv-B');
    }

    console.log('\ndeleteInvoiceDocsFromServer() — a failed commit REJECTS, never reports false success');
    {
      // The v1.0.211 lesson: the old cleanup paths swallowed this with console.warn and
      // reported success. Here the caller must see the failure and log it.
      const { sync: s8 } = makeSync(SERVER_DOCS, [], { commitFails: true });
      let threw = false;
      try { await s8.deleteInvoiceDocsFromServer(['srv-A']); } catch (e) { threw = true; }
      t('the rejection propagates to the caller', threw === true);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
