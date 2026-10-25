// test-image-caps.js — v1.0.251
//
// Two findings from inspecting the live signed invoices 241069-001 (1400×1136) and
// 221069-001 (987×1400):
//
//  1. The signed invoice had TWO upload paths with different caps — uploadSignedInvoice
//     at 1400 and the แก้ไขรูป path hard-coded at 1200 — both writing the same
//     signedImage field. Replacing a signed invoice silently shrank it and re-encoded an
//     already-compressed JPEG, a second generation loss on top of a smaller image.
//     Every cap now comes from one IMG_MAX_PX map.
//
//  2. .pay-hist-img set only max-height, so each thumbnail took its own width and a row
//     mixing portrait invoices with landscape captures never lined up. The box is now
//     A5-shaped (148:210 = 0.705) with object-fit:contain.
//
// Utils.compressImage scales both axes by ONE factor, so it can never distort — the
// ratio differences came in with the files. This suite pins that property too, because
// a "fix" that stretched an image to fill the box would corrupt a delivery document.
//
// Run: node test-image-caps.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const pay = fs.readFileSync(path.join(__dirname, 'payments.html'), 'utf8');
const utils = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');

// ── run the real compressImage maths ───────────────────────────────────────
// Lifted from utils.js so the property is tested, not a restatement of it.
const scaleSrc = /const scale\s+= (Math\.min\(1, maxPx \/ img\.width, maxPx \/ img\.height\));/.exec(utils);
const scaleOf = scaleSrc
  ? new Function('maxPx', 'img', 'return ' + scaleSrc[1] + ';')
  : null;
const resize = (w, h, maxPx) => {
  const s = scaleOf(maxPx, { width: w, height: h });
  return { w: Math.round(w * s), h: Math.round(h * s) };
};

section('compressImage cannot distort a document');
{
  t('the scale expression was found in utils.js', !!scaleSrc);
  const cases = [[4000, 3000], [3000, 4000], [987, 1400], [1400, 1136], [800, 600]];
  cases.forEach(([w, h]) => {
    const r = resize(w, h, 1400);
    const before = w / h, after = r.w / r.h;
    t(`${w}×${h} keeps its ratio`, Math.abs(before - after) < 0.005, [before.toFixed(3), after.toFixed(3)]);
  });
  // Math.min(1, …) is what stops a small scan being blown up into a blurry mess.
  const small = resize(600, 800, 1400);
  t('an image under the cap is left alone, never enlarged',
    small.w === 600 && small.h === 800, small);
  const big = resize(4000, 3000, 1400);
  t('the LONG edge is what meets the cap', Math.max(big.w, big.h) === 1400, big);
}

section('one map holds every cap');
{
  t('IMG_MAX_PX exists', /const IMG_MAX_PX\s+= \{/.test(pay));
  const m = /const IMG_MAX_PX\s+= \{([^}]*)\}/.exec(pay)[1];
  t('the signed invoice gets the larger cap', /signed:\s*1400/.test(m), m.trim());
  t('slips and cheques stay at 1200', /transfer:\s*1200/.test(m) && /cheque:\s*1200/.test(m));
  t('there is one quality constant', /const IMG_QUALITY = 0\.82;/.test(pay));
  t('_imgMaxPx falls back for an unknown type', /_imgMaxPx\(type\) \{ return IMG_MAX_PX\[type\] \|\| 1200; \}/.test(pay));

  // The whole point: no call site may carry its own number again.
  const hardcoded = pay.match(/compressImage\([^)]*?,\s*\d{3,4}\s*,/g) || [];
  t('no compressImage call hard-codes a cap any more', hardcoded.length === 0, hardcoded);
  const calls = pay.match(/Utils\.compressImage\([^)]*\)/g) || [];
  t('every call in payments.html routes through _imgMaxPx',
    calls.length > 0 && calls.every(c => /_imgMaxPx\(/.test(c)), calls.length);
}

section('the signed invoice keeps 1400 on BOTH of its paths');
{
  const fn = name => {
    const i = pay.indexOf('function ' + name + '(');
    return i < 0 ? '' : pay.slice(i, i + 1800);
  };
  t('uploadSignedInvoice asks the map for the signed cap',
    /_imgMaxPx\('signed'\)/.test(fn('uploadSignedInvoice')));
  // This path writes signedImage too, via fieldMap — it must not apply the slip's cap.
  t('the แก้ไขรูป path still maps signed → signedImage', /signed: 'signedImage'/.test(pay));
  t('…and compresses by the type actually chosen',
    /_imgMaxPx\(type\)/.test(fn('confirmImageUpdate')));
  // The type select can be changed AFTER the file is picked, so the stored copy is
  // rebuilt from the original file rather than from the preview.
  t('the final copy is made from the ORIGINAL file, not the preview',
    /compressImage\(_imgUpdateFile, _imgMaxPx\(type\)/.test(fn('confirmImageUpdate')));
  t('a failure there keeps the preview rather than losing the upload',
    /catch \(e\) \{ \/\* keep the preview copy/.test(pay));
  // Anchored to the start of a line: a commented-out `// _imgUpdateFile = null;` still
  // contains the text, and matching it loosely passed while the reset was disabled.
  t('the file is cleared when the modal opens',
    /\n\s*_imgUpdateFile = null;/.test(fn('openImageUpdateModal')));
}

section('the thumbnail box is A5-shaped and never crops');
{
  const css = /\.pay-hist-img\s+\{([^}]*)\}/.exec(pay);
  t('.pay-hist-img still exists', !!css);
  const rule = css[1].replace(/\s+/g, ' ').trim();
  t('it has a fixed height', /height:60px/.test(rule), rule);
  t('…and a fixed width, so a row lines up', /width:42px/.test(rule));
  // 148:210 = 0.7048. Anything else and a correctly shot invoice no longer fills the box.
  t('the box matches A5 within a pixel', Math.abs(42 / 60 - 148 / 210) < 0.01, (42 / 60).toFixed(3));
  t('max-height alone is gone — that was the ragged-row cause', !/max-height:60px/.test(rule));
  // object-fit:cover would CROP a delivery document; fill would stretch it.
  t('object-fit is contain', /object-fit:contain/.test(rule));
  t('…not cover or fill', !/object-fit:\s*(cover|fill)/.test(rule));
  t('letterboxing shows against a background, not a hole', /background:#f8f9fa/.test(rule));
  t('it is still clickable for the lightbox', /cursor:pointer/.test(rule));
}

section('the full-size view is untouched');
{
  // Normalising the thumbnail must not shrink what you see when you open the image.
  const fsCss = /\.img-fullscreen img \{([^}]*)\}/.exec(pay)[1];
  t('the lightbox still shows the image at up to 95vw/95vh',
    /max-width:95vw/.test(fsCss) && /max-height:95vh/.test(fsCss));
  t('the lightbox does not inherit the A5 box', !/object-fit/.test(fsCss));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
