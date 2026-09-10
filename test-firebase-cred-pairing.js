// test-firebase-cred-pairing.js — run:  node test-firebase-cred-pairing.js
//
// User report: "why some users firestore badge is red with invalid log in credentials
// warning, how can i fix it".
//
// Found live: aing and test have firebaseEmail but NO firebasePassword in their user
// records (admin, joe, aieng have both). sync.js picked the two halves independently:
//     email = user.firebaseEmail    || team email
//     pass  = user.firebasePassword || team password
// so aing signed in with aing@main.wt.local + the TEAM password → Firebase rejects →
// init's catch → red badge, wt_sync_last_error, and ready never set → no sync all
// session (saves queue on that device until a later successful sign-in there).
// index.html's login-time switch had the same pairing bug.
//
// Fix (user chose "pair + self-repair"):
//   - own account only when BOTH halves are stored (and it hasn't failed this session);
//     otherwise team email AND team password
//   - if the own account is still rejected as bad credentials, fall back to the team
//     account, remember it for the session, and log SYNC-AUTH-FALLBACK — never the
//     password. auth/user-disabled and network errors do NOT fall back.
//
// Drives the REAL methods sliced out of sync.js, the REAL _signIn closure, and the REAL
// credential lines sliced out of index.html.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

function sliceBalanced(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('marker not found: ' + startMarker);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced: ' + startMarker);
  return src.slice(start, end);
}

const syncSrc  = fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const setSrc   = fs.readFileSync(path.join(DIR, 'settings.js'), 'utf8');

// ── the real Sync methods ───────────────────────────────────────────────────────────
const pickSrc  = sliceBalanced(syncSrc, '_pickFirebaseCreds(appUser, cfg, ownFailed) {');
const shouldSrc = sliceBalanced(syncSrc, '_shouldFallbackToTeam(err, creds, cfg) {');
const codesSrc = (syncSrc.match(/_AUTH_FALLBACK_CODES:\s*\[[\s\S]*?\]/) || [])[0];
const Sync = new Function(`return { ${pickSrc}, ${codesSrc}, ${shouldSrc} };`)();

const CFG = { teamEmail: 'team@main.wt.local', teamPassword: 'TEAM-PW' };
// shapes taken from the live records
const ADMIN = { username: 'admin', firebaseEmail: 'admin@main.wt.local', firebasePassword: 'ADMIN-PW' };
const AING  = { username: 'aing',  firebaseEmail: 'aing@main.wt.local' };            // no password
const TEST  = { username: 'test',  firebaseEmail: 'test@main.wt.local' };            // no password
const NOFB  = { username: 'new' };                                                   // never provisioned

console.log('_pickFirebaseCreds — both halves or neither');
{
  const a = Sync._pickFirebaseCreds(AING, CFG, false);
  t('aing (email, no password) → team email', a.email === CFG.teamEmail, a.email);
  t('aing → team password', a.pass === CFG.teamPassword);
  t('aing is NOT treated as an own account', a.own === false);
  t('aing never gets their own email paired with the team password',
    !(a.email === AING.firebaseEmail && a.pass === CFG.teamPassword));

  const x = Sync._pickFirebaseCreds(TEST, CFG, false);
  t('test (same state) → team pair', x.email === CFG.teamEmail && x.pass === CFG.teamPassword && !x.own);

  const d = Sync._pickFirebaseCreds(ADMIN, CFG, false);
  t('admin (both stored) → own account', d.email === ADMIN.firebaseEmail && d.pass === ADMIN.firebasePassword && d.own);

  const f = Sync._pickFirebaseCreds(ADMIN, CFG, true);
  t('own account already failed this session → team pair', f.email === CFG.teamEmail && f.pass === CFG.teamPassword && !f.own);

  const n = Sync._pickFirebaseCreds(NOFB, CFG, false);
  t('never-provisioned user → team pair (unchanged behaviour)', n.email === CFG.teamEmail && !n.own);
  const z = Sync._pickFirebaseCreds(null, CFG, false);
  t('no user at all (login page) → team pair', z.email === CFG.teamEmail && !z.own);
  const p = Sync._pickFirebaseCreds({ firebasePassword: 'X' }, CFG, false);
  t('password without an email is not an own account either', p.email === CFG.teamEmail && !p.own);
}

console.log('\n_shouldFallbackToTeam — only for bad own credentials');
{
  const own = { own: true }, team = { own: false };
  const err = (code, message = '') => ({ code, message });
  t('invalid-credential on an own account → fall back', Sync._shouldFallbackToTeam(err('auth/invalid-credential'), own, CFG));
  t('invalid-login-credentials → fall back', Sync._shouldFallbackToTeam(err('auth/invalid-login-credentials'), own, CFG));
  t('wrong-password → fall back', Sync._shouldFallbackToTeam(err('auth/wrong-password'), own, CFG));
  t('user-not-found (deleted in console) → fall back', Sync._shouldFallbackToTeam(err('auth/user-not-found'), own, CFG));
  t('INVALID_LOGIN_CREDENTIALS in the message only → fall back',
    Sync._shouldFallbackToTeam(err('auth/internal-error', 'INVALID_LOGIN_CREDENTIALS'), own, CFG));
  t('user-disabled is NOT bypassed', !Sync._shouldFallbackToTeam(err('auth/user-disabled'), own, CFG));
  t('a network error does NOT fall back (offline handling still applies)',
    !Sync._shouldFallbackToTeam(err('auth/network-request-failed'), own, CFG));
  t('the TEAM account failing does not "fall back" to itself', !Sync._shouldFallbackToTeam(err('auth/invalid-credential'), team, CFG));
  t('no team credentials configured → nothing to fall back to',
    !Sync._shouldFallbackToTeam(err('auth/invalid-credential'), own, { teamEmail: '', teamPassword: '' }));
}

// ── the real _signIn closure ────────────────────────────────────────────────────────
const signInSrc = sliceBalanced(syncSrc, 'const _signIn = async () => {');

function harness({ creds, valid, username = 'admin', cfg = CFG, failWith }) {
  const calls = [], logs = [], store = {};
  const auth = {
    async signInWithEmailAndPassword(email, pw) {
      calls.push(email);
      if (failWith && failWith[email]) { const e = new Error(failWith[email].message || failWith[email].code); e.code = failWith[email].code; throw e; }
      if (valid[email] === pw) return { user: { email } };
      const e = new Error('Firebase: Error (auth/invalid-credential).'); e.code = 'auth/invalid-credential'; throw e;
    },
    async signInAnonymously() { calls.push('anonymous'); return { user: {} }; },
  };
  const firebase = { auth: () => auth };
  const sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  const DB = { logError: (type, message, detail) => logs.push({ type, message, detail }) };
  const console_ = { log() {}, warn() {}, error() {} };
  const run = new Function('firebase', 'sessionStorage', 'DB', 'FIREBASE_CONFIG', 'console',
    '_creds', '_fbEmail', '_fbPass', '_ownFailKey', '_appSession',
    `${signInSrc};\nreturn _signIn;`);
  const _signIn = run.call(Sync, firebase, sessionStorage, DB, cfg, console_,
    creds, creds.email, creds.pass, 'wt_fb_own_failed:' + username, { username });
  return { _signIn, calls, logs, store };
}
const VALID = { 'team@main.wt.local': 'TEAM-PW', 'admin@main.wt.local': 'ADMIN-PW' };

(async () => {
  console.log('\n_signIn — aing, as the live data has them');
  {
    const creds = Sync._pickFirebaseCreds(AING, CFG, false);
    const h = harness({ creds, valid: VALID, username: 'aing' });
    let threw = null; try { await h._signIn(); } catch (e) { threw = e; }
    t('aing signs in — no invalid-credential failure', !threw, threw && threw.code);
    t('with the team account, first try', h.calls.join(',') === 'team@main.wt.local', h.calls.join(','));
    t('nothing to repair, so nothing logged', h.logs.length === 0);
  }

  console.log('\n_signIn — a stored own password that is WRONG falls back');
  {
    const stale = { username: 'joe', firebaseEmail: 'joe@main.wt.local', firebasePassword: 'STALE' };
    const creds = Sync._pickFirebaseCreds(stale, CFG, false);
    const h = harness({ creds, valid: VALID, username: 'joe' });
    let threw = null; try { await h._signIn(); } catch (e) { threw = e; }
    t('sync still signs in', !threw, threw && threw.code);
    t('tried own first, then the team account', h.calls.join(',') === 'joe@main.wt.local,team@main.wt.local', h.calls.join(','));
    t('remembered for the rest of the session', h.store['wt_fb_own_failed:joe'] === '1');
    t('logged once as SYNC-AUTH-FALLBACK', h.logs.length === 1 && h.logs[0].type === 'SYNC-AUTH-FALLBACK');
    t('the log names the user', /joe/.test(h.logs[0].message), h.logs[0].message);
    t('the log NEVER contains the password',
      !JSON.stringify(h.logs).includes('STALE') && !JSON.stringify(h.logs).includes('TEAM-PW'));

    // next page load in the same session: the flag steers straight to the team account
    const next = Sync._pickFirebaseCreds(stale, CFG, h.store['wt_fb_own_failed:joe'] === '1');
    const h2 = harness({ creds: next, valid: VALID, username: 'joe' });
    await h2._signIn();
    t('the next page load skips the doomed own sign-in', h2.calls.join(',') === 'team@main.wt.local', h2.calls.join(','));
    t('and does not log again', h2.logs.length === 0);
  }

  console.log('\n_signIn — a working own account is untouched');
  {
    const creds = Sync._pickFirebaseCreds(ADMIN, CFG, false);
    const h = harness({ creds, valid: VALID, username: 'admin' });
    await h._signIn();
    t('admin signs in with their own account only', h.calls.join(',') === 'admin@main.wt.local', h.calls.join(','));
    t('no flag, no log', !h.store['wt_fb_own_failed:admin'] && h.logs.length === 0);
  }

  console.log('\n_signIn — what must NOT fall back');
  {
    const creds = Sync._pickFirebaseCreds(ADMIN, CFG, false);
    const dis = harness({ creds, valid: VALID, failWith: { 'admin@main.wt.local': { code: 'auth/user-disabled' } } });
    let e1 = null; try { await dis._signIn(); } catch (e) { e1 = e; }
    t('a DISABLED account still fails — not bypassed', e1 && e1.code === 'auth/user-disabled', e1 && e1.code);
    t('and the team account was never tried', !dis.calls.includes('team@main.wt.local'), dis.calls.join(','));

    const net = harness({ creds, valid: VALID, failWith: { 'admin@main.wt.local': { code: 'auth/network-request-failed' } } });
    let e2 = null; try { await net._signIn(); } catch (e) { e2 = e; }
    t('a network error is re-thrown to init\'s offline handling', e2 && e2.code === 'auth/network-request-failed');

    const teamCreds = Sync._pickFirebaseCreds(null, CFG, false);
    const bad = harness({ creds: teamCreds, valid: { 'team@main.wt.local': 'SOMETHING-ELSE' } });
    let e3 = null; try { await bad._signIn(); } catch (e) { e3 = e; }
    t('a wrong TEAM password still surfaces as an error (no loop)', e3 && e3.code === 'auth/invalid-credential');
    t('tried exactly once', bad.calls.length === 1, bad.calls.join(','));
  }

  console.log('\n_signIn — no credentials at all');
  {
    const h = harness({ creds: { email: '', pass: '', own: false }, valid: VALID });
    await h._signIn();
    t('falls through to anonymous, as before', h.calls.join(',') === 'anonymous');
  }

  // ── every sign-in site goes through _signIn ───────────────────────────────────────
  console.log('\nall three sign-in paths use _signIn');
  {
    const initSrc = syncSrc;
    const direct = (initSrc.match(/signInWithEmailAndPassword\(_fbEmail, _fbPass\)/g) || []).length;
    t('the own/team pair is signed in from exactly one place (inside _signIn)', direct === 1, `found ${direct}`);
    // \r?\n — sync.js may be checked out with Windows line endings
    t('browser fresh sign-in (step 4b) uses _signIn', /Step 4b[^\n]*\r?\n\s*await _signIn\(\);/.test(initSrc));
    t('browser account switch (step 4c) uses _signIn', /Step 4c[^\n]*\r?\n\s*await firebase\.auth\(\)\.signOut\(\);\r?\n\s*await _signIn\(\);/.test(initSrc));
    t('Tauri sign-in uses _signIn', /await _signIn\(\);\r?\n\s*this\._uid = firebase\.auth\(\)\.currentUser\?\.uid \|\| 'anon-tauri'/.test(initSrc));
    t('the old independent fallbacks are gone',
      !/_appUser\?\.firebasePassword \|\| FIREBASE_CONFIG\.teamPassword/.test(initSrc));
  }

  // ── index.html — the login-time switch ───────────────────────────────────────────
  console.log('\nindex.html login — same pairing rule');
  {
    const lines = (indexSrc.match(/let ownFailed = false;[\s\S]*?const fbPass[^\n]*;/) || [])[0];
    t('the login credential lines were found', !!lines);
    const pick = (userRecord, u, flags = {}) => new Function('userRecord', 'u', 'sessionStorage', 'FIREBASE_CONFIG',
      `${lines}\nreturn { ownCreds, fbEmail, fbPass };`)(
      userRecord, u, { getItem: k => flags[k] ?? null }, CFG);
    const a = pick(AING, 'aing');
    t('aing logs in → team pair, not aing email + team password',
      a.fbEmail === CFG.teamEmail && a.fbPass === CFG.teamPassword && !a.ownCreds, `${a.fbEmail}`);
    const d = pick(ADMIN, 'admin');
    t('admin logs in → own pair', d.fbEmail === ADMIN.firebaseEmail && d.fbPass === ADMIN.firebasePassword && d.ownCreds);
    const f = pick(ADMIN, 'admin', { 'wt_fb_own_failed:admin': '1' });
    t('an own account that failed this session → team pair', f.fbEmail === CFG.teamEmail && !f.ownCreds);
    t('the old independent fallbacks are gone from index.html',
      !/userRecord\?\.firebasePassword \|\| FIREBASE_CONFIG\.teamPassword/.test(indexSrc));
    t('index.html and sync.js share the session flag name',
      indexSrc.includes("'wt_fb_own_failed:' + u") && syncSrc.includes("'wt_fb_own_failed:' + _appSession.username"));
  }

  // ── settings.js — the advice shown on the red card ───────────────────────────────
  console.log('\nsettings.js — the red card no longer blames Netlify');
  {
    t('the Netlify advice is gone', !/Netlify/.test(setSrc));
    t('invalid-credential now points at the team password secret', /FIREBASE_TEAM_PASSWORD/.test(setSrc));
    t('and at the Troubleshoot entry for per-user fallbacks', /SYNC-AUTH-FALLBACK/.test(setSrc));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
