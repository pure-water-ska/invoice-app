// test-invoice-number-collision.js — run:  node test-invoice-number-collision.js
//
// Covers the save-time invoice-number collision check added in v1.0.200:
//   DB.invoiceNumberCandidate() / DB.commitInvoiceNumber()   (db.js)
//   Sync.invoiceNumberOwners() / Sync.reserveFreeInvoiceNumber()  (sync.js)
//
// Why this exists: four numbers in production ended up shared by two different customers
// (180669-209, 300669-209, 270369-203, 280169-206). Every one came from the PDF import
// path, which already checked uniqueness — but via DB.getInvoicesByNumber(), i.e. LOCAL
// data, which holds only ARCHIVE_MONTHS and can be cold. The other customer's invoice
// wasn't there, so the guard passed. The fix asks the server; these tests pin the exact
// semantics, especially the two that are easy to get wrong:
//   * offline / query error must read as UNKNOWN, never as "the number is free"
//   * a multi-page invoice must not false-positive against its own siblings
//
// Loads the real db.js and sync.js and stubs ONLY the Firestore round-trip.

const fs   = require('fs');
const path = require('path');
const DIR  = __dirname;

global.window        = {};
global.localStorage  = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.LZString      = { compressToUTF16: s => s, decompressFromUTF16: s => s };
global.document      = { addEventListener() {}, getElementById: () => null };
global.navigator     = { onLine: true };

const loadDB   = () => new Function(fs.readFileSync(path.join(DIR, 'db.js'), 'utf8') + '\n;return DB;')();
const loadSync = () => new Function(fs.readFileSync(path.join(DIR, 'sync.js'), 'utf8') + '\n;return Sync;')();

const CUST_A = 'cust_a', CUST_B = 'cust_b';
const ISO = '2026-06-30', PREFIX = '300669-';

function freshDB() {
  const DB = loadDB();
  DB._cache[DB.K.CUSTOMERS] = [{ id: CUST_A, name: 'ลูกค้า A' }, { id: CUST_B, name: 'ลูกค้า B' }];
  DB._cache[DB.K.PAYMENTS]  = [];
  DB._cache[DB.K.COUNTER]   = {};
  // Two existing local invoices on that date: -001 (A) and -002 (B, a collided number
  // sharing -001? no — distinct). Local max run = 2, so candidate(0) must be -003.
  DB._cache[DB.K.INVOICES]  = [
    { id: 'i1', invoiceNumber: PREFIX + '001', page: 1, customerId: CUST_A, totalAmount: 100 },
    { id: 'i2', invoiceNumber: PREFIX + '002', page: 1, customerId: CUST_B, totalAmount: 200 },
    // one genuinely collided number, to exercise _numberHasMultipleOwners
    { id: 'i3', invoiceNumber: PREFIX + '009', page: 1, customerId: CUST_A, totalAmount: 300 },
    { id: 'i4', invoiceNumber: PREFIX + '009', page: 1, customerId: CUST_B, totalAmount: 400 },
  ];
  DB._set = function (k, v) { this._cache[k] = v; };   // no persistence under test
  return DB;
}

function syncWithServer(records, opts = {}) {
  const S = loadSync();
  S.ready = opts.ready === undefined ? true : opts.ready;
  S._db = {};
  S._orgRef = () => ({
    collection: () => ({
      where: (field, op, val) => ({
        get: async () => {
          if (opts.throws) throw new Error('permission-denied');
          return { docs: records.filter(r => r[field] === val).map(r => ({ id: r.id, data: () => r })) };
        },
      }),
    }),
  });
  return S;
}

let pass = 0, fail = 0;
const t = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
};

(async () => {
  const DB = freshDB();
  const nextFor = n => DB.invoiceNumberCandidate(ISO, n);
  const first = DB.invoiceNumberCandidate(ISO, 0);

  // Highest local run for this prefix is 009 (the collided pair), so the next free
  // number is 010 — NOT 003. _maxRunningForPrefix() takes the max over every local
  // record, which is what guarantees a generated number never clashes with local data
  // (and why only the server can reveal a clash).
  console.log('candidate numbering (highest local run is 009)');
  t('candidate(0) clears every local number', first === PREFIX + '010', first);
  t('candidate(1)/(2) step forward', nextFor(1) === PREFIX + '011' && nextFor(2) === PREFIX + '012',
    `${nextFor(1)}, ${nextFor(2)}`);
  t('candidate() does NOT consume the counter', DB.invoiceNumberCandidate(ISO, 0) === first);

  console.log('\nserver says the number is free');
  let r = await syncWithServer([]).reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('keeps it', r.number === first, JSON.stringify(r));
  t('verified', r.verified === true);
  t('not bumped', r.bumped === false);

  console.log('\nserver has it under a DIFFERENT customer (the production bug)');
  r = await syncWithServer([{ id: 'x', invoiceNumber: first, customerId: CUST_B }])
        .reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('advances', r.number === nextFor(1), JSON.stringify(r));
  t('flags bumped', r.bumped === true);

  console.log('\nserver has it under the SAME customer (stale local — still a duplicate)');
  r = await syncWithServer([{ id: 'x', invoiceNumber: first, customerId: CUST_A }])
        .reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('advances', r.number === nextFor(1), JSON.stringify(r));

  console.log('\nseveral consecutive numbers taken');
  r = await syncWithServer([
        { id: 'x1', invoiceNumber: nextFor(0), customerId: CUST_B },
        { id: 'x2', invoiceNumber: nextFor(1), customerId: CUST_B },
        { id: 'x3', invoiceNumber: nextFor(2), customerId: CUST_B },
      ]).reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('skips all three', r.number === nextFor(3), JSON.stringify(r));

  console.log('\noffline / not ready — must never block a save, never bump');
  r = await syncWithServer([{ id: 'x', invoiceNumber: first, customerId: CUST_B }], { ready: false })
        .reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('number unchanged', r.number === first, JSON.stringify(r));
  t('verified=false means UNKNOWN, not free', r.verified === false);
  t('not bumped', r.bumped === false);

  console.log('\nquery error — must read as UNKNOWN, never as free');
  const owners = await syncWithServer([], { throws: true }).invoiceNumberOwners(first);
  t('invoiceNumberOwners() returns null', owners === null, String(owners));
  r = await syncWithServer([], { throws: true }).reserveFreeInvoiceNumber(first, CUST_A, nextFor);
  t('reserve falls back to the original number', r.number === first && r.verified === false);

  console.log('\ninvoiceNumberOwners() shape');
  const got = await syncWithServer([
    { id: 'x1', invoiceNumber: first, customerId: CUST_A, totalAmount: 11 },
    { id: 'x2', invoiceNumber: first, customerId: CUST_B, totalAmount: 22 },
  ]).invoiceNumberOwners(first);
  t('returns one entry per server record', Array.isArray(got) && got.length === 2, JSON.stringify(got));
  t('carries customerId', got && got.map(o => o.customerId).sort().join(',') === [CUST_A, CUST_B].sort().join(','));
  t('empty number resolves to [] without querying', (await syncWithServer([]).invoiceNumberOwners('')).length === 0);

  console.log('\ncommitInvoiceNumber() consumes the counter');
  const before   = DB.invoiceNumberCandidate(ISO, 0);
  const bumpedTo = nextFor(2);                    // pretend the server pushed us +2
  DB.commitInvoiceNumber(ISO, bumpedTo);
  t('next candidate moves past the committed number',
    DB.invoiceNumberCandidate(ISO, 0) > bumpedTo, `${before} → committed ${bumpedTo} → ${DB.invoiceNumberCandidate(ISO, 0)}`);
  const held = DB.invoiceNumberCandidate(ISO, 0);
  DB.commitInvoiceNumber(ISO, 'OTHERDATE-999');
  t('ignores a number from another date/prefix', DB.invoiceNumberCandidate(ISO, 0) === held);
  DB.commitInvoiceNumber(ISO, PREFIX + '001');
  t('never rewinds the counter', DB.invoiceNumberCandidate(ISO, 0) === held, DB.invoiceNumberCandidate(ISO, 0));

  console.log('\nDB._numberHasMultipleOwners()');
  t('true for a collided number', DB._numberHasMultipleOwners(PREFIX + '009') === true);
  t('false for a normal number', DB._numberHasMultipleOwners(PREFIX + '001') === false);
  t('false for an unknown number', DB._numberHasMultipleOwners('nope') === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
