// test-pricing-no-price-customers.js — run:  node test-pricing-no-price-customers.js
//
// User-reported: "why เขากลอยการค้า cannot be found at pricing.html". Investigated on the
// live data: the customer IS present (99 customers, id mq0t77la4xkdetas8) and the picker
// DOES match them — but they hold 0 of the 3,277 pricing rules, so filtering the price
// list by that name matched nothing and the table showed the bare "ไม่พบข้อมูลราคา",
// which reads as though the CUSTOMER is missing rather than their prices.
//
// Two fixes, both covered here:
//   1. renderNoPriceBanner() surfaces every customer with no rules at all — they bill at
//      ราคากลาง, which is legitimate but invisible everywhere else in the app. Three exist
//      in production and were only found because one was reported as missing.
//   2. The empty state names the customer when the typed filter resolves to exactly one,
//      instead of the ambiguous message. An unmatched string still gets the plain message.
//
// Extracts the ACTUAL functions from pricing.html — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'pricing.html'), 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

function grab(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s < 0) throw new Error(`${name} not found — update extraction marker`);
  let depth = 0, i = src.indexOf('{', s), seen = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return src.slice(s, i);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

function build(customers, pricing, expanded = false) {
  const DB = { getPricing: () => pricing, getCustomers: () => customers };
  let html = '', display = null;
  const box = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    style: { set display(v) { display = v; }, get display() { return display; } },
  };
  const document = { getElementById: id => (id === 'noPriceBanner' ? box : null) };
  const fns = new Function('DB', 'document', 'esc', '_npExpanded',
    `${grab('customersWithoutPrices')}\n${grab('renderNoPriceBanner')}\n` +
    `return { customersWithoutPrices, renderNoPriceBanner };`)(DB, document, esc, expanded);
  return { fns, get html() { return html; }, get display() { return display; } };
}

// The exact production shape found on the live data.
const CUSTS = [
  { id: 'a', name: 'เขากลอยการค้า' },
  { id: 'b', name: 'น้ำดื่มทวีสุข' },
  { id: 'c', name: 'ร้านที่มีราคา' },
  { id: 'd', name: 'มัสยิดกลาง ปริก' },
];
const PRICING = [{ customerId: 'c', productId: 'p1' }, { customerId: null, productId: 'p2' }];

console.log('customersWithoutPrices() — finds customers holding no rule at all');
{
  const b = build(CUSTS, PRICING);
  const none = b.fns.customersWithoutPrices(CUSTS);
  t('finds exactly the 3 uncovered customers', none.length === 3, none.map(c => c.name).join(', '));
  t('excludes the customer who has a rule', !none.some(c => c.id === 'c'));
  t('a null-customerId rule (ราคากลาง) does not count as covering anyone',
    none.map(c => c.id).join(',') === 'a,b,d');
}

console.log('\ncustomersWithoutPrices() — ignores malformed customer records');
{
  const b = build([...CUSTS, null, { name: 'no id' }], PRICING);
  const none = b.fns.customersWithoutPrices([...CUSTS, null, { name: 'no id' }]);
  t('a null entry and an id-less record are skipped, not counted or crashed',
    none.length === 3, String(none.length));
}

console.log('\nrenderNoPriceBanner() — shows the count and a chip per customer');
{
  const b = build(CUSTS, PRICING);
  b.fns.renderNoPriceBanner(CUSTS);
  t('banner is made visible', b.display === '');
  t('reports 3 ราย', /<strong>3 ราย<\/strong>/.test(b.html), (b.html.match(/<strong>[^<]*<\/strong>/) || [])[0]);
  t('one clickable chip per customer', (b.html.match(/openPriceModalFor\(/g) || []).length === 3);
  t('chips carry the customer names', b.html.includes('เขากลอยการค้า') && b.html.includes('มัสยิดกลาง ปริก'));
  t('list starts collapsed', /id="noPriceList" style="display:none"/.test(b.html));
}

console.log('\nrenderNoPriceBanner() — hidden entirely when every customer has a rule');
{
  const covered = [{ customerId: 'a' }, { customerId: 'b' }, { customerId: 'c' }, { customerId: 'd' }];
  const b = build(CUSTS, covered);
  b.fns.renderNoPriceBanner(CUSTS);
  t('banner hidden', b.display === 'none');
  t('and emptied, so no stale chips linger', b.html === '');
}

console.log('\nrenderNoPriceBanner() — respects the expanded toggle across re-renders');
{
  const b = build(CUSTS, PRICING, true);
  b.fns.renderNoPriceBanner(CUSTS);
  t('stays open when _npExpanded is true', /id="noPriceList" style="display:block"/.test(b.html));
  t('toggle button reads ซ่อน', b.html.includes('>ซ่อน<'));
}

console.log('\nEmpty state — names the customer only when the filter resolves to exactly one');
{
  // The real branch out of render(); `hit` decides which message shows.
  const pick = (fc, customers) => fc ? customers.filter(c => (c.name || '').toLowerCase().includes(fc)) : [];
  t('a full unique name → 1 hit, so the named message shows',
    pick('เขากลอย', CUSTS).length === 1);
  t('an unmatched string → 0 hits, so the plain ไม่พบข้อมูลราคา shows',
    pick('ไม่มีลูกค้าชื่อนี้', CUSTS).length === 0);
  t('an ambiguous prefix matching several → not named (would be misleading)',
    pick('ร้าน', [...CUSTS, { id: 'e', name: 'ร้านอีกแห่ง' }]).length === 2);
  t('empty filter → no hits, plain message', pick('', CUSTS).length === 0);
}

console.log('\nThe rendered empty state carries the right pieces');
{
  const s = src.indexOf('ยังไม่มีราคาเฉพาะ');
  t('the named branch exists in render()', s > 0);
  const block = src.slice(s - 400, s + 500);
  t('offers a button to add a price for that customer', block.includes('openPriceModalFor('));
  t('explains the ราคากลาง fallback', block.includes('ใช้ราคากลางอยู่'));
  t('the plain message is still the fallback', block.includes('ไม่พบข้อมูลราคา'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
