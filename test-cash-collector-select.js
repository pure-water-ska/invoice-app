// test-cash-collector-select.js — run:  node test-cash-collector-select.js
//
// User requests, in order:
//   1. "in payments, user can select cash receiver by user name"
//   2. "cash receiver should be a logged in user by default"
//   3. "admin can select which user can show on the dropdown list", refined to — with
//      test hidden:
//        aing logs in (user)  → cannot see test
//        joe  logs in (admin) → can see test
//        test logs in         → can only see themselves
//
// The ผู้รับเงิน field was a READ-ONLY input locked to the logged-in user. It is now a
// <select> in both the single-invoice and multi-invoice modals, built by one shared
// _cashCollectorOptions(). Each user carries a cashReceiver flag set in users.html
// (absent = shown). The audit trail (createdBy/createdByUser) is untouched.
//
// Drives the REAL helpers sliced out of payments.html, the REAL multi-modal opener lines
// and the REAL multi-pay save expression, rather than restating any of them.

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
const users = fs.readFileSync(path.join(DIR, 'users.html'), 'utf8');

const helperSrc = [
  'function _cashCollectorIsAdmin() {',
  'function _cashCollectorLocked() {',
  'function _cashCollectorOptions(selected) {',
  'function buildCashCollectorSelect() {',
].map(m => sliceBalanced(html, m)).join('\n');

// Legacy user list — no cashReceiver flag anywhere, as on every record before this change.
const USERS = [
  { id: 'u1', username: 'joe',   name: 'โจ',          active: true },
  { id: 'u2', username: 'aing',  name: 'อิ่ง',         active: true },
  { id: 'u3', username: 'aieng', name: 'เอียง',        active: true },
  { id: 'u4', username: 'old',   name: 'พนักงานเก่า',  active: false },
  { id: 'u5', username: 'admin', name: 'ผู้ดูแลระบบ',   active: true },
  { id: 'u6', username: 'legacy' },                      // no active field, no name
];

// The user's own scenario: test is hidden; joe and admin are admins.
const TEAM = [
  { username: 'admin', name: 'ผู้ดูแลระบบ', role: 'admin', active: true },
  { username: 'aing',  name: 'aing',        role: 'user',  active: true },
  { username: 'test',  name: 'test',        role: 'user',  active: true, cashReceiver: false },
  { username: 'joe',   name: 'joe',         role: 'admin', active: true },
  { username: 'aieng', name: 'aieng',       role: 'user',  active: true },
];

// A select stub that behaves like the DOM: assigning innerHTML with a `selected` option
// makes that option's value the select's value; with none marked, the first option wins.
function makeSelect() {
  const s = { _html: '', value: '', disabled: false };
  Object.defineProperty(s, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      const opts = [...v.matchAll(/<option value="([^"]*)"( selected)?>/g)];
      const sel = opts.find(o => o[2]) || opts[0];
      this.value = sel ? sel[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    },
  });
  return s;
}

function load(list, session, isAdmin = false, extra = '') {
  const sel = makeSelect();
  const DB = { getUsers: () => list };
  const document = { getElementById: () => sel };
  const Auth = { isAdmin: () => isAdmin };
  const api = new Function('DB', 'document', 'session', 'Auth',
    `${helperSrc}\n${extra}\nreturn { _cashCollectorOptions, buildCashCollectorSelect, _cashCollectorLocked };`)(
    DB, document, session, Auth);
  return Object.assign(api, { sel });
}
const values = h => [...h.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
const labelOf = (h, u) => (h.match(new RegExp(`<option value="${u}"[^>]*>([^<]*)</option>`)) || [])[1];

// ── the field is a choice, not a locked box ─────────────────────────────────────────
console.log('both fields are selects now, not read-only inputs');
{
  t('payCashCollector is a <select>', /<select id="payCashCollector"/.test(html));
  t('multiCashCollector is a <select>', /<select id="multiCashCollector"/.test(html));
  t('neither is a readonly input any more',
    !/id="payCashCollector"[^>]*readonly/.test(html) && !/id="multiCashCollector"[^>]*readonly/.test(html));
}

// ── legacy data: no flags → behaves exactly as before ───────────────────────────────
console.log('\nlegacy users (no cashReceiver flag) — active users only');
{
  const { _cashCollectorOptions } = load(USERS, { username: 'joe' });
  const v = values(_cashCollectorOptions('joe'));
  t('every active user is offered', ['joe', 'aing', 'aieng', 'admin'].every(u => v.includes(u)), v.join(','));
  t('a suspended user is NOT offered', !v.includes('old'), v.join(','));
  t('a user with no active field counts as active', v.includes('legacy'));
  t('each user appears once', new Set(v).size === v.length);
}

console.log('\nthe label — name (username), stored value — username');
{
  const { _cashCollectorOptions } = load(USERS, { username: 'joe' });
  const h = _cashCollectorOptions('joe');
  t('label shows the name with the username', labelOf(h, 'aing') === 'อิ่ง (aing)', labelOf(h, 'aing'));
  t('the value is the username, not the name', h.includes('value="aing"') && !h.includes('value="อิ่ง"'));
  t('a user with no name is labelled by username alone', labelOf(h, 'legacy') === 'legacy');
}

// ── the user's own scenario ─────────────────────────────────────────────────────────
console.log('\ntest is hidden — aing logs in (user role) → cannot see test');
{
  const { _cashCollectorOptions, buildCashCollectorSelect, sel } = load(TEAM, { username: 'aing' }, false);
  const v = values(_cashCollectorOptions('aing'));
  t('test is NOT offered to aing', !v.includes('test'), v.join(','));
  t('everyone else shown is offered', ['admin', 'aing', 'joe', 'aieng'].every(u => v.includes(u)), v.join(','));
  buildCashCollectorSelect();
  t('aing defaults to aing', sel.value === 'aing', sel.value);
  t('aing can still choose — the box is not locked', sel.disabled === false);
  t('test cannot be smuggled in as a "kept" selection either',
    !values(_cashCollectorOptions('test')).includes('test'));
}

console.log('\ntest is hidden — joe logs in (admin role) → can see test');
{
  const { _cashCollectorOptions, buildCashCollectorSelect, sel } = load(TEAM, { username: 'joe' }, true);
  const h = _cashCollectorOptions('joe');
  const v = values(h);
  t('test IS offered to joe', v.includes('test'), v.join(','));
  t('all five are offered', v.length === 5, v.join(','));
  t('test is labelled as hidden, so the admin can tell', labelOf(h, 'test') === 'test · ซ่อน', labelOf(h, 'test'));
  t('shown users carry no hidden label', !/ซ่อน/.test(labelOf(h, 'aing')), labelOf(h, 'aing'));
  buildCashCollectorSelect();
  t('joe defaults to joe', sel.value === 'joe', sel.value);
  t('joe can choose — not locked', sel.disabled === false);
}

console.log('\ntest is hidden — test logs in → can only see themselves');
{
  const { _cashCollectorOptions, buildCashCollectorSelect, _cashCollectorLocked, sel } =
    load(TEAM, { username: 'test' }, false);
  t('test is locked', _cashCollectorLocked() === true);
  t('the list is test alone', values(_cashCollectorOptions('test')).join(',') === 'test',
    values(_cashCollectorOptions('test')).join(','));
  t('even asked to keep someone else, it gives only test',
    values(_cashCollectorOptions('aing')).join(',') === 'test' && /value="test" selected/.test(_cashCollectorOptions('aing')));
  buildCashCollectorSelect();
  t('the box shows test', sel.value === 'test', sel.value);
  t('and is disabled', sel.disabled === true);
  t('a locked user sees no hidden label on themselves', !/ซ่อน/.test(_cashCollectorOptions('test')));
}

console.log('\na hidden ADMIN is not locked — admin wins');
{
  const team = TEAM.map(u => u.username === 'joe' ? { ...u, cashReceiver: false } : u);
  const { _cashCollectorOptions, _cashCollectorLocked } = load(team, { username: 'joe' }, true);
  t('a hidden admin is not locked', _cashCollectorLocked() === false);
  t('and still sees everyone', values(_cashCollectorOptions('joe')).length === 5);
  const asAing = load(team, { username: 'aing' }, false);
  t('an ordinary user cannot see the hidden admin', !values(asAing._cashCollectorOptions('aing')).includes('joe'));
}

// ── defaulting and preserving the pick ──────────────────────────────────────────────
console.log('\nsingle-invoice modal — the logged-in user is preselected');
{
  const { buildCashCollectorSelect, sel } = load(USERS, { username: 'aing' });
  buildCashCollectorSelect();
  t('a fresh modal defaults to the logged-in user', sel.value === 'aing', sel.value);
}

console.log('\nsingle-invoice modal — a pick survives switching method and back');
{
  const { buildCashCollectorSelect, sel } = load(USERS, { username: 'joe' });
  buildCashCollectorSelect();
  sel.value = 'aieng';
  buildCashCollectorSelect();                // onMethodChange → cash again
  t('the chosen receiver is kept, not reset to the logged-in user', sel.value === 'aieng', sel.value);
}

console.log('\nsingle-invoice modal — the per-entry reset falls back to the logged-in user');
{
  const { buildCashCollectorSelect, sel } = load(USERS, { username: 'joe' });
  buildCashCollectorSelect();
  sel.value = 'aieng';
  sel.value = '';
  buildCashCollectorSelect();
  t('an emptied select defaults back to the logged-in user', sel.value === 'joe', sel.value);
}

// Reproduced live: pick aing on 100969-001, open 100969-002 → it defaulted to aing.
console.log('\na NEW invoice window defaults to the logged-in user, not the last pick');
{
  const openSrc = sliceBalanced(html, 'function openPayModal(invNum, custId) {');
  const clearAt = openSrc.indexOf("getElementById('payCashCollector').value");
  // the CALL statement (with its semicolon) — the explanatory comment above the clear
  // also names buildCashCollectorSelect(), and must not be mistaken for the call
  const buildAt = openSrc.indexOf('buildCashCollectorSelect();');
  t('openPayModal clears the receiver box', clearAt >= 0);
  t('and clears it BEFORE rebuilding it', clearAt >= 0 && buildAt > clearAt, `clear@${clearAt} build@${buildAt}`);
  t('it clears it to empty, which the builder treats as "use the logged-in user"',
    /getElementById\('payCashCollector'\)\.value\s*=\s*''/.test(openSrc));

  const { buildCashCollectorSelect, sel } = load(USERS, { username: 'joe' });
  buildCashCollectorSelect();
  sel.value = 'aing';
  sel.value = '';
  buildCashCollectorSelect();
  t('invoice B defaults to the logged-in user, not aing', sel.value === 'joe', sel.value);
}

console.log('\nvalues outside the list');
{
  const { _cashCollectorOptions } = load(USERS, { username: 'joe' });
  const h = _cashCollectorOptions('old');
  t('a suspended-but-selected user stays listed', values(h).includes('old'));
  t('and stays the selection', /value="old" selected/.test(h), h);

  const empty = load([], { username: 'joe' });
  empty.buildCashCollectorSelect();
  t('with no users synced yet, the logged-in user is still offered and selected',
    empty.sel.value === 'joe', empty.sel.value);
  t('and is not locked (their flag is unknown)', empty.sel.disabled === false);
}

console.log('\nescaping');
{
  const { _cashCollectorOptions } = load(
    [{ username: 'x"y', name: '<b>A&B</b>', active: true }], { username: 'x"y' });
  const h = _cashCollectorOptions('x"y');
  t('a quote in the username cannot break out of the attribute', h.includes('value="x&quot;y"'), h);
  t('markup in the name is shown as text, not rendered',
    h.includes('&lt;b&gt;A&amp;B&lt;/b&gt;') && !h.includes('<b>'), h);
}

// ── the multi-invoice path ──────────────────────────────────────────────────────────
console.log('\nmulti-invoice modal — same list, same lock, and actually READ on save');
{
  const openLines = (html.match(/const multiCollector = [\s\S]*?_cashCollectorLocked\(\);/) || [])[0];
  t('the multi opener lines were found', !!openLines);
  const openMulti = (list, session, isAdmin) => {
    const sel = makeSelect();
    new Function('DB', 'document', 'session', 'Auth', `${helperSrc}\n${openLines}`)(
      { getUsers: () => list }, { getElementById: () => sel }, session, { isAdmin: () => isAdmin });
    return sel;
  };
  const a = openMulti(TEAM, { username: 'aing' }, false);
  t('aing: no test, not locked', !values(a.innerHTML).includes('test') && a.disabled === false && a.value === 'aing');
  const j = openMulti(TEAM, { username: 'joe' }, true);
  t('joe (admin): sees test', values(j.innerHTML).includes('test') && j.disabled === false);
  const x = openMulti(TEAM, { username: 'test' }, false);
  t('test: only themselves, locked', values(x.innerHTML).join(',') === 'test' && x.disabled === true);

  t('the old hard-coded session.username assignment is gone',
    !/cashCollector:\s*_multiCurTab === 'cash' \? session\.username : ''/.test(html));
  const m = html.match(/cashCollector:\s*(_multiCurTab === 'cash'\s*\n?\s*\?[^,]*?: ''),/);
  t('the multi save expression was found', !!m, m ? m[1].replace(/\s+/g, ' ') : 'NOT FOUND');
  const evalWith = (tab, picked) => new Function('_multiCurTab', 'document', 'session', `return ${m[1]};`)(
    tab, { getElementById: () => ({ value: picked }) }, { username: 'joe' });
  t('a cash multi-payment saves the PICKED receiver', evalWith('cash', 'aing') === 'aing');
  t('an empty box falls back to the logged-in user', evalWith('cash', '') === 'joe');
  t('a non-cash multi-payment stores no receiver', evalWith('transfer', 'aing') === '');
}

// ── users.html — where the admin sets it ────────────────────────────────────────────
console.log('\nusers.html — the admin switch');
{
  t('the form has the แสดงในรายชื่อผู้รับเงินสด switch', /id="uCashReceiver"/.test(users));
  const openSrc = sliceBalanced(users, 'function openModal(id) {');
  t('editing: an existing user with no flag reads as SHOWN',
    /uCashReceiver'\)\.checked = u\.cashReceiver !== false/.test(openSrc));
  t('adding: a new user starts SHOWN', /uCashReceiver'\)\.checked = true/.test(openSrc));
  const saveSrc = sliceBalanced(users, 'async function saveUser() {');
  t('saveUser reads the switch', /const cashReceiver = document\.getElementById\('uCashReceiver'\)\.checked/.test(saveSrc));
  t('and writes it on both add and edit (both are built from `data`)',
    /const data = \{[^}]*\bcashReceiver\b[^}]*\}/.test(saveSrc) && /\.\.\.data/.test(saveSrc) &&
    /DB\.updateUser\(id, data\)/.test(saveSrc));
  t('users.html is admin-only', /if \(!Auth\.isAdmin\(\)\)/.test(users));
}

console.log('\nusers.html — the table stays aligned');
{
  const head = (users.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/) || [])[1] || '';
  const cols = (head.match(/<th\b/g) || []).length;
  const span = +((users.match(/<td colspan="(\d+)"[^>]*>ยังไม่มีผู้ใช้/) || [])[1] || 0);
  t('there is a รับเงินสด column', /<th[^>]*>รับเงินสด<\/th>/.test(head));
  t('the empty-state row spans every column', cols === span, `th=${cols} colspan=${span}`);
  t('a hidden user shows the eye-slash marker', /u\.cashReceiver === false\s*\n?\s*\?\s*'<i class="bi bi-eye-slash/.test(users));
}

console.log('\nthe audit trail is untouched');
{
  t('single-invoice payments still record createdByUser from the session',
    /createdByUser:\s*session\.username/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
