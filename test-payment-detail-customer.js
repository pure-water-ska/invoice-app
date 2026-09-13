// test-payment-detail-customer.js — run:  node test-payment-detail-customer.js
//
// User request: "in payment record, there's no customer name, just add it".
//
// Each payment in the payment window's history has a collapsible "รายละเอียดทั้งหมด"
// block built by _payDetailHtml(). Its comment says it lists EVERY stored field, but it
// never said whose payment it was: the record stores only customerId. It now starts with
// a ลูกค้า row, looked up by id the same way reports.html does.
//
// Drives the REAL _payDetailHtml sliced out of payments.html with the page's own
// escaper; DB and Utils are stubbed.

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

const html = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
const fnSrc = sliceBalanced(html, 'function _payDetailHtml(p) {');
let escSrc = null;
if (html.includes('function esc(')) escSrc = sliceBalanced(html, 'function esc(');
else { const m = html.match(/const esc\s*=\s*[^\n]+/); escSrc = m && m[0]; }
t("payments.html's escaper was found", !!escSrc);

const Utils = {
  formatDateTH: s => 'D(' + s + ')', formatDateTimeTH: s => 'DT(' + s + ')',
  formatNumber: n => String(n), getBankName: s => s,
};
function render(p, customers) {
  let lookups = 0;
  const DB = { getCustomerById: id => { lookups++; return customers.find(c => c.id === id) || null; } };
  const h = new Function('DB', 'Utils', `${escSrc}\n${fnSrc}\nreturn _payDetailHtml;`)(DB, Utils)(p);
  const rows = [...h.matchAll(/<tr><td class="text-muted"[^>]*>([^<]*)<\/td><td class="fw-semibold">([^<]*)<\/td><\/tr>/g)]
    .map(m => [m[1], m[2]]);
  return { h, rows, lookups };
}

const CUSTS = [{ id: 'c1', name: 'บจก.โกลด์สตาร์วอเตอร์' }, { id: 'c2', name: 'ร้าน <b>A&B</b> "ดี"' }];
const PAY = { id: 'p1', invoiceNumber: '120969-001', customerId: 'c1', method: 'โอน', amount: 20861.75,
  payDate: '2026-09-12', sourceBank: 'กสิกรไทย (KBANK)', createdBy: 'admin', createdAt: '2026-09-12T03:00:00Z' };

console.log('the customer is shown');
{
  const { rows } = render(PAY, CUSTS);
  t('the first row is ลูกค้า', rows[0] && rows[0][0] === 'ลูกค้า', JSON.stringify(rows[0]));
  t('with the customer\'s name', rows[0] && rows[0][1] === 'บจก.โกลด์สตาร์วอเตอร์');
  t('the existing rows follow in their old order (วันที่ชำระ next)', rows[1] && rows[1][0] === 'วันที่ชำระ', JSON.stringify(rows[1]));
  t('the other fields are still listed', ['วิธีชำระ', 'จำนวนเงิน', 'ธนาคารต้นทาง', 'บันทึกโดย'].every(k => rows.some(r => r[0] === k)));
  t('ลูกค้า appears once', rows.filter(r => r[0] === 'ลูกค้า').length === 1);
}

console.log('\nmissing data never breaks the block');
{
  const gone = render({ ...PAY, customerId: 'deleted' }, CUSTS);
  t('customer no longer exists: no ลูกค้า row', !gone.rows.some(r => r[0] === 'ลูกค้า'));
  t('…and the rest still renders', gone.rows[0] && gone.rows[0][0] === 'วันที่ชำระ');
  const noId = render({ ...PAY, customerId: undefined }, CUSTS);
  t('no customerId on the record: no ลูกค้า row', !noId.rows.some(r => r[0] === 'ลูกค้า'));
  t('…and no lookup is attempted', noId.lookups === 0);
}

console.log('\nescaping and read-only');
{
  const { h, rows } = render({ ...PAY, customerId: 'c2' }, CUSTS);
  t('markup in a name is shown as text', !h.includes('<b>') && h.includes('&lt;b&gt;'), rows[0] && rows[0][1]);
  t('quotes and ampersands are escaped', h.includes('A&amp;B') && h.includes('&quot;ดี&quot;'));
  const before = JSON.stringify(PAY);
  render(PAY, CUSTS);
  t('the payment record itself is not modified', JSON.stringify(PAY) === before);
}

console.log('\nlooked up the same way as elsewhere');
{
  t('name comes from DB.getCustomerById(p.customerId)', /DB\.getCustomerById\(p\.customerId\)/.test(fnSrc));
  t('and is added through the same add() as every other row', /add\('ลูกค้า',\s+_cust \? _cust\.name : ''\);/.test(fnSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
