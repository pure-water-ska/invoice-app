// test-stale-balance-flag.js — run:  node test-stale-balance-flag.js
//
// Covers the new "already added to another invoice" flag on invoice-create.html's
// balance alert. Background: DB.allocateOverpayCredit() (v1.0.194) and
// DB.carryForwardOwedBalance() (v1.0.203) retire a source invoice's balance when it's
// folded onto a newer invoice via the "เพิ่มที่เลือกลงใบใหม่" button — but only for
// additions made AFTER each fix shipped. Any addition made BEFORE that (an old
// "ค้างชำระ X" / "ชำระเกิน X" item sitting on some other invoice, with no matching
// retirement) still shows up as outstanding on the balance alert every time, with no
// indication it was already billed elsewhere — a real double-count risk if a user
// re-adds it. This is what the user reported: "the overpaid and partial are stills on
// invoice created even it's already added to another invoice."
//
// Fix: _buildStaleBalanceRefMap() scans every invoice's items for that exact label
// pattern and maps sourceInvoiceNumber -> the newest invoice that referenced it.
// checkCustomerBalance() attaches staleRef to any _balanceDetails entry with a hit, and
// the row renderer flags it (red background, inline badge, checkbox unchecked by
// default) instead of silently offering to add it a second time.
//
// Extracts the ACTUAL functions from invoice-create.html and drives them with a stub
// DB/document — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'invoice-create.html'), 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

function extractFn(name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found — update extraction marker`);
  let depth = 0, i = start, bodyStart = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') { if (bodyStart === -1) bodyStart = i; depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const mapFnSrc = extractFn('_buildStaleBalanceRefMap');
const checkFnSrc = extractFn('checkCustomerBalance');

function makeEnv(invoices, payments) {
  const Utils = { formatNumber: (n) => (parseFloat(n) || 0).toFixed(2) };
  const DB = {
    getCustomerById: (id) => ({ id, name: 'test', payTerms: null }),
    getInvoices: () => invoices,
    getPaymentsByInvoice: (num) => payments.filter(p => p.invoiceNumber === num),
    isChequePending: () => false,
    effectivePaymentAmount: (p) => Math.max(0, (parseFloat(p.amount) || 0) - (parseFloat(p.allocatedOut) || 0)),
    getInvoicePaidAmount: (num, custId) => {
      let ps = payments.filter(p => p.invoiceNumber === num && !p.cancelled);
      const owners = new Set(invoices.filter(i => i.invoiceNumber === num).map(i => i.customerId));
      if (custId && ps.length && owners.size > 1) ps = ps.filter(p => p.customerId === custId);
      return ps.reduce((s, p) => s + Math.max(0, (parseFloat(p.amount) || 0) - (parseFloat(p.allocatedOut) || 0)), 0);
    },
  };
  let alertHtml = '';
  const balanceAlertEl = { get innerHTML() { return alertHtml; }, set innerHTML(v) { alertHtml = v; } };
  const document = {
    getElementById: (id) => id === 'balanceAlert' ? balanceAlertEl : null,
    querySelectorAll: () => [],
  };
  return { Utils, DB, document, getHtml: () => alertHtml };
}

console.log('_buildStaleBalanceRefMap() finds the newest referencing invoice');
{
  const invoices = [
    { invoiceNumber: '150569-004', page: 1, customerId: 'c1', totalAmount: 2500, createdAt: '2026-05-15', items: [] },
    { invoiceNumber: '020669-011', page: 1, customerId: 'c1', totalAmount: 500, createdAt: '2026-06-02',
      items: [{ name: 'ค้างชำระ 150569-004', total: 320 }] },
    { invoiceNumber: '030669-020', page: 1, customerId: 'c1', totalAmount: 100, createdAt: '2026-06-03',
      items: [{ name: 'ค้างชำระ 150569-004', total: 50 }] }, // a SECOND, later reference — newest should win
  ];
  const DB = { getInvoices: () => invoices };
  const fn = new Function('DB', `${mapFnSrc}\nreturn _buildStaleBalanceRefMap;`);
  const map = fn(DB)();
  t('maps to the newest reference (030669-020, not 020669-011)', map['150569-004'] && map['150569-004'].target === '030669-020', JSON.stringify(map));
}

console.log('\ncheckCustomerBalance(): flags an unretired stale reference with a red row + unchecked box');
{
  const invoices = [
    // source invoice, still outstanding (no retiring payment)
    { invoiceNumber: '180669-009', page: 1, customerId: 'c1', totalAmount: 1800, createdAt: '2026-06-18', items: [] },
    // a LATER invoice that already folded this balance in as a memo line, pre-fix (no carryForward/allocation payment exists)
    { invoiceNumber: '250669-002', page: 1, customerId: 'c1', totalAmount: 500, createdAt: '2026-06-25',
      items: [{ name: 'ชำระเกิน 180669-009', total: -150.5 }] },
  ];
  const payments = [
    { id: 'p1', invoiceNumber: '180669-009', customerId: 'c1', amount: 1950.5, allocatedOut: 0, cancelled: false },
  ];
  const { Utils, DB, document, getHtml } = makeEnv(invoices, payments);
  const fn = new Function('DB', 'Utils', 'document', 'updateAddBtn', '_balanceDetails',
    `${mapFnSrc}\n${checkFnSrc}\nreturn checkCustomerBalance;`);
  let _balanceDetails = [];
  const check = fn(DB, Utils, document, () => {}, _balanceDetails);
  check('c1');
  const html = getHtml();

  t('flags the row with the reference badge text', html.includes('เพิ่มลงใบ 250669-002 แล้ว'), html.slice(0, 200));
  t('row gets the red-tinted background', html.includes('background:#fdece9'));
  t('the stale row checkbox is NOT checked by default', /id="bchk0"(?!.*checked)/.test(html.match(/id="bchk0"[^>]*>/)[0]));
  t('footnote explaining the red row is shown', html.includes('เคยเพิ่มลงใบอื่นแล้ว'));
}

console.log('\ncheckCustomerBalance(): an ordinary un-flagged balance still defaults to checked, no badge');
{
  const invoices = [
    { invoiceNumber: '090769-002', page: 1, customerId: 'c1', totalAmount: 3200, createdAt: '2026-07-09', items: [] },
  ];
  const payments = [
    { id: 'p1', invoiceNumber: '090769-002', customerId: 'c1', amount: 2320, allocatedOut: 0, cancelled: false },
  ];
  const { Utils, DB, document, getHtml } = makeEnv(invoices, payments);
  const fn = new Function('DB', 'Utils', 'document', 'updateAddBtn', '_balanceDetails',
    `${mapFnSrc}\n${checkFnSrc}\nreturn checkCustomerBalance;`);
  const check = fn(DB, Utils, document, () => {}, []);
  check('c1');
  const html = getHtml();

  t('no stale badge for an ordinary balance', !html.includes('แล้ว แต่ใบนี้ยังไม่ได้ตัดยอด'));
  t('checkbox defaults to checked', /id="bchk0"[^>]*checked/.test(html));
  t('no footnote when nothing is flagged', !html.includes('เคยเพิ่มลงใบอื่นแล้ว'));
}

console.log('\ncheckCustomerBalance(): a RETIRED reference (matching payment exists) is not flagged');
{
  // Same shape as the stale case, but the source invoice now has a carry-forward-style
  // payment that fully retires it — diff is ~0, so it must not even reach _balanceDetails.
  const invoices = [
    { invoiceNumber: '180669-009', page: 1, customerId: 'c1', totalAmount: 1800, createdAt: '2026-06-18', items: [] },
    { invoiceNumber: '250669-002', page: 1, customerId: 'c1', totalAmount: 500, createdAt: '2026-06-25',
      items: [{ name: 'ชำระเกิน 180669-009', total: -150.5 }] },
  ];
  const payments = [
    { id: 'p1', invoiceNumber: '180669-009', customerId: 'c1', amount: 1800, allocatedOut: 0, cancelled: false },
    { id: 'p2', invoiceNumber: '250669-002', customerId: 'c1', amount: 500, allocatedOut: 0, cancelled: false },
  ];
  const { Utils, DB, document, getHtml } = makeEnv(invoices, payments);
  const fn = new Function('DB', 'Utils', 'document', 'updateAddBtn', '_balanceDetails',
    `${mapFnSrc}\n${checkFnSrc}\nreturn checkCustomerBalance;`);
  const check = fn(DB, Utils, document, () => {}, []);
  check('c1');
  const html = getHtml();

  t('both invoices fully settled produces no balance alert at all', html === '', html.slice(0, 300));
}

console.log('\ncheckCustomerBalance(): self-reference (an invoice referencing its own number) is ignored');
{
  const invoices = [
    { invoiceNumber: '010170-001', page: 1, customerId: 'c1', totalAmount: 1000, createdAt: '2026-01-01',
      items: [{ name: 'ค้างชำระ 010170-001', total: 100 }] }, // pathological self-reference, should not self-flag
  ];
  const payments = [];
  const { Utils, DB, document, getHtml } = makeEnv(invoices, payments);
  const fn = new Function('DB', 'Utils', 'document', 'updateAddBtn', '_balanceDetails',
    `${mapFnSrc}\n${checkFnSrc}\nreturn checkCustomerBalance;`);
  const check = fn(DB, Utils, document, () => {}, []);
  check('c1');
  const html = getHtml();
  t('no self-reference badge', !html.includes('แล้ว แต่ใบนี้ยังไม่ได้ตัดยอด'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
