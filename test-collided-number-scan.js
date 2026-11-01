// test-collided-number-scan.js — v1.0.255
//
// Nothing in the app SCANNED for an invoice number held by two different invoices. The
// settings lookup asks the server about one number you already type in, which only helps
// if something made you suspect it — and a SAME-customer duplicate is invisible
// everywhere else, because getCurrentPagesByNumber collapses (customerId|page) to the top
// editCount and a tie keeps first-seen, so the second invoice is never displayed, printed
// or summed. That is the production shape: device A saved and PRINTED while its uploads
// were stuck, nothing reserved the number, and device B was handed the same one.
//
// DB.findCollidedInvoiceNumbers reads records already in memory — zero Firestore reads —
// and reports only what cannot be proven stale. The risk in a scanner like this is crying
// wolf: a real multi-page invoice legitimately shares a number, and a superseded edit page
// is already the sweep's job. Both must stay silent, or the card gets ignored.
//
// Run: node test-collided-number-scan.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage = global.localStorage;
global.LZString = { compressToUTF16: s => s, decompressFromUTF16: s => s };
global.document = { addEventListener() {}, getElementById: () => null };
global.navigator = { onLine: true };
global.Utils = { uuid: (() => { let n = 0; return () => 'uuid-' + (++n); })() };

const DB = new Function(fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8') + '\n;return DB;')();

const rec = o => Object.assign({
  id: 'r' + Math.random().toString(36).slice(2), invoiceNumber: 'A-1', customerId: 'C1',
  page: 1, editCount: 0, totalAmount: 100, printCount: 0, cancelled: false,
  createdAt: '2026-11-01T00:00:00.000Z',
}, o);
const scan = recs => DB.findCollidedInvoiceNumbers(recs);

section('the reported shape: two devices, one number, one customer');
{
  const hits = scan([
    rec({ id: 'A', totalAmount: 5000, printCount: 1, _by: 'dev_A_stuck' }),
    rec({ id: 'B', totalAmount: 7000, printCount: 0, _by: 'dev_B_online' }),
  ]);
  t('it is reported', hits.length === 1, hits.length);
  t('classified as an undecidable tie', hits[0].kind === 'tie', hits[0] && hits[0].kind);
  t('both records are carried, not just a count', hits[0].detail.length === 2);
  // printCount is the deciding field: the printed copy is in a customer's hands.
  t('it reports how many copies were printed', hits[0].printed === 1, hits[0].printed);
  t('…and the per-record print count, so the UI can name which',
    hits[0].detail.find(d => d.id === 'A').printCount === 1 &&
    hits[0].detail.find(d => d.id === 'B').printCount === 0);
  t('the writing device is carried for telling them apart',
    hits[0].detail.map(d => d.by).sort().join(',') === 'dev_A_stuck,dev_B_online');
}

section('what must NOT be reported — or the card gets ignored');
{
  // A long invoice spans pages and shares one number by design.
  t('a real multi-page invoice is silent',
    scan([rec({ page: 1 }), rec({ page: 2 }), rec({ page: 3 })]).length === 0);
  // An edit writes a new record and deletes the old; a failed delete is the sweep's job.
  t('a superseded edit page is silent',
    scan([rec({ editCount: 0, totalAmount: 500 }), rec({ editCount: 1, totalAmount: 600 })]).length === 0);
  t('a single invoice is silent', scan([rec({})]).length === 0);
  t('an empty dataset is silent', scan([]).length === 0);
  // Cancelled invoices are excluded everywhere money or identity is judged.
  t('a cancelled twin is silent',
    scan([rec({ id: 'live' }), rec({ id: 'void', cancelled: true })]).length === 0);
  t('a record with no invoice number is ignored, not crashed on',
    scan([rec({ invoiceNumber: '' }), rec({ invoiceNumber: null })]).length === 0);
  t('nulls in the array do not crash it', scan([null, rec({}), undefined]).length === 0);
}

section('cross-customer collisions');
{
  const hits = scan([rec({ customerId: 'C1' }), rec({ customerId: 'C2' })]);
  t('one number held by two customers is reported', hits.length === 1);
  t('…classified as cross, not tie', hits[0].kind === 'cross', hits[0].kind);
  t('…and counts the customers', hits[0].customers === 2);

  // Both problems at once on one number.
  const both = scan([
    rec({ customerId: 'C1', id: 'a' }), rec({ customerId: 'C1', id: 'b' }),
    rec({ customerId: 'C2', id: 'c' }),
  ]);
  t('a number with a tie AND two customers is "both"', both[0].kind === 'both', both[0].kind);
}

section('mixed shapes under one number');
{
  // Page 1 is a genuine tie; page 2 is a clean superseded edit. Only the tie is ambiguous.
  const hits = scan([
    rec({ page: 1, id: 'p1a', editCount: 0 }),
    rec({ page: 1, id: 'p1b', editCount: 0 }),
    rec({ page: 2, id: 'p2old', editCount: 0 }),
    rec({ page: 2, id: 'p2new', editCount: 1 }),
  ]);
  t('the number is reported once', hits.length === 1);
  t('only the tied pair is detailed', hits[0].detail.length === 2 &&
    hits[0].detail.every(d => d.id.startsWith('p1')), hits[0].detail.map(d => d.id));
  t('the superseded page is counted separately, not as ambiguous',
    hits[0].supersededPages === 1, hits[0].supersededPages);
}

section('output shape the card depends on');
{
  // Three numbers, inserted A, C, B: sorted is A,B,C while simply reversing insertion
  // order gives B,C,A. With only two numbers a reverse looks identical to a sort.
  const hits = scan([
    rec({ invoiceNumber: 'A-1', id: 'a1' }), rec({ invoiceNumber: 'A-1', id: 'a2' }),
    rec({ invoiceNumber: 'C-3', id: 'c1' }), rec({ invoiceNumber: 'C-3', id: 'c2' }),
    rec({ invoiceNumber: 'B-2', id: 'b1' }), rec({ invoiceNumber: 'B-2', id: 'b2' }),
  ]);
  t('results are sorted by invoice number',
    hits.map(h => h.invoiceNumber).join(',') === 'A-1,B-2,C-3', hits.map(h => h.invoiceNumber));
  t('each hit carries its record count', hits[0].records === 2);
  t('totals are numbers, not strings', typeof hits[0].detail[0].totalAmount === 'number');
  t('a missing printCount reads as 0, never undefined',
    scan([rec({ id: 'n1', printCount: undefined }), rec({ id: 'n2' })])[0].detail
      .every(d => d.printCount === 0));
}

section('the card is wired up and runs by itself');
{
  const html = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
  const js   = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
  // settings.js already contains another sync:updated listener and another
  // `esc(c ? c.name …)`, in lookupInvoiceNumber. Assertions matching the whole file
  // passed while this card's own copies were removed — so scope to this function.
  const renderFn = (() => {
    const s = js.indexOf('function renderDupNumbers() {');
    const e = js.indexOf('\n}', js.indexOf('}).join(\'\')}`;', s));
    if (s < 0 || e < 0) throw new Error('renderDupNumbers not found');
    return js.slice(s, e);
  })();

  t('the card exists', /id="dupNumCard"/.test(html));
  t('…in the ซ่อมข้อมูล pane', (() => {
    const pane = html.slice(html.indexOf('data-pane="repair"'), html.indexOf('/tab-repair'));
    return pane.includes('id="dupNumCard"');
  })());
  t('…hidden until its permission gate runs', /id="dupNumCard" style="display:none"/.test(html));
  t('…and gated on admin or invoice_edit',
    /Auth\.isAdmin\(\) \|\| Auth\.can\('invoice_edit'\)/.test(js));

  t('it runs on load without being asked', /DOMContentLoaded[\s\S]{0,120}renderDupNumbers\(\)/.test(js));
  // Invoices arrive from the Firestore listener AFTER DB.ready resolves. A scan that only
  // ran on DOMContentLoaded would report "ไม่พบ" against an empty cache and never correct
  // itself — the exact trap CLAUDE.md documents for pages gating on DB.ready alone.
  t('…and again when sync delivers invoices',
    /addEventListener\('sync:updated', e => \{[\s\S]{0,200}?wt_invoices[\s\S]{0,80}?_dupNumScheduleRescan\(\)/.test(js));
  t('…and on a full pull', /addEventListener\('sync:pulled', _dupNumScheduleRescan\)/.test(js));
  t('the rescan is debounced', /clearTimeout\(_dupNumT\)/.test(js));

  t('the empty state states the window scanned, not just "ไม่พบ"',
    /ไม่พบเลขที่ซ้ำ — \$\{scope\}/.test(js) && /ย้อนหลัง \$\{\(window\.Sync && Sync\.ARCHIVE_MONTHS\) \|\| 6\} เดือน/.test(js));
  t('the advice depends on what was printed',
    /h\.printed === 0/.test(js) && /h\.printed === 1/.test(js));
  t('…and says the printed copy keeps its number', /ต้องคงเลขเดิมไว้/.test(js));
  t('it hands off to the server lookup rather than re-reading Firestore',
    /_dupNumLookup/.test(js) && /lookupInvoiceNumber\(\)/.test(js));
  t('customer names are escaped', /esc\(c \? c\.name/.test(renderFn));
  t('…as are invoice numbers put into markup', /esc\(h\.invoiceNumber\)/.test(renderFn));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
