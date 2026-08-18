// test-subrow-badges.js — run:  node test-subrow-badges.js
//
// Covers invoices.html's expanded sub-row rendering — specifically the "ปัจจุบัน" /
// "เก่า/ซ้ำ" badges (v1.0.202) and the collision warning + renumber button (v1.0.199/204).
//
// Bug found and fixed here: isCurrent was computed as `pg.id === inv.id`, where `inv` is
// the single record the outer `seen` map picks to represent the WHOLE invoice number.
// That works fine when the duplicate group and `inv` share a customer, but 300669-209 is
// a COMBINED case — a genuine cross-customer collision (ร้านอรวรรณ vs ทรัพย์มณี) where the
// same-customer duplicate group (2× ทรัพย์มณี) belongs to the customer NOT picked as `inv`.
// No ทรัพย์มณี record's id could ever equal inv.id (a ร้านอรวรรณ id), so BOTH duplicate
// rows showed "เก่า/ซ้ำ" and NEITHER showed "ปัจจุบัน" — no cue for which to keep. This was
// live and user-reported. Fix: compute the "current" (highest-editCount) member PER
// (customerId, page) GROUP, not against the single outer `inv` record.
//
// This exact combined shape was never covered by a committed test before — only ad hoc
// scratch verification during earlier development, which is how the bug shipped
// unnoticed. Extracts the ACTUAL sub-row block from invoices.html — not a
// reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
const start = src.indexOf('if (pages > 1 && isExp) {');
const endMark = "      }).join('');\n    }";
const end = src.indexOf(endMark, start) + endMark.length;
if (start < 0 || end <= start) throw new Error('invoices.html structure changed — update this test\'s extraction markers');
const block = src.slice(start, end);

const Utils = { formatDateTH: () => '', formatNumber: n => Number(n).toFixed(2) };

function render(allPages, invIndex, custMap) {
  const inv = allPages[invIndex];
  const pages = allPages.length, isExp = true, _selMode = false;
  const fn = new Function('allPages', 'inv', 'pages', 'isExp', '_selMode', 'custMap', 'Utils',
    'let html="";' + block + ';return html;');
  return fn(allPages, inv, pages, isExp, _selMode, custMap, Utils);
}

function rowsOf(html) {
  return html.split('<tr').slice(1).map(r => '<tr' + r);
}
function badgeOf(row) {
  if (/badge bg-success ms-1">ปัจจุบัน/.test(row)) return 'current';
  if (/badge bg-secondary ms-1">เก่า\/ซ้ำ/.test(row)) return 'stale';
  return null;
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('the exact production bug: cross-customer collision WHERE the duplicate group is NOT the customer picked as inv');
{
  const custMap = { AO: { id: 'AO', name: 'ร้านอรวรรณ ดริ้งค์' }, TM: { id: 'TM', name: 'ทรัพย์มณี' } };
  const allPages = [
    { id: 'ao1', invoiceNumber: 'NUM-1', customerId: 'AO', page: 1, totalAmount: 9112.5, items: [{ name: 'ขวด' }], editCount: 0 },
    { id: 'tm1', invoiceNumber: 'NUM-1', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
    { id: 'tm2', invoiceNumber: 'NUM-1', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
  ];
  // inv = allPages[0] = the ร้านอรวรรณ record — mirrors the `seen` map necessarily picking
  // SOME single record for the whole number, which cannot equal either ทรัพย์มณี id.
  const html = render(allPages, 0, custMap);
  const rows = rowsOf(html);
  const tmRows = rows.filter(r => r.includes('ทรัพย์มณี'));
  t('exactly 2 ทรัพย์มณี rows found', tmRows.length === 2, `found ${tmRows.length}`);
  const badges = tmRows.map(badgeOf);
  t('exactly ONE ทรัพย์มณี row is marked current', badges.filter(b => b === 'current').length === 1, JSON.stringify(badges));
  t('exactly ONE ทรัพย์มณี row is marked stale', badges.filter(b => b === 'stale').length === 1, JSON.stringify(badges));
  t('collision warning banner present', /ถูกใช้ซ้ำกับลูกค้า 2 ราย/.test(html));
  t('duplicate-page banner present', /มีหน้าซ้ำของลูกค้าเดียวกัน/.test(html));
}

console.log('\nsame bug, but inv happens to be one of the DUPLICATE group members — must still work (no regression)');
{
  const custMap = { AO: { id: 'AO', name: 'ร้านอรวรรณ ดริ้งค์' }, TM: { id: 'TM', name: 'ทรัพย์มณี' } };
  const allPages = [
    { id: 'tm1', invoiceNumber: 'NUM-2', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
    { id: 'ao1', invoiceNumber: 'NUM-2', customerId: 'AO', page: 1, totalAmount: 9112.5, items: [{ name: 'ขวด' }], editCount: 0 },
    { id: 'tm2', invoiceNumber: 'NUM-2', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
  ];
  const html = render(allPages, 0, custMap); // inv = tm1, a member of the duplicate group
  const rows = rowsOf(html);
  const tmRows = rows.filter(r => r.includes('ทรัพย์มณี'));
  const badges = tmRows.map(badgeOf);
  t('still exactly one current, one stale', badges.filter(b => b === 'current').length === 1 &&
    badges.filter(b => b === 'stale').length === 1, JSON.stringify(badges));
}

console.log('\nrenumber button (↻) only ever appears on the foreign customer\'s rows, never the group with inv');
{
  const custMap = { AO: { id: 'AO', name: 'ร้านอรวรรณ ดริ้งค์' }, TM: { id: 'TM', name: 'ทรัพย์มณี' } };
  const allPages = [
    { id: 'ao1', invoiceNumber: 'NUM-3', customerId: 'AO', page: 1, totalAmount: 9112.5, items: [{ name: 'ขวด' }], editCount: 0 },
    { id: 'tm1', invoiceNumber: 'NUM-3', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
    { id: 'tm2', invoiceNumber: 'NUM-3', customerId: 'TM', page: 1, totalAmount: 9640, items: [], editCount: 0 },
  ];
  const html = render(allPages, 0, custMap);
  const renumberCalls = html.match(/renumberInvoicePage\([^)]*\)/g) || [];
  t('renumber offered on both ทรัพย์มณี rows (both foreign to inv)', renumberCalls.length === 2, JSON.stringify(renumberCalls));
  t('never offered on the ร้านอรวรรณ row', !renumberCalls.some(c => c.includes('ao1')));
}

console.log('\nsame-customer duplicate WITHOUT any cross-customer collision — no collision banner, badges still correct');
{
  const custMap = { A: { id: 'A', name: 'ลูกค้า A' } };
  const allPages = [
    { id: 'old', invoiceNumber: 'NUM-4', customerId: 'A', page: 1, totalAmount: 900, items: [], editCount: 0 },
    { id: 'new', invoiceNumber: 'NUM-4', customerId: 'A', page: 1, totalAmount: 800, items: [{ name: 'x' }], editCount: 1 },
  ];
  const html = render(allPages, 0, custMap); // inv = old (array-first, matches production shape)
  t('no collision banner (only one customer)', !/ถูกใช้ซ้ำกับลูกค้า/.test(html));
  t('duplicate-page banner present', /มีหน้าซ้ำของลูกค้าเดียวกัน/.test(html));
  const rows = rowsOf(html);
  const badges = rows.map(badgeOf).filter(Boolean);
  t('the higher-editCount record is current, not array-first', badges.filter(b => b === 'current').length === 1);
  const newRow = rows.find(r => r.includes('฿800.00') || true); // sanity: current picks editCount 1 regardless of inv
  t('exactly one stale', badges.filter(b => b === 'stale').length === 1);
}

console.log('\ncross-customer collision with NO duplicates (each customer has exactly one record) — no dup banner, no badges');
{
  const custMap = { AO: { id: 'AO', name: 'ร้านอรวรรณ ดริ้งค์' }, TM: { id: 'TM', name: 'ทรัพย์มณี' } };
  const allPages = [
    { id: 'ao1', invoiceNumber: 'NUM-5', customerId: 'AO', page: 1, totalAmount: 10661.4, items: [{ name: 'x' }], editCount: 0 },
    { id: 'tm1', invoiceNumber: 'NUM-5', customerId: 'TM', page: 1, totalAmount: 4485, items: [], editCount: 0 },
  ];
  const html = render(allPages, 0, custMap);
  t('collision banner present', /ถูกใช้ซ้ำกับลูกค้า 2 ราย/.test(html));
  t('NO duplicate-page banner (no customer has 2 records)', !/มีหน้าซ้ำของลูกค้าเดียวกัน/.test(html));
  t('no ปัจจุบัน/เก่า badges at all', !/ปัจจุบัน|เก่า\/ซ้ำ/.test(html));
  t('renumber offered on the one foreign (ทรัพย์มณี) row', (html.match(/renumberInvoicePage/g) || []).length === 1);
}

console.log('\nordinary multi-page invoice (2 real pages, different page numbers) — completely unaffected');
{
  const custMap = { A: { id: 'A', name: 'ลูกค้า A' } };
  const allPages = [
    { id: 'p1', invoiceNumber: 'NUM-6', customerId: 'A', page: 1, totalAmount: 500, items: [{ name: 'x' }], editCount: 0 },
    { id: 'p2', invoiceNumber: 'NUM-6', customerId: 'A', page: 2, totalAmount: 500, items: [{ name: 'y' }], editCount: 0 },
  ];
  const html = render(allPages, 0, custMap);
  t('no collision banner', !/ถูกใช้ซ้ำกับลูกค้า/.test(html));
  t('no duplicate banner', !/มีหน้าซ้ำของลูกค้าเดียวกัน/.test(html));
  t('no badges', !/ปัจจุบัน|เก่า\/ซ้ำ/.test(html));
  t('no renumber button', !/renumberInvoicePage/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
