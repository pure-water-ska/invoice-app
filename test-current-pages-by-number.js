// test-current-pages-by-number.js — run:  node test-current-pages-by-number.js
//
// Covers DB.getCurrentPagesByNumber() (db.js) — the fix for a bug reported as "an edited
// invoice's printed edit count also shows on the original page."
//
// Root cause: an edit writes a new page record and is supposed to explicitly delete the
// old one from Firestore, but that delete has occasionally still failed to land
// (documented recurring live on invoice 180769-001 — see saveInvoiceEdit()'s own
// comment in invoice-create.html). Every VIEW/PRINT/EDIT-basis consumer used to fetch
// invoice pages with a raw DB.getInvoices().filter()/.find() — array-order-first, no
// awareness that two records might share a number. Concretely this meant:
//   - loadView()/doPrint(): the stale OLD-content page printed as if it were a real
//     extra page, and printCount got bumped on it too.
//   - doPrint()/renderPreview(): editCount/reprintCount were read from pages[0] and
//     applied to EVERY page in the print loop — so the OLD page's printout could show
//     an edit-count badge that belongs to the NEW page (exactly the reported symptom).
//   - loadEdit(): items were flatMapped across BOTH records into the edit form —
//     duplicated/wrong line items, risking corruption on the next save.
//   - saveInvoiceEdit()'s meta (editCount/editHistory/printCount/issuedAt basis): if
//     the stale record sorted first, editCount could reset BACKWARD and editHistory
//     could be silently TRUNCATED (the stale record's history is shorter).
//
// getCurrentPagesByNumber() collapses each (customerId, page) group down to the
// highest-editCount record, so all of the above resolve to the correct one. Deletion
// flows (existingPages/oldIds) deliberately keep using the raw getInvoicesByNumber() —
// they need every physical record so cleanup removes the stale one too.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function loadDB() {
  return new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();
}

function withInvoices(invoices) {
  const DB = loadDB();
  global.window = {};
  DB._cache[DB.K.INVOICES] = invoices;
  DB._set = function (k, v) { this._cache[k] = v; };
  return DB;
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('the exact reported shape: 2 records, same customer, same page, different editCount');
{
  const DB = withInvoices([
    { id: 'old', invoiceNumber: 'NUM-1', customerId: 'A', page: 1, editCount: 0, totalAmount: 23665, printCount: 3 },
    { id: 'new', invoiceNumber: 'NUM-1', customerId: 'A', page: 1, editCount: 1, totalAmount: 22715, printCount: 3 },
  ]);
  const out = DB.getCurrentPagesByNumber('NUM-1');
  t('exactly ONE record returned, not two', out.length === 1, JSON.stringify(out.map(r => r.id)));
  t('it is the higher-editCount (current) one', out[0].id === 'new');
  t('the stale record is excluded entirely — never printed, never counted', !out.some(r => r.id === 'old'));
}

console.log('\narray order does not matter — stale-first must still resolve to current');
{
  // Same fixture, OLD record listed FIRST — this is the exact shape that broke plain
  // .find()/[0] everywhere before this fix.
  const DB = withInvoices([
    { id: 'old', invoiceNumber: 'NUM-2', customerId: 'A', page: 1, editCount: 0 },
    { id: 'new', invoiceNumber: 'NUM-2', customerId: 'A', page: 1, editCount: 3 },
  ]);
  t('still picks the current record despite array order', DB.getCurrentPagesByNumber('NUM-2')[0].id === 'new');
}

console.log('\nordinary multi-page invoice (distinct page numbers) is completely unaffected');
{
  const DB = withInvoices([
    { id: 'p1', invoiceNumber: 'NUM-3', customerId: 'A', page: 1, editCount: 0 },
    { id: 'p2', invoiceNumber: 'NUM-3', customerId: 'A', page: 2, editCount: 0 },
    { id: 'p3', invoiceNumber: 'NUM-3', customerId: 'A', page: 3, editCount: 0 },
  ]);
  const out = DB.getCurrentPagesByNumber('NUM-3');
  t('all 3 real pages returned', out.length === 3, JSON.stringify(out.map(r => r.id)));
  t('sorted by page ascending', out.map(r => r.page).join(',') === '1,2,3');
}

console.log('\ncross-customer collision (different customerId) is unaffected — both kept, not merged');
{
  const DB = withInvoices([
    { id: 'a', invoiceNumber: 'NUM-4', customerId: 'A', page: 1, editCount: 0 },
    { id: 'b', invoiceNumber: 'NUM-4', customerId: 'B', page: 1, editCount: 5 },
  ]);
  const out = DB.getCurrentPagesByNumber('NUM-4');
  t('both customers\' records survive — this is a collision, not a duplicate', out.length === 2,
    JSON.stringify(out.map(r => r.id)));
  // Higher editCount must NOT cause one customer's record to "win" over the other's —
  // that would silently drop a different customer's real invoice.
  t('neither record was dropped for having a lower editCount', out.some(r => r.id === 'a') && out.some(r => r.id === 'b'));
}

console.log('\n3-way duplicate, no edit history at all (010469-206\'s actual shape — tie, not a clean edit)');
{
  const DB = withInvoices([
    { id: 'r1', invoiceNumber: 'NUM-5', customerId: 'A', page: 1, editCount: 0, totalAmount: 18910.8 },
    { id: 'r2', invoiceNumber: 'NUM-5', customerId: 'A', page: 1, editCount: 0, totalAmount: 16947.3 },
    { id: 'r3', invoiceNumber: 'NUM-5', customerId: 'A', page: 1, editCount: 0, totalAmount: 16947.3 },
  ]);
  const out = DB.getCurrentPagesByNumber('NUM-5');
  t('collapses to exactly one (no signal to prefer any, so array-first wins the tie)',
    out.length === 1 && out[0].id === 'r1', JSON.stringify(out.map(r => r.id)));
}

console.log('\nmissing customerId/page fields do not crash (defensive — treat as one shared group)');
{
  const DB = withInvoices([
    { id: 'x', invoiceNumber: 'NUM-6', editCount: 0 },
    { id: 'y', invoiceNumber: 'NUM-6', editCount: 1 },
  ]);
  const out = DB.getCurrentPagesByNumber('NUM-6');
  t('does not throw, picks the higher editCount', out.length === 1 && out[0].id === 'y');
}

console.log('\nunknown invoice number returns an empty array, not undefined/throw');
{
  const DB = withInvoices([{ id: 'x', invoiceNumber: 'NUM-7', customerId: 'A', page: 1 }]);
  const out = DB.getCurrentPagesByNumber('DOES-NOT-EXIST');
  t('empty array', Array.isArray(out) && out.length === 0);
}

console.log('\nequal editCount, non-first-in-array — first-seen wins deterministically (no signal to prefer either)');
{
  const DB = withInvoices([
    { id: 'first', invoiceNumber: 'NUM-8', customerId: 'A', page: 1, editCount: 2 },
    { id: 'second', invoiceNumber: 'NUM-8', customerId: 'A', page: 1, editCount: 2 },
  ]);
  t('deterministic: keeps the first one seen', DB.getCurrentPagesByNumber('NUM-8')[0].id === 'first');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
