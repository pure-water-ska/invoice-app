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

console.log(`\nVersion bumped to ${ver}.  Next:`);
console.log(`  git add -A && git commit -m "release v${ver}"`);
console.log(`  git tag v${ver} && git push origin main --tags`);
