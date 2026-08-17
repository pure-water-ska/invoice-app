// test-save-edit-meta.js — run:  node test-save-edit-meta.js
//
// Covers the specific highest-severity part of the "stale-edit duplicate" fix: the
// meta/editHistory computation at the top of saveInvoiceEdit() in invoice-create.html.
//
// Before the fix, `meta` was `existingPages[0]` — array-order-first over the RAW list of
// every physical record under the invoice number. If a stale pre-edit record (see
// DB.getCurrentPagesByNumber()'s comment — an edit's old page sometimes survives a
// failed Firestore delete) happened to sort first, saving a FURTHER edit would:
//   - compute newEditCount from the STALE record's (lower) editCount, resetting the
//     count backward instead of incrementing from the true current value.
//   - spread the STALE record's (shorter) editHistory array — silently TRUNCATING the
//     real edit history, losing prior edits' "previous" snapshots permanently.
//   - flatMap items from BOTH the stale and current records into the "previous"
//     snapshot, corrupting what the history entry claims the pre-edit state was.
//
// existingPages (the raw list) is still used elsewhere in the real function for oldIds
// — deletion needs every physical record so cleanup removes the stale one too. Only
// meta/editHistory needed to change, which is exactly what this test isolates.
//
// Extracts the ACTUAL code block from invoice-create.html and drives it with a stub DB
// and fixture invoice records — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'invoice-create.html'), 'utf8');
const start = src.indexOf('  const existingPages = DB.getInvoices().filter');
const end   = src.indexOf('  const totalAmount = activeItems.reduce', start);
if (start < 0 || end < start) throw new Error('invoice-create.html structure changed — update this test\'s extraction markers');
const block = src.slice(start, end);

// Real DB.getCurrentPagesByNumber(), loaded from the actual db.js — not reimplemented.
const DBReal = new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();

function run(invoices, currentInvNum) {
  DBReal._cache = DBReal._cache || {};
  DBReal._cache[DBReal.K.INVOICES] = invoices;
  DBReal._set = function (k, v) { this._cache[k] = v; };
  const session = { name: 'joe', username: 'joe' };
  const fn = new Function('DB', 'currentInvNum', 'session',
    `${block}\nreturn { existingPages, currentPages, meta, newEditCount, editHistory };`
  );
  return fn(DBReal, currentInvNum, session);
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('the exact danger scenario: stale record sorts FIRST, has lower editCount and shorter history');
{
  const invoices = [
    // stale (pre-edit) record — survived a failed delete, sorts first in array order
    {
      id: 'stale', invoiceNumber: 'NUM-1', customerId: 'A', page: 1,
      editCount: 1, totalAmount: 900,
      editHistory: [{ at: '2026-01-01', previous: { totalAmount: 800 } }], // only 1 entry
    },
    // current (post-edit) record — the real one, has the FULL history
    {
      id: 'current', invoiceNumber: 'NUM-1', customerId: 'A', page: 1,
      editCount: 2, totalAmount: 700,
      editHistory: [
        { at: '2026-01-01', previous: { totalAmount: 800 } },
        { at: '2026-01-02', previous: { totalAmount: 900 } },
      ], // 2 entries — the TRUE history
      items: [{ name: 'ขวด PET', qty: 10 }],
    },
  ];
  const { meta, newEditCount, editHistory } = run(invoices, 'NUM-1');

  t('meta resolves to the CURRENT record, not the stale one', meta.id === 'current', meta.id);
  t('newEditCount increments from the TRUE current value (2→3), not the stale one (1→2)',
    newEditCount === 3, `got ${newEditCount}`);
  t('editHistory is NOT truncated — starts from the full 2-entry history, not the stale 1-entry one',
    editHistory.length === 3, `length=${editHistory.length}`);
  t('the new entry\'s "previous" totalAmount is the CURRENT record\'s total (700), not the stale one\'s (900)',
    editHistory[2].previous.totalAmount === 700, JSON.stringify(editHistory[2].previous));
  t('the new entry\'s "previous" items come from the CURRENT record only',
    editHistory[2].previous.items.length === 1 && editHistory[2].previous.items[0].name === 'ขวด PET',
    JSON.stringify(editHistory[2].previous.items));
}

console.log('\nexistingPages (used elsewhere for Firestore deletion) still returns the FULL raw list');
{
  const invoices = [
    { id: 'stale', invoiceNumber: 'NUM-2', customerId: 'A', page: 1, editCount: 0 },
    { id: 'current', invoiceNumber: 'NUM-2', customerId: 'A', page: 1, editCount: 1 },
  ];
  const { existingPages, currentPages } = run(invoices, 'NUM-2');
  t('existingPages has BOTH records — deletion cleanup needs the stale one included',
    existingPages.length === 2, JSON.stringify(existingPages.map(p => p.id)));
  t('currentPages has only the ONE current record', currentPages.length === 1 && currentPages[0].id === 'current');
}

console.log('\nno stale duplicate (ordinary edit) — behaves exactly as before, no regression');
{
  const invoices = [
    { id: 'only', invoiceNumber: 'NUM-3', customerId: 'A', page: 1, editCount: 0, totalAmount: 500, editHistory: [] },
  ];
  const { meta, newEditCount, editHistory } = run(invoices, 'NUM-3');
  t('meta is the one and only record', meta.id === 'only');
  t('editCount increments normally 0→1', newEditCount === 1);
  t('history gets its first entry', editHistory.length === 1);
}

console.log('\nfirst-ever edit (no prior invoice record found at all) — falls back gracefully, does not throw');
{
  const { meta, newEditCount, editHistory } = run([], 'NUM-DOES-NOT-EXIST');
  t('meta falls back to an empty object, not undefined', typeof meta === 'object' && meta !== null);
  t('editCount starts at 1', newEditCount === 1);
  t('history has exactly the new entry', editHistory.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
