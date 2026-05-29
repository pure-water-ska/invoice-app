/**
 * tauri-copy-dist.js
 * Copies all web assets from the project root into dist/ before `tauri build`.
 * Run via: node scripts/tauri-copy-dist.js
 *
 * Excluded: node_modules, src-tauri, dist, .git, .claude, scripts,
 *           *.md, mockup-*.html, temp result files
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Directories / patterns to skip entirely
const SKIP_DIRS = new Set([
  'node_modules', 'src-tauri', 'dist', '.git', '.claude',
  'scripts', 'icons',
]);

// File-name prefixes/patterns to skip
function skipFile(name) {
  if (name.startsWith('mockup-'))   return true;   // temp mockup files
  if (name.endsWith('.md'))         return true;   // markdown docs
  if (name.endsWith('.lock'))       return true;   // git lock files
  // Example / template files — not needed in the built app
  if (name === 'firebase-config.example.js') return true;
  if (name === 'drive-config.example.js')    return true;
  // temp result txt files from session
  const tempFiles = ['gitpush_result.txt','gitresult.txt','gitresult2.txt',
                     'gitstatus.txt','gr3.txt','CONTINUATION_PROMPT.md',
                     'HANDOFF.md'];
  if (tempFiles.includes(name))     return true;
  return false;
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (SKIP_DIRS.has(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    if (skipFile(path.basename(src))) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Clean dist first
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST);

// Copy root entries
let count = 0;
for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP_DIRS.has(entry)) continue;
  if (skipFile(entry)) continue;
  // skip hidden dirs/files except sw.js, manifest.json etc
  if (entry.startsWith('.')) continue;
  const src  = path.join(ROOT, entry);
  const dest = path.join(DIST, entry);
  copyRecursive(src, dest);
  count++;
}

// Also copy the icons folder (needed for PWA manifest)
const iconsSrc = path.join(ROOT, 'icons');
if (fs.existsSync(iconsSrc)) {
  copyRecursive(iconsSrc, path.join(DIST, 'icons'));
}

console.log(`✅ dist/ ready — ${count} entries copied from project root`);
