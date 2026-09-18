// test-upload-info.js — run:  node test-upload-info.js
//
// User request: "sometimes the warning bar shows pending upload, how can user know what
// it is and reason with try to upload button" — then "keeping the old form with adding
// 'more info' button to show details".
//
// The blue bar ("ค้างอัปโหลด N รายการ — จะอัปโหลดเองเมื่อเน็ต/โควต้ากลับมา · ปิดได้ …")
// had no button and no detail, and the reason for a failed upload was thrown away (only
// written to Troubleshoot). Now:
//   - every queued entry carries a reason, a "waiting since" that survives re-queues,
//     and a failure count
//   - the bar keeps its exact wording and gains a รายละเอียด button, which opens the
//     reason (in Thai), what is waiting, a don't-clear-the-browser note, and a
//     double-click-safe ลองอัปโหลดอีกครั้ง that reuses flushNow()
//
// Drives the REAL methods sliced out of sync.js (stubbed storage/DOM/time), plus
// structural checks on every call site that queues data.

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

const src = fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8');
const MARKERS = [
  '_enqueue(key, val, reason) {', '_getQueue() {', '_reasonFromError(e) {', '_noteQueueFailure(key, e) {',
  '_escHtml(s) {', '_UPLOAD_KEY_NAMES: {', '_uploadKeyName(k) {', '_fmtTime(ms, now) {',
  '_quotaResetAt(nowMs) {', '_describeReason(r, ctx) {', '_uploadHeadline(ctx) {', '_uploadInfoRows(now) {',
  '_renderUploadInfo(show, ctx) {', 'async retryPendingUploads() {', 'async _flushQueue() {',
  '_extraPending() {',
];
const methodSrc = MARKERS.map(m => sliceBalanced(src, m)).join(',\n');

function makeSync(opts = {}) {
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const els = {};
  const document = {
    body: { appendChild(el) { els[el.id] = el; } },
    getElementById: id => els[id] || null,
    createElement: () => ({ id: '', style: {}, innerHTML: '',
      querySelector(sel) { return sel === '#wtUploadRetryBtn' ? (this._btn = this._btn || {}) : null; } }),
  };
  const logs = [];
  const DB = { logError: (type, msg) => logs.push({ type, msg }) };
  const S = new Function('localStorage', 'navigator', 'window', 'document', 'DB', 'Utils', 'console',
    `return { ${methodSrc} };`)(
    localStorage, {}, {}, document, DB, { formatDateTH: iso => 'D(' + iso.slice(0, 10) + ')' },
    { log() {}, warn() {}, error() {} });
  let emits = 0;
  Object.assign(S, {
    _pendingLsKey: 'wt_sync_pending', _online: true, ready: true,
    _pendingWrite: {}, _docDebounce: {}, _pushDebounce: {}, _activeSince: 0,
    _badge() {}, _emitUploadState() { emits++; },
    _uploadActiveCount() { return Object.values(this._pendingWrite).filter(Boolean).length; },
  }, opts);
  return { S, store, els, logs, emits: () => emits, localStorage };
}
const realNow = Date.now;
const at = ms => { Date.now = () => ms; };
const T0 = Date.UTC(2026, 8, 13, 2, 42);        // 09:42 Thai

(async () => {
  // ── _enqueue — reason, since, attempts ──────────────────────────────────────────
  console.log('_enqueue — keeps the reason and when it first started waiting');
  {
    const { S } = makeSync();
    at(T0);
    S._enqueue('wt_invoices', [1, 2], { kind: 'offline' });
    let q = S._getQueue();
    t('the entry is queued', q.length === 1 && q[0].key === 'wt_invoices');
    t('since = when it was queued', q[0].since === T0);
    t('the reason is kept, with a time', q[0].reason.kind === 'offline' && !!q[0].reason.at);
    t('no failed attempts yet', q[0].attempts === 0);

    at(T0 + 33 * 60000);                         // 10:15 — re-queued after a real failure
    const err = Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' });
    S._enqueue('wt_invoices', [1, 2, 3], S._reasonFromError(err));
    q = S._getQueue();
    t('still one entry for the key', q.length === 1);
    t('the newest data replaced the old', q[0].val.length === 3);
    t('"waiting since" is NOT reset by the re-queue', q[0].since === T0, new Date(q[0].since).toISOString());
    t('ts moves on to the latest queue time', q[0].ts === T0 + 33 * 60000);
    t('the reason is now the real error', q[0].reason.kind === 'error' && q[0].reason.code === 'resource-exhausted');

    at(T0 + 40 * 60000);                         // page closed with a fresh edit pending
    S._enqueue('wt_invoices', [1, 2, 3, 4], { kind: 'unload' });
    q = S._getQueue();
    t('"page closed" does not hide the earlier quota error', q[0].reason.code === 'resource-exhausted');
    t('…but the data is still the newest', q[0].val.length === 4);

    S._enqueue('wt_payments', [9], { kind: 'unload' });
    t('with no earlier error, "page closed" is the reason', S._getQueue().find(e => e.key === 'wt_payments').reason.kind === 'unload');

    // an entry written by an older version has no `since`
    const { S: S2, store } = makeSync();
    store.wt_sync_pending = JSON.stringify([{ key: 'wt_settings', val: {}, ts: T0 - 3600000 }]);
    at(T0);
    S2._enqueue('wt_settings', { a: 1 }, { kind: 'offline' });
    t('an old entry without `since` keeps its original ts as since', S2._getQueue()[0].since === T0 - 3600000);
  }

  console.log('\n_reasonFromError — captures code and message, bounded');
  {
    const { S } = makeSync();
    const r = S._reasonFromError(Object.assign(new Error('x'.repeat(1000)), { code: 'permission-denied' }));
    t('kind error, code kept', r.kind === 'error' && r.code === 'permission-denied');
    t('message truncated to 300', r.message.length === 300);
    t('a plain string error still works', S._reasonFromError('boom').message === 'boom');
  }

  // ── a failed retry is recorded on the entry ──────────────────────────────────────
  console.log('\n_flushQueue — a failure is recorded on the entry, queue left intact');
  {
    const { S, logs } = makeSync();
    at(T0);
    S._enqueue('wt_invoices', [1], { kind: 'offline' });
    S._enqueue('wt_payments', [2], { kind: 'offline' });
    at(T0 + 10 * 60000);
    const writes = [];
    S._writeKey = async (key) => { writes.push(key); const e = new Error('Quota exceeded.'); e.code = 'resource-exhausted'; throw e; };
    S._lsWrite = () => {};
    await S._flushQueue();
    const q = S._getQueue();
    t('stops at the first failure', writes.join(',') === 'wt_invoices');
    t('both entries are still queued', q.length === 2);
    t('the failed entry now carries the error', q[0].reason.kind === 'error' && q[0].reason.code === 'resource-exhausted');
    t('its failure count went up', q[0].attempts === 1);
    t('the untried entry keeps its own reason', q[1].reason.kind === 'offline');
    t('still logged to Troubleshoot as before', logs.some(l => l.type === 'SYNC-FLUSH-FAIL'));
  }

  // ── describing the reason ────────────────────────────────────────────────────────
  console.log('\n_describeReason — plain Thai, escaped details');
  {
    const { S } = makeSync();
    const E = (code, message = '') => ({ kind: 'error', code, message, at: new Date().toISOString() });
    const q = S._describeReason(E('resource-exhausted'), { quotaTime: '14:00' });
    t('quota: says the quota is used up', /โควต้าฟรีของวันนี้หมด/.test(q), q);
    t('quota: says when it returns', /14:00 น\./.test(q));
    t('quota detected from the message too', /โควต้า/.test(S._describeReason(E('', 'Quota exceeded.'), {})));
    t('permission-denied → tell the admin', /permission-denied/.test(S._describeReason(E('permission-denied'))) && /ผู้ดูแลระบบ/.test(S._describeReason(E('permission-denied'))));
    t('unauthenticated → log out and back in', /ออกจากระบบแล้วเข้าใหม่/.test(S._describeReason(E('unauthenticated'))));
    t('unavailable → connection problem', /เชื่อมต่อเซิร์ฟเวอร์ไม่ได้/.test(S._describeReason(E('unavailable'))));
    t('oversized batch → explained', /ใหญ่เกิน/.test(S._describeReason(E('invalid-argument', 'Request payload size exceeds the limit'))));
    t('an unknown code is shown as-is', /weird-code/.test(S._describeReason(E('weird-code'))));
    t('page closed', /ปิดหรือรีเฟรชหน้าก่อนอัปโหลดเสร็จ/.test(S._describeReason({ kind: 'unload' })));
    t('offline', /ออฟไลน์/.test(S._describeReason({ kind: 'offline' })));
    const nr = S._describeReason({ kind: 'not-ready' }, { initError: 'auth/invalid-credential' });
    t('not connected: includes the sign-in error', /auth\/invalid-credential/.test(nr), nr);
    t('not connected, no error yet: says it is still connecting', /กำลังเชื่อมต่อ/.test(S._describeReason({ kind: 'not-ready' }, {})));
    t('an entry from an older version: says there is no reason recorded', /ไม่มีข้อมูลสาเหตุ/.test(S._describeReason(null)));
    const x = S._describeReason(E('<img src=x onerror=alert(1)>'));
    t('error details are HTML-escaped', !x.includes('<img') && x.includes('&lt;img'), x);
  }

  console.log('\n_quotaResetAt — next midnight Pacific, following daylight saving');
  {
    const { S } = makeSync();
    const iso = ms => new Date(ms).toISOString();
    t('summer (PDT): 09:42 Thai → 14:00 Thai the same day',
      iso(S._quotaResetAt(Date.UTC(2026, 8, 13, 2, 42))) === '2026-09-13T07:00:00.000Z', iso(S._quotaResetAt(Date.UTC(2026, 8, 13, 2, 42))));
    t('summer, after the reset (15:00 Thai) → the next day',
      iso(S._quotaResetAt(Date.UTC(2026, 8, 13, 8, 0))) === '2026-09-14T07:00:00.000Z');
    t('winter (PST): → 15:00 Thai',
      iso(S._quotaResetAt(Date.UTC(2026, 11, 1, 3, 0))) === '2026-12-01T08:00:00.000Z', iso(S._quotaResetAt(Date.UTC(2026, 11, 1, 3, 0))));
  }

  // ── the headline ─────────────────────────────────────────────────────────────────
  console.log('\n_uploadHeadline — current blocker first, then the newest recorded error');
  {
    const { S, store } = makeSync();
    at(T0);
    S._enqueue('wt_invoices', [1], S._reasonFromError(Object.assign(new Error('q'), { code: 'resource-exhausted' })));
    t('online + connected: the recorded error', /resource-exhausted/.test(S._uploadHeadline({})));
    S._online = false;
    t('offline beats the recorded error', /ออฟไลน์/.test(S._uploadHeadline({})));
    S._online = true; S.ready = false;
    store.wt_sync_last_error = JSON.stringify({ msg: 'auth/invalid-credential' });
    t('not connected: shows the sign-in error', /auth\/invalid-credential/.test(S._uploadHeadline({})));
    S.ready = true;
    const { S: S3 } = makeSync();
    t('nothing queued but a stuck write: "server not acknowledging"', /12 วินาที/.test(S3._uploadHeadline({ stuck: true })));
    at(T0 + 5 * 60000);
    S._enqueue('wt_payments', [2], S._reasonFromError(Object.assign(new Error('p'), { code: 'permission-denied' })));
    t('the NEWEST error wins', /permission-denied/.test(S._uploadHeadline({})));

    // Seen live in the preview: invoices failed on quota, then payments were queued by a
    // page close 3 minutes later — the headline showed "page closed" and hid the quota.
    const { S: S4 } = makeSync();
    at(T0);
    S4._enqueue('wt_invoices', [1], S4._reasonFromError(Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' })));
    at(T0 + 3 * 60000);
    S4._enqueue('wt_payments', [2], { kind: 'unload' });
    t('a real error beats a NEWER "page closed" (seen live)', /resource-exhausted/.test(S4._uploadHeadline({})), S4._uploadHeadline({}));
    S4._enqueue('wt_settings', {}, { kind: 'offline' });
    t('…and beats a newer "was offline" too', /resource-exhausted/.test(S4._uploadHeadline({})));
    const { S: S5 } = makeSync();
    at(T0);
    S5._enqueue('wt_payments', [2], { kind: 'unload' });
    t('with no error recorded, "page closed" is shown', /ปิดหรือรีเฟรช/.test(S5._uploadHeadline({})));
  }

  // ── rows ─────────────────────────────────────────────────────────────────────────
  console.log('\n_uploadInfoRows — what is waiting, in Thai, with times');
  {
    const { S } = makeSync();
    at(T0);
    S._enqueue('wt_invoices', [1], { kind: 'offline' });
    at(T0 + 33 * 60000);
    S._enqueue('wt_invoices', [1, 2], S._reasonFromError(Object.assign(new Error('q'), { code: 'resource-exhausted' })));
    S._enqueue('wt_settings', {}, { kind: 'unload' });
    S._pendingWrite = { wt_payments: true }; S._activeSince = T0 + 33 * 60000 - 40000;
    const rows = S._uploadInfoRows(T0 + 33 * 60000);
    t('three rows: two queued, one in flight', rows.length === 3, rows.map(r => r.key).join(','));
    t('data types are named in Thai', rows[0].name === 'ใบกำกับ' && rows[1].name === 'ตั้งค่า' && rows[2].name === 'การชำระเงิน');
    t('invoices: waiting since the FIRST time, and last tried', /ค้างตั้งแต่/.test(rows[0].detail) && /ลองล่าสุด/.test(rows[0].detail) && /ไม่สำเร็จ/.test(rows[0].detail), rows[0].detail);
    t('settings: "page closed"', /ปิดหน้าก่อนอัปโหลดเสร็จ/.test(rows[1].detail));
    t('in-flight payments: "sending, waiting N seconds"', /กำลังส่ง/.test(rows[2].detail) && /40 วินาที/.test(rows[2].detail), rows[2].detail);
    t('times read as clock times', /\d{1,2}:\d{2} น\./.test(rows[0].detail), rows[0].detail);
    const old = S._fmtTime(T0 - 86400000 * 2, T0);
    t('a time from another day includes the date', /^D\(/.test(old), old);
    t('an unknown key falls back to its name', S._uploadKeyName('wt_other') === 'other');
  }

  // ── the panel ────────────────────────────────────────────────────────────────────
  console.log('\n_renderUploadInfo — only when open, with reason, rows and retry');
  {
    const { S, els } = makeSync();
    els.wtUploadBar = { getBoundingClientRect: () => ({ bottom: 90 }) };
    at(T0);
    S._enqueue('wt_payments', [1], S._reasonFromError(Object.assign(new Error('q'), { code: 'resource-exhausted' })));
    S._uploadInfoOpen = false;
    S._renderUploadInfo(true, {});
    t('closed: no panel is shown', !els.wtUploadInfo || els.wtUploadInfo.style.display === 'none');
    S._uploadInfoOpen = true;
    S._renderUploadInfo(true, {});
    const p = els.wtUploadInfo;
    t('open: the panel is shown', p && p.style.display === 'block');
    t('sits just below the bar', p.style.top === '94px', p.style.top);
    t('shows the reason', /โควต้าฟรีของวันนี้หมด/.test(p.innerHTML));
    t('lists what is waiting', /การชำระเงิน/.test(p.innerHTML));
    t('warns not to clear the browser', /ห้ามล้างข้อมูลเบราว์เซอร์\/แคช/.test(p.innerHTML));
    t('has the retry button, enabled online', /id="wtUploadRetryBtn">/.test(p.innerHTML));
    t('the retry button is wired to retryPendingUploads', typeof p._btn.onclick === 'function');
    S._online = false;
    S._renderUploadInfo(true, {});
    t('offline: the retry button is disabled', /id="wtUploadRetryBtn" disabled/.test(p.innerHTML));
    t('offline: and says to connect first', /ต่ออินเทอร์เน็ตก่อน/.test(p.innerHTML));
    S._renderUploadInfo(false);
    t('leaving the waiting state hides it', p.style.display === 'none');
  }

  // ── retry ────────────────────────────────────────────────────────────────────────
  console.log('\nretryPendingUploads — reuses flushNow, reports the outcome');
  {
    const { S } = makeSync();
    let flushes = 0;
    S.flushNow = async () => { flushes++; };
    S._online = false;
    await S.retryPendingUploads();
    t('offline: does not try', flushes === 0);
    t('offline: says so', S._retryMsg.state === 'bad' && /ออฟไลน์/.test(S._retryMsg.text));

    S._online = true; S.ready = false;
    await S.retryPendingUploads();
    t('not connected: does not try', flushes === 0);
    t('not connected: says so', /เชื่อมต่อ Firebase ไม่ได้/.test(S._retryMsg.text));
  }
  {
    const env = makeSync();
    const { S } = env;
    let flushes = 0;
    at(T0);
    S._enqueue('wt_invoices', [1], { kind: 'offline' });
    S.flushNow = async () => { flushes++; env.localStorage.removeItem('wt_sync_pending'); };
    await S.retryPendingUploads();
    t('success: flushNow ran once', flushes === 1);
    t('success: reported as uploaded', S._retryMsg.state === 'ok' && /อัปโหลดสำเร็จ/.test(S._retryMsg.text));
    t('the retry lock is released', S._retrying === false);
  }
  {
    const { S } = makeSync();
    at(T0);
    S._enqueue('wt_invoices', [1], { kind: 'offline' });
    S.flushNow = async () => { S._noteQueueFailure('wt_invoices', Object.assign(new Error('q'), { code: 'resource-exhausted' })); };
    await S.retryPendingUploads();
    t('still failing: reported as not yet', S._retryMsg.state === 'bad' && /ยังไม่สำเร็จ/.test(S._retryMsg.text));
    t('…with the NEW reason', /resource-exhausted/.test(S._retryMsg.text), S._retryMsg.text);
  }
  {
    const { S } = makeSync();
    let flushes = 0; const releases = [];
    S.flushNow = () => { flushes++; return new Promise(r => { releases.push(r); }); };
    const a = S.retryPendingUploads();
    const b = S.retryPendingUploads();          // double-click
    // release EVERY flush, so a broken lock shows as a clean FAIL instead of a hang
    releases.forEach(r => r()); await a; await b;
    t('a double-click retries only once', flushes === 1);
  }
  {
    const { S } = makeSync();
    S.flushNow = async () => { throw Object.assign(new Error('boom'), { code: 'internal' }); };
    await S.retryPendingUploads();
    t('an unexpected error is reported, not swallowed', S._retryMsg.state === 'bad' && /internal/.test(S._retryMsg.text));
    t('and the lock is still released', S._retrying === false);
  }

  // ── every place that queues data records why ─────────────────────────────────────
  console.log('\nevery queue site passes a reason');
  {
    t('no two-argument _enqueue calls remain', !/this\._enqueue\(key, (val|fresh)\)/.test(src));
    t('both page-close paths say "unload"', (src.match(/this\._enqueue\(key, val, \{ kind: 'unload' \}\)/g) || []).length === 2);
    t('push() says offline or not connected', /this\._enqueue\(key, val, \{ kind: this\._online \? 'not-ready' : 'offline' \}\)/.test(src));
    t('both failed-write paths pass the error',
      (src.match(/this\._enqueue\(key, fresh, this\._reasonFromError\(e\)\)/g) || []).length === 4);
    t('flushNow no longer throws the error away',
      !/\.catch\(\(\) => \{ this\._pendingWrite\[key\] = false; this\._enqueue/.test(src) && !/\.catch\(\(\) => this\._enqueue/.test(src));
    t('_flushQueueNow records a failure too', /pre-flush error:[^\n]*\r?\n\s*this\._noteQueueFailure\(key, e\);/.test(src));
  }

  // ── the bar itself ───────────────────────────────────────────────────────────────
  console.log('\nthe bar — wording unchanged, one button added');
  {
    t('the waiting text is unchanged',
      // the visible wording (the <span> gained a flex style so the button sits at the right)
      src.includes("<strong>ค้างอัปโหลด ' + _defN + ' รายการ</strong> — จะอัปโหลดเองเมื่อเน็ต/โควต้ากลับมา · ' +") &&
      src.includes("'<strong>ปิดได้</strong> ข้อมูลบันทึกในเครื่องแล้ว</span>' +"));
    t('the รายละเอียด button is added', /id="wtUploadInfoBtn"[^\n]*\r?\n[^\n]*รายละเอียด /.test(src));
    t('the button toggles the panel', /_infoBtn\.onclick = \(\) => \{ this\._uploadInfoOpen = !this\._uploadInfoOpen;/.test(src));
    t('the waiting state renders the panel', src.includes('this._renderUploadInfo(true, { activeN, queuedN, stuck });'));
    t('the uploading (amber) state hides it', /รายการ\)<\/span>' : ''\) \+ '<\/span>';\r?\n\s*this\._renderUploadInfo\(false\);/.test(src));
    t('the done state closes it and clears the retry message',
      /อัปโหลดข้อมูลครบแล้ว<\/strong> — ทำงานต่อได้เลย';\r?\n\s*this\._uploadInfoOpen = false; this\._retryMsg = null;/.test(src));
    t('the uploading text is unchanged', src.includes('<span><strong>กำลังอัปโหลดข้อมูล…</strong> อย่าเพิ่งปิดหรือรีเฟรชหน้านี้'));
  }

  Date.now = realNow;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
