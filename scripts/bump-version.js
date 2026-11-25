#!/usr/bin/env node
/**
 * bump-version.js — sync the app version across all three sources at once.
 *
 *   node scripts/bump-version.js 1.0.3
 *
 * Updates:
 *   • package.json                 "version"
 *   • src-tauri/tauri.conf.json    package.version  (drives auto-update compare)
 *   • utils.js  APP_VERSION        version / date / label  (settings card display)
 *
 * Then commit + tag to release:
 *   git add -A && git commit -m "release v1.0.3"
 *   git tag v1.0.3 && git push origin main --tags
 */
const fs   = require('fs');
const path = require('path');

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error('Usage: node scripts/bump-version.js X.Y.Z   (e.g. 1.0.3)');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const now   = new Date();
const isoDate = now.toISOString();                                 // full ISO timestamp (date + time)
const label = `v${ver} (${now.getDate()} ${THAI_MONTHS[now.getMonth()]} ${now.getFullYear() + 543})`;

function patch(file, fn) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (before === after) { console.warn(`⚠ no change in ${file} — pattern not found?`); }
  fs.writeFileSync(p, after);
  console.log(`✓ ${file}`);
}

// package.json — first "version": "..."
patch('package.json', s =>
  s.replace(/("version":\s*)"[\d.]+"/, `$1"${ver}"`));

// tauri.conf.json — version inside the "package" block
patch('src-tauri/tauri.conf.json', s =>
  s.replace(/("version":\s*)"[\d.]+"/, `$1"${ver}"`));

// utils.js — APP_VERSION object
patch('utils.js', s =>
  s.replace(
    /const APP_VERSION = \{[\s\S]*?\};/,
    `const APP_VERSION = {\n  version: '${ver}',\n  date: '${isoDate}',\n  label: '${label}',\n};`
  ));

// ── Cache-bust core Cache-First JS in every HTML ───────────────────────────
// The service worker serves these files Cache-First; an auto-update does NOT
// bust that cache, so the desktop app can keep running stale pre-fix JS (this
// caused the "deleted customer comes back" bug to survive many releases — the
// db.js fixes were cached and never ran). Appending ?v=<version> changes the
// request URL each release; since the SW matches by exact URL (no ignoreSearch)
// the new query misses the cached entry and falls through to the network/bundle,
// guaranteeing a FRESH copy on the very first launch of the new version.
const BUST_FILES = ['utils.js', 'db.js', 'auth.js', 'idb.js', 'nav.js', 'settings.js', 'connection-status.js'];

// CSS had exactly the same problem and none of the protection: style.css is precached
// by the SW and its <link> carried NO query at all, so a brand-new rule could arrive
// late on a device still holding the old stylesheet. A badge whose class has no rule
// draws with no background — unreadable white, reported live in v1.0.261 and measured
// in the browser as computed background rgba(0,0,0,0) while the served file had the rule.
//
// Vendor CSS is deliberately NOT busted: bootstrap and its icons never change between
// releases, so a per-release query would force a pointless re-download of the largest
// assets every time. Only files this project edits belong here.
// TEMPORARILY EMPTY — diagnostic revert, v1.0.263.
//
// v1.0.262 added style.css to this list. "บันทึก & พิมพ์" then stopped producing a
// print dialog on the DESKTOP app; v1.0.260 was the last version that printed. Across
// 260 → 262 invoice-create.html's own code is byte-identical — the only change reaching
// that page is this stylesheet query (plus the script ?v= it already had). So the list
// is emptied to isolate it: if printing returns, this is the cause and the fix is to
// version the SW cache name in the desktop bundle instead of the asset URL (pages.yml
// bumps that cache only for the WEB deploy, so the desktop cache name never changes —
// which is why the asset query was reached for in the first place).
//
// Putting 'style.css' back re-enables it. The white-badge problem this originally fixed
// does NOT return meanwhile: v1.0.261 also sets that colour inline on the badge.
const BUST_CSS = [];

for (const f of fs.readdirSync(ROOT)) {
  if (!f.endsWith('.html')) continue;
  patch(f, s => {
    let out = s;
    for (const js of BUST_FILES) {
      const re = new RegExp(`(src=")((?:\\./)?)${js.replace('.', '\\.')}(?:\\?v=[\\d.]+)?(")`, 'g');
      out = out.replace(re, `$1$2${js}?v=${ver}$3`);
    }
    for (const css of BUST_CSS) {
      const re = new RegExp(`(href=")((?:\\./)?)${css.replace('.', '\\.')}(?:\\?v=[\\d.]+)?(")`, 'g');
      out = out.replace(re, `$1$2${css}?v=${ver}$3`);
    }
    return out;
  });
}

console.log(`\nVersion bumped to ${ver}.  Next:`);
console.log(`  git add -A && git commit -m "release v${ver}"`);
console.log(`  git tag v${ver} && git push origin main --tags`);
