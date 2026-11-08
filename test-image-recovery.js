// test-image-recovery.js — v1.0.257
//
// Images.store writes the local IDB copy first and pushes to Firestore BEST-EFFORT
// (its own comment says so). When that push fails — offline, quota, or a device that
// is online but cannot WRITE — the "img:<id>" ref still lands in the record and syncs
// to every device, while the image exists only in the uploading device's IndexedDB.
// Nothing ever retried it, so the comment's promise that "cross-device will fill in
// once it syncs" was never true.
//
// Found live: 12 signed invoices (210969-001 … 240969-002) whose images/{id} documents
// are absent from Firestore AND from this machine's IDB; every ref was minted in a
// three-minute window on 25 Sep 2026.
//
// The two things this recovery must never get wrong:
//   • the id must be PRESERVED — every record points at that exact ref, so minting a
//     new one would leave the invoice pointing at nothing;
//   • an existing server copy must never be overwritten — this device's copy could be
//     the stale one, and clobbering a good image to fix a missing one is a bad trade.
//
// Run: node test-image-recovery.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

// ── load the real image-store.js against fakes ────────────────────────────
function makeStore({ idb = {}, server = {}, readThrows = false, writeThrows = false } = {}) {
  const calls = { reads: [], writes: [], idbGets: [] };
  const col = {
    doc: id => ({
      get: async () => {
        calls.reads.push(id);
        if (readThrows) throw new Error('read blew up');
        return { exists: id in server, data: () => server[id] };
      },
      set: async v => {
        if (writeThrows) throw new Error('quota exceeded');
        calls.writes.push({ id, v }); server[id] = v;
      },
      delete: async () => { delete server[id]; },
    }),
  };
  const ctx = {
    window: {}, console: { warn() {} },
    IDB: { images: {
      get: async id => { calls.idbGets.push(id); return id in idb ? idb[id] : null; },
      set: async (id, v) => { idb[id] = v; },
      delete: async id => { delete idb[id]; },
    } },
    Utils: { uuid: () => 'newid' + Object.keys(idb).length },
  };
  ctx.window.Sync = { ready: true, _deviceId: 'dev-test', _orgRef: () => ({ collection: () => col }) };
  const src = fs.readFileSync(path.join(__dirname, 'image-store.js'), 'utf8');
  // image-store.js guards on `window.Sync` but then calls the BARE global `Sync` — a
  // browser global, absent in this sandbox. Supplied as a parameter so the real source
  // runs unmodified. (Same bare-global convention as DB/IDB/Auth; see CLAUDE.md.)
  new Function('window', 'IDB', 'Utils', 'console', 'Sync', src)(
    ctx.window, ctx.IDB, ctx.Utils, ctx.console, ctx.window.Sync);
  return { Images: ctx.window.Images, calls, idb, server };
}

const IMG = 'data:image/jpeg;base64,AAAA';

// Wrapped: this file is CommonJS (require), so await cannot sit at the top level.
(async () => {

section('the reported case: image only on this device');
{
  const { Images, server, calls } = makeStore({ idb: { abc: IMG }, server: {} });
  const r = await Images.pushLocalToServer('img:abc');
  t('it uploads', r.status === 'uploaded', r);
  // The whole point: every record already points at img:abc.
  t('…under the SAME id, never a new one', 'abc' in server && Object.keys(server).length === 1,
    Object.keys(server));
  t('…carrying the image bytes', server.abc.data === IMG);
  t('…and marked as recovered, so an audit can tell it apart', server.abc._recovered === true);
  t('it checked the server before writing', calls.reads.includes('abc'));
}

section('it never destroys a good server copy');
{
  const good = 'data:image/jpeg;base64,GOOD';
  const { Images, server, calls } = makeStore({ idb: { abc: 'data:image/jpeg;base64,STALE' },
                                                server: { abc: { data: good } } });
  const r = await Images.pushLocalToServer('img:abc');
  t('an image already on the server is left alone', r.status === 'already', r);
  t('…and is byte-for-byte untouched', server.abc.data === good);
  t('…with no write attempted at all', calls.writes.length === 0);
}

section('it never invents data');
{
  const { Images, calls } = makeStore({ idb: {}, server: {} });
  const r = await Images.pushLocalToServer('img:gone');
  t('a ref this device does not hold is reported, not fabricated', r.status === 'no-local', r);
  // Spending a read on something we could not upload anyway is wasted quota.
  t('…and costs no Firestore read', calls.reads.length === 0);

  const inline = await Images.pushLocalToServer('data:image/jpeg;base64,ZZ');
  t('an inline value is not treated as a ref', inline.status === 'not-a-ref');
  t('an empty value is not treated as a ref',
    (await Images.pushLocalToServer('')).status === 'not-a-ref');
}

section('failures are reported, never silently swallowed');
{
  // A read failure is NOT proof the image is absent — uploading on that basis could
  // overwrite a good copy.
  const a = makeStore({ idb: { x: IMG }, server: {}, readThrows: true });
  const ra = await a.Images.pushLocalToServer('img:x');
  t('a failed existence check aborts instead of writing blind', ra.status === 'failed', ra.status);
  t('…and writes nothing', a.calls.writes.length === 0);
  t('…and says which step failed', /read:/.test(ra.error || ''), ra.error);

  const b = makeStore({ idb: { y: IMG }, server: {}, writeThrows: true });
  const rb = await b.Images.pushLocalToServer('img:y');
  t('a failed upload is reported as failed', rb.status === 'failed');
  t('…naming the write step and the cause', /write:/.test(rb.error) && /quota/.test(rb.error), rb.error);

  const c = makeStore({ idb: { z: IMG } });
  c.Images && (c.window = null);
  t('hasLocal is true for a held image', (await c.Images.hasLocal('img:z')) === true);
  t('hasLocal is false for one we do not hold', (await c.Images.hasLocal('img:nope')) === false);
  // Without the isRef guard it would slice 4 characters off ANY string and look that
  // up — so an inline value whose tail happens to match a stored key would report a
  // local copy that does not exist. Seeded here so the guard is actually proven.
  // 'data:image/x'.slice(4) is ':image/x' — the colon is index 4.
  const d = makeStore({ idb: { ':image/x': IMG } });
  t('hasLocal is false for a non-ref, even one whose tail collides with a key',
    (await d.Images.hasLocal('data:image/x')) === false);
}

section('store() still behaves as before — recovery did not change the write path');
{
  const { Images, server, idb } = makeStore({ idb: {}, server: {} });
  const ref = await Images.store(IMG);
  t('a normal save still returns a ref', /^img:/.test(ref), ref);
  t('…writes IDB', Object.keys(idb).length === 1);
  t('…and pushes to the server', Object.keys(server).length === 1);

  // requireRemote is what the Phase-2 migration relies on: no server, no ref.
  const f = makeStore({ idb: {}, server: {}, writeThrows: true });
  let threw = false;
  try { await f.Images.store(IMG, { requireRemote: true }); } catch (e) { threw = true; }
  t('requireRemote still throws when the push fails', threw);
  t('…and leaves no half-written local copy', Object.keys(f.idb).length === 0);

  // And the behaviour that CAUSED all this is still the default, deliberately —
  // local-first saves must keep working offline. The recovery card is the safety net.
  const g = makeStore({ idb: {}, server: {}, writeThrows: true });
  const gref = await g.Images.store(IMG);
  t('a normal save still succeeds locally when the server write fails',
    /^img:/.test(gref) && Object.keys(g.idb).length === 1 && Object.keys(g.server).length === 0);
}

section('the card is wired up and cheap');
{
  const html = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
  const js   = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');

  t('the card exists and is admin-only', /id="imgRecoverCard"/.test(html) &&
    /<div class="card mb-4 admin-only" id="imgRecoverCard">/.test(html));
  t('…in the ซ่อมข้อมูล pane', (() => {
    const pane = html.slice(html.indexOf('data-pane="repair"'), html.indexOf('/tab-repair'));
    return pane.includes('id="imgRecoverCard"');
  })());
  t('it tells the user to run it on the device that uploaded', /เครื่องที่อัปรูปนั้นไว้/.test(html));

  const scan = js.slice(js.indexOf('async function scanMissingImages'), js.indexOf('async function recoverMissingImages'));
  // Checking every ref against Firestore would be ~2,575 reads. Local first narrows it
  // to what this device could actually contribute. Match the filtering LOOP, not the
  // name: `Images.hasLocal` also appears in the guard at the top of the function, so an
  // ordering check on the bare name passed while the filter itself was deleted.
  t('it filters by LOCAL holdings before spending any read',
    /for \(const x of all\) \{ if \(await Images\.hasLocal\(x\.ref\)\) held\.push\(x\); \}/.test(scan));
  t('…and only the held ones reach Firestore',
    /for \(const x of held\) \{[\s\S]*?collection\('images'\)/.test(scan));
  t('…and says so when the device holds nothing', /ไม่มีไฟล์รูปเก็บไว้เลย/.test(scan));
  t('a read error is skipped rather than counted as missing',
    /a read failure is not proof of absence/.test(scan));
  t('nothing uploads without a confirm', /Utils\.confirm\(/.test(js.slice(js.indexOf('async function recoverMissingImages'))));
  t('the upload is logged', /กู้คืนรูปขึ้นเซิร์ฟเวอร์/.test(js));
  t('refs shared by several records are collapsed once', /byRef/.test(js));
  t('it covers slips, cheques and history, not just signed invoices',
    /transferImage/.test(js.slice(js.indexOf('function _imgRecRefs'))) &&
    /chequeImage/.test(js.slice(js.indexOf('function _imgRecRefs'))) &&
    /imageHistory/.test(js.slice(js.indexOf('function _imgRecRefs'))));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})();
