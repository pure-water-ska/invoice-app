// test-number-collision-tie.js — v1.0.254
//
// Scenario reported by the user: device A is ONLINE but its uploads are stuck. It saves
// an invoice, PRINTS it, hands it to the customer. Device B then creates an invoice and
// uploads fine — and gets the SAME number.
//
// Why that happens, and why it is silent:
//   reserveInvoiceNumberAtomic is a Firestore TRANSACTION — a write. A device that cannot
//   write fails it and returns null. reserveFreeInvoiceNumber only READS (sync.js says so
//   itself), finds the number free, and returns verified:true. So the save lands on
//   _numSource 'checked', which warned about nothing — QUIETER than being fully offline,
//   which does warn. Nothing advanced inv_counters, A's invoice never reached the server,
//   so B's atomic floor could not see it and B was handed the same number.
//
// Two fixes, both covered here:
//   1. settings.js lookupInvoiceNumber must not PRE-TICK an editCount tie for deletion.
//      Both records are editCount 0 for the same customer and page: neither is a previous
//      version of the other, and one of them is on paper. The old code labelled whichever
//      came back second "เก่า/ซ้ำ" and ticked it, under a caption asserting it was a
//      failed-delete edit page — the same mistake the v1.0.246 sweep incident was about.
//   2. invoice-create.html must warn when the number was only CHECKED, not reserved.
//
// Run: node test-number-collision-tie.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const settings = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
const create   = fs.readFileSync(path.join(__dirname, 'invoice-create.html'), 'utf8');
const sync     = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');

// ── run the REAL grouping logic out of lookupInvoiceNumber ─────────────────
// Lifted rather than restated: the point is that the shipped classifier behaves, not
// that a copy of it does.
const block = (() => {
  const a = settings.indexOf('  const byGroup = new Map();');
  const b = settings.indexOf('  const staleCount =', a);
  const end = settings.indexOf('\n', b);
  if (a < 0 || b < 0) throw new Error('lookupInvoiceNumber grouping block not found');
  return settings.slice(a, end);
})();
const classify = new Function('docs', block + '\n return { currentIds, tiedIds, staleCount };');

const doc = (id, cust, edit, total, page) =>
  ({ id, by: 'dev-' + id, ts: 1, rec: { customerId: cust, page: page || 1, editCount: edit, totalAmount: total } });

section('the reported case: two devices, same number, same customer');
{
  // A printed its copy; B uploaded first. Both editCount 0.
  const r = classify([doc('B-rec', 'C1', 0, 7000), doc('A-rec', 'C1', 0, 5000)]);
  t('neither is called the current one', r.currentIds.size === 0, [...r.currentIds]);
  t('both are flagged as an undecidable duplicate', r.tiedIds.size === 2, [...r.tiedIds]);
  t('nothing is counted as stale, so nothing is pre-ticked',
    r.staleCount === 0, r.staleCount);
}

section('a genuine failed-delete edit page is still caught');
{
  // This is what the tool was built for: an edit wrote E1 and the delete of E0 failed.
  const r = classify([doc('old', 'C1', 0, 5000), doc('new', 'C1', 1, 6000)]);
  t('the edited record is the current one', r.currentIds.has('new') && r.currentIds.size === 1);
  t('the superseded page is stale, and pre-ticked', r.staleCount === 1);
  t('…and is not treated as an undecidable tie', r.tiedIds.size === 0);
}

section('ordinary invoices are untouched');
{
  const one = classify([doc('solo', 'C1', 0, 100)]);
  t('a single record is simply current', one.currentIds.size === 1 && one.staleCount === 0 && one.tiedIds.size === 0);

  // A real multi-page invoice shares a number by design — different pages, so different
  // groups. Flagging it would make the tool cry wolf on every long invoice.
  const multi = classify([doc('p1', 'C1', 0, 100, 1), doc('p2', 'C1', 0, 100, 2)]);
  t('a two-page invoice is two current records, no tie',
    multi.currentIds.size === 2 && multi.tiedIds.size === 0 && multi.staleCount === 0);

  // A cross-customer collision is a different shape and already had its own handling.
  const cross = classify([doc('x', 'C1', 0, 100), doc('y', 'C2', 0, 200)]);
  t('two customers on one number are separate groups, not a tie',
    cross.currentIds.size === 2 && cross.tiedIds.size === 0);
}

section('a tie among three, with one proven older');
{
  const r = classify([doc('a', 'C1', 1, 10), doc('b', 'C1', 1, 20), doc('c', 'C1', 0, 30)]);
  t('the two at the top tie', r.tiedIds.size === 2 && r.tiedIds.has('a') && r.tiedIds.has('b'));
  t('the one strictly below is still stale', r.staleCount === 1);
  t('…and nothing is marked current', r.currentIds.size === 0);
}

section('the UI never pre-ticks a tie');
{
  t('the checkbox is unticked for current AND tied rows',
    /data-id="\$\{esc\(d\.id\)\}" \$\{\(isCurrent \|\| isTied\) \? '' : 'checked'\}/.test(settings));
  t('a tie gets its own badge, not "เก่า/ซ้ำ"', /ซ้ำ — ต้องตรวจสอบ/.test(settings));
  t('…and its own row colour', /isTied \? ' style="background:#fff3cd"'/.test(settings));
  // The old caption asserted these rows were failed-delete edit pages. For a tie that is
  // a false claim about a real invoice.
  t('the stale caption is shown only when something is really stale',
    /\$\{staleCount \? `<div class="small mt-2 p-2 rounded" style="background:#fdece9/.test(settings));
  t('the tie caption warns that one copy may already be printed',
    /พิมพ์ให้ลูกค้าไปแล้ว/.test(settings));
  t('…and points at the renumber button rather than deletion',
    /เปลี่ยนเลขที่ในหน้ารายการใบกำกับ/.test(settings));
  t('a tie makes the verdict red', /owners\.length > 1 \|\| tiedIds\.size\) \? 'danger'/.test(settings));
  t('tiedIds is computed before the verdict reads it',
    settings.indexOf('const tiedIds') < settings.indexOf("const cls = (!docs.length)"));
}

section('saving warns when the number was checked but never reserved');
{
  t('sync.js still says the read-only path only checks',
    /reserveFreeInvoiceNumber\(\) only \*checks\*/.test(sync));
  // If this ever starts writing the counter, the warning below becomes wrong.
  t('only the atomic path advances inv_counters',
    (sync.match(/collection\('inv_counters'\)/g) || []).length === 1);

  t('the checked path now warns', /_numSource === 'checked'/.test(create));
  t('…with its own error code for the log', /INV-NUMBER-NOT-RESERVED/.test(create));
  t('…and an activity entry', /ออกเลขที่โดยไม่ได้จองกับเซิร์ฟเวอร์/.test(create));
  t('the message says the reservation failed, not that the number is bad',
    /จองไม่สำเร็จ/.test(create));
  t('…and tells the user to upload before printing', /อัปโหลดให้ขึ้นก่อนพิมพ์ให้ลูกค้า/.test(create));
  // The fully-offline case must keep its own, different warning.
  t('the local-only warning still exists separately',
    /INV-NUMBER-UNVERIFIED/.test(create) && /_numSource === 'local'/.test(create));
  t('the two warnings are distinct code paths',
    create.indexOf("_numSource === 'checked'") < create.indexOf("if (_numSource === 'local')"));
  t('a reason is always printed, never an empty parenthesis',
    /_numWhy\.join\('; '\) \|\| 'จองแบบ atomic ไม่สำเร็จ'/.test(create));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
