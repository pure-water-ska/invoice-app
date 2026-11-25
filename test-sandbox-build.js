// test-sandbox-build.js — v1.0.264
//
// A release used to be tried for the first time ON THE BUSINESS. v1.0.258 shipped a
// cropping regression and v1.0.262 is still suspected in the desktop print fault, both
// found only after the real app had updated itself. The sandbox exists so a build can
// be exercised on the real machine first.
//
// It only helps if it genuinely cannot touch production, and the three things that keep
// it apart are one-line config values that a careless edit would undo silently:
//   * bundle identifier  → Tauri derives %APPDATA%\<identifier>\ from it, so a shared
//     identifier means a SHARED HDD store, and DB._tauri.write rewrites each
//     wt_*.json whole-file — the two apps would clobber each other's invoices;
//   * Firestore orgId     → everything lives under orgs/<orgId>/…, so a shared orgId
//     means test invoices, customers and prices written into the real data;
//   * updater off + prerelease → the production updater polls releases/latest, so a
//     sandbox published as a normal release would install itself on every device.
//
// This suite patches a throwaway copy (MTB_ROOT) rather than the real checkout.
//
// Run: node test-sandbox-build.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts', 'make-test-build.js');
const FILES = ['src-tauri/tauri.conf.json', 'firebase-config.js', 'utils.js'];

// ── run the patcher against a disposable copy ───────────────────────────────
function runPatcher(suffix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sandbox-'));
  fs.mkdirSync(path.join(tmp, 'src-tauri'), { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(tmp, f), read(f));
  const out = execFileSync(process.execPath, [SCRIPT, suffix || 'test'], {
    env: Object.assign({}, process.env, { MTB_ROOT: tmp }), encoding: 'utf8'
  });
  const after = {};
  for (const f of FILES) after[f] = fs.readFileSync(path.join(tmp, f), 'utf8');
  return { tmp, out, after, conf: JSON.parse(after['src-tauri/tauri.conf.json']) };
}

const before = {
  conf: JSON.parse(read('src-tauri/tauri.conf.json')),
  fb: read('firebase-config.js'),
};
const r = runPatcher('test');

section('the repo itself always holds the PRODUCTION configuration');
{
  // The patch is applied inside CI, never committed — otherwise a later `v…` tag would
  // build and publish a sandbox AS the real release.
  t('identifier is production', before.conf.tauri.bundle.identifier === 'com.wt.invoice',
    before.conf.tauri.bundle.identifier);
  t('the updater is on', before.conf.tauri.updater.active === true);
  t('orgId is main', /orgId:\s*"main"/.test(before.fb));
  t('the patcher is not run by npm bump or any build hook',
    !/make-test-build/.test(read('package.json')) &&
    !/make-test-build/.test(read('scripts/bump-version.js')));
}

section('its own data folder — the sandbox cannot share the HDD store');
{
  t('the identifier changes', r.conf.tauri.bundle.identifier === 'com.wt.invoice.test',
    r.conf.tauri.bundle.identifier);
  t('…and is a strict suffix of the real one, not a rename',
    r.conf.tauri.bundle.identifier.startsWith(before.conf.tauri.bundle.identifier + '.'));
  // Same identifier would mean %APPDATA%\com.wt.invoice\data\wt_invoices.json shared by
  // both apps. This is the assertion that matters most in the whole file.
  t('it is NOT the production identifier',
    r.conf.tauri.bundle.identifier !== before.conf.tauri.bundle.identifier);
  // main.rs derives the single-instance lock port from the identifier, so the two apps
  // also stop fighting over one port (see test-single-instance.js).
  t('main.rs keys the instance lock off the identifier, so both can run at once',
    /port_for\(&ctx\.config\(\)\.tauri\.bundle\.identifier\)/
      .test(read('src-tauri/src/main.rs')));
}

section('its own Firestore root — real invoices, customers and prices are untouched');
{
  t('orgId becomes test', /orgId:\s*"test"/.test(r.after['firebase-config.js']));
  t('…and main is gone', !/orgId:\s*"main"/.test(r.after['firebase-config.js']));
  // The org root is built from this single value, so changing it moves EVERY read and
  // write at once — collections, documents and the per-record sync modules alike.
  const sync = read('sync.js');
  t('sync.js takes the org from orgId', /_orgId = FIREBASE_CONFIG\.orgId/.test(sync));
  t('…and every path hangs off that one org document',
    /collection\('orgs'\)\.doc\(this\._orgId\)/.test(sync));
  // Only the ROOT changes: same project, same credentials, so sync is really exercised
  // rather than silently disabled — a sandbox that cannot sync would not test much.
  t('the Firebase project is unchanged', r.after['firebase-config.js'].replace(/orgId:\s*"test"/, 'orgId:        "main"') === before.fb);
}

section('it can never be served as an update to the real app');
{
  t('the updater is switched off', r.conf.tauri.updater.active === false);
  // Left on, the sandbox would poll releases/latest and replace itself with the
  // production build — losing the thing under test.
  t('the endpoint is removed too, not just disabled',
    !('endpoints' in r.conf.tauri.updater));

  const wf = read('.github/workflows/release-test.yml');
  t('the sandbox workflow publishes a PRERELEASE', /prerelease:\s*true/.test(wf));
  // latest.json IS the production update channel. A sandbox that wrote one would push
  // itself onto every device — the single worst mistake available here.
  t('it does NOT write latest.json', !/latest\.json/.test(wf.replace(/^\s*#.*$/gm, '')));
  t('…and the reason is written down for whoever edits it next',
    /latest\.json/.test(wf) && /Do not add that step/.test(wf));
  t('it is triggered only by a test-v tag', /- 'test-v\*'/.test(wf) && !/- 'v\*'/.test(wf));
  t('it runs the patcher before building',
    wf.indexOf('make-test-build.js') < wf.indexOf('tauri-apps/tauri-action'));
  t('…and verifies the isolation in CI rather than trusting it',
    /com\.wt\.invoice\.test/.test(wf) && /orgId:\s+"test"/.test(wf));
  t('no updater signing key is passed to the sandbox build',
    !/TAURI_PRIVATE_KEY/.test(wf));

  const prod = read('.github/workflows/release-desktop.yml');
  t('the production workflow still ignores test tags', !/test-v/.test(prod));
  t('…and is the only one that generates latest.json', /latest\.json/.test(prod));
}

section('it is obvious on screen which build is running');
{
  // Two windows with the same layout, one holding real data: the version label in the
  // navbar is what tells them apart in a screenshot.
  t('the version label is tagged', /\[TEST\]'/.test(r.after['utils.js']));
  t('the product name says ทดสอบ', /\(ทดสอบ\)$/.test(r.conf.package.productName),
    r.conf.package.productName);
  t('…and keeps the real name as its prefix',
    r.conf.package.productName.startsWith(before.conf.package.productName));
  t('only the CURRENT version label is touched, not the changelog entries',
    (r.after['utils.js'].match(/\[TEST\]/g) || []).length === 1);
}

section('the patcher refuses to do anything it cannot do correctly');
{
  // Running it twice would give com.wt.invoice.test.test and a doubled (ทดสอบ).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sandbox2-'));
  fs.mkdirSync(path.join(tmp, 'src-tauri'), { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(tmp, f), r.after[f]);
  let threw = false;
  try {
    execFileSync(process.execPath, [SCRIPT, 'test'],
      { env: Object.assign({}, process.env, { MTB_ROOT: tmp }), stdio: 'pipe' });
  } catch { threw = true; }
  t('re-running on an already-patched tree fails instead of double-patching', threw);

  // A silent no-op is the dangerous failure: the build would succeed and look like a
  // sandbox while writing to orgs/main.
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sandbox3-'));
  fs.mkdirSync(path.join(tmp3, 'src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(tmp3, 'src-tauri/tauri.conf.json'), read('src-tauri/tauri.conf.json'));
  fs.writeFileSync(path.join(tmp3, 'firebase-config.js'), 'const FIREBASE_CONFIG = { orgId: "something-else" };');
  fs.writeFileSync(path.join(tmp3, 'utils.js'), read('utils.js'));
  let threw3 = false;
  try {
    execFileSync(process.execPath, [SCRIPT, 'test'],
      { env: Object.assign({}, process.env, { MTB_ROOT: tmp3 }), stdio: 'pipe' });
  } catch { threw3 = true; }
  t('an unexpected orgId is a hard failure, not a silent skip', threw3);

  t('a different suffix gives a different identifier',
    runPatcher('staging').conf.tauri.bundle.identifier === 'com.wt.invoice.staging');
  t('it reports every change it made',
    /identifier/.test(r.out) && /orgId/.test(r.out) && /updater/.test(r.out));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
