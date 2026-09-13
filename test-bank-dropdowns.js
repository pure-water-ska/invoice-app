// test-bank-dropdowns.js — run:  node test-bank-dropdowns.js
//
// User request: "in payment with transferred, customer's bank should be a drop down list",
// then "build it, cheque bank too".
//
// The four payment bank fields — customer's bank on a transfer (paySourceBank /
// multiSourceBank) and the cheque's bank (payChequeBank / multiChequeBank) — were text
// boxes with a searchable suggestion popup. Anyone could skip the popup and type
// "กสิกร" or "kbank", which was saved as-is; the ธนาคารต้นทาง filter matches the saved
// text exactly, so every variant showed as a separate bank.
//
// They are now pick-only <select>s filled from Utils.BANKS. The saved value is the full
// bank name — exactly what the old picker saved — so old and new payments still match.
//
// Drives the REAL _bankSelectOptions against the REAL Utils.BANKS (from utils.js) and
// the page's own escaper, plus structural checks on the fields, resets and save paths.

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

const html  = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
const utils = fs.readFileSync(path.join(DIR, 'utils.js'), 'utf8');

const IDS = ['paySourceBank', 'payChequeBank', 'multiSourceBank', 'multiChequeBank'];

// ── the real bank list and the page's own escaper ───────────────────────────────────
const banksSrc = (utils.match(/BANKS:\s*(\[[\s\S]*?\n\s*\]),/) || [])[1];
t('Utils.BANKS was found in utils.js', !!banksSrc);
const BANKS = new Function(`return ${banksSrc};`)();
t('it is the 18-bank list ending in อื่นๆ', BANKS.length === 18 && BANKS[BANKS.length - 1].name === 'อื่นๆ', BANKS.length);

let escSrc = null;
if (html.includes('function esc(')) escSrc = sliceBalanced(html, 'function esc(');
else { const m = html.match(/const esc\s*=\s*[^\n]+/); escSrc = m && m[0]; }
t("payments.html's escaper was found", !!escSrc);

const optsSrc = sliceBalanced(html, 'function _bankSelectOptions() {');
const build = (banks) => new Function('Utils', `${escSrc}\n${optsSrc}\nreturn _bankSelectOptions();`)({ BANKS: banks });
const optionValues = h => [...h.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
const optionLabels = h => [...h.matchAll(/<option value="[^"]*">([^<]*)<\/option>/g)].map(m => m[1]);

// ── the fields ──────────────────────────────────────────────────────────────────────
console.log('\nall four payment bank fields are dropdowns');
for (const id of IDS) {
  t(`${id} is a <select>`, new RegExp(`<select id="${id}" class="form-select"></select>`).test(html));
  t(`${id} is no longer a text box`, !new RegExp(`<input[^>]*id="${id}"`).test(html));
}
t('no payment bank field still uses the free-typing datalist',
  !IDS.some(id => new RegExp(`id="${id}"[^>]*list="bankDatalist"`).test(html)));

console.log('\nthe old searchable text picker leaves them alone');
{
  const ids = (html.match(/const _BANK_IDS = (\[[^\]]*\]);/) || [])[1];
  const list = ids ? new Function(`return ${ids};`)() : null;
  t('_BANK_IDS was found', !!list);
  t('none of the four payment fields are in it', list && IDS.every(id => !list.includes(id)), JSON.stringify(list));
  t("the transfer-account manager's own fields still use it",
    list && list.includes('editAcctBank') && list.includes('newAcctBank'));
}

console.log('\nfilled at start-up, from the same place the old picker was wired');
{
  t('_initBankSelects() is called right after _initBankCombos()', /_initBankCombos\(\);\r?\n\s*_initBankSelects\(\);/.test(html));
  const initSrc = sliceBalanced(html, 'function _initBankSelects() {');
  const listed = (html.match(/const _BANK_SELECT_IDS = (\[[^\]]*\]);/) || [])[1];
  t('it fills exactly the four payment fields', listed && JSON.stringify(new Function(`return ${listed};`)()) === JSON.stringify(IDS), listed);

  // drive the real init against stub elements
  const els = {};
  IDS.forEach(id => { els[id] = { tagName: 'SELECT', innerHTML: '' }; });
  els.stray = { tagName: 'INPUT', innerHTML: '' };
  new Function('Utils', 'document', `${escSrc}\n${optsSrc}\nconst _BANK_SELECT_IDS = ${listed};\n${initSrc}\n_initBankSelects();`)(
    { BANKS }, { getElementById: id => els[id] || null });
  t('every dropdown received the bank list', IDS.every(id => optionValues(els[id].innerHTML).length === BANKS.length + 1));
  t('a non-select element with the same id would be left untouched', els.stray.innerHTML === '');
}

// ── the options ─────────────────────────────────────────────────────────────────────
console.log('\nthe options — the real bank list, saving the full name');
{
  const h = build(BANKS);
  const vals = optionValues(h);
  t('first option is the empty "— เลือกธนาคาร —"', vals[0] === '' && /<option value="">— เลือกธนาคาร —<\/option>/.test(h));
  t('then every bank, in the same order as Utils.BANKS', JSON.stringify(vals.slice(1)) === JSON.stringify(BANKS.map(b => b.name)));
  t('the saved value is the FULL name, e.g. กสิกรไทย (KBANK)', vals.includes('กสิกรไทย (KBANK)'));
  t('not the short code', !vals.includes('KBANK'));
  t('อื่นๆ is offered for banks not in the list', vals.includes('อื่นๆ'));
  t('labels read the same as the values', JSON.stringify(optionLabels(h)) === JSON.stringify(['— เลือกธนาคาร —', ...BANKS.map(b => b.name)]));
  t('no option is pre-selected (a new payment starts empty)', !/ selected/.test(h));
}

console.log('\nold and new payments stay the same bank');
{
  // the old picker put b.name into the text box — the dropdown's value must be that same string
  t('the old picker saved b.name', /_bankPick\('\$\{b\.name\.replace/.test(html) && /function _bankPick\(name\) \{ if \(_bankActiveInput\) _bankActiveInput\.value = name;/.test(html));
  const dropdownValue = optionValues(build(BANKS)).find(v => v.includes('KBANK'));
  const oldPickerValue = BANKS.find(b => b.code === 'KBANK').name;
  t('a KBANK payment saved via the dropdown === one saved via the old picker', dropdownValue === oldPickerValue, `${dropdownValue} vs ${oldPickerValue}`);
  t('so the ธนาคารต้นทาง filter still matches on the exact saved text', /\(!fSrcBank\s+\|\| p\.sourceBank\s+=== fSrcBank\)/.test(html));
}

console.log('\nescaping');
{
  const h = build([{ code: 'X', name: 'A"B<b>' }]);
  t('a quote in a bank name cannot break the attribute', h.includes('value="A&quot;B&lt;b&gt;"'), h);
  t('markup in a bank name is shown as text', !h.includes('<b>'));
}

// ── resets and saving still work with a <select> ────────────────────────────────────
console.log("\nresets and saving are unchanged — and work because '' is a real option");
{
  t('single modal open clears both fields to empty',
    /getElementById\('paySourceBank'\)\.value\s*=\s*'';/.test(html) && /getElementById\('payChequeBank'\)\.value\s*=\s*'';/.test(html));
  t('multi modal open clears both fields to empty', /'multiSourceBank','multiChequeBank','multiChequeNo'\]\.forEach\(id => \{\s*\r?\n\s*const el = document\.getElementById\(id\); if \(el\) el\.value = '';/.test(html));
  t("'' matches the placeholder option, so a cleared dropdown shows — เลือกธนาคาร —", optionValues(build(BANKS))[0] === '');
  // capture the right-hand side of EVERY assignment and require each to be '' — a
  // negative lookahead after \s* backtracks past the spaces and matches '' lines too
  const assigns = [...html.matchAll(/(?:SourceBank|ChequeBank)['"]\)\.value\s*=\s*([^;\n]+);/g)].map(m => m[1].trim());
  t('nothing else writes a bank name into these fields by code — every assignment is a reset',
    assigns.length > 0 && assigns.every(v => v === "''"), JSON.stringify(assigns));
  t('single save reads the fields as before',
    /sourceBank:\s+document\.getElementById\('paySourceBank'\)\.value\s+\|\| '',/.test(html) &&
    /chequeBank:\s+document\.getElementById\('payChequeBank'\)\.value\s+\|\| '',/.test(html));
  t('multi save reads the fields as before',
    /sourceBank:\s+document\.getElementById\('multiSourceBank'\)\.value \|\| '',/.test(html) &&
    /chequeBank:\s+document\.getElementById\('multiChequeBank'\)\.value\s+\|\| '',/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
