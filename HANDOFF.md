# Project Handoff — ใบกำกับสินค้า PWA

## What this project is
Thai-language invoice management PWA for a water-distribution small business.
Vanilla JS + Bootstrap 5.3.2, no bundler. Hosted on Netlify, deploys from GitHub `main`.
Primary data store: localStorage (`wt_*` keys). Real-time sync via Firestore. Backup via Google Drive.
Read `CLAUDE.md` in the repo root for full architecture notes before touching any file.

---

## State after the last session

### Phase 3 — Per-user Firebase Auth (COMPLETE)

**`users.html`**
- `_genFirebasePassword()` — generates 20-char random password for Firebase only
- `_createFirebaseAccount(username)` — uses a secondary Firebase App instance so the admin session is never interrupted; handles `auth/email-already-in-use` gracefully
- `saveUser()` is now `async` — provisions a Firebase account on every add/edit, stores `firebaseEmail` + `firebasePassword` on the user record in localStorage
- Cloud indicator in the user table (✓ = provisioned, slash = not yet)
- Firebase email format: `username@{orgId}.wt.local`

**`sync.js`**
- Resolves per-user credentials just before auth: `Auth.session()` → `DB.getUserById()` → `.firebaseEmail/.firebasePassword`, falls back to `FIREBASE_CONFIG.teamEmail/teamPassword`
- Auth mismatch detection: if `restoredUser.email !== _fbEmail`, signs out and re-signs in with the correct account (Step 4c)

**`index.html`**
- After `Auth.login()` succeeds, switches Firebase Auth to the per-user account before navigating to `dashboard.html` — pre-caches the correct token in IndexedDB so `sync.js` on the next page has no mismatch

---

### Phase 4 — Firestore Security Rules + Invoice Archive (COMPLETE + 3 bugs fixed)

**New files**
- `firestore.rules` — restricts each org's Firestore path to `*@{orgId}.wt.local` emails only. Deploy with `firebase deploy --only firestore:rules`.
- `firebase.json` — Firebase CLI config pointing at the rules and indexes files
- `firestore.indexes.json` — empty template (no composite indexes needed yet)

⚠️ **Deployment requirement**: `FIREBASE_TEAM_EMAIL` env var in Netlify must be `team@{orgId}.wt.local` (matching `FIREBASE_ORG_ID`). If it is a Gmail or other external address the login-page sync will immediately fail with `PERMISSION_DENIED`.

**`sync.js` — archive window**
- `ARCHIVE_MONTHS = 6` constant, `_persistedSidsKey = 'wt_sync_sids'` localStorage key
- `_saveServerIds(colName)` / `_loadSavedServerIds(colName)` — persists the full Set<id> across page reloads so tombstone-deletion of archived invoices works even when they are outside the pull window
- `_pullAll()` for invoices: seeds `_serverIds` from the persisted set, then queries with `.where('createdAt', '>=', cutoffISO)`. Delta-skip path also merges into the persisted set instead of replacing.
- `_setupListeners()` for invoices: listener now uses the same `where('createdAt', '>=', cutoffISO)` filter — **Bug 1 fix** (without this, the first live snapshot was overwriting localStorage with all historical invoices)
- `_writeKey()` for invoices: merges into the persisted set instead of replacing — **Bug 2 fix** (replacing was erasing archive IDs on every local write)
- `_pullAll()` merge section: skips records with `createdAt < cutoffISO` to avoid pushing archive invoices back to Firestore on every page load — **Bug 3 fix**
- `loadArchive(fromISO, toISO)` — public method; queries Firestore with a date range, merges new records into `wt_invoices` localStorage, updates persisted serverIds

**`invoices.html` — archive load button**
- `_archiveLoaded` flag (resets when filterFrom comes back inside the 6-month window)
- Archive banner appears automatically when `filterFrom` is set older than `ARCHIVE_MONTHS`
- `loadArchiveInvoices()` — calls `Sync.loadArchive()`, shows spinner, re-renders on success

---

## Files modified in the last session

| File | Change |
|---|---|
| `sync.js` | Phase 3 per-user auth + Phase 4 archive (5 features + 3 bug fixes) |
| `users.html` | Phase 3 Firebase provisioning |
| `index.html` | Phase 3 login-time auth switch |
| `invoices.html` | Phase 4 archive banner + loadArchiveInvoices() |
| `firestore.rules` | NEW — Phase 4 security rules |
| `firebase.json` | NEW — Firebase CLI config |
| `firestore.indexes.json` | NEW — empty index template |

---

## Known limitations (acceptable for this use case)

- Archived invoices deleted on *another device* will not auto-disappear from this device's localStorage until the user manually calls loadArchive() again or clears local data. This is because the date-filtered listener cannot detect remote deletions of records it never fetches.

---

## Pending / next possible work

- **Deploy security rules**: run `firebase deploy --only firestore:rules` after confirming `FIREBASE_TEAM_EMAIL` is in `.wt.local` format
- **Migrate existing users**: open `users.html`, edit each user → `saveUser()` will provision their Firebase account automatically
- **Phase 1 low-priority**: centralise `ACTION_ICONS` map (currently duplicated in `utils.js` and `history.html`)
- Consider adding a Firestore composite index on `invoices` for `(orgId, createdAt)` if query latency becomes noticeable once the invoice count grows

---

## Running locally

```bash
python -m http.server 8000
# open index.html
```

No build step. Firebase and Drive are optional — app works fully offline without them.
