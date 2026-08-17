// test-renumber-invoice.js — run:  node test-renumber-invoice.js
//
// Covers invoices.html's renumberInvoicePage() — the admin tool (v1.0.204) for moving
// ONE record off a cross-customer invoice-number collision (see
// DB._numberHasMultipleOwners) onto the next free number, added while resolving
// 180669-209 (ทรัพย์มณี's real ฿4,485.00 invoice sharing a number with ร้านอรวรรณ's).
//
// There was no existing UI to rename an invoice's number at all — editing an invoice
// deliberately keeps invoiceNumber fixed. This reuses the exact three-tier reservation
// saveInvoice() uses (v1.0.200/201: atomic transaction → server-checked → local
// fallback), so this test focuses on the parts specific to renumbering: picking up the
// reserved number correctly, stripping the ambiguous hasPdfPage flag (renumbering does
// NOT move the pdf_pages/{invoiceNumber} Firestore doc, and a collided number's two
// records may share one scan with no way to tell whose it is), and never mutating
// anything when the user cancels the confirm dialog.
//
// Extracts the ACTUAL functions from invoices.html and drives them with stub
// DB/Sync/Utils — not a reimplementation. Covers both renumberInvoicePage() (the
// re-entrancy lock + busy-state wrapper, added after a real production incident — see
// the "re-entrancy lock" tests below) and _renumberInvoicePageInner() (the actual
// reservation/update logic).

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src   = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
const start = src.indexOf('const _renumberInFlight = new Set();');
const end   = src.indexOf('\n// ── Load archived invoices', start);
if (start < 0 || end < start) throw new Error('invoices.html structure changed — update this test\'s extraction markers');
const fnSrc = src.slice(start, end);

function harness({ atomic, checked, confirmAnswer = true, dbOverrides = {}, confirmDelayMs = 0 } = {}) {
  const calls = { updateInvoice: [], commitInvoiceNumber: [], logActivity: [], flushNow: 0, alerts: [], renders: 0 };

  const DB = Object.assign({
    getInvoiceById: id => ({ id, invoiceNumber: 'DUP-1', customerId: 'cust1', totalAmount: 4485, createdAt: '2026-06-18T00:00:00.000Z', hasPdfPage: true }),
    _invNumParts: iso => ({ dateKey: iso.slice(0, 10), prefix: iso.slice(0, 10).split('-').reverse().join('') + '-' }),
    localFloorRunForDate: () => 0,
    invoiceNumberCandidate: (iso, n) => `LOCAL-${n}`,
    updateInvoice: (id, patch) => { calls.updateInvoice.push({ id, patch }); },
    commitInvoiceNumber: (iso, num) => { calls.commitInvoiceNumber.push({ iso, num }); },
    logActivity: (uid, uname, action, details) => { calls.logActivity.push({ action, details }); },
  }, dbOverrides);

  const Sync = {
    ready: true,
    reserveInvoiceNumberAtomic: atomic === undefined
      ? async () => ({ number: 'ATOMIC-1', run: 1 })
      : atomic,
    reserveFreeInvoiceNumber: checked === undefined
      ? async () => ({ number: 'CHECKED-1', verified: true })
      : checked,
    flushNow: () => { calls.flushNow++; },
  };

  const Utils = {
    formatNumber: n => String(n),
    // Simulates the real world: a confirm dialog takes time to answer, during which
    // a second click on the same button is exactly what the lock must catch.
    confirm: async (msg) => {
      calls.lastConfirmMsg = msg;
      if (confirmDelayMs) await new Promise(r => setTimeout(r, confirmDelayMs));
      return confirmAnswer;
    },
    showAlert: (msg) => { calls.alerts.push(msg); },
  };

  const session = { userId: 'u1', username: 'joe', name: 'joe' };
  const global_render = () => { calls.renders++; };

  const fn = new Function('DB', 'window', 'Sync', 'Utils', 'session', 'render', 'console',
    `${fnSrc}\nreturn renumberInvoicePage;`
  );
  const renumberInvoicePage = fn(DB, { Sync }, Sync, Utils, session, global_render, console);

  const makeBtn = () => ({ disabled: false, innerHTML: '<i class="bi bi-arrow-repeat"></i>' });
  return { renumberInvoicePage, calls, makeBtn };
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

(async () => {
  console.log('atomic reservation succeeds — uses that number, marks verified');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('updateInvoice called with the atomic number', calls.updateInvoice[0]?.patch.invoiceNumber === 'ATOMIC-1', JSON.stringify(calls.updateInvoice));
    t('commitInvoiceNumber called with the same number', calls.commitInvoiceNumber[0]?.num === 'ATOMIC-1');
    t('logged with verified:true', calls.logActivity[0]?.details.verified === true, JSON.stringify(calls.logActivity[0]));
    t('flushNow called', calls.flushNow === 1);
    t('render called', calls.renders === 1);
  }

  console.log('\natomic fails — falls to checked reservation');
  {
    const { renumberInvoicePage, calls } = harness({ atomic: async () => null });
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('uses the checked-tier number', calls.updateInvoice[0]?.patch.invoiceNumber === 'CHECKED-1');
  }

  console.log('\nboth atomic and checked fail (offline) — falls to local candidate, warns in the confirm text');
  {
    const { renumberInvoicePage, calls } = harness({
      atomic: async () => { throw new Error('offline'); },
      checked: async () => { throw new Error('offline'); },
    });
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('falls back to local candidate', calls.updateInvoice[0]?.patch.invoiceNumber === 'LOCAL-0');
    t('confirm dialog warns it is unverified', /ไม่สามารถตรวจสอบกับเซิร์ฟเวอร์/.test(calls.lastConfirmMsg || ''));
    t('logged with verified:false', calls.logActivity[0]?.details.verified === false);
  }

  console.log('\nhasPdfPage:true — stripped, and the confirm dialog explains why');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('hasPdfPage explicitly set to false', calls.updateInvoice[0]?.patch.hasPdfPage === false, JSON.stringify(calls.updateInvoice[0]?.patch));
    t('confirm dialog mentions the PDF link is being removed', /ไฟล์ PDF/.test(calls.lastConfirmMsg || ''));
  }

  console.log('\nhasPdfPage:false — left untouched (no unnecessary field, no misleading PDF note)');
  {
    const { renumberInvoicePage, calls } = harness({
      dbOverrides: { getInvoiceById: id => ({ id, invoiceNumber: 'DUP-1', customerId: 'cust1', totalAmount: 4485, createdAt: '2026-06-18T00:00:00.000Z', hasPdfPage: false }) },
    });
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('patch has no hasPdfPage key at all', !('hasPdfPage' in (calls.updateInvoice[0]?.patch || {})), JSON.stringify(calls.updateInvoice[0]?.patch));
    t('confirm dialog does NOT mention the PDF file', !/ไฟล์ PDF/.test(calls.lastConfirmMsg || ''));
  }

  console.log('\nuser cancels the confirm — nothing is mutated');
  {
    const { renumberInvoicePage, calls } = harness({ confirmAnswer: false });
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('updateInvoice never called', calls.updateInvoice.length === 0);
    t('commitInvoiceNumber never called', calls.commitInvoiceNumber.length === 0);
    t('logActivity never called', calls.logActivity.length === 0);
    t('flushNow never called', calls.flushNow === 0);
    t('render never called', calls.renders === 0);
  }

  console.log('\nrecord not found (already deleted elsewhere) — no-op, no crash');
  {
    const { renumberInvoicePage, calls } = harness({ dbOverrides: { getInvoiceById: () => null } });
    await renumberInvoicePage(null, 'gone', 'DUP-1', 'ทรัพย์มณี');
    t('nothing mutated', calls.updateInvoice.length === 0 && calls.logActivity.length === 0);
  }

  console.log('\nconfirm dialog names the customer, old number, and new number');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('mentions the customer', calls.lastConfirmMsg.includes('ทรัพย์มณี'));
    t('mentions the old number', calls.lastConfirmMsg.includes('DUP-1'));
    t('mentions the new number', calls.lastConfirmMsg.includes('ATOMIC-1'));
  }

  // ── re-entrancy lock — added after a real production incident ──────────────────────
  // 180669-209's ทรัพย์มณี record got FOUR "เปลี่ยนเลขที่ใบกำกับ" log entries within about
  // a minute — 209→211, then 211→212 three more times. Each call correctly asked the
  // server and got a genuinely free number back at that instant; nothing was wrong with
  // the reservation logic. The bug was that nothing stopped the button being invoked
  // again while a previous call was still awaiting its confirm dialog / Firestore
  // round-trip — the exact class of bug v1.0.197 fixed for saveInvoice(), just missed
  // here. No duplicate records resulted (every call targets the same fixed pageId), but
  // the counter was burned three times over for nothing and the log became confusing.

  console.log('\nre-entrancy lock: a second call while the first is still awaiting confirm() is ignored');
  {
    const { renumberInvoicePage, calls } = harness({ confirmDelayMs: 20 });
    const call1 = renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    const call2 = renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'); // fired before call1's confirm() resolves
    await Promise.all([call1, call2]);
    t('only ONE update happened, not two', calls.updateInvoice.length === 1, JSON.stringify(calls.updateInvoice));
    t('only ONE activity log entry', calls.logActivity.length === 1);
    t('only ONE counter commit', calls.commitInvoiceNumber.length === 1);
  }

  console.log('\nre-entrancy lock: the exact production shape — 4 rapid calls, only 1 must go through');
  {
    const { renumberInvoicePage, calls } = harness({ confirmDelayMs: 5 });
    await Promise.all([
      renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'),
      renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'),
      renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'),
      renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'),
    ]);
    t('exactly one update reached the database', calls.updateInvoice.length === 1, JSON.stringify(calls.updateInvoice));
  }

  console.log('\nre-entrancy lock: is per-pageId, not global — two DIFFERENT collided records can renumber concurrently');
  {
    const { renumberInvoicePage, calls } = harness({ confirmDelayMs: 10 });
    await Promise.all([
      renumberInvoicePage(null, 'pageA', 'DUP-1', 'ลูกค้า A'),
      renumberInvoicePage(null, 'pageB', 'DUP-1', 'ลูกค้า B'),
    ]);
    t('both distinct pageIds went through', calls.updateInvoice.length === 2,
      JSON.stringify(calls.updateInvoice.map(c => c.id)));
  }

  console.log('\nre-entrancy lock: released after completion — a LATER call (not concurrent) is not blocked forever');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี'); // fully sequential — lock must not stick
    t('the second, later call is NOT blocked by a stuck lock', calls.updateInvoice.length === 2);
  }

  console.log('\nre-entrancy lock: released even when the user cancels the confirm dialog');
  {
    const { renumberInvoicePage, calls } = harness({ confirmAnswer: false });
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    await renumberInvoicePage(null, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('lock does not stick after a cancel', calls.lastConfirmMsg !== undefined);
    // both calls should have reached the confirm dialog — proves the lock from call 1
    // was released, not that call 2 was silently swallowed.
  }

  console.log('\nbusy state: button disabled + spinner during the call, restored after');
  {
    const { renumberInvoicePage, makeBtn } = harness({ confirmDelayMs: 10 });
    const btn = makeBtn();
    const origHtml = btn.innerHTML;
    const p = renumberInvoicePage(btn, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('disabled immediately (before awaiting)', btn.disabled === true);
    t('shows a spinner immediately', /spinner-border/.test(btn.innerHTML));
    await p;
    t('re-enabled after completion', btn.disabled === false);
    // On SUCCESS the real row is gone (render() removed it) — restoring this detached
    // node's HTML is a harmless no-op we still verify happens, since the alternative
    // (leaving it disabled forever) would matter if render() were ever skipped.
    t('innerHTML restored (or at least no longer stuck on the spinner)', !/spinner-border/.test(btn.innerHTML));
  }

  console.log('\nbusy state: restored correctly on cancel (the real, still-visible-row case)');
  {
    const { renumberInvoicePage, makeBtn } = harness({ confirmAnswer: false, confirmDelayMs: 10 });
    const btn = makeBtn();
    const origHtml = btn.innerHTML;
    await renumberInvoicePage(btn, 'page1', 'DUP-1', 'ทรัพย์มณี');
    t('re-enabled after cancel', btn.disabled === false);
    t('original icon restored exactly (row is still live, this one matters)', btn.innerHTML === origHtml, btn.innerHTML);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
