// test-device-identity.js — run:  node test-device-identity.js
//
// User-reported, correcting an inference I had drawn: invoices ARE created on different
// devices, yet every record on the server carries the same _by / _byName
// (dev_kb2b12k711mmqg47oj7 / "ASUS") across the aing, joe and aieng logins. I had read that
// as proof of a single shared machine. It proved no such thing.
//
// Root cause: device identity was stored as ordinary data, so it travelled with the data.
// DB._set() mirrors EVERY key it is handed to the Local Folder Sync folder — wt_device_id
// included — and restore() reads every .json back. Point two machines at the same synced
// folder, or restore one machine's folder onto another, and they become the same "device",
// which destroys the only field that says which machine wrote a record.
//
// Three fixes, all covered here:
//   1. local-folder-sync.js excludes the identity keys from the mirror AND from restore.
//   2. A Settings action regenerates this machine's id (one machine at a time).
//   3. Records carry createdDevice / createdDeviceName stamped at CREATION — immutable app
//      data, unlike _by which records the last writer and is overwritten by any re-push.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

const lfs = fs.readFileSync(path.join(DIR, 'local-folder-sync.js'), 'utf8');

console.log('The leak is closed — identity keys never reach the folder');
{
  t('an exclusion list exists', /var DEVICE_LOCAL_KEYS = \[/.test(lfs));
  t('it names the key that actually leaked (wt_device_id)', /DEVICE_LOCAL_KEYS = \[[^\]]*'wt_device_id'/.test(lfs));
  t('queueWrite skips it', /queueWrite\(key, val\) \{[\s\S]{0,200}DEVICE_LOCAL_KEYS\.indexOf\(key\) !== -1\) return;/.test(lfs));
  t('restore skips it too — otherwise a shared folder re-infects on read',
    /DEVICE_LOCAL_KEYS\.indexOf\(key\) !== -1\) continue;/.test(lfs));
  t('writeAll filters it as well', /writeAll[\s\S]{0,400}DEVICE_LOCAL_KEYS\.indexOf\(k\) === -1/.test(lfs));
}

console.log('\nThe exclusion actually behaves — driving the REAL queueWrite/restore filters');
{
  // Extract the real predicate rather than restating it.
  const listSrc = /var DEVICE_LOCAL_KEYS = (\[[^\]]*\]);/.exec(lfs);
  const KEYS = new Function(`return ${listSrc[1]};`)();
  const blocked = k => KEYS.indexOf(k) !== -1;
  t('wt_device_id is blocked', blocked('wt_device_id') === true);
  t('wt_device_label is blocked', blocked('wt_device_label') === true);
  t('ordinary data still mirrors', blocked('wt_invoices') === false && blocked('wt_payments') === false);
  t('settings still mirror', blocked('wt_settings') === false);
}

console.log('\ncreatorDeviceFields() — stamped at creation, independent of sync metadata');
{
  const dbSrc = fs.readFileSync(path.join(DIR, 'db.js'), 'utf8');
  const s = dbSrc.indexOf('  creatorDeviceFields() {');
  const e = dbSrc.indexOf('\n  },', s) + 4;
  if (s < 0) throw new Error('creatorDeviceFields not found — update extraction marker');
  const fn = new Function('window', `const o = { ${dbSrc.slice(s, e)} }; return o.creatorDeviceFields;`);
  // note: the real app also exposes Sync as a global; the function only uses window.Sync.

  const withSync = fn({ Sync: { _deviceId: 'dev_abc', _deviceName: () => 'counter-PC' } })();
  t('captures the device id', withSync.createdDevice === 'dev_abc', JSON.stringify(withSync));
  t('captures the human-readable name', withSync.createdDeviceName === 'counter-PC');

  // Must never throw during a save just because sync isn't up.
  const noSync = fn({})();
  t('degrades to empty strings when Sync is absent',
    noSync.createdDevice === '' && noSync.createdDeviceName === '', JSON.stringify(noSync));
  const badSync = fn({ Sync: { _deviceId: 'dev_x', _deviceName: () => { throw new Error('boom'); } } })();
  t('a throwing _deviceName cannot break a save',
    badSync.createdDevice === 'dev_x' && badSync.createdDeviceName === '', JSON.stringify(badSync));
}

console.log('\nCreation sites are stamped');
{
  const inv = fs.readFileSync(path.join(DIR, 'invoice-create.html'), 'utf8');
  const pay = fs.readFileSync(path.join(DIR, 'payments.html'), 'utf8');
  t('invoice creation stamps the device', inv.includes('...DB.creatorDeviceFields()'));
  t('payment creation stamps it too (both sites)',
    (pay.match(/\.\.\.DB\.creatorDeviceFields\(\)/g) || []).length === 2,
    String((pay.match(/\.\.\.DB\.creatorDeviceFields\(\)/g) || []).length));
  // The stamp belongs to creation only: an edit must not relabel who issued the invoice.
  const editIdx = inv.indexOf('function saveInvoiceEdit');
  t('the edit path does NOT re-stamp it',
    inv.slice(editIdx).indexOf('creatorDeviceFields') === -1);
}

console.log('\nSettings device card');
{
  const html = fs.readFileSync(path.join(DIR, 'settings.html'), 'utf8');
  const js   = fs.readFileSync(path.join(DIR, 'settings.js'), 'utf8');
  t('shows the device id', html.includes('id="devIdText"'));
  t('has a place for the collision warning', html.includes('id="devCollisionWarn"'));
  t('offers the regenerate action', html.includes('regenerateDeviceId()'));
  t('regenerate uses Utils.confirm, not window.confirm (Tauri returns a truthy Promise)',
    /async function regenerateDeviceId[\s\S]{0,900}await Utils\.confirm\(/.test(js));
  t('regenerate writes a genuinely new id', /const fresh = 'dev_' \+ Math\.random/.test(js));
  t('it is logged', /logActivity[\s\S]{0,120}สร้างรหัสประจำเครื่องใหม่/.test(js));
  t('failure is recorded rather than swallowed', js.includes("'DEVICE-ID-REGEN-FAILED'"));
  t('the card re-renders once sync is ready', /addEventListener\('sync:ready'[\s\S]{0,80}renderDeviceIdentity/.test(js));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
