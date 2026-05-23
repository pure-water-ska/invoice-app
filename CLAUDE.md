# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**ใบกำกับสินค้า** — a Thai-language invoice management PWA for a water distribution small business. Runs entirely in the browser with no build step. Optional real-time sync via Firestore and backup via Google Drive.

- **Stack:** Vanilla JS + HTML + Bootstrap 5.3.2 — no framework, no bundler
- **Hosting:** Netlify (static), auto-deployed from GitHub on push to `main`
- **Primary storage:** localStorage (`wt_*` keys), LZString-compressed by `DB._set()`
- **Offline-first:** Service Worker + localStorage work without any network

## UI/UX Workflow Rule

**Always show an interactive mockup BEFORE writing any code for new UI features.**

- Use `mcp__visualize__show_widget` to build an interactive HTML mockup for any new page, modal, card, form, or visible UI change.
- Wait for explicit user approval ("ทำเลย" / "do it") before touching any source files.
- This rule applies even when the request sounds straightforward. Mockup first, code second.

## Running Locally

No install step. Serve the directory with any HTTP server:

```bash
python -m http.server 8000
# or
npx serve .
```

Open `index.html` (login page). The app works fully offline without Firebase or Drive credentials.

**Optional Firebase sync:** Copy `firebase-config.example.js` → `firebase-credentials.js` and fill in the team password.

**Optional Drive backup:** Copy `drive-config.example.js` → `drive-config.js` and fill in `GOOGLE_CLIENT_ID`.

## Architecture

### Data Layer (`db.js`)

`db.js` wraps localStorage with namespaced `wt_*` keys. Every `DB._set()` call automatically queues a Firestore push (`Sync.push()`) and a Drive backup upload — both are no-ops when not configured.

**All localStorage keys are defined in `DB.K`:**

| Key constant | localStorage key | Description |
|---|---|---|
| `INVOICES` | `wt_invoices` | Invoice records (array) |
| `PAYMENTS` | `wt_payments` | Payment records (array) |
| `CUSTOMERS` | `wt_customers` | Customer list |
| `PRODUCTS` | `wt_products` | Product catalogue |
| `PRICING` | `wt_pricing` | Per-customer pricing rules |
| `SETTINGS` | `wt_settings` | App settings object |
| `USERS` | `wt_users` | User accounts |
| `RETURNS` | `wt_returns` | Return/credit records |
| `VERSIONS` | `wt_versions` | Version notes |
| `PAY_METHODS` | `wt_pay_methods` | Payment method list |
| `TRANSFER_ACCOUNTS` | `wt_transfer_accounts` | Receiver bank accounts (own key — NOT inside settings) |
| `CAP_COLORS` | `wt_cap_colors` | Cap color stock |
| `CAP_RECEIPTS` | `wt_cap_receipts` | Cap receipt records |
| `CAP_DEDUCTIONS` | `wt_cap_deductions` | Cap deductions per invoice |
| `PRICE_HISTORY` | `wt_price_history` | Price change history |
| `COUNTER` | `wt_inv_counter` | Invoice number counter |
| `ACTIVITY` | `wt_activity` | Activity log |
| `LOGINS` | `wt_logins` | Login history |
| `ERRORS` | `wt_errors` | Error log (Settings → Troubleshoot) |

> **Important:** `wt_transfer_accounts` is its own top-level key. It was separated from `wt_settings` specifically because object-type DOCUMENTS in Firestore get replaced wholesale on sync — storing it inside settings would cause it to be wiped when another device synced settings without having the accounts locally. A one-time migration in `DB.getTransferAccounts()` auto-promotes data from the old location.

**LZString compression:** `DB._set()` compresses values with `LZString.compressToUTF16()` before writing to localStorage. `DB._get()` / `DB._lzRead()` detect and decompress automatically. `sync.js` must always use `this._localRead(lsKey)` (not `localStorage.getItem()` directly) for the same reason.

**In-memory cache:** `DB._cache` holds the last parsed value per key. Invalidated by `DB._set()` and by `DB.invalidate(key)` (called from `sync.js` after Firestore writes localStorage directly).

### Sync Engine (`sync.js`)

Firestore bidirectional sync. Two categories of data with different Firestore layouts:

**COLLECTIONS** — one Firestore document per record (avoids 1 MB doc limit):
- `wt_invoices` → `invoices/` collection
- `wt_payments` → `payments/` collection

**DOCUMENTS** — entire array/object stored in one Firestore document:
- All other keys (`wt_customers`, `wt_products`, `wt_transfer_accounts`, etc.)

#### Write path optimisations (all three active)

**① Debounce DOCUMENTS (600 ms)**
DOCUMENTS writes are debounced 600 ms (same as COLLECTIONS). Rapid saves within the window collapse into one Firestore write. Pending timers are flushed to the offline queue on `beforeunload` so no data is lost on navigation.

**② Skip DOCUMENTS if content unchanged**
At debounce fire time, `JSON.stringify(fresh)` is compared to `_lastDocJson[key]` (the fingerprint of the last successful write). If identical, the Firestore round-trip is skipped entirely. `_lastDocJson` is seeded from `_pullAll()` so a re-save of just-pulled data is also skipped.

**③ Diff-only COLLECTIONS upserts**
`_writeKey()` compares each record against `_lastSyncedRecs[colName]` (a `Map<id, jsonFingerprint>`). Only records whose content changed (or are new) are included in the `batch.set()`. Saving 1 invoice out of 300 → 1 Firestore write instead of 300. The fingerprint map is seeded from `_pullAll()` so the optimisation is active from the very first write. Deletions always go through the same atomic batch regardless.

Console output: `[Sync] invoices: 1 upserted, 0 deleted, 299 unchanged (skipped)`

#### Pull path

`_pullAll()` runs on page load:
- **DOCUMENTS:** fetches each doc; skips if server `ts` < last pull timestamp (delta optimisation).
- **COLLECTIONS:** skips the round-trip entirely if pulled within the last 30 s (trusts the real-time listener); otherwise runs a date-filtered query (invoices: last `ARCHIVE_MONTHS = 6` months).
- After pulling, both DOCUMENTS and COLLECTIONS seed their fingerprint caches (`_lastDocJson`, `_lastSyncedRecs`) so the first write only sends genuine changes.

#### Invoice archive & PDF import

Invoices older than `ARCHIVE_MONTHS` are not fetched on page load. `_serverIds[colName]` (a persisted Set in `wt_sync_sids`) tracks every ID ever seen in Firestore, including archived ones outside the pull window. The merge logic in `_pullAll()` uses `knownServerIds` (not date comparison) to distinguish:
- **Already in Firestore (archived):** `knownServerIds.has(r.id)` → keep locally, skip push
- **New with old date (PDF import):** NOT in `knownServerIds` → push to Firestore and keep locally

This prevents PDF-imported invoices with old dates from being silently deleted on the next navigation.

#### Real-time listeners

All Firestore reads use `onSnapshot()` with `{ includeMetadataChanges: true }`. Use `snapshot.metadata.fromCache` to detect connection state — **do NOT use `navigator.onLine`** (the network can be up but Firestore unreachable).

`sync.js` dispatches `sync:connectionstate` custom events on `fromCache` transitions. `connection-status.js` (loaded by `nav.js`) shows/hides an amber bottom banner.

#### Background Sync (offline queue)

Failed Firestore writes go to `wt_sync_pending` via `sync._enqueue()`. The code registers a Background Sync tag (`sync-pending-writes`). `sw.js` handles the `sync` event and posts `FLUSH_PENDING_WRITES` to all clients. Safari/Firefox fall back to Firestore's built-in IndexedDB persistence + the `online` event listener.

**Firestore offline persistence:** `enableIndexedDbPersistence({ synchronizeTabs: false })`. `synchronizeTabs: false` is required — `true` uses a primary-tab lock that blocks a second device from connecting when both share the same Firebase team account.

### Multi-page Invoices

Multiple invoice records can share the same `invoiceNumber` — each is a separate "page" (หน้า). Each record has a unique `id` (UUID) and a `page` field (1, 2, 3…).

- `DB.getInvoicesByNumber(num)` returns all pages for an invoice number.
- `DB.deleteInvoice(id)` deletes a single page by its unique `id`.
- `invoices.html` shows a "X หน้า" badge and an expand chevron for multi-page invoices. Expanded sub-rows let the user view, edit, or delete individual pages. The main row's delete button removes all pages.
- `invoice-create.html?view=NUM` / `?edit=NUM` always operates on all pages for that invoice number.

### Auth & Permissions (`auth.js`)

Session stored in sessionStorage (clears on tab close). SHA-256 hashed passwords. 47 granular permissions in `Auth.PERMS`; Admin role bypasses all checks. First login forces a password change.

```javascript
if (!Auth.can('invoice_delete')) { /* deny */ }
```

### Pages

`index.html` (login) → `dashboard.html` → feature pages. Every page must include this shell:

```html
<script src="utils.js"></script>
<script src="db.js"></script>
<script src="auth.js"></script>
<div id="navContainer"></div>
<script src="nav.js"></script>
```

Then call `Nav.render('page-name')` in an inline script.

`nav.js` renders the navbar, handles PWA install prompt, Service Worker registration, connection status badge, and dark mode. It also dynamically loads `connection-status.js` and `sync.js` (both Network-Only).

### Service Worker (`sw.js`)

Network-First for HTML; Cache-First for assets. `nav.js`, `sync.js`, `connection-status.js`, and `settings.js` are always Network-Only so fixes apply immediately without an SW update cycle. Cache version is bumped by `netlify-build.sh` on every deploy. `sw.js` handles the `sync` event (tag `sync-pending-writes`) for Background Sync.

### Drive Backup (`drive-store.js` + `drive-db-sync.js`)

Google Drive OAuth token stored in sessionStorage; cached in IndexedDB (`idb.js`). DB key writes are debounced at 5 s and uploaded to Drive.

## Key Conventions

- **No reactivity:** The DOM is not auto-synced to data. After writing to DB, call render functions explicitly.
- **New localStorage key:** Define in `DB.K.*` in `db.js`, add to the snapshot key list in `DB.snapshot()`, and add to `Sync.DOCUMENTS` (or `COLLECTIONS`) in `sync.js`.
- **New permission:** Add to `Auth.PERMS` in `auth.js`, check with `Auth.can('key')`.
- **Storing objects vs arrays:** Object sub-keys inside a DOCUMENT are silently clobbered when another device syncs. Give any independently-managed data its own top-level `wt_*` key (see `wt_transfer_accounts`).
- **Never read localStorage directly in sync.js:** Always use `this._localRead(lsKey)` — it handles LZString decompression.
- **Error logging:** Uncaught errors go to `DB.logError()` → `wt_errors`; visible in Settings → Troubleshoot.
- **Print layout:** A5 invoice format defined with `@media print` rules in `style.css`.
- **Date filtering:** Invoice list and sync pull use Buddhist Era dates (BE = CE + 543) via `bedate.js`. Use `Utils.parseBEToISO()` / `Utils.formatDateTH()`.

## Git Note

The sandbox cannot remove Windows `.git/HEAD.lock` files. If a commit fails with `cannot lock ref 'HEAD'`, run in a local terminal:

```bash
del "C:\Users\APINUN_JP\Downloads\web app\.git\HEAD.lock"
cd "C:\Users\APINUN_JP\Downloads\web app"
git add <files>
git commit -m "..."
git push origin main
```

## Deployment

Push to `main` → GitHub Actions triggers Netlify build → `netlify-build.sh` injects Firebase/Drive config from env vars and bumps the SW cache version.

Required Netlify environment variables: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`, `FIREBASE_ORG_ID`, `FIREBASE_TEAM_EMAIL`, `FIREBASE_TEAM_PASSWORD`, `GOOGLE_CLIENT_ID`.
