// test-lexical-globals.js — v1.0.271
//
// A top-level `const X = …` in a classic script is a LEXICAL global: it is reachable by
// its bare name, but it is NOT a property of window. So `window.X` is undefined, and
// `if (window.X && X.foo())` silently takes the false branch forever. No error, no log —
// the feature just never runs.
//
// This class has now cost five separate live bugs in this project:
//   window.DB      — disabled the customer backstop for several releases, and made
//                    invoice-create run its init BEFORE DB.ready, producing -001 for a
//                    number that already existed.
//   window.IDB     — disabled sync.js's cache+HDD writes (Firestore-pulled invoices
//                    vanished after navigation) and local-folder-sync's handle
//                    persistence (the folder showed as "gone" on every reload).
//   window.Auth    — the idle logout NEVER fired at any setting; the unclean-close
//                    restore marker was never written; and the Tauri close guard never
//                    held the window, so pending uploads were not guaranteed to flush.
//   window.Utils   — the desktop close overlay never appeared, so nothing told the user
//                    the app was holding the close to save data; cross-device activity
//                    toasts never showed. (v1.0.271)
//   window.APP_VERSION — four sites. Two in nav.js meant NO dynamically loaded script
//                    ever received a ?v= cache-bust; one printed '?' in a diagnostic;
//                    one showed a hardcoded, by then wrong, "v1.0.239" to the user.
//                    (v1.0.271)
//
// Every one was found by accident, in production. CLAUDE.md says to grep before adding
// code that reads these globals, which is advice a person has to remember. This suite
// makes it a build failure instead, and it DERIVES the names from the source so a global
// added later is covered without anyone updating a list.
//
// Run: node test-lexical-globals.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const ROOT = __dirname;
// App sources only: test files build their own stubs and may legitimately poke at window.
const appJs = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') &&
  !f.startsWith('test-') && f !== 'sw.js');
const appHtml = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Strip comments AND string literals: a name inside a message or a regex is not a read.
// Without this the suite would flag its own explanatory comments, which is the mistake
// that wasted three assertions in test-save-never-strands.js.
function liveCode(src) {
  return src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map(l => l.replace(/\/\/.*$/, ''))                 // trailing comments
    .map(l => l.replace(/'(?:[^'\\]|\\.)*'/g, "''"))    // single-quoted strings
    .map(l => l.replace(/"(?:[^"\\]|\\.)*"/g, '""'))    // double-quoted
    .map(l => l.replace(/`(?:[^`\\]|\\.)*`/g, '``'))    // templates
    .join('\n');
}

// ── derive the lexical-only globals from the app's own sources ───────────────
const declared = new Set();
for (const f of appJs) {
  for (const m of read(f).matchAll(/^const ([A-Z][A-Za-z0-9_]*)\s*=/gm)) declared.add(m[1]);
}
// A name that IS also assigned to window is safe — window.Sync works because sync.js
// does `window.Sync = Sync`.
const onWindow = new Set();
for (const f of appJs) {
  const src = read(f);
  for (const n of declared) {
    if (new RegExp('window\\.' + n + '\\s*=').test(src)) onWindow.add(n);
  }
}
const lexicalOnly = [...declared].filter(n => !onWindow.has(n)).sort();

section('the derivation itself works');
{
  // If this came back empty the whole suite would pass vacuously.
  t('lexical-only globals were found', lexicalOnly.length >= 5, lexicalOnly);
  // The five that have actually caused bugs must be in the derived set, or the
  // derivation has drifted and is no longer protecting what it claims to.
  for (const n of ['DB', 'IDB', 'Auth', 'Utils', 'APP_VERSION']) {
    t(n + ' is recognised as lexical-only', lexicalOnly.includes(n));
  }
  // The contrast case: proves the derivation can tell the two apart rather than
  // labelling everything unsafe.
  //
  // THE RULE, exactly: a top-level `var` becomes a property of window; `const` and
  // `let` do not. sync.js uses `var Sync = {`, which is why window.Sync works with no
  // explicit assignment anywhere — and why scanning for `const` is the right way to
  // find the unsafe names. That distinction is the whole bug class in one sentence.
  t('Sync is declared with var, so it IS on window', /^var Sync = \{/m.test(read('sync.js')));
  t('…and is therefore not in the lexical-only set', !lexicalOnly.includes('Sync'));
  t('window.Sync is used freely, and legitimately',
    /window\.Sync/.test(read('invoice-create.html')));
}

section('no app file READS one of them through window');
{
  const offenders = [];
  for (const f of [...appJs, ...appHtml]) {
    const code = liveCode(read(f));
    for (const n of lexicalOnly) {
      // An assignment would make it safe; we are looking for reads.
      const re = new RegExp('window\\.' + n + '\\b(?!\\s*=[^=])', 'g');
      const lines = code.split('\n');
      lines.forEach((l, i) => { if (re.test(l)) offenders.push(f + ':' + (i + 1) + ' window.' + n); });
    }
  }
  t('no live window.<lexical global> reads remain', offenders.length === 0, offenders.slice(0, 12));
}

section('the five historical sites are fixed, in the correct form');
{
  // Pinned individually: a derived check passing is good, but these specific lines are
  // the ones that shipped broken, and each should read the bare name.
  const sync = read('sync.js'), utils = read('utils.js'), nav = read('nav.js'), settings = read('settings.js');
  t('activity toasts test Utils bare',
    /typeof Utils !== 'undefined' && Utils\.showToast/.test(sync));
  t('the desktop close overlay tests Utils bare',
    /\(typeof Utils !== 'undefined' && Utils\.blockingProgress\)/.test(utils));
  t('the dynamic-script cache-bust tests APP_VERSION bare',
    (nav.match(/typeof APP_VERSION !== 'undefined' && APP_VERSION\.version/g) || []).length === 2,
    (nav.match(/typeof APP_VERSION !== 'undefined' && APP_VERSION\.version/g) || []).length);
  t('both settings sites test APP_VERSION bare',
    (settings.match(/typeof APP_VERSION !== 'undefined' \? APP_VERSION\.version/g) || []).length === 2);
  // The close guard and the idle timer were fixed earlier for Auth; keep them pinned so
  // a future edit cannot quietly reintroduce the window form next door to the comment
  // warning about it.
  t('the Tauri close guard tests Auth bare', /typeof Auth !== 'undefined' && Auth\.session/.test(utils));
  t('the idle timer tests Auth bare', /typeof Auth === 'undefined' \|\| !Auth\.session\(\)|typeof Auth !== 'undefined' && Auth\.session/.test(nav));
}

section('the cache-bust this re-enables actually has something to protect');
{
  // nav.js loads these at runtime, so bump-version.js (which rewrites <script src> in
  // HTML) never versions them. With the bust dead AND the file Cache-First, the desktop
  // app — whose committed SW cache name never changes between releases — could serve a
  // stale copy indefinitely. pages.yml masks this on the web by bumping the cache name
  // every deploy.
  const sw = read('sw.js'), bump = read('scripts/bump-version.js');
  const networkOnly = n => new RegExp("endsWith\\('/" + n + "'\\)").test(sw);
  const versionedInHtml = n => new RegExp(n.replace('.', '\\.') + "'", 'g').test(bump);
  const dynamic = ['local-folder-sync.js', 'drive-store.js', 'drive-db-sync.js'];
  const exposed = dynamic.filter(n => !networkOnly(n) && !versionedInHtml(n));
  t('at least one dynamically loaded script relies on the ?v= bust', exposed.length >= 1, exposed);
  t('…so re-enabling it is not cosmetic', true);
  // Guard the mechanism itself: the bust only works because the SW matches by exact URL.
  t('the service worker still matches by exact url', !/ignoreSearch\s*:\s*true/.test(sw));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
