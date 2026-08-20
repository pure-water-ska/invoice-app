// test-cancelled-excluded-from-unpaid.js — run:  node test-cancelled-excluded-from-unpaid.js
//
// User-reported: "the cancelled invoice still available on unpaid list in customer".
//
// Root cause: DB.getCustomerBalance() has always excluded cancelled invoices, but SIX
// other places computed "unpaid/outstanding" by re-filtering on customerId alone and so
// silently kept them. The customer card contradicted itself — the ค้างสุทธิ money badge
// excluded a voided invoice while the "N ค้างชำระ" count and red chip list beside it
// still counted it — and worse, two customer-facing outputs (the copied reminder text,
// the printed ใบแจ้งยอดค้างชำระ) billed for voided invoices, while payments.html's
// overpay allocation would cut REAL credit onto one.
//
// Fix: DB.getActiveInvoicesByCustomer(custId) is now the single list every money
// calculation draws from. Per explicit user decision the customer card hides cancelled
// invoices completely — the "N ใบกำกับ" count and "ใบล่าสุด" date exclude them too, so a
// voided invoice can neither inflate the bill count nor pose as the latest activity.
// They stay visible on invoices.html with their ยกเลิก badge.
//
// Extracts the REAL code from db.js / customers.html / payments.html — no reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// ── Real DB, backed by an in-memory store ───────────────────────────────────
function loadDB(store) {
  const src = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
  const start = src.indexOf('const DB = {');
  if (start < 0) throw new Error('DB literal not found — update extraction marker');
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const Utils = { uuid: () => 'id-' + Math.random() };
  const DB = new Function('Utils', 'window', 'localStorage', 'sessionStorage', 'console',
    `return ${src.slice(src.indexOf('{', start), end)};`)(
    Utils, {}, { getItem: () => null, setItem: () => {} },
    { getItem: () => null, setItem: () => {} }, { log(){}, warn(){}, error(){} });
  DB._get = (k) => store[k] || [];
  DB._set = (k, v) => { store[k] = v; };
  return DB;
}

// Extract a whole top-level `function name(...) { … }` from a source file.
function extractFn(file, name) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file} — update extraction marker`);
  let depth = 0, i = start, seen = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// One cancelled invoice (fully unpaid) alongside two live ones — the exact reported shape.
const INVOICES = [
  { id: 'i1', invoiceNumber: '010869-001', page: 1, customerId: 'c1', totalAmount: 1000, createdAt: '2026-08-01', items: [] },
  { id: 'i2', invoiceNumber: '020869-002', page: 1, customerId: 'c1', totalAmount: 500,  createdAt: '2026-08-02', items: [] },
  { id: 'i3', invoiceNumber: '030869-003', page: 1, customerId: 'c1', totalAmount: 7777, createdAt: '2026-08-03', items: [],
    cancelled: true, cancelledAt: '2026-08-04', cancelledReason: 'ยกเลิกโดยลูกค้า' },
];
const PAYMENTS = [
  { id: 'p1', invoiceNumber: '010869-001', customerId: 'c1', amount: 1000 },  // paid in full
  // 020869-002 unpaid (500), 030869-003 cancelled + unpaid (7777) → must NOT count
];
const CUSTOMERS = [{ id: 'c1', name: 'ร้านทดสอบ', payTerms: { maxBills: 1, maxDays: 0 } }];

function freshDB() {
  return loadDB({ wt_invoices: JSON.parse(JSON.stringify(INVOICES)),
                  wt_payments: JSON.parse(JSON.stringify(PAYMENTS)),
                  wt_customers: JSON.parse(JSON.stringify(CUSTOMERS)) });
}

console.log('DB.getActiveInvoicesByCustomer() — the shared helper');
{
  const DB = freshDB();
  const active = DB.getActiveInvoicesByCustomer('c1');
  t('drops the cancelled invoice', active.length === 2, active.map(i => i.invoiceNumber).join(','));
  t('never returns the cancelled number', !active.some(i => i.invoiceNumber === '030869-003'));
  t('agrees with getCustomerBalance (500 owed, not 8277)',
    Math.abs(DB.getCustomerBalance('c1').owed - 500) < 0.005,
    String(DB.getCustomerBalance('c1').owed));
  t('balance counts one owed invoice, not two', DB.getCustomerBalance('c1').owedCount === 1);
}

console.log('\ncustomers.html card — the ค้างชำระ count and red chip list');
{
  // The card body is inside a .map(), so slice the real computation block out of it —
  // from the invoices lookup through the lastInv reduce, covering every figure the card
  // shows: the ใบกำกับ count, the ค้างชำระ count, and the ใบล่าสุด date.
  const src = fs.readFileSync(path.join(DIR, 'customers.html'), 'utf8');
  const s = src.indexOf('    const invoices = DB.getActiveInvoicesByCustomer(c.id);');
  if (s < 0) throw new Error('card block not found — update extraction marker');
  const e = src.indexOf(': null;', src.indexOf('const lastInv', s)) + 7;
  const block = src.slice(s, e);

  const DB = freshDB();
  const out = new Function('DB', 'c', `${block}\nreturn { totalBill, unpaid, uniqNums, lastInv };`)(DB, CUSTOMERS[0]);

  t('unpaid count is 1 (only the live unpaid invoice)', out.unpaid === 1, String(out.unpaid));
  t('the cancelled number is not in the money list', out.uniqNums.indexOf('030869-003') === -1, out.uniqNums.join(','));
  t('"N ใบกำกับ" counts 2, not 3 — the void is hidden entirely', out.totalBill === 2, String(out.totalBill));
  t('ใบล่าสุด is the live 02/08 invoice, not the cancelled 03/08 one',
    out.lastInv && out.lastInv.invoiceNumber === '020869-002', out.lastInv && out.lastInv.invoiceNumber);
}

console.log('\ncustomers.html getPayTermsViolations() — credit limit no longer tripped by a void');
{
  const DB = freshDB();
  const fn = new Function('DB', `${extractFn('customers.html', 'getPayTermsViolations')}\nreturn getPayTermsViolations;`)(DB);
  const invoices = DB.getActiveInvoicesByCustomer('c1');
  const uniqNums = [...new Set(invoices.map(i => i.invoiceNumber))];
  const viol = fn(CUSTOMERS[0], invoices, uniqNums);
  // maxBills is 1 and only ONE live invoice is unpaid, so nothing should trip. Counting
  // the cancelled invoice would have made it 2 > 1 and raised a false violation.
  t('no false "เกินกำหนด" violation from the cancelled invoice', viol.length === 0, JSON.stringify(viol));
}

console.log('\ncustomers.html copyOverdueMsg() — the reminder text sent TO the customer');
{
  const DB = freshDB();
  let copied = '';
  const navigator = { clipboard: { writeText: (s) => { copied = s; return Promise.resolve(); } } };
  const Utils = { showAlert: () => {} };
  const fn = new Function('DB', 'navigator', 'Utils', 'prompt',
    `${extractFn('customers.html', 'copyOverdueMsg')}\nreturn copyOverdueMsg;`)(DB, navigator, Utils, () => {});
  fn('c1');

  t('says 1 ใบ, not 2', /ค้างชำระ 1 ใบ/.test(copied), copied.replace(/\n/g, ' | '));
  t('total is 500.00, not 8,277.00', /500\.00 บาท/.test(copied), copied.replace(/\n/g, ' | '));
  t('the cancelled 7,777 never appears', copied.indexOf('7,777') === -1);
}

console.log('\ncustomers.html showOutstandingPreview() — the printed ใบแจ้งยอดค้างชำระ');
{
  const src = fs.readFileSync(path.join(DIR, 'customers.html'), 'utf8');
  const s = src.indexOf('  const invoices  = DB.getActiveInvoicesByCustomer(id);',
                        src.indexOf('function showOutstandingPreview'));
  const e = src.indexOf('const totalRem', s);
  if (s < 0) throw new Error('preview block not found — update extraction marker');

  const DB = freshDB();
  const out = new Function('DB', 'id', `${src.slice(s, e)}\nreturn unpaidRows;`)(DB, 'c1');

  t('statement lists exactly 1 row', out.length === 1, JSON.stringify(out.map(r => r.num)));
  t('that row is the live unpaid invoice', out[0] && out[0].num === '020869-002');
  t('cancelled invoice is absent from the statement', !out.some(r => r.num === '030869-003'));
}

console.log('\npayments.html _overpayOutstanding() — where real credit gets cut');
{
  const DB = freshDB();
  // Cutting an overpayment recorded against 010869-001; the picker must offer only the
  // live outstanding invoice, never the cancelled one.
  const pendingOverpayData = { custId: 'c1', invNum: '010869-001' };
  const fn = new Function('DB', 'pendingOverpayData',
    `${extractFn('payments.html', '_overpayOutstanding')}\nreturn _overpayOutstanding;`)(DB, pendingOverpayData);
  const rows = fn();

  t('offers exactly 1 target', rows.length === 1, JSON.stringify(rows.map(r => r.num)));
  t('offers the live unpaid invoice', rows[0] && rows[0].num === '020869-002');
  t('NEVER offers the cancelled invoice as a credit target', !rows.some(r => r.num === '030869-003'));
}

console.log('\nRegression: a customer with no cancelled invoices behaves exactly as before');
{
  const DB = loadDB({
    wt_invoices: [
      { id: 'a', invoiceNumber: '010869-001', page: 1, customerId: 'c9', totalAmount: 1000, createdAt: '2026-08-01', items: [] },
      { id: 'b', invoiceNumber: '020869-002', page: 1, customerId: 'c9', totalAmount: 500,  createdAt: '2026-08-02', items: [] },
    ],
    wt_payments: [{ id: 'p', invoiceNumber: '010869-001', customerId: 'c9', amount: 400 }],
    wt_customers: [{ id: 'c9', name: 'ปกติ' }],
  });
  t('all invoices still returned', DB.getActiveInvoicesByCustomer('c9').length === 2);
  t('owed still 1100 (600 + 500)', Math.abs(DB.getCustomerBalance('c9').owed - 1100) < 0.005,
    String(DB.getCustomerBalance('c9').owed));
}

console.log('\nRegression: cancelling an invoice that was PARTIALLY paid removes it from owed');
{
  const DB = loadDB({
    wt_invoices: [
      { id: 'a', invoiceNumber: '010869-001', page: 1, customerId: 'c8', totalAmount: 1000, createdAt: '2026-08-01', items: [], cancelled: true },
    ],
    wt_payments: [{ id: 'p', invoiceNumber: '010869-001', customerId: 'c8', amount: 300 }],
    wt_customers: [{ id: 'c8', name: 'จ่ายบางส่วนแล้วยกเลิก' }],
  });
  t('no active invoices', DB.getActiveInvoicesByCustomer('c8').length === 0);
  t('owed is 0, not the remaining 700', Math.abs(DB.getCustomerBalance('c8').owed) < 0.005,
    String(DB.getCustomerBalance('c8').owed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
