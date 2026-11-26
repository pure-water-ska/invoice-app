// test-save-never-strands.js — v1.0.268
//
// THE BUG, confirmed on the user's machine 26 Nov 2026 after five releases of guessing:
//
//   saveInvoice() did `await PdfGen.run(...)` BEFORE the code that arms the print.
//   PdfGen.run awaits _saveToLocalFolder, which awaited handle.requestPermission() on
//   the saved PDF folder. That call needs a LIVE USER GESTURE, and by then the click is
//   long gone — so in the Tauri WebView no prompt rendered and the promise NEVER
//   SETTLED. Not rejected: settled never. The invoice saved, execution stopped, and the
//   arming code was never reached.
//
// Why it was so hard to see, and what each fact ruled out:
//   * Nothing threw, so neither the 'error' nor the 'unhandledrejection' hook fired.
//     A promise that never settles produces no event of any kind.
//   * The manual พิมพ์ button worked — same doPrint(), same printer — which exonerated
//     the print code and the environment.
//   * A fresh SANDBOX install printed from the same commit, because it has no pdf_dir
//     in IndexedDB: _saveToLocalFolder returned on line 2 and never reached the hang.
//     Identical code, opposite behaviour, decided entirely by whether a folder was
//     configured.
//   * printCount was misread as proof window.print() had been reached. The manual button
//     bumps it too, so it was evidence about neither path. That sent v1.0.261–263 after
//     a stylesheet query and a db.js change, all irrelevant.
//   * The trace added in v1.0.267 ended it in one line: "nav=navigate ap=NONE →
//     ไม่พิมพ์: not armed", with no arm line at all. Never armed, so never attempted.
//
// Run: node test-save-never-strands.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
// Comments MENTION requestPermission to explain why it is gone, so counting them would
// pass while the call was still there. Three assertions in this file failed on that
// before it was added — the same trap as in test-pages-workflow.js.
const codeOf = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const utilsSrc = read('utils.js');
const createSrc = read('invoice-create.html');

// ── the real withTimeout, lifted from utils.js ──────────────────────────────
const withTimeout = (() => {
  const s = utilsSrc.indexOf('withTimeout(promise, ms, label) {');
  const e = utilsSrc.indexOf('// Trace the hand-off into wt_errors');
  if (s < 0 || e < 0 || e < s) throw new Error('withTimeout not found in utils.js');
  const body = utilsSrc.slice(s, e).trim().replace(/,\s*$/, '');
  return new Function('return {' + body + '};')().withTimeout;
})();

const never = () => new Promise(() => {});          // the shape that caused this bug

(async () => {

section('withTimeout survives a promise that never settles');
{
  // The whole point. Everything else in this file depends on this one behaviour.
  const r = await withTimeout(never(), 60, 'hang');
  t('a never-settling promise still resolves', r && r.ok === false, r);
  t('…and is identified as a timeout', r.timedOut === true);
  t('…carrying the label, so the log names what hung', r.label === 'hang');
}

section('…and passes everything else through unchanged');
{
  const ok = await withTimeout(Promise.resolve(42), 1000, 'x');
  t('a resolved value comes back', ok.ok === true && ok.value === 42, ok);
  const bad = await withTimeout(Promise.reject(new Error('boom')), 1000, 'y');
  t('a rejection is reported, not thrown', bad.ok === false && String(bad.error.message) === 'boom');
  t('…and is NOT mislabelled as a timeout', !bad.timedOut);
  // A rejection must stay distinguishable from a hang: one means "it failed", the other
  // "it never answered", and they need different fixes.
  t('timeout and failure are distinguishable', bad.timedOut === undefined && (await withTimeout(never(), 50, 'z')).timedOut === true);

  const sync = await withTimeout('plain value', 1000, 'w');
  t('a non-promise is accepted', sync.ok === true && sync.value === 'plain value');

  let threw = false;
  try { await withTimeout(never(), 50, 'q'); } catch (e) { threw = true; }
  t('it never rejects, so a call site can always carry on', !threw);
}

section('the timer cannot keep the process (or the app) alive');
{
  // Promise.race leaves the loser pending; an uncleared setTimeout would hold a handle.
  const before = process._getActiveHandles ? process._getActiveHandles().length : 0;
  await withTimeout(Promise.resolve(1), 5000, 'fast');
  const after = process._getActiveHandles ? process._getActiveHandles().length : 0;
  t('the timeout is cleared when the promise wins', after <= before, { before, after });
  t('…explicitly, in code', /clearTimeout\(timer\); return r;/.test(utilsSrc));
}

section('requestPermission is GONE from the save path');
{
  const fn = createSrc.slice(createSrc.indexOf('async _saveToLocalFolder'),
                             createSrc.indexOf('async run(bodyHtml'));
  t('the save path was found', fn.length > 100 && fn.length < 4000, fn.length);
  // This is the bug itself. requestPermission needs a gesture; inside an async save
  // there is none, and in the Tauri WebView it then never settles.
  t('_saveToLocalFolder does not call requestPermission', !/requestPermission/.test(codeOf(fn)));
  t('it asks with queryPermission instead, which never prompts', /queryPermission/.test(fn));
  t('…and even that is time-boxed', /withTimeout\(dir\.queryPermission/.test(fn));
  t('a folder that is not granted is skipped, not waited on', /q\.value !== 'granted'/.test(fn));
  t('the write is time-boxed too', /withTimeout\(\(async \(\) => \{[\s\S]*?\}\)\(\), 15000/.test(fn));
  t('reading the handle is time-boxed', /withTimeout\(IDB\.get\('pdf_dir'\), 3000/.test(fn));
  // Silence is what cost the releases. Every exit must leave a trace.
  t('a skipped folder is logged', /apTrace\('pdf folder: not granted/.test(fn));
  t('…and the user is told the invoice still saved', /ใบกำกับบันทึกแล้ว/.test(fn));
  t('a failed write is logged', /apTrace\('pdf folder: write /.test(fn));
  t('the reason for not re-requesting is written down',
    /requires a live\s*\n?\s*\/\/ user gesture|requires a live user gesture/.test(fn));
}

section('printing no longer depends on the PDF step');
{
  // Order is the structural fix: even a PdfGen that hangs forever cannot stop the arm.
  const armAt = createSrc.indexOf('const _apUrl = shouldPrint ? Utils.armAutoPrint(invNumber)');
  const pdfAt = createSrc.indexOf('withTimeout(PdfGen.run(_pdfBody');
  t('saveInvoice arms before the PDF runs', armAt > 0 && pdfAt > 0 && armAt < pdfAt, { armAt, pdfAt });

  const eArmAt = createSrc.indexOf('? Utils.armAutoPrint(currentInvNum)');
  const ePdfAt = createSrc.indexOf("withTimeout(PdfGen.run(_ePdfBody");
  t('saveInvoiceEdit arms before the PDF runs too', eArmAt > 0 && ePdfAt > 0 && eArmAt < ePdfAt,
    { eArmAt, ePdfAt });

  // An unused arm is only harmless because it needs its token in the URL (v1.0.265).
  t('an unused arm cannot leak into a later view', /&ap=' \+ token/.test(utilsSrc));
  t('…and the comment says why arming early is safe', /An arm that goes unused is harmless/.test(createSrc));
}

section('the save always reaches its end');
{
  t('PdfGen.run is time-boxed in saveInvoice', /withTimeout\(PdfGen\.run\(_pdfBody, _fn, invNumber\), 30000/.test(createSrc));
  t('…and in saveInvoiceEdit', /withTimeout\(PdfGen\.run\(_ePdfBody, _eFn\), 30000/.test(createSrc));
  // The edit path had NO try/catch at all, so a rejection stranded it too.
  t('the edit path no longer awaits PdfGen bare', !/^\s*await PdfGen\.run\(_ePdfBody, _eFn\);$/m.test(createSrc));
  t('a PDF timeout is logged', /PdfGen\.run ' \+ \(_pdf\.timedOut \? 'TIMED OUT'/.test(createSrc));
  t('…and in the edit path', /PdfGen\.run \(edit\) ' \+ \(_ePdf\.timedOut \? 'TIMED OUT'/.test(createSrc));
  t('…and the user is told printing still works', /ยังพิมพ์ได้ตามปกติ/.test(createSrc));

  // Navigation must no longer sit behind the PDF either, or a hang still traps the user
  // on the edit form with a saved invoice and no way forward.
  t('navigation happens whatever the PDF did',
    /location\.href = _apUrl \|\| 'invoices\.html'/.test(createSrc));
  t('…and still goes to the list when not printing',
    /_apUrl \? 1500 : 1000/.test(createSrc));
}

section('the other requestPermission sites are accounted for');
{
  // Seven remain. They sit in VIEW actions (open a PDF, show a slip) where a hang is
  // visible and retryable, not in a save, so they are deliberately out of scope here —
  // but the count is pinned so a new one in a save path is noticed.
  const files = ['invoice-create.html', 'invoices.html', 'payments.html', 'pdf-import.html',
                 'settings.js', 'local-folder-sync.js'];
  const sites = [];
  for (const f of files) {
    const n = (codeOf(read(f)).match(/requestPermission/g) || []).length;
    if (n) sites.push(f + ':' + n);
  }
  const total = sites.reduce((a, s) => a + Number(s.split(':')[1]), 0);
  // Nine in app code before this release; the one inside _saveToLocalFolder is gone.
  // Pinned so adding a tenth is a deliberate act — in a SAVE path it would re-create
  // this bug exactly, and nothing about it would be visible at runtime.
  t('eight remain, one fewer than before', total === 8, { total, sites });
  // invoice-create.html keeps exactly one, in the PDF-view path, not in a save.
  t('invoice-create.html keeps only its view-path call',
    (codeOf(read('invoice-create.html')).match(/requestPermission/g) || []).length === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})();
