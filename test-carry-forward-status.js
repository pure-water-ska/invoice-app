// test-carry-forward-status.js — v1.0.261
//
// DB.carryForwardOwedBalance settles the SOURCE invoice with a payment that has no
// money behind it (carryForward:true) — the debt moves to a newer invoice number. The
// invoice list then showed plain "ชำระแล้ว", indistinguishable from a cash payment.
// Live data: 141169-006 read ชำระแล้ว at ฿29,299.10 with ฿0 actually received, the whole
// amount having moved to 241169-005, and that ฿29,299.10 was counted in the list's
// ชำระแล้ว figure as though it were takings.
//
// Two things must stay true while fixing that:
//   • these invoices are SETTLED — key stays 'paid', so the filter keeps showing them
//     and the outstanding figure must not claim the money back; the new invoice already
//     carries it, and counting it in both places is a double count;
//   • a few satang carried as a rounding remainder is effectively paid — five of the six
//     carry-forwards in live data are ≤฿0.50 and must not get the distinct badge.
//
// Run: node test-carry-forward-status.js

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
global.Utils = { uuid: (() => { let n = 0; return () => 'u' + (++n); })() };

const DB = new Function(fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8') + '\n;return DB;')();
DB._set = function (k, v) { this._cache[k] = v; };

const html = fs.readFileSync(path.join(__dirname, 'invoices.html'), 'utf8');
// The real statusInfo, lifted — not a restatement of it.
const statusInfo = (() => {
  const s = html.indexOf('function statusInfo(');
  const e = html.indexOf('\n}', html.indexOf("return { key:'pending'", s)) + 2;
  return new Function('DB', 'return ' + html.slice(s, e))(DB);
})();

const seed = (invoices, payments) => {
  DB._cache[DB.K.INVOICES] = invoices;
  DB._cache[DB.K.PAYMENTS] = payments;
  DB._cache[DB.K.CUSTOMERS] = [];
};
const inv = o => Object.assign({ id: 'i' + Math.random(), invoiceNumber: 'A-1', customerId: 'C1',
  page: 1, editCount: 0, totalAmount: 1000, cancelled: false, createdAt: '2026-11-14T00:00:00.000Z' }, o);
const pay = o => Object.assign({ id: 'p' + Math.random(), invoiceNumber: 'A-1', customerId: 'C1',
  amount: 1000, method: 'โอน', cancelled: false }, o);
const cf = (o) => pay(Object.assign({ method: 'ยกยอดไปใบใหม่', carryForward: true, carryForwardTo: 'B-2' }, o));

const statusOf = (invoice) => {
  const paid = DB.paidForInvoice(DB.invoicePaidMap(), invoice);
  const nc = DB.nonCashForInvoice(DB.invoiceNonCashMap(), invoice);
  return statusInfo(paid, parseFloat(invoice.totalAmount) || 0, invoice.cancelled, nc);
};

section('the live case: the whole debt moved, no money received');
{
  // 141169-006 → 241169-005, ฿29,299.10, cash ฿0.
  const i = inv({ invoiceNumber: '141169-006', totalAmount: 29299.10 });
  seed([i], [cf({ invoiceNumber: '141169-006', amount: 29299.10, carryForwardTo: '241169-005' })]);
  const s = statusOf(i);
  t('it is still settled, not outstanding', s.key === 'paid', s.key);
  t('…but no longer reads as a cash payment', s.label !== 'ชำระแล้ว', s.label);
  t('…it names where the debt went', s.label === 'ยกยอด → 241169-005', s.label);
  t('…and is flagged for the renderer', s.carried === true);
  t('…with its own badge colour, not the green one', s.cls === 'badge-carried');
  // The filter dropdown offers paid / partial / pending. Changing the key would make
  // these vanish from every filter.
  t('the ชำระแล้ว filter still finds it', s.key === 'paid');
  t('no cash is credited', DB.getInvoiceCashReceived('141169-006', 'C1') === 0);
  t('…while the invoice counts as settled', DB.getInvoicePaidAmount('141169-006', 'C1') === 29299.10);
}

section('a satang remainder is not a carry-forward');
{
  // 080669-204: ฿25,513.05 total, ฿25,513.00 cash, ฿0.05 carried. Five of the six in
  // live data look like this; badging them would be noise.
  const i = inv({ invoiceNumber: '080669-204', totalAmount: 25513.05 });
  seed([i], [
    pay({ invoiceNumber: '080669-204', amount: 25513.00 }),
    cf({ invoiceNumber: '080669-204', amount: 0.05, carryForwardTo: '070869-001' }),
  ]);
  const s = statusOf(i);
  t('it shows as an ordinary paid invoice', s.label === 'ชำระแล้ว' && !s.carried, s.label);
  t('…because the carried part is under the 1% threshold',
    !DB.isCarriedForward(25513.05, { amount: 0.05, carriedTo: '070869-001' }));
  // Right at the boundary, to pin the rule rather than leave it incidental.
  t('exactly 1% does NOT qualify', !DB.isCarriedForward(1000, { amount: 10, carriedTo: 'B-2' }));
  t('just over 1% does', DB.isCarriedForward(1000, { amount: 10.01, carriedTo: 'B-2' }));
}

section('ordinary invoices are untouched');
{
  let i = inv({ totalAmount: 2184 });
  seed([i], [pay({ amount: 2184 })]);
  t('a cash-paid invoice still says ชำระแล้ว', statusOf(i).label === 'ชำระแล้ว');

  i = inv({ totalAmount: 9278.40 });
  seed([i], []);
  t('an unpaid invoice still says ค้างชำระ', statusOf(i).label === 'ค้างชำระ');

  i = inv({ totalAmount: 1000 });
  seed([i], [pay({ amount: 400 })]);
  t('a part payment still says ชำระบางส่วน', statusOf(i).label === 'ชำระบางส่วน');

  i = inv({ totalAmount: 1000, cancelled: true });
  seed([i], [cf({ amount: 1000 })]);
  t('a cancelled invoice still says ยกเลิก — cancellation wins',
    statusOf(i).label === 'ยกเลิก');

  // A write-off is non-cash too, but it names no target invoice, so it keeps the plain
  // label rather than rendering "ยกยอด → undefined".
  i = inv({ totalAmount: 1000 });
  seed([i], [pay({ amount: 1000, writeOff: true, method: 'ตัดหนี้สูญ' })]);
  t('a write-off has no target, so it keeps the plain label', statusOf(i).label === 'ชำระแล้ว');
  t('…but is still counted as non-cash',
    DB.nonCashForInvoice(DB.invoiceNonCashMap(), i).amount === 1000);
}

section('the non-cash map');
{
  seed([inv({})], [
    cf({ amount: 300, carryForwardTo: 'B-2' }),
    pay({ amount: 700 }),
    cf({ amount: 100, carryForwardTo: 'B-3', cancelled: true }),
  ]);
  const m = DB.invoiceNonCashMap();
  const e = DB.nonCashForInvoice(m, inv({}));
  t('it sums only the non-cash entries', e.amount === 300, e);
  t('…ignores cancelled ones', e.amount === 300);
  t('…and keeps the target invoice number', e.carriedTo === 'B-2');
  t('an invoice with none gets a zero entry, not undefined',
    DB.nonCashForInvoice(m, inv({ invoiceNumber: 'ZZZ' })).amount === 0);
  // Keyed with customerId, like invoicePaidMap — on a collided number, summing by
  // number alone credits one customer's settlement to the other's invoice.
  t('the map is keyed by number AND customer', /invoiceNumber \+ '\|' \+ \(p\.customerId/.test(
    fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8').slice(
      fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8').indexOf('invoiceNonCashMap()'))));
}

section('the summary adds up, and never counts the same money twice');
{
  const src = html.slice(html.indexOf('let sumTotal = 0, sumPaid = 0, sumNonCash = 0;'));
  t('ชำระแล้ว excludes the non-cash part', /sumPaid \+= paid - nonCash;/.test(src));
  t('it is reported on its own line', /sumNonCash \+= nonCash;/.test(src) && /id="sumNonCash"/.test(html));
  // This is the trap: subtracting only cash would show the carried debt as outstanding
  // HERE while the invoice it moved to shows it too.
  t('ค้างชำระ subtracts BOTH, so the carried debt is not claimed back',
    /sumTotal - sumPaid - sumNonCash/.test(html));
  t('the non-cash line is hidden when there is none', /sumNonCash > 0\.005 \? '' : 'none'/.test(html));

  // cash + non-cash + outstanding === total, on the real figures.
  const rows = [
    { total: 29299.10, cash: 0,        nc: 29299.10 },
    { total: 25513.05, cash: 25513.00, nc: 0.05 },
    { total: 2184.00,  cash: 2184.00,  nc: 0 },
    { total: 9278.40,  cash: 0,        nc: 0 },
  ];
  const sumTotal = rows.reduce((s, r) => s + r.total, 0);
  const sumPaid  = rows.reduce((s, r) => s + r.cash, 0);
  const sumNC    = rows.reduce((s, r) => s + r.nc, 0);
  t('cash + non-cash + outstanding = total',
    Math.abs((sumPaid + sumNC + (sumTotal - sumPaid - sumNC)) - sumTotal) < 0.005);
  t('…and ชำระแล้ว is real money only', Math.abs(sumPaid - 27697) < 0.005, +sumPaid.toFixed(2));
  t('…with the carried amount shown separately', Math.abs(sumNC - 29299.15) < 0.005, +sumNC.toFixed(2));
}

section('the badge is actually readable');
{
  // First attempt used #ffc107 — the exact colour of .badge-pending, so "settled by
  // carry-forward" looked like "ค้างชำระ" at a glance; the mockup used #fff3cd, which is
  // near-white and washed the text out. Both are the kind of thing a later tidy-up
  // reintroduces, so pin the properties rather than the hex.
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const rule = n => {
    const m = new RegExp('\\.badge-' + n + '\\s*\\{([^}]*)\\}').exec(css);
    if (!m) return null;
    const bg = /background:\s*(#[0-9a-f]{3,6})/i.exec(m[1]);
    const fg = /color:\s*(#[0-9a-f]{3,6})/i.exec(m[1]);
    return { bg: bg && bg[1].toLowerCase(), fg: fg && fg[1].toLowerCase() };
  };
  const lum = hex => {
    const h = hex.replace('#', '');
    const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // What actually RENDERS is the inline style, because style.css is precached and its
  // <link> has no ?v= (bump-version.js rewrites only .html) — so a new class can arrive
  // late and a badge with no matching rule draws with no background at all. Confirmed in
  // the browser: computed background was rgba(0,0,0,0) while the served file had the rule.
  {
    const i = inv({ invoiceNumber: 'X-9', totalAmount: 5000 });
    seed([i], [cf({ invoiceNumber: 'X-9', amount: 5000, carryForwardTo: 'Y-1' })]);
    const s = statusOf(i);
    t('the carried badge carries its colour inline, not only via the class',
      /background:\s*#[0-9a-f]{6}/i.test(s.style || ''), s.style);
    t('…and its text colour too', /color:\s*#[0-9a-f]{3,6}/i.test(s.style || ''));
    t('ordinary statuses add no inline style', !statusOf(inv({ totalAmount: 0 })).style);
    t('the renderer emits it', /\$\{si\.style \? ` style="\$\{si\.style\}"` : ''\}/.test(html));
    const inlineBg = /background:\s*(#[0-9a-f]{6})/i.exec(s.style)[1].toLowerCase();
    const ruleBg = (rule('carried') || {}).bg;
    t('inline and stylesheet agree, so the two cannot drift', inlineBg === ruleBg,
      [inlineBg, ruleBg]);
  }

  const carried = rule('carried');
  t('.badge-carried is defined', !!(carried && carried.bg), carried);
  t('…with an opaque background, not near-white', lum(carried.bg) < 0.75, +lum(carried.bg).toFixed(3));
  t('…and an explicit text colour', !!carried.fg);
  // Light text on a light chip, or dark on dark, is the readability failure.
  t('…that contrasts with its own background',
    Math.abs(lum(carried.bg) - lum(carried.fg)) > 0.35,
    [+lum(carried.bg).toFixed(2), +lum(carried.fg).toFixed(2)]);
  ['pending', 'paid', 'partial', 'cancelled'].forEach(other => {
    const o = rule(other);
    t('…and is a different colour from .badge-' + other, o && o.bg !== carried.bg,
      o && o.bg);
  });
}

section('the list builds its maps once, not per row');
{
  // pricing.html's O(rows x invoices) render is the documented lesson here.
  t('the non-cash map is built once per render',
    (html.match(/DB\.invoiceNonCashMap\(\)/g) || []).length === 1);
  t('rows read it through a lookup', /const nonCashFor = inv => DB\.nonCashForInvoice\(nonCashMap, inv\)/.test(html));
  t('every statusInfo call site passes it',
    (html.match(/statusInfo\([^)]*nonCashFor\(/g) || []).length >= 3,
    (html.match(/statusInfo\([^)]*nonCashFor\(/g) || []).length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
