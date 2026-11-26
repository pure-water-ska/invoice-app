// test-autoprint-handoff.js — v1.0.265
//
// "บันทึก & พิมพ์" saved and opened the invoice view but produced NO print dialog, on
// the desktop app. Four releases went into this; three of them bisected the wrong
// thing, because the failure was silent and I had mis-read printCount as proof that
// window.print() had been reached. It had not: the manual พิมพ์ button on the same
// page, calling the same doPrint(), works — and it also bumps printCount.
//
// What actually broke: the save path cannot print, it navigates to the view page and
// the view page prints on arrival. That hand-off carried a 30 s TTL, stamped BEFORE a
// 1.5 s navigation delay and a full app boot. On the real device — ~1,000 invoices and
// ~1,175 payments loaded from HDD, plus loadView's own 4 s cache-settle retry, plus
// renderPreview — the budget runs out, the arm is consumed and silently dropped. A
// sandbox build of the SAME code with a handful of records printed fine, which is how
// the timing was identified rather than guessed.
//
// The TTL existed to stop an earlier bug: an arm that never reached its view survived
// the session and fired later on an unrelated save-only edit, recording a print nobody
// asked for. A clock is the wrong instrument for that. The question is "does this arm
// belong to THIS navigation", so the arm now carries a one-shot token that is also in
// the view URL. This suite pins both failures shut at once — they pull in opposite
// directions, which is exactly why a fix for one re-opened the other.
//
// Run: node test-autoprint-handoff.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const utilsSrc = read('utils.js');
const createSrc = read('invoice-create.html');
const listSrc = read('invoices.html');

// ── the real helpers, lifted from utils.js ──────────────────────────────────
// sessionStorage is passed in as a parameter so the lifted closure resolves it.
const store = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
// The slice must start at apTrace, not at armAutoPrint: arming traces itself now, and a
// slice that omitted apTrace threw "this.apTrace is not a function" rather than testing
// anything. `performance` is stubbed because navType reads it.
const traced = [];
const U = (() => {
  const s = utilsSrc.indexOf('apTrace(msg, extra) {');
  const e = utilsSrc.indexOf('// Cross-platform confirm');
  if (s < 0 || e < 0 || e < s) throw new Error('autoprint helpers not found in utils.js');
  const body = utilsSrc.slice(s, e).trim().replace(/,\s*$/, '');
  const fakePerf = { getEntriesByType: () => [{ type: 'navigate' }] };
  const o = new Function('sessionStorage', 'performance', 'DB',
    'return {' + body + '};')(store, fakePerf, { logError: (k, m, x) => traced.push(m) });
  return o;
})();
const tokenOf = url => new URLSearchParams(url.slice(url.indexOf('?'))).get('ap');
const numOf = url => new URLSearchParams(url.slice(url.indexOf('?'))).get('view');
const reset = () => { store._d = {}; };

section('arming produces a URL that carries its own token');
{
  reset();
  const url = U.armAutoPrint('251169-006');
  t('navigates to the view page', url.startsWith('invoice-create.html?view='), url);
  t('the invoice number survives', numOf(url) === '251169-006');
  t('a token is in the URL', !!tokenOf(url) && tokenOf(url).length >= 8);
  t('the arm is stored', !!store.getItem('autoPrint'));
  const armed = JSON.parse(store.getItem('autoPrint'));
  t('the stored token matches the URL', armed.token === tokenOf(url));
  t('the arm records the invoice', armed.num === '251169-006');
  // Two arms must never be mistaken for each other.
  reset();
  const a = tokenOf(U.armAutoPrint('X')), b = tokenOf(U.armAutoPrint('X'));
  t('tokens are unique per arm', a !== b, { a, b });
}

section('the reported bug: a slow boot must NOT lose the print');
{
  // This is the whole point. The old code compared Date.now() against a stamp taken
  // before the navigation and failed closed once the sum passed 30 s.
  reset();
  const url = U.armAutoPrint('251169-006');
  const armed = JSON.parse(store.getItem('autoPrint'));
  armed.at = Date.now() - 10 * 60 * 1000;   // ten minutes of boot and cache settling
  store.setItem('autoPrint', JSON.stringify(armed));
  const v = U.takeAutoPrint('251169-006', tokenOf(url));
  t('an arm 10 minutes old still prints', v.fire === true, v);
  t('…and the wait is reported, so a slow device is measurable', v.waitedMs > 500000);
  // Guard against the fix being undone by reintroducing any deadline at all.
  t('no wall-clock deadline remains in the helpers', !/TTL|30000|Date\.now\(\) - /.test(
    utilsSrc.slice(utilsSrc.indexOf('armAutoPrint(num) {'), utilsSrc.indexOf('// Cross-platform confirm'))
      .replace(/at: Date\.now\(\)/g, '').replace(/Date\.now\(\) - \(armed\.at \|\| 0\)/g, '')));
  t('AUTOPRINT_TTL_MS is gone from the view page', !/AUTOPRINT_TTL_MS/.test(createSrc));
}

section('the EARLIER bug stays shut: an arm may never fire on a later visit');
{
  // Original fault: a bare invoice number removed only on a matching view. An arm that
  // never reached that view survived the session and fired on a later save-only edit —
  // a print nobody asked for, plus a printHistory entry for it.
  reset();
  U.armAutoPrint('251169-006');                      // armed, navigation interrupted
  const later = U.takeAutoPrint('251169-006', null); // user opens the same invoice later
  t('same invoice, no token in the URL → does not print', later.fire === false, later);
  t('…and it is not treated as a fault', later.notable === false);
  t('…and the arm is GONE, so it cannot fire later either', store.getItem('autoPrint') === null);

  // One-shot: a reload of the printing URL must not print a second time.
  reset();
  const url = U.armAutoPrint('251169-007');
  t('first arrival prints', U.takeAutoPrint('251169-007', tokenOf(url)).fire === true);
  const again = U.takeAutoPrint('251169-007', tokenOf(url));
  t('a reload of the same URL does not print again', again.fire === false, again);
  t('…and a reload is not reported as a fault', again.notable === false);
}

section('mismatches are refused AND reported');
{
  reset();
  const url = U.armAutoPrint('251169-006');
  const other = U.takeAutoPrint('251169-999', tokenOf(url));
  t('an arm for another invoice does not print', other.fire === false);
  t('…and IS flagged, because it means something is wrong', other.notable === true, other.why);

  reset();
  U.armAutoPrint('251169-006');
  const stale = U.takeAutoPrint('251169-006', 'some-other-token');
  t('a token that does not match the arm does not print', stale.fire === false);
  t('…and is flagged as a stale arm', stale.notable === true, stale.why);

  reset();
  const clean = U.takeAutoPrint('251169-006', null);
  t('an ordinary view with nothing armed is silent', clean.fire === false && clean.notable === false, clean.why);
}

section('nothing in the arm can throw');
{
  // Legacy bare-string values are still in some sessions' storage; JSON.parse throws on
  // them. A throw here would abort loadView AFTER the invoice had rendered.
  reset();
  store.setItem('autoPrint', '251169-006');
  let threw = false, v = null;
  try { v = U.takeAutoPrint('251169-006', 'tok'); } catch (e) { threw = true; }
  t('a legacy bare-string arm does not throw', !threw);
  t('…does not print', v && v.fire === false);
  t('…and is cleared rather than left to rot', store.getItem('autoPrint') === null);

  reset();
  store.setItem('autoPrint', '{"num":"X"}');   // object with no token
  t('an arm with no token does not print', U.takeAutoPrint('X', 'tok').fire === false);
}

section('every call site uses the helper — no site writes the arm itself');
{
  // Three sites arm: save, save-edit, and the list page's printer button. The bug was
  // duplicated logic; a fourth hand-rolled site would reintroduce it.
  const live = ['utils.js', 'invoice-create.html', 'invoices.html'];
  const writers = live.filter(f => /setItem\('autoPrint'/.test(read(f)));
  t('only utils.js writes the arm', writers.length === 1 && writers[0] === 'utils.js', writers);
  // v1.0.268 moved this ahead of the PDF step and made it conditional in one expression.
  // Arming on a plain "บันทึก PDF" would print an invoice nobody asked to print.
  t('save uses the helper, and only when printing was asked for',
    /const _apUrl = shouldPrint \? Utils\.armAutoPrint\(invNumber\) : null;/.test(createSrc));
  t('save-edit uses the helper', /Utils\.armAutoPrint\(currentInvNum\)/.test(createSrc));
  t('the list page uses the helper', /location\.href = Utils\.armAutoPrint\(num\)/.test(listSrc));
  // The edit path navigates to the view page whether or not it prints; only the
  // printing branch may carry a token, or a plain save would print.
  t('save-edit only arms when printing was asked for',
    /shouldPrint\s*\n?\s*\?\s*Utils\.armAutoPrint\(currentInvNum\)\s*\n?\s*:\s*'invoice-create\.html\?view='/.test(createSrc));
  t('the view page consumes via the helper', /Utils\.takeAutoPrint\(invNum, _apToken\)/.test(createSrc));
  t('…reading the token from the URL', /URLSearchParams\(location\.search\)\.get\('ap'\)/.test(createSrc));
}

section('an auto-print that cannot find its data waits, then says so');
{
  // doPrint's only silent exit was `if (!pages.length) return;`. A Firestore snapshot
  // landing between loadView and the 800 ms timer can briefly empty DB._cache — the
  // same reason loadView retries — and an empty read there is indistinguishable from
  // the failure being investigated. It must not be silent.
  const d = createSrc.slice(createSrc.indexOf('async function doPrint('),
                            createSrc.indexOf('function buildInvoicePage'));
  t('doPrint takes an opts argument', /async function doPrint\(opts = \{\}\)/.test(d));
  t('the auto path identifies itself', /doPrint\(\{ auto: true \}\)/.test(createSrc));
  t('the manual button does not', /onclick="doPrint\(\)"/.test(createSrc));
  t('an empty cache is retried on the auto path only', /if \(!pages\.length && opts\.auto\)/.test(d));
  t('…and pages is re-read inside the loop', /pages = DB\.getCurrentPagesByNumber\(currentInvNum\)/.test(
    d.slice(d.indexOf('opts.auto'))));
  t('pages must be reassignable', /let pages = DB\.getCurrentPagesByNumber/.test(d) && !/const pages =/.test(d));
  t('giving up is logged', /DB\.logError\('AUTOPRINT'/.test(d));
  t('…and the user is told, not left guessing', /showAlert\([^)]*พิมพ์/.test(d));
  t('the manual path still returns quietly', /if \(!pages\.length\) \{\s*\n\s*if \(opts\.auto\)/.test(d));
}

section('the decision is recorded where it can actually be read');
{
  // DevTools is disabled in release Tauri builds; Settings → Troubleshoot (wt_errors)
  // is the only channel. A silent hand-off is what cost four releases.
  t('the outcome is logged', /DB\.logError\('AUTOPRINT'/.test(createSrc));
  t('both verdicts are distinguishable in the log',
    /\? 'จะพิมพ์' : 'ไม่พิมพ์: ' \+ _ap\.why/.test(createSrc));
  t('the reason is carried, not just the verdict', /why: _ap\.why/.test(createSrc));
  t('the wait is carried, so a slow boot is visible', /waitedMs: _ap\.waitedMs/.test(createSrc));
  // v1.0.265 gated routine lines behind localStorage.__apTrace — unreadable on the
  // desktop app, because DB.init()'s Tauri branch wipes every localStorage key but a
  // short keep-list on each launch. The flag was gone before any page ran, so the
  // release shipped silence. Nothing about this trace may depend on localStorage.
  // Comments-stripped: utils.js and this file both MENTION the dead gate to explain why
  // it is gone, and matching that prose would pass while the gate was still in force.
  const noComments = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  t('the trace does NOT depend on localStorage',
    !/localStorage\.__apTrace/.test(noComments(createSrc) + noComments(utilsSrc)));
  t('the keep-list really does not carry such a flag',
    !/__apTrace/.test(read('db.js')));
  t('every hand-off is traced, not just faults', /Utils\.apTrace\('view /.test(createSrc));
  t('…including how the page was entered, to catch a reload', /nav=' \+ Utils\.navType\(\)/.test(createSrc));
  t('…and the url as actually seen', /search: location\.search/.test(createSrc));
  t('arming is traced too, so a missing arm is distinguishable from a lost one',
    /apTrace\('arm /.test(utilsSrc));
  t('…and a silent sessionStorage failure is detected by reading back',
    /stored = !!sessionStorage\.getItem\('autoPrint'\)/.test(utilsSrc));

  // The decisive measurement: window.print() blocks until the dialog is dismissed, so
  // ~0 ms is proof of suppression. printCount cannot show this — the manual button
  // bumps it too, which is how it was misread as proof the print had been reached.
  t('window.print() is timed',
    /const _t0 = Date\.now\(\);\s+window\.print\(\);\s+const _printMs = Date\.now\(\) - _t0;/.test(createSrc));
  t('…and the elapsed time is logged', /print\(\) ' \+ _printMs \+ 'ms/.test(createSrc));
  t('…with an immediate return called out explicitly',
    /RETURNED IMMEDIATELY \(no dialog shown\)/.test(createSrc));
  t('…for the manual path as well, so the two are comparable',
    /via=' \+ \(opts\.auto \? 'auto' : 'button'\)/.test(createSrc));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
