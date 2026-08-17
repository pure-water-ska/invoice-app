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
// Extracts the ACTUAL function from invoices.html and drives it with stub DB/Sync/Utils
// — not a reimplementation of the function's logic.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const src = fs.readFileSync(path.join(DIR, 'invoices.html'), 'utf8');
const start = src.indexOf('async function renumberInvoicePage');
const end   = src.indexOf('\n// ── Load archived invoices', start);
if (start < 0 || end < start) throw new Error('invoices.html structure changed — update this test\'s extraction markers');
const fnSrc = src.slice(start, end);

function harness({ atomic, checked, confirmAnswer = true, dbOverrides = {} } = {}) {
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
    confirm: async (msg) => { calls.lastConfirmMsg = msg; return confirmAnswer; },
    showAlert: (msg) => { calls.alerts.push(msg); },
  };

  const session = { userId: 'u1', username: 'joe', name: 'joe' };
  const global_render = () => { calls.renders++; };

  const fn = new Function('DB', 'window', 'Sync', 'Utils', 'session', 'render', 'console',
    `${fnSrc}\nreturn renumberInvoicePage;`
  );
  const renumberInvoicePage = fn(DB, { Sync }, Sync, Utils, session, global_render, console);
  return { renumberInvoicePage, calls };
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`); };

(async () => {
  console.log('atomic reservation succeeds — uses that number, marks verified');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('updateInvoice called with the atomic number', calls.updateInvoice[0]?.patch.invoiceNumber === 'ATOMIC-1', JSON.stringify(calls.updateInvoice));
    t('commitInvoiceNumber called with the same number', calls.commitInvoiceNumber[0]?.num === 'ATOMIC-1');
    t('logged with verified:true', calls.logActivity[0]?.details.verified === true, JSON.stringify(calls.logActivity[0]));
    t('flushNow called', calls.flushNow === 1);
    t('render called', calls.renders === 1);
  }

  console.log('\natomic fails — falls to checked reservation');
  {
    const { renumberInvoicePage, calls } = harness({ atomic: async () => null });
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('uses the checked-tier number', calls.updateInvoice[0]?.patch.invoiceNumber === 'CHECKED-1');
  }

  console.log('\nboth atomic and checked fail (offline) — falls to local candidate, warns in the confirm text');
  {
    const { renumberInvoicePage, calls } = harness({
      atomic: async () => { throw new Error('offline'); },
      checked: async () => { throw new Error('offline'); },
    });
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('falls back to local candidate', calls.updateInvoice[0]?.patch.invoiceNumber === 'LOCAL-0');
    t('confirm dialog warns it is unverified', /ไม่สามารถตรวจสอบกับเซิร์ฟเวอร์/.test(calls.lastConfirmMsg || ''));
    t('logged with verified:false', calls.logActivity[0]?.details.verified === false);
  }

  console.log('\nhasPdfPage:true — stripped, and the confirm dialog explains why');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('hasPdfPage explicitly set to false', calls.updateInvoice[0]?.patch.hasPdfPage === false, JSON.stringify(calls.updateInvoice[0]?.patch));
    t('confirm dialog mentions the PDF link is being removed', /ไฟล์ PDF/.test(calls.lastConfirmMsg || ''));
  }

  console.log('\nhasPdfPage:false — left untouched (no unnecessary field, no misleading PDF note)');
  {
    const { renumberInvoicePage, calls } = harness({
      dbOverrides: { getInvoiceById: id => ({ id, invoiceNumber: 'DUP-1', customerId: 'cust1', totalAmount: 4485, createdAt: '2026-06-18T00:00:00.000Z', hasPdfPage: false }) },
    });
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('patch has no hasPdfPage key at all', !('hasPdfPage' in (calls.updateInvoice[0]?.patch || {})), JSON.stringify(calls.updateInvoice[0]?.patch));
    t('confirm dialog does NOT mention the PDF file', !/ไฟล์ PDF/.test(calls.lastConfirmMsg || ''));
  }

  console.log('\nuser cancels the confirm — nothing is mutated');
  {
    const { renumberInvoicePage, calls } = harness({ confirmAnswer: false });
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('updateInvoice never called', calls.updateInvoice.length === 0);
    t('commitInvoiceNumber never called', calls.commitInvoiceNumber.length === 0);
    t('logActivity never called', calls.logActivity.length === 0);
    t('flushNow never called', calls.flushNow === 0);
    t('render never called', calls.renders === 0);
  }

  console.log('\nrecord not found (already deleted elsewhere) — no-op, no crash');
  {
    const { renumberInvoicePage, calls } = harness({ dbOverrides: { getInvoiceById: () => null } });
    await renumberInvoicePage('gone', 'DUP-1', 'ทรัพย์มณี');
    t('nothing mutated', calls.updateInvoice.length === 0 && calls.logActivity.length === 0);
  }

  console.log('\nconfirm dialog names the customer, old number, and new number');
  {
    const { renumberInvoicePage, calls } = harness();
    await renumberInvoicePage('page1', 'DUP-1', 'ทรัพย์มณี');
    t('mentions the customer', calls.lastConfirmMsg.includes('ทรัพย์มณี'));
    t('mentions the old number', calls.lastConfirmMsg.includes('DUP-1'));
    t('mentions the new number', calls.lastConfirmMsg.includes('ATOMIC-1'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
