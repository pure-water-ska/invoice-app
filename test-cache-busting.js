// test-cache-busting.js — v1.0.262
//
// The service worker serves local assets Cache-First and matches by EXACT url (no
// ignoreSearch), so an unversioned asset keeps being served from cache after a release.
// bump-version.js appends ?v=<version> to break that — but it only ever rewrote
// `src="…"` on script tags, so CSS had none of the protection.
//
// What that cost, live: a brand-new `.badge-carried` rule shipped in v1.0.261 never
// reached a browser that already held style.css. A badge whose class has no rule draws
// with NO BACKGROUND — unreadable white, which is exactly what was reported. Measured
// in the browser: computed background rgba(0,0,0,0) while the served file had the rule.
//
// Run: node test-cache-busting.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const ROOT = __dirname;
const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const bump = read('scripts/bump-version.js');
const version = JSON.parse(read('package.json')).version;

section('the bump script versions stylesheets, not only scripts');
{
  t('there is a CSS list', /const BUST_CSS = \[/.test(bump));
  t('style.css is in it', /const BUST_CSS = \[[^\]]*'style\.css'/.test(bump));
  // The two rewrites differ by attribute — a script is src=, a stylesheet is href=.
  // Reusing the src= regex for CSS silently matches nothing, which is how this was missed.
  t('scripts are matched on src=', /\(src="\)\(\(\?:\\\\\.\/\)\?\)/.test(bump));
  t('stylesheets are matched on href=', /\(href="\)\(\(\?:\\\\\.\/\)\?\)/.test(bump));
  t('both rewrites run over every html file',
    bump.indexOf('for (const css of BUST_CSS)') > bump.indexOf('for (const js of BUST_FILES)') &&
    bump.indexOf('for (const css of BUST_CSS)') < bump.indexOf("if (!f.endsWith('.html')) continue;") + 2000);
}

section('every page links a VERSIONED style.css');
{
  const linking = htmlFiles.filter(f => /href="(?:\.\/)?style\.css/.test(read(f)));
  t('the pages were found', linking.length >= 20, linking.length);
  const bare = linking.filter(f => /href="(?:\.\/)?style\.css"/.test(read(f)));
  t('none links it without a version', bare.length === 0, bare);
  const stale = linking.filter(f => !new RegExp('href="(?:\\./)?style\\.css\\?v=' + version.replace(/\./g, '\\.') + '"').test(read(f)));
  t('every link carries the CURRENT version', stale.length === 0, stale);
}

section('vendor CSS is deliberately left alone');
{
  // bootstrap and its icons never change between releases; versioning them would force
  // a re-download of the largest assets on every release for nothing.
  const versionedVendor = htmlFiles.filter(f => /vendor\/[^"]*\.css\?v=/.test(read(f)));
  t('no vendor stylesheet is versioned', versionedVendor.length === 0, versionedVendor);
  t('…and it is not in the bust list', !/BUST_CSS = \[[^\]]*vendor/.test(bump));
}

section('the core scripts kept their versioning');
{
  // Regression guard: the CSS work must not disturb what already worked.
  const core = ['utils.js', 'db.js', 'auth.js', 'nav.js'];
  const pagesWith = f => core.filter(js => new RegExp('src="(?:\\./)?' + js.replace('.', '\\.')).test(read(f)));
  const offenders = [];
  for (const f of htmlFiles) {
    for (const js of pagesWith(f)) {
      if (new RegExp('src="(?:\\./)?' + js.replace('.', '\\.') + '"').test(read(f))) offenders.push(f + ':' + js);
    }
  }
  t('no core script is linked without a version', offenders.length === 0, offenders.slice(0, 5));
}

section('the service worker still matches by exact url');
{
  const sw = read('sw.js');
  // If it ever matched with ignoreSearch, the ?v= would be stripped before lookup and
  // every bust in this file would quietly stop working.
  t('cache lookups do not ignore the query string', !/ignoreSearch\s*:\s*true/.test(sw));
  t('style.css is still precached as a fallback', /'\.\/style\.css'/.test(sw));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
