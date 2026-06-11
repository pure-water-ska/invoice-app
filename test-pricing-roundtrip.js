// Round-trip + write-diff test for pricing-grouped-sync.js helpers.
// Proves: flat array → group → (Firestore doc shape) → flatten → flat array
// preserves every rule and every field, and that the write-diff only touches
// products that actually changed. Run: node test-pricing-roundtrip.js
const { groupByProduct, flattenDocs, fpRules, stripMeta } = require('./pricing-grouped-sync.js');

let pass = 0, fail = 0;
const ok  = (name, cond) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name); };

// Simulate "save to Firestore then read back": group → docs → flatten.
function groupToDocs(arr) {
  const g = groupByProduct(arr);
  return [...g.entries()].map(([pid, rules]) => ({ id: pid, data: { productId: pid, rules, _by: 'devX', _ts: 1 } }));
}
function roundTrip(arr) { return flattenDocs(groupToDocs(arr)); }
const byId = a => Object.fromEntries(a.map(r => [r.id, r]));

// ── Sample data: realistic mix incl. central price, tier, notifiedAt, empty ship,
//    extra unknown fields (must survive), Thai shipping text. ───────────────────
const sample = [
  { id: 'u1', productId: 'P1', customerId: 'C1', shippingMethod: 'จัดส่ง', price: 48, tierQty: 100, tierPrice: 9.5, tierBasis: 'bottle', notifiedAt: '2026-06-10' },
  { id: 'u2', productId: 'P1', customerId: 'C2', shippingMethod: 'รับหน้าโรงงาน', price: 50 },
  { id: 'u3', productId: 'P1', customerId: '',   shippingMethod: '', price: 46 },                 // central price
  { id: 'u4', productId: 'P2', customerId: 'C1', shippingMethod: 'จัดส่ง', price: 12, _legacyFlag: true }, // unknown field
  { id: 'u5', productId: 'P2', customerId: 'C3', shippingMethod: 'ณัฐวุฒิ', price: 13, tierQty: 0, tierPrice: null },
  { id: 'u6', productId: 'P3', customerId: 'C2', shippingMethod: 'จัดส่ง', price: 7.25 },
];

// 1) Round-trip preserves count
const rt = roundTrip(sample);
ok('round-trip count', rt.length === sample.length);

// 2) Round-trip preserves every field of every rule (deep-equal by id)
const A = byId(sample), B = byId(rt);
let allEqual = Object.keys(A).length === Object.keys(B).length;
for (const id in A) if (JSON.stringify(A[id]) !== JSON.stringify(B[id])) { allEqual = false; console.log('   mismatch id=' + id); }
ok('round-trip deep-equal (all fields incl tier/notifiedAt/unknown)', allEqual);

// 3) Grouping count = distinct products
ok('group → 3 product docs', groupByProduct(sample).size === 3);

// 4) Central price (empty customer/ship) survives
ok('central price u3 preserved', JSON.stringify(B['u3']) === JSON.stringify(A['u3']));

// 5) Write-diff: editing one rule marks ONLY its product as changed
const serverFp = new Map([...groupByProduct(sample).entries()].map(([pid, r]) => [pid, fpRules(r)]));
const edited = sample.map(r => r.id === 'u2' ? { ...r, price: 999 } : r);
const localFp = new Map([...groupByProduct(edited).entries()].map(([pid, r]) => [pid, fpRules(r)]));
const changed = [...localFp.keys()].filter(pid => serverFp.get(pid) !== localFp.get(pid));
ok('edit u2 → only P1 dirty', changed.length === 1 && changed[0] === 'P1');

// 6) Write-diff: no change → nothing dirty (idempotent saves don't write)
const same = sample.map(r => ({ ...r }));
const sameFp = new Map([...groupByProduct(same).entries()].map(([pid, r]) => [pid, fpRules(r)]));
const noChange = [...sameFp.keys()].filter(pid => serverFp.get(pid) !== sameFp.get(pid));
ok('re-save identical → 0 writes', noChange.length === 0);

// 7) Delete a rule: product P3 emptied → product removed from groups (doc delete)
const delAll3 = sample.filter(r => r.productId !== 'P3');
const g7 = groupByProduct(delAll3);
const delPids = [...serverFp.keys()].filter(pid => !g7.has(pid));
ok('remove all P3 rules → P3 doc deleted', delPids.length === 1 && delPids[0] === 'P3');

// 8) Delete ONE rule of a 2-rule product: product stays, fp changes
const delU1 = sample.filter(r => r.id !== 'u1');   // P1 keeps u2,u3
const g8 = groupByProduct(delU1);
ok('remove u1 → P1 still present', g8.has('P1') && Object.keys(g8.get('P1')).length === 2);
ok('remove u1 → P1 fp changed', fpRules(g8.get('P1')) !== serverFp.get('P1'));

// 9) fpRules is order-independent (object key order must not matter)
const r1 = { a: { id: 'a', price: 1 }, b: { id: 'b', price: 2 } };
const r2 = { b: { id: 'b', price: 2 }, a: { id: 'a', price: 1 } };
ok('fpRules order-independent', fpRules(r1) === fpRules(r2));

// 10) stripMeta removes _by/_ts but keeps data
ok('stripMeta drops meta only', JSON.stringify(stripMeta({ id: 'x', price: 5, _by: 'd', _ts: 1, _byName: 'n' })) === JSON.stringify({ id: 'x', price: 5 }));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
