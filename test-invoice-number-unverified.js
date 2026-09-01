// test-invoice-number-unverified.js — run:  node test-invoice-number-unverified.js
//
// Production incident (31 Aug 2026): an invoice saved at 16:24 was issued 310869-003 when
// 003 and 004 had existed on the server since 06:39 and 08:45 that same day. Not a race —
// eight hours apart, and all from ONE machine (every invoice since 25 Aug carries the same
// device id, so aing/joe/aieng are logins on a shared PC, not separate devices).
//
// The numbering has three tiers: atomic (Firestore transaction) → checked (server query) →
// local (offline, unverified). Both server tiers return null the instant Sync isn't
// connected — which is the normal state for a few seconds after the app opens, since
// DB.ready resolves before the Firestore listener delivers anything. Both catch blocks
// only console.warn, invisible in the desktop build.
//
// So a number that could NOT be verified was indistinguishable from one that was, and the
// duplicate surfaced only the next day. This does not change the numbering (offline-first:
// a save must never be blocked) — it makes the unverified case SAY SO and get recorded.
//
// Extracts the REAL allocation block from invoice-create.html.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'invoice-create.html'), 'utf8');

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

const s = src.indexOf('  const _firstNum = DB.invoiceNumberCandidate(_dateISO, 0);');
const e = src.indexOf('  DB.commitInvoiceNumber(_dateISO, invNumber);');
if (s < 0 || e < s) throw new Error('allocation block not found — update extraction markers');
const block = src.slice(s, e);

// Runs the REAL block against a controllable Sync/DB and reports what happened.
function allocate({ sync, localCandidate = '310869-003', localFloor = 2 }) {
  const errors = [], acts = [], alerts = [];
  const DB = {
    invoiceNumberCandidate: () => localCandidate,
    _invNumParts: () => ({ dateKey: '2026-08-31', prefix: '310869-' }),
    localFloorRunForDate: () => localFloor,
    logError: (type, msg, detail) => errors.push({ type, msg, detail }),
    logActivity: (uid, un, action, detail) => acts.push({ action, detail }),
  };
  const Utils = { showAlert: (m, kind) => alerts.push({ m, kind }) };
  const fn = new Function('DB', 'Utils', 'window', 'Sync', 'session', 'customerId', '_dateISO', 'console',
    `return (async () => { ${block} return { invNumber, _numSource, _numWhy }; })();`);
  return fn(DB, Utils, { Sync: sync }, sync, { userId: 'u', username: 'joe', name: 'Joe' },
            'c1', '2026-08-31', { warn(){}, log(){} })
    .then(r => ({ ...r, errors, acts, alerts }));
}

// The pre-existing "เลขที่ X ถูกใช้แล้ว — เปลี่ยนเป็น Y" alert fires whenever the number was BUMPED, which is
// correct and unrelated. Only the new unverified warning is under test here.
const unverifiedAlerts = alerts => alerts.filter(a => /ยังไม่ได้ตรวจกับเซิร์ฟเวอร์/.test(a.m));

const okSync = (num) => ({
  ready: true,
  reserveInvoiceNumberAtomic: async () => ({ number: num, run: parseInt(num.slice(-3), 10) }),
  reserveFreeInvoiceNumber: async () => ({ number: num, verified: true }),
});

(async () => {

console.log('Healthy path — atomic wins, nothing is warned or logged');
{
  const r = await allocate({ sync: okSync('310869-005') });
  t('uses the atomic number', r.invNumber === '310869-005', r.invNumber);
  t('source is atomic', r._numSource === 'atomic');
  t('no error logged', r.errors.length === 0);
  t('no unverified warning', unverifiedAlerts(r.alerts).length === 0, JSON.stringify(r.alerts.map(a=>a.m)));
}

console.log('\nThe actual incident — Sync not connected yet, so BOTH tiers return null');
{
  // reserveInvoiceNumberAtomic and reserveFreeInvoiceNumber both bail on !ready.
  const notReady = {
    ready: false,
    reserveInvoiceNumberAtomic: async () => null,
    reserveFreeInvoiceNumber: async () => ({ number: '310869-003', verified: false }),
  };
  const r = await allocate({ sync: notReady });
  t('falls back to the local number (save is never blocked)', r.invNumber === '310869-003', r.invNumber);
  t('source stays local', r._numSource === 'local');
  t('an error IS recorded now', r.errors.length === 1 && r.errors[0].type === 'INV-NUMBER-UNVERIFIED',
    JSON.stringify(r.errors.map(x => x.type)));
  t('the reason names the real cause — saved before sync connected',
    /not connected yet/.test(r.errors[0].detail.reason), r.errors[0].detail.reason);
  t('the user is warned at save time', unverifiedAlerts(r.alerts).length === 1);
  t('the warning names the number', unverifiedAlerts(r.alerts)[0].m.includes('310869-003'));
  t('an activity entry is written too', r.acts.length === 1, JSON.stringify(r.acts.map(a => a.action)));
  t('the local floor is captured for diagnosis', r.errors[0].detail.localFloor === 2);
}

console.log('\nAtomic throws, checked tier rescues it — verified, so no warning');
{
  const sync = {
    ready: true,
    reserveInvoiceNumberAtomic: async () => { throw new Error('transaction aborted'); },
    reserveFreeInvoiceNumber: async () => ({ number: '310869-005', verified: true }),
  };
  const r = await allocate({ sync });
  t('checked tier supplies the number', r.invNumber === '310869-005' && r._numSource === 'checked');
  t('no unverified error, because it WAS verified', r.errors.length === 0);
  t('no unverified warning', unverifiedAlerts(r.alerts).length === 0);
}

console.log('\nAtomic returns null, checked cannot verify — warned, and both reasons kept');
{
  const sync = {
    ready: true,
    reserveInvoiceNumberAtomic: async () => null,
    reserveFreeInvoiceNumber: async () => ({ number: '310869-003', verified: false }),
  };
  const r = await allocate({ sync });
  t('warned', unverifiedAlerts(r.alerts).length === 1);
  t('records that atomic returned null', /atomic returned null/.test(r.errors[0].detail.reason), r.errors[0].detail.reason);
  t('records that the check could not verify', /could not verify/.test(r.errors[0].detail.reason));
}

console.log('\nBoth tiers throw — the exception text is preserved for diagnosis');
{
  const sync = {
    ready: true,
    reserveInvoiceNumberAtomic: async () => { throw new Error('deadline-exceeded'); },
    reserveFreeInvoiceNumber: async () => { throw new Error('unavailable'); },
  };
  const r = await allocate({ sync });
  t('still saves with the local number', r.invNumber === '310869-003');
  t('atomic exception recorded', /deadline-exceeded/.test(r.errors[0].detail.reason));
  t('checked exception recorded', /unavailable/.test(r.errors[0].detail.reason), r.errors[0].detail.reason);
}

console.log('\nSync absent entirely (offline build / not loaded)');
{
  const r = await allocate({ sync: undefined });
  t('local number used', r.invNumber === '310869-003' && r._numSource === 'local');
  t('reason says Sync not loaded', /Sync not loaded/.test(r.errors[0].detail.reason), r.errors[0].detail.reason);
  t('user still warned', unverifiedAlerts(r.alerts).length === 1);
}

console.log('\nA logError failure must never break the save');
{
  // logError is wrapped in try/catch precisely so a logging fault can't lose an invoice.
  const errors = [];
  const DB = {
    invoiceNumberCandidate: () => '310869-003',
    _invNumParts: () => ({ dateKey: '2026-08-31', prefix: '310869-' }),
    localFloorRunForDate: () => 2,
    logError: () => { throw new Error('log storage full'); },
    logActivity: () => {},
  };
  const Utils = { showAlert: () => {} };
  const fn = new Function('DB', 'Utils', 'window', 'Sync', 'session', 'customerId', '_dateISO', 'console',
    `return (async () => { ${block} return invNumber; })();`);
  let threw = false, num = null;
  try { num = await fn(DB, Utils, {}, undefined, { userId:'u', username:'joe', name:'Joe' },
                       'c1', '2026-08-31', { warn(){}, log(){} }); }
  catch (e) { threw = true; }
  t('the save still produces a number', threw === false && num === '310869-003', String(num));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
