// test-standard-price-retire.js — run:  node test-standard-price-retire.js
//
// User request: remove ทุกลูกค้า (ราคากลาง) prices — "which customer prices refer to
// standard prices, just keep its value" — converting ONLY the customer × product ×
// delivery combinations actually invoiced at a standard price (11 on live data), not all
// 2,769 theoretical fallbacks.
//
// Drives the REAL pricing.html functions (_stdConversions, _stdLostSave,
// renderStdRetireCard, retireStandardPrices, _pcRender) and the REAL DB.getPriceAsOf
// from db.js, with stubbed storage/DOM.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

function sliceBalanced(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('marker not found: ' + startMarker);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced: ' + startMarker);
  return src.slice(start, end);
}

const html = fs.readFileSync(path.join(DIR, 'pricing.html'), 'utf8');
const dbSrc = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
const escSrc = (html.match(/function esc\(s\)\{[^\n]*\}/) || [])[0];
const PAGE_FNS = ['function _stdConversions(pricing, invoices, customers) {', 'function _stdLostSave(s) {',
  'function renderStdRetireCard() {', 'async function retireStandardPrices() {', 'function _pcRender(list){']
  .map(m => sliceBalanced(html, m)).join('\n');

// ── sample shaped like the live data ────────────────────────────────────────────
const CUSTS = [
  { id: 'C1', name: 'มัสยิดกลาง ปริก' },            // no prices of its own at all
  { id: 'C2', name: 'พลอยใส' },                      // own price for P2 only
  { id: 'C3', name: 'จันทร์สุข' },                   // own P1 price for every delivery method
];
const STD = [
  { id: 'S1', productId: 'P1', customerId: '', shippingMethod: 'รับหน้าโรงงาน', price: 92, tierQty: 100, tierPrice: 90, tierBasis: 'line', notifiedAt: '2026-01-01' },
  { id: 'S2', productId: 'P1', customerId: '', shippingMethod: 'จัดส่ง', price: 86 },
  { id: 'S3', productId: 'P2', customerId: '', shippingMethod: 'รับหน้าโรงงาน', price: 0.15 },
];
const OWN = [
  { id: 'O1', productId: 'P2', customerId: 'C2', shippingMethod: 'รับหน้าโรงงาน', price: 0.14 },
  { id: 'O2', productId: 'P1', customerId: 'C3', shippingMethod: '', price: 80 },
];
// I-2 (older) is listed BEFORE I-1 (newer) on purpose, so "newest wins" is really tested
// — with the newest first, "first seen wins" would give the same answer.
const INVS = [
  { invoiceNumber: 'I-2', customerId: 'C1', shippingMethod: 'รับหน้าโรงงาน', createdAt: '2026-06-01', items: [{ productId: 'P1', price: 80 }] },
  { invoiceNumber: 'I-1', customerId: 'C1', shippingMethod: 'รับหน้าโรงงาน', createdAt: '2026-07-31', items: [{ productId: 'P1', price: 75 }, { productId: 'P2', price: 0.15 }] },
  { invoiceNumber: 'I-3', customerId: 'C2', shippingMethod: 'รับหน้าโรงงาน', createdAt: '2026-08-12', items: [{ productId: 'P2', price: 0.14 }, { productId: 'P1', price: 92 }] },
  { invoiceNumber: 'I-4', customerId: 'C3', shippingMethod: 'จัดส่ง', createdAt: '2026-08-20', items: [{ productId: 'P1', price: 80 }] },
  { invoiceNumber: 'I-5', customerId: 'C1', shippingMethod: 'จัดส่ง', createdAt: '2026-08-21', cancelled: true, items: [{ productId: 'P1', price: 86 }] },
  { invoiceNumber: 'I-6', customerId: 'CX', shippingMethod: 'จัดส่ง', createdAt: '2026-08-22', items: [{ productId: 'P1', price: 86 }] },
];
const HIST = [{ id: 'h1', productId: 'P1', customerId: '', shippingMethod: 'รับหน้าโรงงาน', price: 70, changedAt: '2026-08-08T01:30:38.073Z', changedByUser: 'aing' }];
const clone = x => JSON.parse(JSON.stringify(x));

function page({ admin = true, confirm = true, pricing = STD.concat(OWN), edits = {} } = {}) {
  const store = { pricing: clone(pricing), hist: clone(HIST) };
  const calls = { saves: 0, histSaves: 0, alerts: [], activity: [], renders: 0 };
  const els = { stdRetireCard: { style: {}, innerHTML: '' }, priceCustDropdown: { style: {}, innerHTML: '' } };
  let n = 0;
  const DB = {
    getPricing: () => store.pricing, savePricing: v => { calls.saves++; store.pricing = v; },
    getInvoices: () => INVS, getCustomers: () => CUSTS, getProductById: id => ({ id, name: 'สินค้า ' + id }),
    getPriceHistory: () => store.hist, savePriceHistory: v => { calls.histSaves++; store.hist = v; },
    getPriceHistoryFor: (p, c, s) => store.hist.filter(h => h.productId === p && (h.customerId || '') === (c || '') && (h.shippingMethod || '') === (s || '')),
    logActivity: (u, un, action, detail) => calls.activity.push({ action, detail }),
  };
  const Utils = { uuid: () => 'new' + (++n), confirm: async () => confirm, showAlert: (m, ty) => calls.alerts.push({ m, ty }),
    formatNumber: v => String(v), formatDateTH: s => 'D(' + String(s).slice(0, 10) + ')' };
  const Auth = { isAdmin: () => admin };
  const api = new Function('DB', 'Utils', 'Auth', 'session', 'document', 'render', '__edits',
    `${escSrc}\nlet _stdEdits = __edits;\nlet _pcHi = -1;\n${PAGE_FNS}\nreturn { _stdConversions, _stdLostSave, renderStdRetireCard, retireStandardPrices, _pcRender };`)(
    DB, Utils, Auth, { name: 'Joe', username: 'joe', userId: 'u1' }, { getElementById: id => els[id] || null },
    () => { calls.renders++; }, Object.assign({}, edits));
  return { api, store, calls, els };
}

(async () => {
  console.log('which combinations are converted');
  {
    const { api } = page();
    const rows = api._stdConversions(STD.concat(OWN), INVS, CUSTS);
    const keys = rows.map(r => r.key).sort();
    t('exactly the 3 combinations invoiced at a standard price', keys.join(' ') === ['P1|C1|รับหน้าโรงงาน', 'P1|C2|รับหน้าโรงงาน', 'P2|C1|รับหน้าโรงงาน'].sort().join(' '), keys.join(' '));
    t('a customer with its own price for that product is not converted (พลอยใส P2)', !keys.includes('P2|C2|รับหน้าโรงงาน'));
    t('an own price for every delivery method also counts (จันทร์สุข P1)', !keys.some(k => k.includes('|C3|')));
    t('cancelled invoices are ignored', !keys.includes('P1|C1|จัดส่ง'));
    t('invoices of customers that no longer exist are ignored', !keys.some(k => k.includes('CX')));
    const c1p1 = rows.find(r => r.key === 'P1|C1|รับหน้าโรงงาน');
    t('last billed comes from the NEWEST invoice (75 on I-1, not 80 on I-2)', c1p1.lastBilled === 75 && c1p1.lastInvoice === 'I-1');
    t('the standard rule it replaces is attached', c1p1.std.id === 'S1');
    t('nothing to convert when no standard prices exist', api._stdConversions(OWN, INVS, CUSTS).length === 0);
  }

  console.log('\nlost-save warning');
  {
    const { api } = page();
    const lost = api._stdLostSave(STD[0]);
    t('flags a standard price whose last save never landed (92 shown, 70 saved)', lost && lost.price === 70);
    t('no flag when the history agrees', api._stdLostSave(STD[2]) === null);
  }

  console.log('\nthe one-time card');
  {
    const a = page();
    a.api.renderStdRetireCard();
    const h = a.els.stdRetireCard.innerHTML;
    t('shown to an admin while standard prices exist', a.els.stdRetireCard.style.display === '');
    t('says how many customers and items', /ลูกค้า 2 ราย เคยซื้อสินค้า 3 รายการ/.test(h));
    t('and that all 3 standard prices will be deleted', /ลบราคากลางทั้ง 3 รายการ/.test(h));
    t('one editable value per conversion, defaulting to the standard value', (h.match(/data-stdkey=/g) || []).length === 3 && /value="92"/.test(h));
    t('the lost-save row is highlighted with both numbers', /table-warning/.test(h) && /ราคากลาง 92 แต่เคยบันทึกเป็น 70/.test(h));
    t('customer names are escaped', !/<script/i.test(h));
    const na = page({ admin: false }); na.api.renderStdRetireCard();
    t('hidden from non-admins', na.els.stdRetireCard.style.display === 'none');
    const done = page({ pricing: OWN }); done.api.renderStdRetireCard();
    t('gone once there are no standard prices', done.els.stdRetireCard.style.display === 'none' && done.els.stdRetireCard.innerHTML === '');
    const kept = page({ edits: { 'P1|C1|รับหน้าโรงงาน': '70' } }); kept.api.renderStdRetireCard();
    t('a value typed in the card survives a re-render', /data-stdkey="P1\|C1\|รับหน้าโรงงาน" value="70"/.test(kept.els.stdRetireCard.innerHTML));
  }

  console.log('\nconverting');
  {
    const p = page({ edits: { 'P1|C1|รับหน้าโรงงาน': '70' } });
    await p.api.retireStandardPrices();
    const list = p.store.pricing;
    t('saved in ONE savePricing call', p.calls.saves === 1);
    t('no ทุกลูกค้า prices remain', !list.some(r => !r.customerId));
    t('existing customer prices are kept untouched', ['O1', 'O2'].every(id => list.some(r => r.id === id)));
    const c1p1 = list.find(r => r.customerId === 'C1' && r.productId === 'P1');
    t('the edited value is used (70)', c1p1 && c1p1.price === 70, c1p1 && c1p1.price);
    const c2p1 = list.find(r => r.customerId === 'C2' && r.productId === 'P1');
    t('unedited rows keep the standard value (92)', c2p1 && c2p1.price === 92);
    t('with the standard price\'s delivery method', c2p1.shippingMethod === 'รับหน้าโรงงาน');
    t('volume-tier settings are copied too', c2p1.tierQty === 100 && c2p1.tierPrice === 90 && c2p1.tierBasis === 'line');
    t('but not the standard price\'s notify date', !('notifiedAt' in c2p1));
    t('new ids, not the standard rule\'s', !list.some(r => ['S1', 'S2', 'S3'].includes(r.id)) && /^new/.test(c2p1.id));
    t('a price-history entry per converted price', p.store.hist.filter(h => h.note === 'แปลงจากราคากลาง').length === 3);
    t('history marks who converted it', p.store.hist.some(h => h.note && h.changedByUser === 'joe' && h.customerId === 'C1'));
    t('old history is kept', p.store.hist.some(h => h.id === 'h1'));
    t('logged to the activity log', p.calls.activity.some(a => a.action === 'ยกเลิกราคากลาง' && a.detail.converted === 3 && a.detail.removed === 3));
    t('the page re-renders', p.calls.renders === 1);
  }
  {
    const c = page({ confirm: false }); await c.api.retireStandardPrices();
    t('cancelled at the confirm → nothing changes', c.calls.saves === 0 && c.store.pricing.some(r => !r.customerId));
    const na = page({ admin: false }); await na.api.retireStandardPrices();
    t('a non-admin cannot run it', na.calls.saves === 0);
    const bad = page({ edits: { 'P2|C1|รับหน้าโรงงาน': '' } }); await bad.api.retireStandardPrices();
    t('an empty value blocks the conversion', bad.calls.saves === 0 && bad.calls.alerts.some(a => a.ty === 'warning'));
    const neg = page({ edits: { 'P2|C1|รับหน้าโรงงาน': '-1' } }); await neg.api.retireStandardPrices();
    t('a negative value blocks the conversion', neg.calls.saves === 0);
  }

  console.log('\nthe price form');
  {
    const p = page();
    p.api._pcRender([{ id: 'C1', name: 'มัสยิดกลาง ปริก' }]);
    t('the customer picker no longer offers ทุกลูกค้า', !p.els.priceCustDropdown.innerHTML.includes('ทุกลูกค้า'));
    t('it lists the customers', p.els.priceCustDropdown.innerHTML.includes('มัสยิดกลาง ปริก'));
    const save = sliceBalanced(html, 'function savePrice() {');
    t('saving without a customer is refused', /if \(!customerId\) \{ Utils\.showAlert\('กรุณาเลือกลูกค้า/.test(save));
    t('…before anything is written', save.indexOf('if (!customerId)') < save.indexOf('DB.upsertPrice') && save.indexOf('if (!customerId)') < save.indexOf('DB.savePricing'));
    t('the placeholder asks to choose a customer', /placeholder="— เลือกลูกค้า — พิมพ์เพื่อค้นหา"/.test(html));
    t('the banner says those customers have no price', /ที่ยังไม่มีราคา — ต้องตั้งราคาก่อนออกใบกำกับ/.test(html));
    t('the priority note no longer mentions a standard price tier', !/วิธีจัดส่งอย่างเดียว/.test(html));
    t('the card runs on every render', /function render\(\) \{\r?\n\s*renderStdRetireCard\(\);/.test(html));
  }

  console.log('\ninvoices: DB.getPriceAsOf no longer falls back to an old standard price');
  {
    // Same loader as test-payment-rounding.js: db.js contains braces inside strings and
    // regexes, so a plain brace walk never closes — slicing to the end of the file still
    // evaluates correctly because everything after `return { …DB… };` is unreachable.
    const start = dbSrc.indexOf('const DB = {');
    let depth = 0, i = dbSrc.indexOf('{', start), end = -1;
    for (; i < dbSrc.length; i++) {
      if (dbSrc[i] === '{') depth++;
      else if (dbSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const body = dbSrc.slice(dbSrc.indexOf('{', start), end);
    const load = (pricing, hist) => {
      const DB = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console', `return ${body};`)(
        { uuid: () => 'x' }, {}, { getItem: () => null, setItem() {} }, { getItem: () => null, setItem() {} }, { log() {}, warn() {}, error() {} });
      const store = { wt_pricing: pricing, wt_price_history: hist, wt_products: [{ id: 'P2', name: 'ฝาขวด', defaultPrice: 0 }] };
      DB._get = k => store[k] || [];
      DB.K = Object.assign({}, DB.K, { PRICING: 'wt_pricing', PRICE_HISTORY: 'wt_price_history', PRODUCTS: 'wt_products' });
      return DB;
    };
    t('db.js sliced', start >= 0);
    const stdHist = [{ productId: 'P2', customerId: '', shippingMethod: 'รับหน้าโรงงาน', price: 0.15, changedAt: '2026-05-01T00:00:00Z' }];
    const before = load(STD.concat(OWN), stdHist);
    t('before the conversion: a customer without a price still gets the standard 0.15', before.getPriceAsOf('P2', 'C9', 'รับหน้าโรงงาน', '2026-09-18') === 0.15);
    const after = load(OWN, stdHist);
    t('after the conversion: the old standard price in history is NOT used', after.getPriceAsOf('P2', 'C9', 'รับหน้าโรงงาน', '2026-09-18') === 0,
      String(after.getPriceAsOf('P2', 'C9', 'รับหน้าโรงงาน', '2026-09-18')));
    const ownHist = stdHist.concat([{ productId: 'P2', customerId: 'C2', shippingMethod: 'รับหน้าโรงงาน', price: 0.14, changedAt: '2026-06-01T00:00:00Z' }]);
    t('a customer\'s own price history still works', load(OWN, ownHist).getPriceAsOf('P2', 'C2', 'รับหน้าโรงงาน', '2026-09-18') === 0.14);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
