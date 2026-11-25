#!/usr/bin/env node
// make-test-build.js — turn the working tree into a SANDBOX build (v1.0.264)
//
// Run by .github/workflows/release-test.yml before tauri-action, so a `test-v*` tag
// produces an app that installs beside the real one and cannot touch it. Nothing here
// is committed: the repo always holds the production configuration, and this only
// rewrites the checkout inside CI.
//
// What makes it safe to run next to production:
//   • a different bundle identifier  → Tauri gives it its OWN %APPDATA% folder, so the
//     real app's HDD store (wt_*.json) is untouched;
//   • a different Firestore orgId    → sync works for real but against orgs/test/…,
//     so production invoices, customers and prices are never read or written;
//   • the updater is switched OFF    → the sandbox can never jump onto a production
//     release, and the workflow publishes it as a PRERELEASE so the production
//     updater (which reads releases/latest) never sees it either;
//   • the single-instance port is derived from the identifier in main.rs, so launching
//     the sandbox while the real app runs no longer focuses the real window and exits.
//
// Usage:  node scripts/make-test-build.js [suffix]      (default suffix: test)

const fs = require('fs');
const path = require('path');

// MTB_ROOT lets test-sandbox-build.js run this against a throwaway copy of the three
// files. Without it a test would have to patch the real checkout and then restore it,
// which risks discarding whatever else is uncommitted.
const ROOT = process.env.MTB_ROOT || path.join(__dirname, '..');
const SUFFIX = (process.argv[2] || 'test').replace(/[^a-z0-9-]/gi, '').toLowerCase();
if (!SUFFIX) { console.error('suffix must contain at least one letter or digit'); process.exit(1); }

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);
const changes = [];

// ── 1. Tauri bundle identity ────────────────────────────────────────────────
{
  const f = 'src-tauri/tauri.conf.json';
  const conf = JSON.parse(read(f));
  const beforeId = conf.tauri.bundle.identifier;
  const beforeName = conf.package.productName;

  if (beforeId.endsWith('.' + SUFFIX)) {
    console.error('already patched — refusing to run twice'); process.exit(1);
  }
  conf.tauri.bundle.identifier = beforeId + '.' + SUFFIX;
  conf.package.productName = beforeName + ' (ทดสอบ)';

  // An updater left on would pull the sandbox back onto a production build, silently
  // replacing it — and with it the whole point of having a separate app.
  if (conf.tauri.updater) {
    conf.tauri.updater.active = false;
    delete conf.tauri.updater.endpoints;
  }
  write(f, JSON.stringify(conf, null, 2) + '\n');
  changes.push(`identifier  ${beforeId} → ${conf.tauri.bundle.identifier}`);
  changes.push(`productName ${beforeName} → ${conf.package.productName}`);
  changes.push('updater     active → false (endpoints removed)');
}

// ── 2. Firestore org ────────────────────────────────────────────────────────
// Same Firebase project and the same team credentials — only the document root
// changes, so sync is exercised for real without touching production data.
{
  const f = 'firebase-config.js';
  const src = read(f);
  const m = /orgId:\s*"([^"]+)"/.exec(src);
  if (!m) { console.error('FATAL: orgId not found in ' + f); process.exit(1); }
  if (m[1] !== 'main') { console.error('FATAL: expected orgId "main", found "' + m[1] + '"'); process.exit(1); }
  write(f, src.replace(/orgId:\s*"main"/, `orgId:        "${SUFFIX}"`));
  changes.push(`orgId       main → ${SUFFIX}  (orgs/${SUFFIX}/… in Firestore)`);
}

// ── 3. Make it obvious on screen which build is running ─────────────────────
// Every page shows APP_VERSION in the navbar; without this the two apps are hard to
// tell apart in a screenshot, which is exactly when it matters.
{
  const f = 'utils.js';
  const src = read(f);
  const m = /label:\s*'([^']+)'/.exec(src);
  if (!m) { console.error('FATAL: APP_VERSION label not found in ' + f); process.exit(1); }
  write(f, src.replace(/label:\s*'([^']+)'/, `label: '$1 [${SUFFIX.toUpperCase()}]'`));
  changes.push(`version label → "${m[1]} [${SUFFIX.toUpperCase()}]"`);
}

console.log('Sandbox build configured:');
for (const c of changes) console.log('  • ' + c);
console.log('\nThis checkout is now a TEST build. Do not commit it.');
