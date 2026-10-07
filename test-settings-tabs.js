// test-settings-tabs.js — v1.0.249
//
// settings.html's 23 cards were regrouped from one ~1,000-line scroll into six
// Bootstrap tabs. The cards were MOVED, not rewritten — so the real risk is not
// that a tab looks wrong, it is that the cut-and-paste silently dropped a card,
// an element id, or a permission gate (.admin-only / inline display:none) that
// settings.js relies on. Nearly every id below is wired up by getElementById in
// settings.js; losing one is a silent TypeError on a button the user needs.
//
// This suite therefore pins the INVENTORY, not the layout: every card, every id,
// every gate, each still present exactly once and in a known tab.
//
// Run: node test-settings-tabs.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const html = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
const js   = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
const L    = html.split('\n');

const TABS = ['general', 'backup', 'sync', 'repair', 'check', 'danger'];
const EXPECTED = { general: 3, backup: 7, sync: 4, repair: 5, check: 3, danger: 1 };

// ── walk the panes with a div-depth counter; a card is a depth-1 pane child ──
const panes = {};
{
  let cur = null, depth = 0, buf = [];
  for (const line of L) {
    const open  = (line.match(/<div\b/g) || []).length;
    const close = (line.match(/<\/div>/g) || []).length;
    const m = /data-pane="([a-z]+)"/.exec(line);
    if (m && !cur) { cur = m[1]; depth = open - close; buf = []; continue; }
    if (!cur) continue;
    if (depth + open - close <= 0) { panes[cur] = buf.join('\n'); cur = null; continue; }
    if (depth === 1 && /^ {4}<div [^>]*class="card\b/.test(line)) buf.push('@@CARD@@' + line);
    else buf.push(line);
    depth += open - close;
  }
}

section('all six tabs exist, each with the cards it was given');
{
  t('tab nav is present', /id="settingsTabs"/.test(html));
  t('tab content container is present', /id="settingsTabContent"/.test(html));
  TABS.forEach(id => {
    t('tab "' + id + '" has a button and a pane',
      html.includes('id="tabBtn-' + id + '"') && html.includes('id="tab-' + id + '"'));
  });
  let total = 0;
  TABS.forEach(id => {
    const n = (panes[id] || '').split('@@CARD@@').length - 1;
    total += n;
    t('tab "' + id + '" holds ' + EXPECTED[id] + ' cards', n === EXPECTED[id], n);
  });
  t('all 23 cards are accounted for, none orphaned', total === 23, total);
  // A card left outside every pane would render above the tabs and be uncounted.
  const allCards = (html.match(/<div [^>]*class="card mb-4/g) || []).length;
  t('…and settings.html contains no card outside a pane', allCards === 23, allCards);
}

section('exactly one tab opens by default, and it is the first');
{
  t('one pane is show active', (html.match(/class="tab-pane fade show active"/g) || []).length === 1);
  t('one nav-link is active', (html.match(/class="nav-link active"/g) || []).length === 1);
  t('the active pane is the first tab',
    html.indexOf('show active') < html.indexOf('id="tab-backup"'));
  t('Danger Zone is last and flagged red',
    TABS[TABS.length - 1] === 'danger' && /nav-link text-danger/.test(html));
}

section('every permission gate survived the move');
{
  // If a gate were lost in the paste, a non-admin would suddenly see an admin tool.
  const adminCards = (html.match(/<div class="card mb-4 admin-only/g) || []).length;
  t('17 admin-only cards still carry the class', adminCards === 17, adminCards);
  ['backupCard', 'custPriceRestoreCard', 'importCard', 'invLookupCard', 'staleBalCard', 'driveCard']
    .forEach(id => {
      const line = L.find(l => l.includes('id="' + id + '"') && /class="card/.test(l));
      t(id + ' is still hidden until its gate runs',
        !!line && /style="display:none"/.test(line), line && line.trim().slice(0, 80));
    });
  t('settings.js still hides .admin-only itself (the tabs do not duplicate the rule)',
    /querySelectorAll\('\.admin-only'\)/.test(js));
}

section('every element id settings.js touches still exists in the HTML');
{
  const ids = new Set();
  const seen = new Map();
  for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) {
    ids.add(m[1]);
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const wanted = new Set();
  for (const m of js.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)) wanted.add(m[1]);

  // These twelve live inside markup settings.js injects itself (the cleanup
  // card's preview, the sync panel's push output, the stale-balance and
  // invoice-lookup result tables, the restore button) — they were never in
  // settings.html, before or after the regroup. Everything else must be static
  // markup, so a static id lost in the paste shows up here rather than hiding
  // behind a blanket exemption.
  const RUNTIME_IDS = ['scLogs', 'scPrice', 'scPriceKeep', 'scPreviewAlert', 'btnRunCleanup',
    'pushMissingOut', 'staleGoBtn', 'staleSummary', 'staleChkAll', 'invDelBtn', 'invDelCount',
    'cpRestoreBtn'];
  const notInjected = RUNTIME_IDS.filter(id => !js.includes('id="' + id + '"'));
  t('every exempted id really is built by settings.js at runtime',
    notInjected.length === 0, notInjected);

  const missing = [...wanted].filter(id => !ids.has(id) && !RUNTIME_IDS.includes(id));
  t('no static id referenced by settings.js is missing from settings.html',
    missing.length === 0, missing);
  t('…and the scan actually found ids to check', wanted.size > 50, wanted.size);
  // A duplicated id breaks getElementById silently — the first one wins.
  const dupes = [...seen].filter(([, v]) => v > 1).map(([k, v]) => k + '×' + v);
  t('no id was duplicated by the move', dupes.length === 0, dupes);
}

section('the counting pass reads the real gated state');
{
  // Counting before the gates ran would show admin numbers to everyone; counting
  // a pane's own visibility would report 0 for every closed tab.
  t('_tabsRefresh exists', /function _tabsRefresh\(\)/.test(js));
  t('it counts per pane via data-pane', /\[data-pane\]/.test(js));
  t('a pane being inactive does not make its cards invisible',
    !/offsetParent/.test(js) &&
    /function _tabCardVisible\(card\) \{\s*return card\.style\.display/.test(js));
  t('an empty tab is hidden, not left to open onto nothing',
    /li\.style\.display = n \? '' : 'none'/.test(js));
  t('a user whose remembered tab is empty is moved to a live one',
    /!activeLive && firstLive/.test(js));
  t('it re-runs when a gate writes display (observer), not on a hand-kept list',
    /MutationObserver/.test(js) && /attributeFilter: \['style', 'class'\]/.test(js));
  t('…and the observer is debounced', /clearTimeout\(t\)/.test(js) && /setTimeout\(_tabsRefresh/.test(js));
  t('the observer watches the content, not the nav it writes to (no feedback loop)',
    /\.observe\(content,/.test(js) && !/\.observe\(document\.getElementById\('settingsTabs'\)/.test(js));
  t('the open tab is remembered', /sessionStorage\.setItem\(_TAB_KEY/.test(js));
  t('…and restored on the next visit', /sessionStorage\.getItem\(_TAB_KEY/.test(js));
  t('storage access is wrapped (private mode throws)',
    /try \{ sessionStorage\.setItem\(_TAB_KEY/.test(js));
  t('_tabsInit runs on DOMContentLoaded', /DOMContentLoaded[\s\S]{0,80}_tabsInit\(\)/.test(js));
}

section('bootstrap can actually drive these tabs');
{
  t('each button declares data-bs-toggle="tab"',
    (html.match(/data-bs-toggle="tab"/g) || []).length === 6);
  TABS.forEach(id => {
    t('tab "' + id + '" button targets its own pane',
      html.includes('data-bs-target="#tab-' + id + '"'));
  });
  // bootstrap.Tab must exist by the time _tabsInit runs. Match the script TAGS —
  // "settings.js" also appears in prose in the tab comment, much earlier.
  t('bootstrap bundle is loaded before settings.js',
    html.indexOf('src="./vendor/bootstrap.bundle.min.js"') < html.indexOf('src="settings.js'));
}

section('the page still closes cleanly');
{
  const start = L.findIndex(l => l.includes('class="page-wrap"'));
  const end   = L.findIndex(l => l.includes('/page-wrap'));
  let depth = 0;
  for (let i = start; i <= end; i++) {
    depth += (L[i].match(/<div\b/g) || []).length - (L[i].match(/<\/div>/g) || []).length;
  }
  t('page-wrap div nesting balances', depth === 0, depth);
  t('tab-content closes', /<\/div><!-- \/tab-content -->/.test(html));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
