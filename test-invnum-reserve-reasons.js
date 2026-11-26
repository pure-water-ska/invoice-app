// test-invnum-reserve-reasons.js — v1.0.269
//
// The user hit "เลขที่ 251169-005 / -006 ตรวจแล้วว่าว่าง แต่ไม่ได้ถูกจอง: atomic returned
// null". A number checked free but never RESERVED is the dangerous shape: another device
// can legitimately be handed the same one, which is exactly how four numbers collided
// before. reserveFreeInvoiceNumber only READS; only the transaction advances inv_counters.
//
// Five different conditions returned a bare null and the caller logged all of them as the
// same four words. Those five need five different fixes — Firestore rules, connectivity, a
// missing transaction API, a failed floor read, or plain contention — so the log said
// nothing actionable. Worse, the real Firebase error went only to console.warn, invisible
// in a release Tauri build: the "swallowed error blinds every probe above it" trap from
// this project's own troubleshooting notes, which had just cost five releases on the print
// bug.
//
// This release is diagnostic only. Every fallback behaves exactly as before; the failure
// now names itself and carries the Firebase error code.
//
// Run: node test-invnum-reserve-reasons.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const syncSrc = read('sync.js');
const createSrc = read('invoice-create.html');
const settingsJs = read('settings.js');
const settingsHtml = read('settings.html');
const codeOf = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── lift the two real methods out of sync.js ────────────────────────────────
// Each is an object method at indent 2, ending at a line that is exactly "  },".
function method(name) {
  const lines = syncSrc.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith('  ' + name + '(') || l.startsWith('  async ' + name + '('));
  if (start < 0) throw new Error('method not found: ' + name);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) { if (lines[i] === '  },') { end = i; break; } }
  if (end < 0) throw new Error('end of method not found: ' + name);
  return lines.slice(start, end + 1).join('\n').replace(/,\s*$/, '');
}
const S = new Function('console',
  'return {' + method('_serverMaxRunForPrefix') + ',' + method('reserveInvoiceNumberAtomic') + '};'
)({ warn() {}, log() {} });

// A Sync-like host. Everything the two methods touch, and nothing else.
function host(over) {
  return Object.assign({
    ready: true,
    _deviceId: 'dev1',
    _lastFloorWhy: '',
    _lastAtomicWhy: '',
    _db: { runTransaction: async fn => fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {} }) },
    _orgRef: () => ({ collection: () => ({ doc: () => ({}), where() { return this; }, get: async () => ({ docs: [] }) }) }),
    _serverMaxRunForPrefix: S._serverMaxRunForPrefix,
    reserveInvoiceNumberAtomic: S.reserveInvoiceNumberAtomic,
  }, over || {});
}

(async () => {

section('every way of failing now names itself');
{
  // The point of the release. Each of these was "atomic returned null".
  const notReady = host({ ready: false });
  t('sync not ready', await notReady.reserveInvoiceNumberAtomic('251126', '261169-') === null
    && /not ready/.test(notReady._lastAtomicWhy), notReady._lastAtomicWhy);

  const noDb = host({ _db: null });
  await noDb.reserveInvoiceNumberAtomic('251126', '261169-');
  t('no firestore handle', /no firestore handle/.test(noDb._lastAtomicWhy), noDb._lastAtomicWhy);

  const noKey = host();
  await noKey.reserveInvoiceNumberAtomic('', '261169-');
  t('missing dateKey', /no dateKey/.test(noKey._lastAtomicWhy), noKey._lastAtomicWhy);

  const noPrefix = host();
  await noPrefix.reserveInvoiceNumberAtomic('251126', '');
  t('missing prefix', /no prefix/.test(noPrefix._lastAtomicWhy), noPrefix._lastAtomicWhy);

  // If this ever fires it means the reservation has NEVER worked on that device — the
  // single most important thing to be able to tell apart, per the standing note that
  // the atomic path was never verified against live Firestore.
  const noTx = host({ _db: {} });
  await noTx.reserveInvoiceNumberAtomic('251126', '261169-');
  t('runTransaction missing is called out as permanent',
    /runTransaction unavailable/.test(noTx._lastAtomicWhy), noTx._lastAtomicWhy);

  // All five must be DIFFERENT strings, or naming them achieved nothing.
  const reasons = [notReady, noDb, noKey, noPrefix, noTx].map(h => h._lastAtomicWhy);
  t('the five reasons are all distinct', new Set(reasons).size === 5, reasons);
}

section('the Firebase error code survives, because it names the fix');
{
  const mk = code => host({
    _db: { runTransaction: async () => { const e = new Error('nope'); e.code = code; throw e; } },
  });
  // permission-denied → rules; unavailable → connectivity; aborted → contention.
  for (const code of ['permission-denied', 'unavailable', 'aborted', 'failed-precondition']) {
    const h = mk(code);
    const r = await h.reserveInvoiceNumberAtomic('251126', '261169-');
    t('transaction ' + code + ' is reported verbatim',
      r === null && h._lastAtomicWhy.indexOf(code) >= 0, h._lastAtomicWhy);
  }
  const noCode = host({ _db: { runTransaction: async () => { throw new Error('bare'); } } });
  await noCode.reserveInvoiceNumberAtomic('251126', '261169-');
  t('an error with no code still reports something', /transaction failed/.test(noCode._lastAtomicWhy),
    noCode._lastAtomicWhy);
  // Messages are capped: wt_errors is a 200-entry ring and one stack trace could eat it.
  const huge = host({ _db: { runTransaction: async () => { throw new Error('x'.repeat(900)); } } });
  await huge.reserveInvoiceNumberAtomic('251126', '261169-');
  t('the message is truncated', huge._lastAtomicWhy.length < 200, huge._lastAtomicWhy.length);
}

section('a failed floor read is distinguishable from a failed write');
{
  // This is the subtle one. _serverMaxRunForPrefix uses { source: 'server' }, so it fails
  // when the server is unreachable — while reserveFreeInvoiceNumber can still "verify"
  // from cache. That combination is what produces a number checked free but unreserved,
  // and the two causes need opposite responses.
  const h = host({
    _orgRef: () => ({ collection: () => ({ where() { return this; },
      get: async () => { const e = new Error('offline'); e.code = 'unavailable'; throw e; } }) }),
  });
  const r = await h.reserveInvoiceNumberAtomic('251126', '261169-');
  t('it fails', r === null);
  t('…and says the floor was the problem', /no server floor/.test(h._lastAtomicWhy), h._lastAtomicWhy);
  t('…carrying the read error code, not the write path', /unavailable/.test(h._lastAtomicWhy));
  t('…and the floor reason is recorded separately too', /server read unavailable/.test(h._lastFloorWhy),
    h._lastFloorWhy);

  const notReady = host({ ready: false });
  await notReady._serverMaxRunForPrefix('261169-');
  t('the floor read reports its own early exits', /not ready/.test(notReady._lastFloorWhy),
    notReady._lastFloorWhy);
}

section('success still works, and leaves no stale reason behind');
{
  // A reason left over from an earlier failure would be reported against a later success.
  const h = host({ _lastAtomicWhy: 'stale from last time' });
  const r = await h.reserveInvoiceNumberAtomic('251126', '261169-');
  t('a number comes back', r && r.number === '261169-001', r);
  t('…with its run', r && r.run === 1);
  t('the stale reason is cleared', h._lastAtomicWhy === '', h._lastAtomicWhy);

  // The floor is respected: a server already at 7 must not reissue 001.
  const h2 = host({
    _orgRef: () => ({ collection: () => ({ where() { return this; },
      get: async () => ({ docs: [{ data: () => ({ invoiceNumber: '261169-007' }) }] }),
      doc: () => ({}) }) }),
  });
  const r2 = await h2.reserveInvoiceNumberAtomic('251126', '261169-');
  t('it never reissues below the server floor', r2 && r2.run === 8, r2);
}

section('the caller reports the reason instead of swallowing it');
{
  t('the old useless string is gone', !/'atomic returned null'/.test(codeOf(createSrc)));
  t('the named reason is used', /atomic: ' \+ \(Sync\._lastAtomicWhy/.test(createSrc));
  t('…with a fallback if nothing was recorded', /no reason recorded/.test(createSrc));
  // The reason already flows into wt_errors and the on-screen warning; this is what
  // makes naming it worth anything.
  t('it reaches the error log', /INV-NUMBER-NOT-RESERVED/.test(createSrc));
  t('…and the on-screen warning', /จองไม่สำเร็จ/.test(createSrc));
  t('console.warn is not the only channel any more',
    /_lastAtomicWhy = why/.test(syncSrc) && /_lastFloorWhy = 'server read/.test(syncSrc));
}

section('ตรวจจองเลขที่ — an active probe, not a passive report');
{
  // Passive state reports show WHAT, not WHY. The ตรวจ HDD round-trip is what finally
  // surfaced the fs scope bug after eight passive fixes missed it; this follows it.
  t('the button exists', /onclick="runInvNumCheck\(\)"/.test(settingsHtml));
  t('…in the health-check card next to ตรวจ HDD',
    settingsHtml.indexOf('runInvNumCheck()') > settingsHtml.indexOf('runHddCheck()'));
  t('the handler exists', /async function runInvNumCheck\(\)/.test(settingsJs));

  const fn = settingsJs.slice(settingsJs.indexOf('async function runInvNumCheck'),
                              settingsJs.indexOf('async function runHddCheck'));
  // It must exercise the real rules path — same collection — but never move a real
  // counter, or diagnosing would itself consume an invoice number.
  t('it writes to the real inv_counters collection', /collection\('inv_counters'\)/.test(fn));
  t('…but only to a probe key', /doc\('__probe'\)/.test(fn));
  t('…and never to a real dateKey', !/doc\(dateKey\)/.test(fn));
  t('it marks the doc as a probe', /probe: true/.test(fn));
  t('it actually runs a transaction, not just a read', /runTransaction/.test(fn));
  t('it tests the floor read too', /_serverMaxRunForPrefix/.test(fn));
  t('it reports whether runTransaction even exists', /runTransaction: '/.test(fn));

  // The summary must map a code to an action, or the user is left holding a code.
  t('permission-denied is explained as a rules problem',
    /permission-denied/.test(fn) && /rules/.test(fn));
  t('unavailable is explained as connectivity', /unavailable\|failed-precondition/.test(fn));
  t('…and why the free-check still passes in that case', /cache/.test(fn));
  t('a clean result says so plainly', /ทำงานได้ตามปกติ/.test(fn));
  t('it paints progressively, so a hang is visible', (fn.match(/paint\(\)/g) || []).length >= 5);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})();
