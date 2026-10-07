// test-blank-qty-rows.js — v1.0.250
//
// A row with a product name but no จำนวน and no เศษ used to be filtered out at save
// with NOTHING said: onProductSelect fills name/unitSize/brand/price and never touches
// qty, so picking four products and forgetting one quantity printed an invoice with
// three lines and a smaller total, silently. The row is still excluded by default —
// that part was right — but the user is now asked about each one and can choose to
// print it (จำนวน 0) instead, for a note line or a ของแถม row.
//
// What matters is that the three paths that decide what goes ON the invoice —
// previewInvoice, saveInvoice, saveInvoiceEdit — can never disagree, and that none of
// them can ever drop a named row the user was not asked about. So this suite executes
// the real _splitItems/_isBlankQtyRow logic lifted from invoice-create.html rather than
// a copy, and then asserts the three call sites actually use it.
//
// Run: node test-blank-qty-rows.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const html = fs.readFileSync(path.join(__dirname, 'invoice-create.html'), 'utf8');

// ── load the real functions out of the page ────────────────────────────────
// Lifting the source means a change to the page's logic is tested, not a stale copy.
function lift(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in invoice-create.html');
  let depth = 0, started = false;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') { depth--; if (started && depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// _splitItems closes over the page-level `items`, so bind it to ours explicitly.
const api = new Function('items', `
  ${lift('_isBlankQtyRow')}
  ${lift('_splitItems')}
  return { _isBlankQtyRow, _splitItems };
`);

const run = rows => api(rows)._splitItems();
const blankQ = row => api([])._isBlankQtyRow(row);

const R = (name, qty, remainder, extra) =>
  Object.assign({ name, qty, remainder, price: '10' }, extra || {});

section('which rows count as "no quantity"');
{
  t('a product with a quantity is fine', blankQ(R('น้ำดื่ม', '12', 0)) === false);
  t('a product with no quantity at all is flagged', blankQ(R('ถุงขวด', '', 0)) === true);
  t('an explicit 0 is flagged too', blankQ(R('ถุงขวด', '0', 0)) === true);
  // A loose-bottle line is legitimately 0 cases + some เศษ. Flagging it would block
  // a sale the business makes every day.
  t('เศษ alone counts as a quantity — not flagged', blankQ(R('ถุงขวด', '0', 5)) === false);
  t('…and เศษ as a string counts as well', blankQ(R('ถุงขวด', '', '5')) === false);
  // Returns are added as NEGATIVE lines, so the test must be !== 0, never <= 0.
  t('a negative quantity (a return line) is not flagged', blankQ(R('คืนสินค้า', '-3', 0)) === false);
  t('an empty row with no name is not flagged', blankQ(R('', '', 0)) === false);
  t('a row with only whitespace in qty is flagged', blankQ(R('ถุงขวด', '   ', 0)) === true);
}

section('_splitItems decides what reaches the invoice');
{
  const rows = [R('น้ำดื่ม', '12', 0), R('ถุงขวด', '', 0), R('น้ำแข็ง', '5', 0)];
  const s = run(rows);
  t('priced rows go on the invoice', s.active.length === 2, s.active.map(r => r.name));
  t('the row with no quantity is held back', s.blank.length === 1 && s.blank[0].name === 'ถุงขวด');
  t('…and is reported as not yet ruled on', s.undecided.length === 1);
  t('unnamed rows are ignored entirely, not reported as blank',
    run([R('', '', 0), R('', '', 0)]).blank.length === 0);
}

section('the user can choose to print a row with no quantity');
{
  const kept = run([R('ของแถม', '', 0, { keepZero: true, zeroDecided: true })]);
  t('a kept row IS on the invoice', kept.active.length === 1 && kept.active[0].name === 'ของแถม');
  t('…and is no longer reported as blank', kept.blank.length === 0);

  const dropped = run([R('ถุงขวด', '', 0, { keepZero: false, zeroDecided: true })]);
  t('a row ruled out stays off the invoice', dropped.active.length === 0);
  t('…but is still listed as blank', dropped.blank.length === 1);
  // This is the whole point: a deliberate exclusion must be distinguishable from one
  // nobody was ever asked about, or the save paths cannot tell silence from consent.
  t('…and is NOT undecided, so the save may proceed', dropped.undecided.length === 0);
}

section('order on the printed invoice is preserved');
{
  const s = run([
    R('หนึ่ง', '1', 0),
    R('สอง', '', 0, { keepZero: true }),
    R('สาม', '2', 0),
  ]);
  t('a kept zero row keeps its position between the others',
    s.active.map(r => r.name).join(',') === 'หนึ่ง,สอง,สาม', s.active.map(r => r.name));
}

section('all three paths read the one helper — they cannot disagree');
{
  // The old code repeated the same filter three times. Any of them drifting is how a
  // preview and a save come to show different totals.
  const oldFilter = /items\.filter\(item => \{[\s\S]{0,200}?return qty !== 0 \|\| rem !== 0;/g;
  t('no copy of the old inline filter survives', !oldFilter.test(html));

  const body = fn => {
    const i = html.indexOf('function ' + fn + '(');
    return i < 0 ? '' : html.slice(i, i + 2500);
  };
  ['previewInvoice', 'saveInvoice', 'saveInvoiceEdit'].forEach(fn => {
    t(fn + ' uses _splitItems()', /_splitItems\(\)/.test(body(fn)));
  });
  t('previewInvoice is the one that ASKS', /askAboutBlankRows/.test(body('previewInvoice')));
  // Re-asking inside the save paths would mean an await before their re-entrancy lock,
  // which is exactly how a double click mints two invoices.
  t('saveInvoice does NOT await a dialog before its lock',
    !/askAboutBlankRows/.test(body('saveInvoice')));
  t('saveInvoiceEdit does NOT either', !/askAboutBlankRows/.test(body('saveInvoiceEdit')));
  t('both save paths refuse an unanswered row instead of dropping it',
    (body('saveInvoice').match(/undecided\.length/) || []).length === 1 &&
    (body('saveInvoiceEdit').match(/undecided\.length/) || []).length === 1);
  t('…and name the products when they refuse',
    /ยังไม่ได้ใส่จำนวน: /.test(body('saveInvoice')) && /ยังไม่ได้ใส่จำนวน: /.test(body('saveInvoiceEdit')));
  t('previewInvoice had to become async to await the answer',
    /async function previewInvoice\(/.test(html));
}

section('the warning is visible while typing, before any save');
{
  t('a slot exists for it', /id="blankQtyWarn"/.test(html));
  t('it is painted on every total update', /function updateGrandTotal\(\)\s*\{\s*renderBlankQtyWarning\(\)/.test(html));
  t('the quantity box itself is highlighted', /_isBlankQtyRow\(item\) && !item\.keepZero \? ' style="border-color/.test(html));
  // The A5 print layout shows the same DOM, so a warning without no-print would end up
  // on the customer's copy. Check the alert the function actually emits, not merely that
  // "no-print" appears somewhere nearby — it appears all over this file.
  const warnFn = lift('renderBlankQtyWarning');
  t('the warning is not printed on the invoice',
    /<div class="alert alert-warning[^"]*\bno-print\b/.test(warnFn));
}

section('an answer goes stale when the quantity changes');
{
  t('_clearZeroDecision exists', /function _clearZeroDecision\(i\)/.test(html));
  t('it clears BOTH flags, so the row is asked about again',
    /_clearZeroDecision\(i\) \{\s*items\[i\]\.keepZero = false;\s*items\[i\]\.zeroDecided = false;/.test(html));
  t('typing a quantity clears it', /items\[\$\{i\}\]\.qty=this\.value;_clearZeroDecision\(\$\{i\}\)/.test(html));
  t('typing เศษ clears it too', /items\[\$\{i\}\]\.remainder=this\.value;_clearZeroDecision\(\$\{i\}\)/.test(html));
}

section('reopening a saved invoice does not re-litigate its rows');
{
  // A zero-quantity row that is already ON a saved invoice was either chosen by the
  // user or predates the question. Editing the invoice must not silently drop it.
  const i = html.indexOf('items = pages.flatMap');
  const block = html.slice(i, i + 900);
  t('loaded rows are marked as already decided', /zeroDecided: true/.test(block));
  t('…and as kept, so they stay on the invoice', /keepZero:\s+true/.test(block));
}

section('the dialog itself');
{
  t('it offers a per-row choice, not one answer for all', /js-keep-zero/.test(html));
  t('it returns a Promise so the caller can await the answer',
    /function askAboutBlankRows\(rows\) \{\s*return new Promise/.test(html));
  t('backing out resolves false — nothing is saved', /js-back'\)\.onclick = \(\) => \{ close\(\); resolve\(false\); \}/.test(html));
  t('confirming marks every shown row as decided', /rows\.forEach\(r => \{ r\.zeroDecided = true; \}\)/.test(html));
  // Product names are free text. innerHTML on them would break the dialog on a stray <.
  t('product names are set as text, never as HTML', /js-nm'\)\.forEach\(\(el, k\) => \{ el\.textContent = rows\[k\]\.name; \}\)/.test(html));
  t('it does not use window.confirm (a Promise, never falsy, in the desktop app)',
    !/if \(!confirm\(/.test(html));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
