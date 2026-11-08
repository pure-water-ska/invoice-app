// test-signed-framing.js — v1.0.256
//
// Measured across all 593 stored signed invoices: 87.1% sit at A5's 0.705, but 13% do
// not — 53 portrait crops from 0.644 to 0.78, and 22 landscape from 1.09 to 1.47. July
// 2026 alone ran at 37%; recent months are ~4%. Every one has a long edge of exactly
// 1400, so they all came through the same path and were all downscaled the same way.
//
// compressImage cannot be the cause: it scales both axes by ONE factor, so the ratio out
// is the ratio in (pinned in test-image-caps.js). The off-values form a continuous smear
// rather than a few repeated ones, which is what framing at capture time looks like —
// and auto-rotating would not help, because inverting those landscape ratios gives
// 0.81/0.78/0.85, not 0.705. They are crops, not sideways pages.
//
// Nothing is fixable retroactively, so the check runs at upload while the paper is still
// on the desk. It must WARN, never block: a deliberate partial photo is sometimes all
// there is, and a missing proof of delivery is worse than a badly framed one.
//
// Run: node test-signed-framing.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const pay = fs.readFileSync(path.join(__dirname, 'payments.html'), 'utf8');

// ── the real constants and the real predicate, lifted from the page ────────
const A5_RATIO = eval(/const A5_RATIO\s+= ([^;]+);/.exec(pay)[1]);
const A5_TOL   = parseFloat(/const A5_RATIO_TOL = ([\d.]+);/.exec(pay)[1]);
// The shipped condition, not a restatement of it.
const condSrc = /Math\.abs\(_dim\.w \/ _dim\.h - A5_RATIO\) > A5_RATIO_TOL/.exec(pay);
const flags = (w, h) => Math.abs(w / h - A5_RATIO) > A5_TOL;

section('the constants describe A5, not a guess');
{
  t('the shipped condition was found', !!condSrc);
  t('A5_RATIO is derived from the paper size, not hard-coded',
    /const A5_RATIO\s+= 148 \/ 210;/.test(pay));
  t('…and equals 0.705', Math.abs(A5_RATIO - 0.7048) < 0.0005, A5_RATIO);
  t('the tolerance is a named constant', /const A5_RATIO_TOL = /.test(pay));
}

section('it flags what it should');
{
  // The worst real example, 300769-003.
  t('a landscape capture is flagged (1400×951)', flags(1400, 951));
  t('241069-001 (1400×1136) is flagged', flags(1400, 1136));
  t('a clearly tight crop is flagged (0.62)', flags(620, 1000));
  // The tightest crop in the real population. It clears 0.06 by only 0.0008 — recorded
  // deliberately so the margin is visible rather than accidental. A threshold on a
  // continuum always has a boundary; this nudges obvious cases, it is not a standard.
  t('…and so is the tightest real one (0.644), barely', flags(901, 1400),
    +Math.abs(901 / 1400 - A5_RATIO).toFixed(4));
  t('a square photo is flagged', flags(1000, 1000));
}

section('it stays quiet on what is fine');
{
  // 221069-001, a correctly framed full page.
  t('a correct A5 page passes (987×1400)', !flags(987, 1400));
  t('exact A5 passes', !flags(148, 210));
  // Hand-held shots are never exact; the tolerance has to absorb normal variation or
  // the warning becomes noise and gets clicked through.
  t('the mild real ratios 0.726–0.763 pass',
    [0.726, 0.739, 0.749, 0.763].every(r => !flags(r * 1400, 1400)),
    [0.726, 0.739, 0.749, 0.763].filter(r => flags(r * 1400, 1400)));
}

section('replayed against the real measured distribution');
{
  // The actual ratio census of all 581 readable signed invoices, bucketed. Keeping the
  // real shape here is what stops someone "tidying" the tolerance to a number that
  // would fire on an eighth of every upload.
  const census = [
    [0.705, 506], [0.644, 1], [0.726, 8], [0.739, 9], [0.749, 7], [0.763, 11],
    [0.774, 9], [0.781, 8], [1.089, 3], [1.136, 4], [1.184, 5], [1.232, 4],
    [1.281, 3], [1.330, 2], [1.472, 1],
  ];
  const total = census.reduce((s, [, n]) => s + n, 0);
  const flagged = census.filter(([r]) => flags(r * 1000, 1000)).reduce((s, [, n]) => s + n, 0);
  const pct = 100 * flagged / total;
  t('the census totals the measured population', total === 581, total);
  t('every landscape shot is caught',
    census.filter(([r]) => r > 1).every(([r]) => flags(r * 1000, 1000)));
  t('the correct 87% are never bothered', !flags(0.705 * 1000, 1000));
  // Too loud and it gets ignored; too quiet and it never fires.
  t('it fires on a small minority of uploads (4–9%)', pct > 4 && pct < 9, +pct.toFixed(1));
}

section('it warns — it never blocks, and never silently rewrites');
{
  t('the user can keep the photo', /js-keep/.test(pay) && /ใช้รูปนี้/.test(pay));
  t('…or pick another', /js-retake/.test(pay) && /ถ่ายใหม่/.test(pay));
  t('keeping resolves true, retaking resolves false',
    /js-retake'\)\.onclick = \(\) => \{ close\(\); resolve\(false\); \}/.test(pay) &&
    /js-keep'\)\.onclick   = \(\) => \{ close\(\); resolve\(true\); \}/.test(pay));
  // Nothing may be cropped, rotated or resized to make the number look right — this is
  // a signed delivery document.
  // Comments stripped first: the word "crop" appears in this function's own explanation,
  // and matching prose made this assert nothing about the code.
  t('the image itself is never altered by the check', (() => {
    const fn = /function _confirmFraming[\s\S]*?\n\}/.exec(pay)[0]
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    return !/\.rotate\(|drawImage\(|createElement\(['"]canvas|toDataURL\(/.test(fn);
  })());
  t('declining writes nothing', (() => {
    const fn = /async function uploadSignedInvoice[\s\S]*?\n\}/.exec(pay)[0];
    const decline = fn.slice(fn.indexOf('if (!keep)'), fn.indexOf('DB.updateInvoice'));
    return /return;/.test(decline) && !/DB\.updateInvoice/.test(decline);
  })());
  // Re-picking the same file fires no change event unless the input is cleared.
  t('declining clears the file input so the same file can be re-picked',
    /if \(inputEl\) inputEl\.value = '';/.test(pay));
  t('keeping an off-ratio photo is recorded in the activity log',
    /สัดส่วนไม่ตรง A5/.test(pay));
}

section('the check cannot cost an upload');
{
  const fn = /async function uploadSignedInvoice[\s\S]*?\n\}/.exec(pay)[0];
  // A photo that fails to decode must still save: the image matters more than the check.
  t('an unmeasurable image skips the check instead of failing',
    /_dim && _dim\.h > 0 &&/.test(fn));
  t('_measureDataUrl resolves null rather than rejecting',
    /im\.onerror = \(\) => resolve\(null\);/.test(pay));
  t('it runs BEFORE the upload, so declining costs no write',
    fn.indexOf('_confirmFraming') < fn.indexOf('_drvUpload'));
  t('…and before the record is updated',
    fn.indexOf('_confirmFraming') < fn.indexOf('DB.updateInvoice'));
  t('it only applies to the signed invoice, not slips or cheques',
    !/A5_RATIO/.test(/async function previewImgUpdate[\s\S]*?\n\}/.exec(pay)[0]) &&
    !/A5_RATIO/.test(/async function loadPayImage[\s\S]*?\n\}/.exec(pay)[0]));
}

section('the warning states the real cost, not a flattering one');
{
  const fn = /function _confirmFraming[\s\S]*?\n\}/.exec(pay)[0];
  // The invoice is portrait whichever way it was shot, so the resolution that matters
  // runs DOWN the page. Comparing the short edge to 987 (a correct image's WIDTH)
  // called a landscape 1400×951 a 4% loss when it really loses 32% of the detail on the
  // text — understating precisely the case the warning most needs to land.
  t('vertical loss is measured against 1400, not the short edge against 987',
    /1 - dim\.h \/ 1400/.test(fn) && !/shortEdge \/ 987/.test(fn));
  const vLoss = h => Math.max(0, Math.round(100 * (1 - h / 1400)));
  t('a landscape 1400×951 reports ~32%', vLoss(951) === 32, vLoss(951));
  t('a tight portrait crop reports no loss, because it keeps all 1400', vLoss(1400) === 0);
  // Two different problems need two different sentences: a sideways shot loses detail,
  // a tight crop loses the page edges.
  t('landscape is told it loses detail', /ความละเอียดตามแนวตั้ง/.test(fn));
  t('a tight crop is told its edges may be cut off instead', /ขอบใบบางส่วนอาจไม่ติดมาในรูป/.test(fn));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
