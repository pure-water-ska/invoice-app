// test-payments-pagination.js — v1.0.272
//
// payments.html wrote EVERY matching invoice into the table — ~1,050 rows rebuilt on
// every keystroke in the search box. That is the same cost that made pricing.html take
// about 4 s per render before it was paginated, and the project's own convention is to
// paginate any list over a couple of hundred rows.
//
// The risk in adding pages is not the slicing, it is the state: a page number that
// survives a change to WHICH rows match. Filter down from 1,047 rows to 12 while sitting
// on page 12 and you get an empty table under rows that plainly exist. So most of this
// file is about the reset paths, not the arithmetic.
//
// Deliberately NOT reset: saving, cancelling or deleting a payment, and a remote change
// arriving over sync. Paying several invoices in a row must not bounce the user back to
// page 1 each time.
//
// Run: node test-payments-pagination.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const pay = read('payments.html');
const inv = read('invoices.html');
const codeOf = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── the REAL clamp-and-slice, lifted from payments.html ─────────────────────
// Evaluating the shipped expressions rather than a reimplementation: a copy here would
// only prove the copy works.
const slice = (() => {
  const start = pay.indexOf('  const totalPages = Math.max(1, Math.ceil(list.length / PAY_PAGE_SIZE));');
  const end = pay.indexOf('  tbody.innerHTML = pageList.map(inv => {');
  if (start < 0 || end < 0 || end < start) throw new Error('slice block not found in payments.html');
  const block = pay.slice(start, end);
  const size = Number(/const PAY_PAGE_SIZE = (\d+);/.exec(pay)[1]);
  return (listLength, page) => new Function('list', '_payPage', 'PAY_PAGE_SIZE',
    block + '\nreturn { totalPages, page: _payPage, from: pageList[0], to: pageList[pageList.length-1], n: pageList.length };'
  )(Array.from({ length: listLength }, (_, i) => i + 1), page, size);
})();

section('page size matches invoices.html');
{
  const payeSize = Number(/const PAY_PAGE_SIZE = (\d+);/.exec(pay)[1]);
  const invSize = Number(/const INV_PAGE_SIZE = (\d+);/.exec(inv)[1]);
  t('payments uses 30 per page', payeSize === 30, payeSize);
  t('…the same as invoices', payeSize === invSize, { payeSize, invSize });
}

section('the slice arithmetic');
{
  const r1 = slice(1047, 1);
  t('page 1 shows the first 30', r1.n === 30 && r1.from === 1 && r1.to === 30, r1);
  t('…out of the right number of pages', r1.totalPages === 35, r1.totalPages);
  const r2 = slice(1047, 2);
  t('page 2 continues at 31', r2.from === 31 && r2.to === 60, r2);
  const rLast = slice(1047, 35);
  t('the last page is partial, not padded', rLast.n === 27 && rLast.to === 1047, rLast);
  const rExact = slice(60, 2);
  t('an exact multiple has no empty trailing page', rExact.totalPages === 2 && rExact.n === 30, rExact);
}

section('a page number that outlived its list is clamped');
{
  // The real failure mode: filter 1,047 rows down to 12 while on page 12.
  const r = slice(12, 12);
  t('a page past the end falls back to the last one', r.page === 1 && r.totalPages === 1, r);
  t('…and still shows the rows', r.n === 12, r.n);
  const r0 = slice(100, 0);
  t('page 0 is corrected rather than returning nothing', r0.page === 1 && r0.n === 30, { page: r0.page, n: r0.n });
  const rNeg = slice(100, -3);
  t('a negative page cannot produce a negative slice', rNeg.page === 1 && rNeg.n === 30, rNeg.n);
  // One row must not produce "page 1 / 0".
  const rOne = slice(1, 1);
  t('a single row is one page, not zero', rOne.totalPages === 1 && rOne.n === 1, rOne);
  const rNone = slice(0, 1);
  t('an empty list is still one page, never zero', rNone.totalPages === 1 && rNone.n === 0, rNone.totalPages);
}

section('everything that changes WHICH rows match resets the page');
{
  const code = codeOf(pay);
  const resets = [
    ['the status filter', /getElementById\('filterStatus'\)\.addEventListener\('input', \(\) => \{ _payResetPage\(\); render\(\); \}\)/],
    ['the select filters', /getElementById\(id\)\.addEventListener\('change', \(\) => \{ _payResetPage\(\); render\(\); \}\)/],
    ['the search box', /getElementById\('searchInv'\)\.addEventListener\('input', Utils\.debounce\(\(\) => \{ _payResetPage\(\); render\(\); \}, 200\)\)/],
    ['the from-date picker', /BEDate\.byId\('filterFrom', \{ onChange: \(\) => \{ _payResetPage\(\); render\(\); \} \}\)/],
    ['the to-date picker', /BEDate\.byId\('filterTo',\s+\{ onChange: \(\) => \{ _payResetPage\(\); render\(\); \} \}\)/],
    ['clearing all filters', /el\._flatpickr\.clear\(\);\s*\n\s*\}\);\s*\n\s*_payResetPage\(\);/],
    ['picking a customer', /_fcClose\(\);\s*\n\s*_payResetPage\(\);/],
    ['clearing the customer box', /if \(!q\) \{ _payResetPage\(\); render\(\); \}/],
    ['sorting a column', /_sortCol = col; _sortDir = -1; \}\s*\n(\s*\/\/.*\n)*\s*_payPage = 1;/],
    ['a full sync pull', /sync:ready', \(\) => \{ _payResetPage\(\); render\(\); \}/],
  ];
  for (const [what, re] of resets) t(what + ' resets to page 1', re.test(code), undefined);
  t('all ten reset points are present',
    resets.every(([, re]) => re.test(code)), resets.filter(([, re]) => !re.test(code)).map(x => x[0]));
}

section('…and the paths that must NOT reset, do not');
{
  // Paying several invoices in a row should not send the user back to page 1 each time.
  const code = codeOf(pay);
  const afterSync = /includes\(e\.detail\?\.key\)\) render\(\);/.test(code);
  t('a remote change re-renders without moving the user', afterSync);
  t('…and is not followed by a reset',
    !/includes\(e\.detail\?\.key\)\) \{ _payResetPage\(\)/.test(code));
  // The three payment actions each end in a bare render().
  const bare = (code.match(/refreshSummary\(invNum\);\s*\n\s*render\(\);/g) || []).length;
  t('cancel / clear-cheque / delete keep the page', bare >= 3, bare);
}

section('the pager itself');
{
  t('a container exists after the table', /id="payPagination"/.test(pay));
  t('…hidden by default', /id="payPagination"[^>]*display:none!important/.test(pay));
  t('…with the same classes as the invoices pager',
    /id="payPagination" class="d-flex justify-content-between align-items-center px-3 py-2 border-top small text-muted"/.test(pay));
  // Bootstrap's .d-flex is `display: flex !important`, so a plain inline display:none
  // LOSES to it. The bar starts hidden only because its attribute says
  // display:none!important; the first show clears that, and from then on a plain
  // assignment cannot hide it again — a narrowed filter left a stale
  // "จาก 904 รายการ · หน้า 1 / 31" under a short table. Found by driving the real page
  // in a browser; every source-level assertion here passed while it was broken.
  // invoices.html shipped the same bug and is fixed in the same release.
  t('hiding uses !important, or the utility class wins',
    /if \(totalPages <= 1\) \{ pg\.style\.setProperty\('display', 'none', 'important'\); return; \}/.test(pay));
  t('…and so does showing', /pg\.style\.setProperty\('display', 'flex', 'important'\)/.test(pay));
  t('no plain display assignment is left on the pager',
    !/pg\.style\.display = /.test(codeOf(pay)) && !/pgEmpty\.style\.display = /.test(codeOf(pay)));
  t('invoices.html is fixed the same way',
    /if \(totalPages <= 1\) \{ pg\.style\.setProperty\('display', 'none', 'important'\); return; \}/.test(inv) &&
    !/pg\.style\.display = /.test(codeOf(inv)));
  // The empty-results path RETURNS before the pager code, so it has to hide it itself or
  // a stale "แสดง 1–30 จาก 1,047" is left under an empty table.
  t('the empty-results path hides it too',
    /pgEmpty\.style\.setProperty\('display', 'none', 'important'\)/.test(pay));
  t('…before its own return', pay.indexOf('pgEmpty.style.display') < pay.indexOf('tbody.innerHTML = pageList.map'));
  t('the range label counts the WHOLE list, not the page',
    /จาก \$\{list\.length\} รายการ/.test(pay));
  t('…and the first/last buttons jump to real bounds',
    /onclick="_payPage=1;render\(\)"/.test(pay) && /onclick="_payPage=\$\{totalPages\};render\(\)"/.test(pay));
  t('the ends are disabled at the ends',
    /\$\{_payPage===1\?'disabled':''\}/.test(pay) && /\$\{_payPage===totalPages\?'disabled':''\}/.test(pay));
  t('a missing container cannot throw', /if \(!pg\) return;/.test(pay));
}

section('it is DOM cost only — not a Firestore saving');
{
  // "Show fewer rows" has been mistaken for a read-quota fix before. The listener has
  // already pulled the collection by the time render() runs.
  t('the note is written down where someone would misread it',
    /does not reduce Firestore reads/.test(pay));
  t('render still sums over the full list before slicing',
    pay.indexOf('const paidMap = DB.invoicePaidMap();') < pay.indexOf('const pageList = list.slice'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
