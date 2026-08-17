// test-brand-reorder.js — run:  node test-brand-reorder.js
//
// Covers customers.html's brand-reorder feature: moveBrand()/_brandDrop() (persisted,
// card view) and moveModalBrand()/_modalBrandDrop() (in-memory, the customer edit
// modal). Two interaction paths reach the same reorder: click ‹ › (works on any
// device) or native HTML5 drag (desktop-mouse only — never fires on touch, so the
// buttons are never optional, just the drag path is additive).
//
// Extracts the ACTUAL functions from customers.html and drives them with a stub DB —
// not a reimplementation.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'customers.html'), 'utf8');

function extract(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(start, end);
}

// Line-based extraction — robust against exact-whitespace drift in the source, unlike
// matching a full function body verbatim as an end marker. Finds the FIRST bare "}"
// line (a lone closing brace) at or after a function's declaration line — reliable
// for this file's consistent 2-space, one-function-per-block formatting.
const lines = src.split(/\r?\n/);
function extractLines(startMarker, endMarkerLine) {
  const startIdx = lines.findIndex(l => l.includes(startMarker));
  if (startIdx < 0) throw new Error(`marker not found: ${startMarker}`);
  let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(endMarkerLine));
  if (endIdx < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarkerLine}`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}
function extractFunctionsUpTo(startMarker, lastFunctionDeclLine) {
  const startIdx = lines.findIndex(l => l.includes(startMarker));
  if (startIdx < 0) throw new Error(`marker not found: ${startMarker}`);
  const declIdx = lines.findIndex((l, i) => i >= startIdx && l.includes(lastFunctionDeclLine));
  if (declIdx < 0) throw new Error(`decl not found after ${startMarker}: ${lastFunctionDeclLine}`);
  const closeIdx = lines.findIndex((l, i) => i > declIdx && l === '}');
  if (closeIdx < 0) throw new Error(`closing brace not found after ${lastFunctionDeclLine}`);
  return lines.slice(startIdx, closeIdx + 1).join('\n');
}

// ── Persisted (card view) path ──────────────────────────────────────────────────
function harnessPersisted() {
  const calls = { updateCustomer: [], logActivity: [], renders: 0 };
  const DB = {
    getCustomerById: id => harnessPersisted._customers.find(c => c.id === id),
    updateCustomer: (id, patch) => {
      calls.updateCustomer.push({ id, patch });
      const c = harnessPersisted._customers.find(x => x.id === id);
      Object.assign(c, patch);
    },
    logActivity: (uid, uname, action, details) => { calls.logActivity.push({ action, details }); },
  };
  const session = { userId: 'u1', username: 'joe' };
  const render = () => { calls.renders++; };
  const getBrandsSrc = extractFunctionsUpTo('function getBrands(c) {', 'function getBrands(c) {');
  const moveBrandSrc = extractFunctionsUpTo('function moveBrand(custId, idx, dir, e) {', 'function moveBrand(custId, idx, dir, e) {');
  const dragSrc = extractFunctionsUpTo('let _brandDragFrom = null;', 'function _brandDragEnd(e) {');
  const fn = new Function('DB', 'session', 'render', `
    ${getBrandsSrc}
    ${moveBrandSrc}
    ${dragSrc}
    return { moveBrand, _brandDragStart, _brandDrop, getBrandState: () => _brandDragFrom };
  `);
  const api = fn(DB, session, render);
  return { DB, calls, api };
}

function fakeEvent() {
  const cls = new Set();
  return {
    stopPropagation() {},
    preventDefault() {},
    dataTransfer: { effectAllowed: '', dropEffect: '', setData() {} },
    currentTarget: { classList: { add: c => cls.add(c), remove: c => cls.delete(c), has: c => cls.has(c) } },
  };
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

console.log('moveBrand(): swaps with the left neighbor and updates the primary brand field');
{
  const { DB, calls, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', name: 'ลูกค้า A', brands: ['สิงห์', 'ช้าง', 'ลีโอ'] }];
  api.moveBrand('c1', 1, -1, fakeEvent()); // move ช้าง left, past สิงห์
  const c = DB.getCustomerById('c1');
  t('order updated correctly', JSON.stringify(c.brands) === JSON.stringify(['ช้าง', 'สิงห์', 'ลีโอ']), JSON.stringify(c.brands));
  t('primary brand field follows the new first element', c.brand === 'ช้าง');
  t('activity logged', calls.logActivity.length === 1, JSON.stringify(calls.logActivity));
  t('render triggered', calls.renders === 1);
}

console.log('\nmoveBrand(): swaps with the right neighbor');
{
  const { DB, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['สิงห์', 'ช้าง', 'ลีโอ'] }];
  api.moveBrand('c1', 0, 1, fakeEvent());
  t('สิงห์ and ช้าง swapped', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['ช้าง', 'สิงห์', 'ลีโอ']));
}

console.log('\nmoveBrand(): boundary — first tag cannot move further left');
{
  const { DB, calls, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['สิงห์', 'ช้าง'] }];
  api.moveBrand('c1', 0, -1, fakeEvent());
  t('array unchanged', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['สิงห์', 'ช้าง']));
  t('no update call made (real UI also disables the button here)', calls.updateCustomer.length === 0);
}

console.log('\nmoveBrand(): boundary — last tag cannot move further right');
{
  const { DB, calls, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['สิงห์', 'ช้าง'] }];
  api.moveBrand('c1', 1, 1, fakeEvent());
  t('array unchanged', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['สิงห์', 'ช้าง']));
  t('no update call made', calls.updateCustomer.length === 0);
}

console.log('\ndrag-drop: moving from index 0 to index 2 (not just an adjacent swap)');
{
  const { DB, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['A', 'B', 'C', 'D'] }];
  api._brandDragStart(fakeEvent(), 'c1', 0);
  api._brandDrop(fakeEvent(), 'c1', 2);
  t('A moved to position 2, others shifted left', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['B', 'C', 'A', 'D']),
    JSON.stringify(DB.getCustomerById('c1').brands));
}

console.log('\ndrag-drop: dropping on the same index is a no-op');
{
  const { DB, calls, api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['A', 'B', 'C'] }];
  api._brandDragStart(fakeEvent(), 'c1', 1);
  api._brandDrop(fakeEvent(), 'c1', 1);
  t('array unchanged', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['A', 'B', 'C']));
  t('no update call made', calls.updateCustomer.length === 0);
}

console.log('\ndrag-drop: dropping onto a DIFFERENT customer\'s tag is rejected');
{
  const { DB, calls, api } = harnessPersisted();
  harnessPersisted._customers = [
    { id: 'c1', brands: ['A', 'B'] },
    { id: 'c2', brands: ['X', 'Y'] },
  ];
  api._brandDragStart(fakeEvent(), 'c1', 0);
  api._brandDrop(fakeEvent(), 'c2', 1); // dragged from c1, dropped on c2's tag
  t('c1 unchanged', JSON.stringify(DB.getCustomerById('c1').brands) === JSON.stringify(['A', 'B']));
  t('c2 unchanged', JSON.stringify(DB.getCustomerById('c2').brands) === JSON.stringify(['X', 'Y']));
  t('drag state cleared regardless', api.getBrandState() === null);
  t('no update call made', calls.updateCustomer.length === 0);
}

console.log('\ndrag-drop: state clears after a successful drop (no stuck drag)');
{
  const { api } = harnessPersisted();
  harnessPersisted._customers = [{ id: 'c1', brands: ['A', 'B', 'C'] }];
  api._brandDragStart(fakeEvent(), 'c1', 0);
  t('state set during drag', api.getBrandState() !== null);
  api._brandDrop(fakeEvent(), 'c1', 2);
  t('state cleared after drop', api.getBrandState() === null);
}

// ── Modal (in-memory) path ───────────────────────────────────────────────────────
function harnessModal(initial) {
  let modalBrands = initial.slice();
  const renders = [];
  const document_ = { getElementById: () => ({ set innerHTML(v) { renders.push(v); } }) };
  const src2 = extractFunctionsUpTo('function renderModalBrands() {', 'function renderModalBrands() {');
  const dragSrc2 = extractFunctionsUpTo('let _modalBrandDragFrom = null;', 'function _modalBrandDragEnd(e) {');
  const fn = new Function('document', 'getModalBrands', 'setModalBrands', `
    let modalBrands = getModalBrands();
    ${src2}
    function moveModalBrand(idx, dir) {
      const j = idx + dir;
      if (j < 0 || j >= modalBrands.length) return;
      [modalBrands[idx], modalBrands[j]] = [modalBrands[j], modalBrands[idx]];
      renderModalBrands();
      setModalBrands(modalBrands);
    }
    ${dragSrc2.replace(/renderModalBrands\(\);/, 'renderModalBrands(); setModalBrands(modalBrands);')}
    return { moveModalBrand, _modalBrandDragStart, _modalBrandDrop, getDragState: () => _modalBrandDragFrom };
  `);
  let current = modalBrands;
  const api = fn(document_, () => current, v => { current = v; });
  return { api, get: () => current };
}

console.log('\nmoveModalBrand(): swaps in the in-memory array (no DB call — modal is pre-save)');
{
  const { api, get } = harnessModal(['สิงห์', 'ช้าง', 'ลีโอ']);
  api.moveModalBrand(1, -1, fakeEvent());
  t('order updated', JSON.stringify(get()) === JSON.stringify(['ช้าง', 'สิงห์', 'ลีโอ']), JSON.stringify(get()));
}

console.log('\nmoveModalBrand(): boundaries are no-ops, same as the persisted path');
{
  const { api, get } = harnessModal(['A', 'B']);
  api.moveModalBrand(0, -1);
  api.moveModalBrand(1, 1);
  t('unchanged', JSON.stringify(get()) === JSON.stringify(['A', 'B']));
}

console.log('\nmodal drag-drop: reorders the in-memory array the same way');
{
  const { api, get } = harnessModal(['A', 'B', 'C', 'D']);
  api._modalBrandDragStart(fakeEvent(), 0);
  api._modalBrandDrop(fakeEvent(), 2);
  t('A moved to position 2', JSON.stringify(get()) === JSON.stringify(['B', 'C', 'A', 'D']), JSON.stringify(get()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
