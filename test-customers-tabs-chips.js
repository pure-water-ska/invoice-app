// test-customers-tabs-chips.js — run:  node test-customers-tabs-chips.js
//
// Two customers.html changes, both requested by the user:
//
//  1. ทั้งหมด / ใช้งาน / ระงับ status tabs. Suspension is already an ENFORCED state
//     (invoice-create blocks new invoices for a suspended customer in three places;
//     pricing warns), but customers.html only dimmed the card and mixed it into the same
//     24-per-page grid with no way to filter. ทั้งหมด stays the default on purpose:
//     suspension usually FOLLOWS unpaid debt, so an active-only default would hide exactly
//     the accounts worth chasing. Within ทั้งหมด, suspended sort last.
//
//  2. Unpaid-invoice chips capped at 5 with an expander. Every unpaid invoice used to
//     render, so a customer with 20 outstanding stretched its whole grid row. The toggle
//     carries the hidden COUNT AND TOTAL — a bare "see more" would make a customer with 6
//     unpaid look identical to one with 30 and quietly move real debt out of sight.
//
// Extracts the ACTUAL logic from customers.html — not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'customers.html'), 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

// ── The real filter + sort block out of render() ─────────────────────────────
const fsStart = src.indexOf('  const _nSusp = list.filter(c => c.suspended).length;');
const fsEnd   = src.indexOf('_visibleIds = list.map(c => c.id);');
if (fsStart < 0 || fsEnd < 0) throw new Error('render() filter/sort block not found — update extraction markers');
const filterSortBlock = src.slice(fsStart, fsEnd);

function runFilterSort(customers, status, sortMode = 'name_asc', balances = {}) {
  const counts = {};
  const document = { getElementById: id => ({ set textContent(v) { counts[id] = v; } }) };
  const fn = new Function('list', '_custStatus', 'sortMode', 'document', '_custBalance',
    `${filterSortBlock}\nreturn { list, counts: null };`);
  const out = fn(customers.slice(), status, sortMode, document, c => balances[c.id] || 0);
  return { list: out.list, counts };
}

const CUSTS = [
  { id: 'a', name: 'กิจเจริญ' },
  { id: 'b', name: 'ทรัพย์มณี', suspended: true },
  { id: 'c', name: 'ร้านอรวรรณ' },
  { id: 'd', name: 'บูรพา', suspended: true },
];

console.log('Status tabs — counts always describe the current search result');
{
  const { counts } = runFilterSort(CUSTS, 'all');
  t('ทั้งหมด counts everyone', counts.cntAll === 4, String(counts.cntAll));
  t('ใช้งาน counts the non-suspended', counts.cntActive === 2, String(counts.cntActive));
  t('ระงับ counts the suspended', counts.cntSusp === 2, String(counts.cntSusp));
}
{
  // Counts must be computed BEFORE the status filter, or each tab would report itself as
  // the total and the other two would read 0.
  const { counts } = runFilterSort(CUSTS, 'susp');
  t('counts unchanged while viewing the ระงับ tab',
    counts.cntAll === 4 && counts.cntActive === 2 && counts.cntSusp === 2,
    JSON.stringify(counts));
}

console.log('\nStatus tabs — filtering');
{
  t('ทั้งหมด shows all 4', runFilterSort(CUSTS, 'all').list.length === 4);
  const act = runFilterSort(CUSTS, 'active').list;
  t('ใช้งาน shows only active', act.length === 2 && act.every(c => !c.suspended), act.map(c => c.name).join(','));
  const sus = runFilterSort(CUSTS, 'susp').list;
  t('ระงับ shows only suspended', sus.length === 2 && sus.every(c => c.suspended), sus.map(c => c.name).join(','));
}

console.log('\nStatus tabs — suspended sort last in ทั้งหมด, but sort still applies within groups');
{
  const l = runFilterSort(CUSTS, 'all', 'name_asc').list;
  t('all suspended come after all active',
    !l[0].suspended && !l[1].suspended && l[2].suspended && l[3].suspended,
    l.map(c => (c.suspended ? '*' : '') + c.name).join(' '));
  t('active group is still name-sorted', l[0].name === 'กิจเจริญ' && l[1].name === 'ร้านอรวรรณ',
    l.slice(0, 2).map(c => c.name).join(','));
}
{
  // The suspended-last rule must not fight the chosen sort inside a single-status tab.
  const bal = { a: 10, c: 500 };
  const l = runFilterSort(CUSTS, 'active', 'bal_desc', bal).list;
  t('bal_desc still orders the active tab by balance', l[0].id === 'c' && l[1].id === 'a',
    l.map(c => c.id).join(','));
}
{
  const bal = { a: 10, b: 900, c: 500, d: 20 };
  const l = runFilterSort(CUSTS, 'all', 'bal_desc', bal).list;
  t('in ทั้งหมด a big-balance suspended customer still sorts after every active one',
    l.map(c => c.id).join(',') === 'c,a,b,d', l.map(c => c.id).join(','));
}

// ── The real chip-capping block ──────────────────────────────────────────────
const chipStart = src.indexOf('              const expanded = _unpaidExpanded.has(c.id);');
const chipEnd   = src.indexOf('</div>`;', chipStart) + 8;
if (chipStart < 0) throw new Error('chip block not found — update extraction marker');
const chipBlock = src.slice(chipStart, chipEnd);

function runChips(unpaidList, expandedIds) {
  const Utils = { formatNumber: n => (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  const fn = new Function('unpaidList', '_unpaidExpanded', 'c', 'Utils', 'UNPAID_CHIP_LIMIT', 'encodeURIComponent',
    chipBlock.replace(/^\s*return /, 'const html = ') + '\nreturn html;');
  return fn(unpaidList, new Set(expandedIds), { id: 'cust1' }, Utils, 5, encodeURIComponent);
}

const mk = n => Array.from({ length: n }, (_, i) => ({ num: 'INV-' + (i + 1), rem: (n - i) * 100 }));
// One href per chip — the invoice number itself appears three times per chip (href, title
// and body text), so counting the number would over-count by 3x.
const chipCount = html => (html.match(/payments\.html\?inv=/g) || []).length;

console.log('\nUnpaid chips — at or below the limit nothing is hidden');
{
  const html = runChips(mk(5), []);
  t('all 5 chips render', chipCount(html) === 5, String(chipCount(html)));
  t('no expander shown', !html.includes('อีก '));
  t('no collapse button either', !html.includes('ย่อ'));
}

console.log('\nUnpaid chips — above the limit, the rest collapse behind a counted toggle');
{
  // 8 unpaid: 800,700,600,500,400 shown; 300,200,100 hidden = 600 hidden.
  const html = runChips(mk(8), []);
  t('only 5 chips render', chipCount(html) === 5, String(chipCount(html)));
  t('toggle names the hidden COUNT', html.includes('อีก 3 ใบ'), (html.match(/อีก[^<]*/) || [])[0]);
  t('toggle names the hidden TOTAL, so debt is not silently hidden',
    html.includes('฿600.00'), (html.match(/อีก[^<]*/) || [])[0]);
  t('the largest debts are the ones kept visible', html.includes('INV-1') && !html.includes('INV-8'));
}

console.log('\nUnpaid chips — expanded shows everything plus a collapse control');
{
  const html = runChips(mk(8), ['cust1']);
  t('all 8 chips render', chipCount(html) === 8, String(chipCount(html)));
  t('collapse button offered', html.includes('ย่อ'));
  t('no stale "อีก N ใบ" toggle while expanded', !html.includes('อีก '));
}

console.log('\nUnpaid chips — expansion is per customer, not global');
{
  const other = new Function('unpaidList', '_unpaidExpanded', 'c', 'Utils', 'UNPAID_CHIP_LIMIT', 'encodeURIComponent',
    chipBlock.replace(/^\s*return /, 'const html = ') + '\nreturn html;')(
    mk(8), new Set(['someone-else']), { id: 'cust1' },
    { formatNumber: n => String(n) }, 5, encodeURIComponent);
  t('another customer being expanded does not expand this one',
    chipCount(other) === 5, String(chipCount(other)));
}

console.log('\nUnpaid chips — the toggle is wired to the right customer id');
{
  const html = runChips(mk(8), []);
  t('onclick targets this customer', html.includes("toggleUnpaidChips('cust1')"));
  t('chips still link to the payments page', html.includes('payments.html?inv=INV-1'));
}

console.log('\nSource guards');
{
  t('tab strip exists with all three statuses',
    src.includes('data-status="all"') && src.includes('data-status="active"') && src.includes('data-status="susp"'));
  t('ทั้งหมด is the default tab', /let _custStatus = 'all'/.test(src));
  t('switching tabs resets to page 1', /_custStatus = s;[\s\S]{0,240}_custPage = 1/.test(src));
  t('expansion state survives re-render (declared outside render)',
    /^let _unpaidExpanded = new Set\(\);/m.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
