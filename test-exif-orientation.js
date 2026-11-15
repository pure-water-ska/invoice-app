// test-exif-orientation.js — v1.0.258
//
// Reported from the DESKTOP app: a photo of a portrait A5 invoice came out landscape,
// and the framing dialog's preview showed the page lying on its side. Not reproducible
// in Chrome, and today's 10 uploads from the web were all 987×1400.
//
// Cause: a phone held upright records the sensor frame LANDSCAPE and sets an EXIF
// Orientation tag saying "rotate this to display". Chrome applies that tag when it
// decodes an <img>; WebView2 (the desktop app) does NOT. So the canvas was sized and
// drawn from the raw landscape frame — the image was stored sideways, not merely
// mislabelled. 1.333 in the ratio census is exactly 4:3, a phone frame on its side.
//
// So compressImage now applies the orientation itself. Both halves matter:
//   • apply it when the decoder did not (WebView2), and
//   • do NOT apply it when the decoder already did (Chrome) — or every correct photo
//     on the web build would be rotated a second time.
// The decision is made by comparing the decoded dimensions against the SOF frame size,
// which is the true encoded size before any rotation.
//
// Run: node test-exif-orientation.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

// ── the real helpers, lifted from utils.js ────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
const U = {};
{
  const s = src.indexOf('Utils._jpegOrientation = function');
  const e = src.indexOf('Utils.compressImage = function');
  if (s < 0 || e < 0) throw new Error('orientation helpers not found in utils.js');
  new Function('Utils', src.slice(s, e))(U);
}

// Minimal but real JPEG structure: SOI + APP1(Exif/Orientation) + SOF0(h,w) + SOS.
function jpeg({ orient = 1, w = 1200, h = 900, le = true, exif = true } = {}) {
  const b = [0xFF, 0xD8];
  if (exif) {
    b.push(0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0);
    b.push(...(le ? [0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0] : [0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8]));
    b.push(...(le ? [1, 0] : [0, 1]));
    b.push(...(le ? [0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, orient, 0, 0, 0]
                  : [0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, orient, 0, 0]));
    b.push(0, 0, 0, 0);
  }
  b.push(0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
         3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  b.push(0xFF, 0xDA, 0, 2);
  return new Uint8Array(b);
}

section('reading the tag out of a real JPEG header');
{
  const r = U._jpegOrientation(jpeg({ orient: 6, w: 1200, h: 900 }));
  t('orientation is read', r && r.orientation === 6, r);
  // The SOF size is what makes the "did the decoder already rotate it?" test possible.
  t('…along with the RAW encoded frame size', r.rawW === 1200 && r.rawH === 900);
  t('big-endian TIFF is read too (not all phones are little-endian)',
    U._jpegOrientation(jpeg({ orient: 8, le: false })).orientation === 8);
  t('a JPEG with no EXIF reports orientation 1',
    U._jpegOrientation(jpeg({ exif: false })).orientation === 1);
}

section('it refuses to guess');
{
  t('a non-JPEG returns null', U._jpegOrientation(new Uint8Array([0x89, 0x50, 0x4E, 0x47])) === null);
  // A four-byte PNG header returns null with or without the SOI check, so it proves
  // nothing. This one carries bytes that LOOK like an SOF segment: without the check
  // the walk would read them and report a confident, wrong frame size.
  {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xFF, 0xDA, 0, 2]);
    t('…including one whose bytes would parse as a frame if the SOI check were dropped',
      U._jpegOrientation(png) === null);
  }
  t('an empty buffer returns null', U._jpegOrientation(new Uint8Array([])) === null);
  t('SOI with nothing after it returns null', U._jpegOrientation(new Uint8Array([0xFF, 0xD8])) === null);
  // No frame size means the decoder-already-rotated test cannot be made, and rotating
  // on a guess would wreck correct photos.
  const noSof = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  t('EXIF without a frame size returns null rather than a half answer',
    U._jpegOrientation(noSof) === null);
  // A truncated segment length must stop the walk, not run off the end.
  const bad = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 1, 2, 3]);
  t('a malformed segment length does not throw', (() => {
    try { U._jpegOrientation(bad); return true; } catch (e) { return false; }
  })());
  // "Does not throw" was too weak: trusting an over-long length simply walked off the
  // end and returned null anyway. Here a lying length would skip the REAL SOF and land
  // the walk on bytes that parse as a different frame — a confident wrong answer.
  {
    const lie = new Uint8Array([
      0xFF, 0xD8,
      0xFF, 0xE1, 0x00, 0x40,                   // claims 64 bytes; only ~30 follow
      0x45, 0x78, 0x69, 0x66, 0, 0,
      0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0, 1, 0,
      0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x04, 0xB0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xFF, 0xDA, 0, 2,
    ]);
    // Refusing is the documented contract. Noted honestly: the bounds check itself is
    // DEFENSIVE — removing it makes the walk run off the end and return null too, so no
    // input distinguishes the two. It is kept to avoid out-of-bounds reads, and this
    // asserts the contract rather than pretending to cover the guard.
    t('a lying segment length makes it refuse, not skip ahead and read',
      U._jpegOrientation(lie) === null, U._jpegOrientation(lie));
  }
}

section('the geometry — verified in a browser against corner pixels');
{
  // These matrices were checked in a real canvas with a red bar on the frame's TOP edge
  // and a blue bar on its LEFT: orient 6 put blue on top and red on the right; orient 8
  // put red on the left and blue on the bottom; orient 3 put red at the bottom.
  const tr = (o, w, h) => U._orientTransform(o, w, h);
  t('orientation 1 is the identity and keeps the size',
    JSON.stringify(tr(1, 1200, 900)) === JSON.stringify({ w: 1200, h: 900, t: [1, 0, 0, 1, 0, 0] }));
  [5, 6, 7, 8].forEach(o => {
    const r = tr(o, 1200, 900);
    t('orientation ' + o + ' swaps width and height', r.w === 900 && r.h === 1200);
  });
  [2, 3, 4].forEach(o => {
    const r = tr(o, 1200, 900);
    t('orientation ' + o + ' keeps width and height', r.w === 1200 && r.h === 900);
  });
  // A rotation matrix must not scale: |det| = 1, or the page comes out stretched.
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(o => {
    const m = tr(o, 1200, 900).t;
    t('orientation ' + o + ' neither stretches nor shrinks',
      Math.abs(Math.abs(m[0] * m[3] - m[1] * m[2]) - 1) < 1e-9);
  });
  // Mirrored tags (2/4/5/7) flip handedness; plain rotations (1/3/6/8) must not.
  const det = o => { const m = tr(o, 1200, 900).t; return m[0] * m[3] - m[1] * m[2]; };
  t('plain rotations keep handedness', [1, 3, 6, 8].every(o => det(o) > 0), [1, 3, 6, 8].map(det));
  t('mirrored tags flip it', [2, 4, 5, 7].every(o => det(o) < 0), [2, 4, 5, 7].map(det));
  t('an unknown tag falls back to the identity', tr(99, 10, 20).t.join() === '1,0,0,1,0,0');

  // Swapping w/h and keeping |det|=1 is true of 5, 6, 7 AND 8 alike, so those checks
  // cannot tell a 90° CW from a 90° CCW. Pin where a corner actually lands. Verified in
  // a real canvas: with red on the frame's TOP edge, orientation 6 puts red on the
  // RIGHT and orientation 8 puts it on the LEFT.
  const map = (o, x, y) => {
    const m = tr(o, 1200, 900).t;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  };
  const TL = (o) => map(o, 0, 0).join(),  TR_ = (o) => map(o, 1200, 0).join();
  t('orientation 6 sends the frame\'s top-left to the top-right (90° CW)',
    TL(6) === [900, 0].join(), TL(6));
  t('orientation 8 sends it to the bottom-left (90° CCW)', TL(8) === [0, 1200].join(), TL(8));
  t('…so 6 and 8 are not interchangeable', TL(6) !== TL(8));
  t('orientation 3 sends the top-left to the bottom-right (180°)',
    TL(3) === [1200, 900].join(), TL(3));
  t('orientation 2 mirrors horizontally, leaving the top edge on top',
    TL(2) === [1200, 0].join() && TR_(2) === [0, 0].join());
  t('orientation 1 leaves the top-left where it is', TL(1) === [0, 0].join());
}

section('it must not rotate twice — the decision, exercised');
{
  // These assertions used to match source text inside compressImage's onload, and
  // passed with the branch disabled. The decision is its own function now, so drive it.
  const meta = { orientation: 6, rawW: 1200, rawH: 900 };
  // WebView2: hands back the raw frame → the rotation is ours.
  t('decoder did NOT rotate → we apply the tag',
    U._orientationToApply(meta, 1200, 900) === 6);
  // Chrome: already rotated → applying it again would turn a correct photo sideways.
  t('decoder DID rotate → we apply nothing',
    U._orientationToApply(meta, 900, 1200) === 1);
  t('the same holds for orientation 8',
    U._orientationToApply({ orientation: 8, rawW: 1200, rawH: 900 }, 1200, 900) === 8 &&
    U._orientationToApply({ orientation: 8, rawW: 1200, rawH: 900 }, 900, 1200) === 1);
  // 180° does not change the dimensions, so it can never look "already applied".
  t('a 180° tag is applied regardless of the decoded size',
    U._orientationToApply({ orientation: 3, rawW: 1200, rawH: 900 }, 1200, 900) === 3);
  // Mirror-only tags leave the dimensions alone, so the dimension test cannot see them.
  t('mirror-only tags are always applied',
    U._orientationToApply({ orientation: 2, rawW: 1200, rawH: 900 }, 1200, 900) === 2 &&
    U._orientationToApply({ orientation: 4, rawW: 1200, rawH: 900 }, 1200, 900) === 4);
  t('no tag means no rotation',
    U._orientationToApply({ orientation: 1, rawW: 1200, rawH: 900 }, 1200, 900) === 1);
  t('no metadata at all means no rotation', U._orientationToApply(null, 100, 200) === 1);
  // A square frame is ambiguous — both tests match — but rotating a square is harmless
  // either way, so the only requirement is that it does not throw.
  t('a square frame does not break the decision',
    [1, 6].includes(U._orientationToApply({ orientation: 6, rawW: 900, rawH: 900 }, 900, 900)));

  const fn = src.slice(src.indexOf('Utils.compressImage = function'));
  t('compressImage uses that decision rather than its own copy',
    /Utils\._orientationToApply\(meta, w, h\)/.test(fn));
  t('orientation 1 costs nothing — no transform is set', /if \(orient !== 1\) \{/.test(fn));
}

section('a parse failure can never cost an upload');
{
  const fn = src.slice(src.indexOf('Utils.compressImage = function'));
  t('the header read is wrapped', /catch \(err\) \{ meta = null; \}/.test(fn));
  // meta === null is the fallback: the decision returns 1 and the draw is the identity,
  // i.e. exactly the pre-v1.0.258 behaviour.
  t('…and falls back to the old behaviour', U._orientationToApply(null, 1200, 900) === 1 &&
    /const orient = Utils\._orientationToApply\(meta, w, h\);/.test(fn));
  // Decoding a whole multi-megabyte photo to base64 twice would be wasteful; the header
  // is all that is needed.
  t('only the header is scanned, not the whole file', /256 \* 1024/.test(fn));
  t('non-JPEG files skip the parse entirely', /data:image\\\/jpe\?g/.test(fn));
  t('the transform is reset so the canvas is not left skewed',
    /ctx\.setTransform\(1, 0, 0, 1, 0, 0\);/.test(fn));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
