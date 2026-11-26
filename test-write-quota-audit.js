// test-write-quota-audit.js — v1.0.270
//
// On 26 Nov 2026 ตรวจจองเลขที่ returned "transaction resource-exhausted: Quota exceeded."
// The Spark free tier allows 20,000 Firestore WRITES/day; reads were unaffected, which is
// exactly why only the write path broke — and why 251169-005 and -006 went out on numbers
// that were checked free but never reserved, the shape that duplicated four numbers once
// before.
//
// Reading the code could not find where the writes went. Every candidate costed out
// cheap: pricing batches 3,279 rules into ~32 product docs; delta sync seeds its
// fingerprints from the whole local array, so it does not re-push; the per-record modules
// diff before writing; the activity/login/error logs are NO_SYNC. Modelled normal use is
// TENS of writes a day, not 20,000. The Firebase console only reports a daily aggregate —
// no per-collection breakdown, and it does not attribute onSnapshot traffic at all.
//
// So the count has to come from the client. Sync.countWrite is called at every commit
// site with the number of OPS, not the number of commits — a batch of 300 set() calls is
// 300 writes against the quota, and counting commits would have under-reported by exactly
// the factor that matters.
//
// Run: node test-write-quota-audit.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const codeOf = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const syncSrc = read('sync.js');
const settingsJs = read('settings.js');
const settingsHtml = read('settings.html');

// ── the real counter, lifted from sync.js ───────────────────────────────────
function counter() {
  const lines = syncSrc.split(/\r?\n/);
  const grab = (name) => {
    const start = lines.findIndex(l => l.startsWith('  ' + name + '('));
    if (start < 0) throw new Error('not found: ' + name);
    // _wstatsToday is a one-liner. Scanning for a later "  }," swallowed the NEXT method
    // too, which produced a duplicate object key — legal JS, so it ran and the mistake
    // stayed invisible until the same helper was used in a browser.
    if (/\},?\s*$/.test(lines[start]) && lines[start].includes('{')) {
      return lines[start].trim().replace(/,\s*$/, '');
    }
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) { if (lines[i] === '  },') { end = i; break; } }
    if (end < 0) throw new Error('end not found: ' + name);
    return lines.slice(start, end + 1).join('\n').replace(/,\s*$/, '');
  };
  const body = [grab('_wstatsToday'), grab('_loadWstats'), grab('countWrite')].join(',');
  const writes = [];
  const DB = {
    _getArray: () => null,
    setLocalOnly: (k, v) => writes.push(k),
    _set: (k) => { throw new Error('countWrite must never call DB._set — that pushes to Firestore (' + k + ')'); },
  };
  const o = new Function('DB', 'setTimeout', 'return {_wstats:null,_wstatsDirty:false,' + body + '};')(
    DB, (fn) => { fn(); return 1; });
  return { o, writes };
}

section('it counts OPS, not commits');
{
  const { o } = counter();
  o.countWrite('invoices', 300);
  const day = o._wstatsToday();
  t('a 300-op batch counts as 300', o._wstats[day].invoices === 300, o._wstats[day]);
  t('…and lands in the total', o._wstats[day]._total === 300);
  o.countWrite('invoices', 5);
  t('counts accumulate', o._wstats[day].invoices === 305);
  o.countWrite('pdf_pages', 1);
  t('labels are kept apart', o._wstats[day].pdf_pages === 1 && o._wstats[day].invoices === 305);
  t('…and the total spans labels', o._wstats[day]._total === 306);
}

section('counting must never itself cause a write');
{
  // The circular trap: a counter that syncs makes every measurement cost a write, which
  // on a day like 26 Nov would deepen the very problem it is measuring.
  const { o, writes } = counter();
  o.countWrite('invoices', 1);          // the lifted setTimeout runs the flush inline
  t('it persists via setLocalOnly, which never pushes', writes.length === 1 && writes[0] === 'wt_write_stats', writes);
  // DB._set in the stub throws, so reaching it would have failed the call above.
  t('…and never via DB._set', true);
  t('the key is in Sync.NO_SYNC', /'wt_write_stats',/.test(codeOf(syncSrc).slice(
    codeOf(syncSrc).indexOf('NO_SYNC: new Set(['), codeOf(syncSrc).indexOf('NO_SYNC: new Set([') + 400)));
  t('…and registered in DB.K', /WRITE_STATS:\s+'wt_write_stats'/.test(read('db.js')));
}

section('bad input cannot corrupt the tally');
{
  const { o } = counter();
  const day = o._wstatsToday();
  o.countWrite('x', 0); o.countWrite('x', -5); o.countWrite('x', null); o.countWrite('x', undefined);
  // Bad input returns BEFORE the store is even loaded, so _wstats stays null — which is
  // the strongest form of "ignored": no day bucket is created at all.
  t('zero, negative and missing counts are ignored',
    o._wstats === null || !o._wstats[day] || !o._wstats[day].x, o._wstats);
  o.countWrite('x', 2);
  t('…and a real count still registers', o._wstats[day].x === 2);
}

section('history is bounded');
{
  const { o } = counter();
  o._loadWstats();   // the store is lazy, so materialise it before seeding history
  for (let i = 1; i <= 30; i++) o._wstats['2026-11-' + String(i).padStart(2, '0')] = { _total: i };
  o.countWrite('y', 1);
  t('at most a fortnight is kept', Object.keys(o._wstats).length <= 14, Object.keys(o._wstats).length);
  t('…and the oldest days are the ones dropped',
    !o._wstats['2026-11-01'] && Object.keys(o._wstats).sort()[0] > '2026-11-10');
}

section('every path that writes to Firestore is counted');
{
  // A missed site is worse than no counter: the report would exonerate the real culprit.
  const files = {
    'sync.js': ['invoices:sweep-delete', 'doc:', 'colName, ops', 'pull-repush', 'push-missing',
                'invoices:edit-delete', 'inv_counters'],
    'collection-sync.js': [':dedup', 'this.cfg.col, ops'],
    'customer-sync.js': ['customers_v2:dedup', "'customers_v2', ops"],
    'pricing-grouped-sync.js': ['pricing_byproduct'],
    'image-store.js': ["'images', 1", 'images:delete', 'images:recover'],
    'invoice-create.html': ['pdf_pages'],
    'settings.js': ['admin:'],
  };
  for (const [f, labels] of Object.entries(files)) {
    const src = read(f);
    for (const l of labels) {
      t(f + ' counts ' + l, src.includes('countWrite(') && src.includes(l), undefined);
    }
  }

  // A BATCH site must pass the op count, never a literal 1. Passing 1 makes a 300-write
  // batch report as a single write — under-reporting by exactly the factor the audit
  // exists to measure, while every arithmetic test still passes. A mutation that changed
  // `countWrite(colName, ops)` to `countWrite(colName, 1)` went undetected until this.
  // Sites that genuinely write one document (a DOCUMENT, an image, a pdf page, the
  // counter transaction) legitimately pass 1, so this checks only the batch paths.
  const batchFiles = ['sync.js', 'collection-sync.js', 'customer-sync.js', 'pricing-grouped-sync.js', 'settings.js'];
  const OPCOUNT = /countWrite\([^,]+,\s*(ops|n|chunk\.length|ids\.length|upserts\.length|recs\.length)\s*\)/;
  for (const f of batchFiles) {
    const src = codeOf(read(f));
    // Every countWrite that sits on the same line as a batch.commit() is a batch site.
    const batchLines = src.split(/\r?\n/).filter(l => /batch\.commit\(\)/.test(l) && /countWrite\(/.test(l));
    t(f + ': batch sites pass an op count, not 1',
      batchLines.length > 0 && batchLines.every(l => OPCOUNT.test(l)),
      batchLines.filter(l => !OPCOUNT.test(l)).map(l => l.trim().slice(0, 90)));
  }
  // And the single-doc sites must NOT claim a batch's worth.
  t('single-document sites count exactly 1',
    /countWrite\('doc:' \+ docName, 1\)/.test(syncSrc) &&
    /countWrite\('inv_counters', 1\)/.test(syncSrc) &&
    /countWrite\('images', 1\)/.test(read('image-store.js')) &&
    /countWrite\('pdf_pages', 1\)/.test(read('invoice-create.html')));

  // Count the commit sites and the counted sites, so a NEW commit site added without a
  // counter shows up here rather than silently skewing the report.
  const commitSites = (f) => (codeOf(read(f)).match(/batch\.commit\(\)/g) || []).length;
  const counted = (f) => (codeOf(read(f)).match(/countWrite\(/g) || []).length;
  for (const f of ['sync.js', 'collection-sync.js', 'customer-sync.js', 'pricing-grouped-sync.js']) {
    t(f + ': a counter for every commit', counted(f) >= commitSites(f),
      { commits: commitSites(f), counted: counted(f) });
  }
}

section('the report reads, and never writes');
{
  t('the button exists', /onclick="runWriteStatsCheck\(\)"/.test(settingsHtml));
  t('it sits with the other checks', settingsHtml.indexOf('runWriteStatsCheck()') > settingsHtml.indexOf('runHddCheck()'));
  const fn = settingsJs.slice(settingsJs.indexOf('function runWriteStatsCheck'),
                              settingsJs.indexOf('// ── ตรวจจองเลขที่'));
  t('the handler exists', fn.length > 200, fn.length);
  // A diagnostic that writes would be self-defeating on a quota-exhausted day.
  t('it performs no Firestore write', !/\.set\(|\.commit\(|runTransaction|countWrite\(/.test(codeOf(fn)));
  t('it states the quota so the number means something', /20,000/.test(fn));
  t('it shows the reset time', /_quotaResetAt/.test(fn));
  t('it reports a percentage of quota', /20000 \* 100/.test(fn));
  t('biggest consumer first', /sort\(\(a, b\) => d\[b\] - d\[a\]\)/.test(fn));
  t('…and names it in the summary', /ตัวที่กินมากสุด/.test(fn));
  t('it warns when the quota is full', /เต็มโควต้า/.test(fn));
  // The honest caveat: other devices share the quota and are not counted here.
  t('it says the count is per-device', /เครื่องอื่นใช้โควต้าเดียวกัน/.test(fn));
  t('it says what to do when empty', /ยังไม่มีข้อมูล/.test(fn));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
