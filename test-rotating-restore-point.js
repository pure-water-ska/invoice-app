// test-rotating-restore-point.js — v1.0.244
//
// The close handler used to write ONE file, _restore_on_close.json, overwritten by every
// clean close. On 23 Sep 2026 that destroyed a 4 Sep snapshot which was by then the only
// surviving copy of 99 customers and 3,279 pricing rules — and it had only survived that
// long because the app happened not to close cleanly in between. Now it writes one file
// per DAY, so a good snapshot can no longer be destroyed by the next close.
//
// Nothing is ever deleted: the desktop fs allowlist has readFile/writeFile/readDir/
// createDir but NO removeFile, and adding it is a binary change that would force every
// device onto a fresh .msi. Old files are the user's to clear.
//
// Run: node test-rotating-restore-point.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ── The picker, sliced out of settings.js ──────────────────────────────────
function loadPicker() {
  const src = read('settings.js');
  const s = src.indexOf('function _cpPickNewestRestoreFile(names) {');
  if (s < 0) throw new Error('_cpPickNewestRestoreFile not found');
  const e = src.indexOf('\n}', s);
  return new Function(src.slice(s, e + 2) + '\nreturn _cpPickNewestRestoreFile;')();
}

section('_cpPickNewestRestoreFile — newest day first, legacy last');
{
  const pick = loadPicker();

  t('the newest date comes first',
    pick(['_restore_on_close-2026-09-20.json', '_restore_on_close-2026-09-23.json'])[0]
      === '_restore_on_close-2026-09-23.json');
  t('…regardless of input order',
    pick(['_restore_on_close-2026-09-23.json', '_restore_on_close-2026-09-20.json'])[0]
      === '_restore_on_close-2026-09-23.json');
  t('month and year sort correctly, not lexically by day',
    pick(['_restore_on_close-2026-09-04.json', '_restore_on_close-2026-10-01.json'])[0]
      === '_restore_on_close-2026-10-01.json');
  t('a year boundary sorts correctly',
    pick(['_restore_on_close-2027-01-02.json', '_restore_on_close-2026-12-31.json'])[0]
      === '_restore_on_close-2027-01-02.json');

  const all = pick(['_restore_on_close.json', '_restore_on_close-2026-09-20.json',
                    '_restore_on_close-2026-09-23.json']);
  t('every candidate is returned, so an unreadable one can be skipped', all.length === 3, all.length);
  t('the undated legacy file is tried LAST', all[all.length - 1] === '_restore_on_close.json', all);
  // Legacy-last must fall out of the date comparison itself ('' sorts after any date),
  // not a special case — a two-element check pins that directly.
  t('legacy sorts after a date, whichever order it arrives in',
    pick(['_restore_on_close.json', '_restore_on_close-2026-01-01.json'])[0]
      === '_restore_on_close-2026-01-01.json' &&
    pick(['_restore_on_close-2026-01-01.json', '_restore_on_close.json'])[0]
      === '_restore_on_close-2026-01-01.json');

  // Nothing else in the data folder may be mistaken for a restore point.
  const mixed = pick(['wt_invoices.json', 'wt_customers.json', '_restore_on_close-2026-09-23.json',
                      '_hddtest.json', 'restore-point-2026-09-04.json', '_restore_on_close-bad.json',
                      '_restore_on_close-2026-09-23.json.bak']);
  t('only real restore-point names are considered', mixed.length === 1, mixed);
  t('…and it is the dated one', mixed[0] === '_restore_on_close-2026-09-23.json');

  t('an empty folder yields nothing', pick([]).length === 0);
  t('null input is safe', pick(null).length === 0);
}

// ── The close handler ──────────────────────────────────────────────────────
section('the close handler writes a DATED file');
{
  const src = read('utils.js');
  const i = src.indexOf('Best-effort restore point written straight to the data folder');
  const block = src.slice(i, i + 2200);

  t('the filename carries a date stamp', /_restore_on_close-' \+ stamp \+ '\.json/.test(block),
    (block.match(/_restore_on_close[^)]*\.json'/) || [])[0]);
  t('the stamp is built from the local date', /getFullYear\(\)/.test(block) && /getMonth\(\) \+ 1/.test(block) && /getDate\(\)/.test(block));
  t('month and day are zero-padded, so names sort correctly',
    (block.match(/padStart\(2, '0'\)/g) || []).length === 2);
  t('it no longer writes the single overwritable slot',
    !/'_restore_on_close\.json'/.test(block));
  t('it still writes the full backup payload', /buildBackupPayload\(\)/.test(block));
  t('it is still wrapped so a failure cannot block the close', /try \{/.test(src.slice(i - 200, i + 100)));

  // Reproduce the stamp the handler builds and check it round-trips through the picker.
  const d = new Date('2026-09-04T22:49:00');
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
                '-' + String(d.getDate()).padStart(2, '0');
  t('the stamp format is YYYY-MM-DD', stamp === '2026-09-04', stamp);
  const name = '_restore_on_close-' + stamp + '.json';
  t('a name the handler produces is recognised by the picker',
    loadPicker()([name]).length === 1, name);
}

section('the desktop app genuinely cannot delete — rotation must not assume it can');
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const fsAllow = conf.tauri.allowlist.fs || {};
  t('removeFile is NOT permitted', !fsAllow.removeFile);
  t('fs.all is not enabled either', fsAllow.all !== true);
  t('readDir IS permitted (the picker needs it)', fsAllow.readDir === true);
  t('writeFile IS permitted', fsAllow.writeFile === true);
  const cargo = read('src-tauri/Cargo.toml');
  t('no fs-remove-file Cargo feature', !/fs-remove-file/.test(cargo));
  // If any of the above ever changes, pruning becomes possible — but it is a BINARY
  // change needing a fresh .msi, so it must be a deliberate decision, not a drive-by.
  // Comments may MENTION removeFile (utils.js documents why it is not used) — what
  // matters is that no code CALLS it.
  const calls = f => read(f).split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .some(l => /removeFile\s*\(/.test(l));
  t('nothing in settings.js or utils.js CALLS removeFile', !calls('settings.js') && !calls('utils.js'));
}

section('the reader survives a half-written file');
{
  const src = read('settings.js');
  const i = src.indexOf('async function _cpReadRestorePoint()');
  const body = src.slice(i, src.indexOf('\n}', i));
  t('it loops over candidates rather than reading one path', /for \(const name of _cpPickNewestRestoreFile/.test(body));
  t('a parse failure falls through to the next oldest', /catch \(e\) \{ \/\* unreadable/.test(body));
  t('it validates the payload before accepting it',
    /Array\.isArray\(v\.customers\)/.test(body) && /Array\.isArray\(v\.pricing\)/.test(body));
  t('a readDir failure still tries the legacy name',
    /names = \['_restore_on_close\.json'\]/.test(body));
  t('it returns null when nothing is usable', /return null;\s*$/.test(body.trim()));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
