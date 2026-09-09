// test-outstanding-statement.js — run:  node test-outstanding-statement.js
//
// User request: on the customer's outstanding statement (รายการค้างชำระ →
// ใบแจ้งยอดค้างชำระ), the header must carry the customer's ADDRESS, and the วันที่
// column must read dd/mm/yyyy in Buddhist Era.
//
// The date cell used to print `r.date.slice(0,10)` — the raw ISO string (2026-08-15),
// which is neither dd/mm/yyyy nor B.E. Utils.formatDateTH already produces exactly the
// wanted format, so the fix routes through it rather than hand-rolling a second
// formatter that could drift from the rest of the app.
//
// Runs the REAL showOutstandingPreview() sliced out of customers.html, against the REAL
// Utils.formatDateTH sliced out of utils.js — so a change to either is caught here.

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

const custSrc = fs.readFileSync(path.join(DIR, 'customers.html'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(DIR, 'utils.js'), 'utf8');

// the REAL date formatter, not a restatement of it
const fmtSrc = sliceBalanced(utilsSrc, 'formatDateTH(dateStr) {');
const formatDateTH = new Function(`return function ${fmtSrc};`)();
t('formatDateTH gives dd/mm/yyyy B.E.', formatDateTH('2026-08-15') === '15/08/2569',
  formatDateTH('2026-08-15'));
t('it pads a single-digit day and month', formatDateTH('2026-01-05') === '05/01/2569',
  formatDateTH('2026-01-05'));

const fnSrc = sliceBalanced(custSrc, 'function showOutstandingPreview(id) {');

// ── run the real function against stubs ──────────────────────────────────────────────
function render(customer, invoices, paidBy = {}) {
  let html = '';
  const el = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const DB = {
    getCustomerById: () => customer,
    getSettings: () => ({ companyName: 'น้ำดื่มบริสุทธิ์ สกา' }),
    getActiveInvoicesByCustomer: () => invoices,
    getInvoicePaidAmount: num => paidBy[num] || 0,
  };
  const document = { getElementById: () => el };
  const bootstrap = { Modal: function () { return { show() {} }; } };
  new Function('DB', 'Utils', 'document', 'bootstrap',
    `${fnSrc}; showOutstandingPreview('c1');`)(
    DB, { formatDateTH }, document, bootstrap);
  return html;
}

const CUST = { id: 'c1', name: 'เขากลอยการค้า',
  address: '119/2 หมู่ 4 ต.เขากลอย อ.หาดใหญ่ จ.สงขลา 90110', phone: '081-234-5678' };
const INVS = [
  { invoiceNumber: '150869-004', customerId: 'c1', page: 1, totalAmount: 12480, createdAt: '2026-08-15' },
  { invoiceNumber: '310869-004', customerId: 'c1', page: 1, totalAmount: 4320,  createdAt: '2026-08-31' },
];

console.log('\nthe header carries the address');
{
  const html = render(CUST, INVS, { '150869-004': 5000 });
  t('the address is printed', html.includes(CUST.address));
  t('the name is still printed', html.includes('เขากลอยการค้า'));
  t('the phone is still printed', html.includes('081-234-5678'));
  t('the address sits between the name and the phone',
    html.indexOf(CUST.name) < html.indexOf(CUST.address) &&
    html.indexOf(CUST.address) < html.indexOf('081-234-5678'));
  t('it is inside the customer block, not the company heading',
    html.indexOf('น้ำดื่มบริสุทธิ์ สกา') < html.indexOf(CUST.address));
}

console.log('\na customer with no address gets no blank line');
{
  const html = render({ id: 'c1', name: 'ร้านไม่มีที่อยู่', phone: '02-000-0000' }, INVS);
  t('renders without throwing', html.includes('ร้านไม่มีที่อยู่'));
  t('no empty address div is emitted',
    !/white-space:pre-line">\s*<\/div>/.test(html));
  t('the phone still shows', html.includes('02-000-0000'));
}

console.log('\ndates are dd/mm/yyyy B.E., not raw ISO');
{
  const html = render(CUST, INVS, { '150869-004': 5000 });
  t('15 Aug 2026 prints as 15/08/2569', html.includes('15/08/2569'));
  t('31 Aug 2026 prints as 31/08/2569', html.includes('31/08/2569'));
  t('no raw ISO date leaks into the table', !html.includes('2026-08-15'));
  t('no CE year is shown anywhere in the rows', !/\b2026\b/.test(html));
  t('the statement date in the heading is B.E. too', /\/25\d\d/.test(html));
}

console.log('\nedge cases');
{
  const noDate = [{ invoiceNumber: 'X-1', customerId: 'c1', page: 1, totalAmount: 100 }];
  const html = render(CUST, noDate);
  t('a missing date still renders a dash', html.includes('>-<'), 'no dash cell found');
  t('the row is still listed', html.includes('X-1'));
}
{
  const html = render(CUST, [], {});
  t('a fully-paid customer shows the no-outstanding message',
    html.includes('ไม่มียอดค้างชำระ'));
}
{
  // a fully-settled invoice must not appear as a row at all
  const html = render(CUST, INVS, { '150869-004': 12480, '310869-004': 4320 });
  t('settled invoices are excluded', !html.includes('150869-004'));
  t('and the empty-state message appears', html.includes('ไม่มียอดค้างชำระ'));
}

console.log('\nthe invariant: the date cell must not restate its own formatter');
{
  t('no raw .slice(0,10) date formatting remains', !/date\.slice\(0,\s*10\)/.test(fnSrc));
  t('the cell routes through Utils.formatDateTH',
    /Utils\.formatDateTH\(r\.date\)/.test(fnSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
