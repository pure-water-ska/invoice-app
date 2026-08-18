// test-explicit-delete-logging.js — run:  node test-explicit-delete-logging.js
//
// Covers the fix for a real reliability gap in the explicit-delete cleanup used after
// an invoice edit (invoice-create.html) and after a manual invoice delete
// (invoices.html): batch.commit() was fire-and-forget — `.catch(e =>
// console.warn(...))` — with no persistent record of failure. console.warn is
// invisible in release Tauri builds (DevTools disabled), so a failed cleanup was
// completely untraceable. This is very likely the actual mechanism behind the
// documented live recurrence: invoice 180769-001's stale pre-edit page came back
// TWICE after being manually deleted from the Firestore console.
//
// Per explicit user decision: no retry queue, just visibility — DB.logError() on
// failure so it shows in Settings → Troubleshoot. The existing sub-row cleanup UI
// (ปัจจุบัน/เก่า/ซ้ำ badges, v1.0.210) is the manual recovery path if this fires.
//
// Extracts the ACTUAL code from both files and drives it with a stub Sync/DB whose
// batch.commit() rejects, proving the failure is now recorded — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

function fakeSync(commitResult) {
  const state = { tombstoned: null, deletedIds: [] };
  return {
    sync: {
      ready: true,
      _addTombstones: (col, ids) => { state.tombstoned = { col, ids }; },
      _orgRef: () => ({ collection: (name) => ({ doc: (id) => ({ _col: name, _id: id }) }) }),
      _db: {
        batch: () => ({
          delete: (ref) => { state.deletedIds.push(ref._id); },
          commit: () => commitResult(),
        }),
      },
    },
    state,
  };
}

console.log('invoices.html: _explicitlyDeleteFromFirestore() logs to DB.logError on a failed commit');
{
  const src = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
  const start = src.indexOf('function _explicitlyDeleteFromFirestore');
  const end = src.indexOf('\n}', start) + 2;
  if (start < 0) throw new Error('function not found — update extraction marker');
  const block = src.slice(start, end);

  const logCalls = [];
  const DB = { logError: (type, msg, detail) => logCalls.push({ type, msg, detail }) };
  const { sync: Sync, state } = fakeSync(() => Promise.reject(new Error('permission-denied')));

  const fn = new Function('DB', 'window', 'Sync', 'console', `${block}\nreturn _explicitlyDeleteFromFirestore;`);
  const consoleStub = { warn: () => {} };
  const del = fn(DB, { Sync }, Sync, consoleStub);

  del('invoices', ['old1', 'old2']); // fire-and-forget by design — doesn't return a promise

  (async () => {
    await new Promise(r => setTimeout(r, 0)); // let the rejected promise's .catch handler run
    t('tombstones added before the delete attempt', state.tombstoned && state.tombstoned.ids.join(',') === 'old1,old2');
    t('batch.delete called for both ids', state.deletedIds.join(',') === 'old1,old2');
    t('DB.logError called exactly once on failure', logCalls.length === 1, JSON.stringify(logCalls));
    t('logged with the DELETE-CLEANUP-FAILED type', logCalls[0] && logCalls[0].type === 'DELETE-CLEANUP-FAILED');
    t('detail carries colName and the exact failed ids', logCalls[0] &&
      logCalls[0].detail.colName === 'invoices' && logCalls[0].detail.ids.join(',') === 'old1,old2',
      JSON.stringify(logCalls[0] && logCalls[0].detail));

    console.log('\ninvoices.html: no logError call when the commit SUCCEEDS (no false alarms)');
    {
      const logCalls2 = [];
      const DB2 = { logError: (type, msg, detail) => logCalls2.push({ type, msg, detail }) };
      const { sync: Sync2 } = fakeSync(() => Promise.resolve());
      const del2 = fn(DB2, { Sync: Sync2 }, Sync2, consoleStub);
      del2('invoices', ['x']);
      await new Promise(r => setTimeout(r, 0));
      t('logError never called on success', logCalls2.length === 0);
    }

    console.log('\ninvoices.html: empty id list is a no-op — never even attempts the batch');
    {
      const logCalls3 = [];
      const DB3 = { logError: (type, msg, detail) => logCalls3.push({ type, msg, detail }) };
      const { sync: Sync3, state: state3 } = fakeSync(() => Promise.reject(new Error('should never be called')));
      const del3 = fn(DB3, { Sync: Sync3 }, Sync3, consoleStub);
      del3('invoices', []);
      await new Promise(r => setTimeout(r, 0));
      t('no tombstones, no delete, no log', state3.tombstoned === null && state3.deletedIds.length === 0 && logCalls3.length === 0);
    }

    runPart2();
  })();
}

function runPart2() {
  console.log('\ninvoice-create.html: the saveInvoiceEdit() cleanup block logs to DB.logError on a failed commit');
  {
    const lines = fs.readFileSync(path.join(DIR, 'invoice-create.html'), 'utf8').split('\n');
    const startLine = lines.findIndex(l => l.trim() === 'if (window.Sync && Sync.ready) {');
    if (startLine < 0) throw new Error('block start not found — update extraction marker');
    // walk forward tracking brace depth to find the block's matching close
    let depth = 0, endLine = -1;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endLine = i; break; } }
      }
      if (endLine >= 0) break;
    }
    if (endLine < 0) throw new Error('block end not found');
    const block = lines.slice(startLine, endLine + 1).join('\n');

    const logCalls = [];
    const DB = { logError: (type, msg, detail) => logCalls.push({ type, msg, detail }) };
    const { sync: Sync, state } = fakeSync(() => Promise.reject(new Error('unavailable')));
    const existingPages = [{ id: 'stale1' }, { id: 'stale2' }];
    const currentInvNum = '180769-001';

    const fn = new Function('DB', 'window', 'Sync', 'console', 'existingPages', 'currentInvNum',
      `${block}\n`);
    const consoleStub = { warn: () => {} };
    fn(DB, { Sync }, Sync, consoleStub, existingPages, currentInvNum);

    setTimeout(() => {
      t('tombstones added for the exact stale ids', state.tombstoned && state.tombstoned.ids.join(',') === 'stale1,stale2');
      t('DB.logError called exactly once', logCalls.length === 1, JSON.stringify(logCalls));
      t('logged with the EDIT-DELETE-FAILED type', logCalls[0] && logCalls[0].type === 'EDIT-DELETE-FAILED');
      t('message mentions the invoice number', logCalls[0] && logCalls[0].msg.includes('180769-001'), logCalls[0] && logCalls[0].msg);
      t('detail carries invoiceNumber and oldIds', logCalls[0] &&
        logCalls[0].detail.invoiceNumber === '180769-001' && logCalls[0].detail.oldIds.join(',') === 'stale1,stale2');

      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }, 10);
  }
}
