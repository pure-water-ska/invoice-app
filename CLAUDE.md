# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**ใบกำกับสินค้า** — a Thai-language invoice management PWA for a water distribution small business. Runs entirely in the browser with no build step. Optional real-time sync via Firestore and backup via Google Drive.

- **Stack:** Vanilla JS + HTML + Bootstrap 5.3.2 — no framework, no bundler
- **Hosting:** GitHub Pages (static), auto-deployed from GitHub on push to `main` (`.github/workflows/pages.yml`)
- **Desktop app:** Tauri 1.x Windows build with auto-update (`src-tauri/`, `.github/workflows/release-desktop.yml`) — see "Tauri Desktop App" below
- **Primary storage:** localStorage (`wt_*` keys), LZString-compressed by `DB._set()`. In the Tauri desktop app, storage is HDD JSON files + in-memory cache instead (localStorage stays empty).
- **Offline-first:** Service Worker + localStorage work without any network

## UI/UX Workflow Rule

**Always show an interactive mockup BEFORE writing any code for new UI features.**

- Use `mcp__visualize__show_widget` to build an interactive HTML mockup for any new page, modal, card, form, or visible UI change.
- Wait for explicit user approval ("ทำเลย" / "do it") before touching any source files.
- This rule applies even when the request sounds straightforward. Mockup first, code second.

## Show an Example BEFORE Pushing

**For any user-visible change, show a concrete example and get approval BEFORE committing/pushing.**

- Render an actual example (preview screenshot via `preview_start` + `preview_screenshot`, an `mcp__visualize__show_widget` mockup, or — if rendering is unavailable — a clear before/after text/ASCII illustration of the result).
- Wait for explicit approval ("ทำเลย" / "do it" / "push") before running `npm run bump` + commit + tag + push.
- Applies to new UI, layout/format/wording changes (e.g. dropdown label order, badges, status bars), and any behavior the user will see or interact with.
- Exception: pure non-visible fixes (sync logic, internal refactors, diagnostics) may be pushed without a visual example — but still state what changed and why first.

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
| `CUSTOMERS` | `wt_customers` | Customer list — **owned by `customer-sync.js`** (not `sync.js`) |
| `PRODUCTS` | `wt_products` | Product catalogue — **owned by `product-sync.js`** (not `sync.js`) |
| `PRICING` | `wt_pricing` | Per-customer pricing rules — **owned by `pricing-sync.js`** (not `sync.js`) |
| `SETTINGS` | `wt_settings` | App settings object |
| `USERS` | `wt_users` | User accounts — **owned by `user-sync.js`** (not `sync.js`) |
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

**IndexedDB overflow:** When `localStorage.setItem()` throws `QuotaExceededError`, `DB._set()` automatically moves the key to IndexedDB (`wt_data_v1` store via `idb.js`). The set of overflowed keys is tracked in `DB._idbKeys` (a `Set`) and persisted to `localStorage['wt_idb_keys']` (and also mirrored to IDB) so it survives page reloads. `DB._get()` / `DB._getArray()` transparently read from IDB when `_idbKeys.has(key)`. `sync.js` `_localRead()` / `_lsWrite()` also respect `_idbKeys`. The user sees a toast notification when a key first overflows.

**`DB.addBrandToCustomer(custId, brand)`** — idempotent helper that appends `brand` to a customer's `brands[]` array (migrating from the legacy scalar `brand` field if needed). Always use this instead of calling `DB.updateCustomer()` directly for brand registration, to avoid race-condition side-effects and accidental field overwrites.

### Sync Engine (`sync.js`)

Firestore bidirectional sync. Two categories of data with different Firestore layouts:

> **Not handled here:** `wt_customers`, `wt_products`, `wt_pricing`, and `wt_users`
> were removed from `COLLECTIONS`/`DOCUMENTS` and are now owned by dedicated modules
> (see "Single-Source-of-Truth Sync Modules"). Do not re-add them here.

**COLLECTIONS** — one Firestore document per record (avoids 1 MB doc limit):
- `wt_invoices` → `invoices/` collection
- `wt_payments` → `payments/` collection

**DOCUMENTS** — entire array/object stored in one Firestore document:
- The remaining keys (`wt_settings`, `wt_transfer_accounts`, `wt_returns`, `wt_versions`, `wt_cap_*`, `wt_inv_counter`, etc.)

**NO_SYNC list** — keys explicitly excluded from Firestore sync (local-only):
```javascript
Sync.NO_SYNC = new Set(['wt_activity', 'wt_logins', 'wt_errors'])
```
These keys are still saved to localStorage/IDB normally; they are just never pushed to or pulled from Firestore. Add a key here when it should remain device-local (audit logs, error logs, etc.).

#### Write path optimisations (all three active)

**⓪ Object DOCUMENTS use field-path updates**
Object-type DOCUMENTS (`wt_settings`, `wt_inv_counter`) are written via Firestore `update()` with dot-notation paths (`d.companyName`, `d.autoBackup`, …) instead of `set({d: wholeObject})`. Firestore merges at the field level, so concurrent writes from different devices each preserve their own sub-keys. Falls back to `set()` if the document doesn't exist yet (bootstrap). Array-type documents still use `set()` since arrays have no sub-key identity.

**① Debounce DOCUMENTS (600 ms)**
DOCUMENTS writes are debounced 600 ms (same as COLLECTIONS). Rapid saves within the window collapse into one Firestore write. Pending timers are flushed to the offline queue on `beforeunload` so no data is lost on navigation.

**② Skip DOCUMENTS if content unchanged**
At debounce fire time, `JSON.stringify(fresh)` is compared to `_lastDocJson[key]` (the fingerprint of the last successful write). If identical, the Firestore round-trip is skipped entirely. `_lastDocJson` is seeded from `_pullAll()` so a re-save of just-pulled data is also skipped.

**③ Diff-only COLLECTIONS upserts**
`_writeKey()` compares each record against `_lastSyncedRecs[colName]` (a `Map<id, jsonFingerprint>`). Only records whose content changed (or are new) are included in the `batch.set()`. Saving 1 invoice out of 300 → 1 Firestore write instead of 300. The fingerprint map is seeded from `_pullAll()` so the optimisation is active from the very first write. Deletions always go through the same atomic batch regardless.

Console output: `[Sync] invoices: 1 upserted, 0 deleted, 299 unchanged (skipped)`

#### Pull path

`_pullAll()` runs on page load with a **session guard** (`sessionStorage['wt_sync_session_pulled']`). The full Firestore pull only runs once per browser session (first page load after login). Subsequent page navigations skip the pull and call `_seedStateFromLocalStorage()` instead to restore in-memory caches from local data:

- **DOCUMENTS:** fetches each doc; skips if server `ts` ≤ `_lastDocTs[docName]` (delta optimisation). `_lastDocTs` is persisted in `localStorage['wt_sync_doc_ts']` and is updated both by `_pullAll()` and by the real-time DOCUMENT listener — keeping the delta skip accurate even after a remote change arrives between page navigations.
- **COLLECTIONS:** skips the round-trip entirely if pulled within the last 30 s (trusts the real-time listener); otherwise runs a date-filtered query (invoices and payments: last `ARCHIVE_MONTHS = 6` months).
- After pulling, both DOCUMENTS and COLLECTIONS seed their fingerprint caches (`_lastDocJson`, `_lastSyncedRecs`) so the first write only sends genuine changes.

#### `_pullIds` — new-session invoice guard

`_pullIds[colName]` is a `Set` of every invoice/payment ID that was present in Firestore at the time of the full session pull. The real-time COLLECTIONS listener uses this set to distinguish:

- **ID in `_pullIds`** — record existed in Firestore at session start; a Firestore delete should remove it locally.
- **ID not in `_pullIds`** — record was created locally this session and not yet confirmed by Firestore; the listener must NOT treat it as deleted.

`_pullIds` is persisted to `sessionStorage['wt_sync_pull_ids']` (via `_savePullIds()`) immediately after `_pullAll()` fills it, and restored from there (via `_loadSavedPullIds()`) on subsequent page navigations and on the COL_SKIP path. This prevents the bug where navigating between pages caused all un-synced local invoices to disappear from the list.

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

### Single-Source-of-Truth Sync Modules (customers, products, pricing, users)

**These four data types do NOT use the general `sync.js` engine.** They were moved
out of `sync.js` `COLLECTIONS`/`DOCUMENTS` into dedicated per-record modules built
on one reusable factory, because the old whole-array/tombstone sync could neither
delete reliably across devices nor stop phantom re-uploads, and had a diff bug that
silently dropped new adds. If you touch customer/product/pricing/user sync, work in
these files — **not** `sync.js`:

| File | Exposes | Firestore collection | localStorage key | de-dup key |
|---|---|---|---|---|
| `collection-sync.js` | `CollectionSync.create(cfg)` factory | — | — | — |
| `customer-sync.js` | `window.CustomerSync` | `customers_v2` | `wt_customers` | `name` |
| `product-sync.js` | `window.ProductSync` | `products_v2` | `wt_products` | `name` |
| `pricing-grouped-sync.js` | `window.PricingSync` | `pricing_byproduct` | `wt_pricing` | (grouped — see below) |
| `user-sync.js` | `window.UserSync` | `users_v2` | `wt_users` | `username` |

> `customer-sync.js` is hand-written (the original); product/user are thin
> `CollectionSync.create({...})` instances. All are loaded by `nav.js` after
> `sync.js` and are Network-Only in `sw.js`.
>
> **Pricing is NOT a CollectionSync instance** (v1.0.137+). `pricing-sync.js`
> (old, collection `pricing_v2`, 1 doc per rule) is **dormant — do not re-enable**.
> Pricing now uses `pricing-grouped-sync.js`: **one Firestore doc per product**
> (`pricing_byproduct/{productId}`, `{ productId, rules:{ruleId:rule}, _by/_ts }`)
> to cut reads ~100× (3,329 rule-docs → ~32 product-docs; reads were the dominant
> Firestore cost). The LOCAL shape is unchanged — `wt_pricing` is still a flat
> array, so `DB.getPricing()`/`getPrice()`/pricing.html/invoice-create are
> untouched; a translate layer groups on write (1 write per changed product) and
> flattens on read. Same interface as the old module (`init`/`onLocalChange`/
> `diagnose`); db.js hook + nav wiring unchanged. Round-trip is covered by
> `test-pricing-roundtrip.js` (run `node test-pricing-roundtrip.js`).

**The model (one rule): the Firestore collection is the single source of truth.**
- A live `onSnapshot` listener turns each **server** snapshot into the local array
  via `DB.setLocalOnly(key, arr)` (writes cache + HDD/localStorage but **never**
  pushes — no echo loop). `fromCache` snapshots are trusted for content but an
  *empty* `fromCache` snapshot is ignored (cold cache ≠ "server is empty").
- Local writes are diffed against **`_serverFp`** (a `Map<id, fingerprint>` rebuilt
  from each real server snapshot), **NOT** against `db`'s "previous" value — see the
  in-place-mutation gotcha below. `upsert` = local record absent/different on the
  server; `delete` = server has it, local no longer does. Pushed per-record in a
  batch with `_by`/`_byName`/`_ts` metadata.
- **Un-acked set** (`sessionStorage`, e.g. `wt_cust_unacked`): ids written locally
  but not yet confirmed by the server. The listener retains these so a just-added
  record can't vanish before the server acknowledges it, and re-pushes them on init.
  An id is cleared from the set ONLY when a doc is **server-acknowledged**
  (`!snapshot.docMetadata.hasPendingWrites`) or explicitly removed — never on a
  pending/cached echo (clearing early was the "add disappears on refresh" bug).
- **De-dup:** duplicate uploads (same `dedupKey`, different doc id) are collapsed to
  the smallest doc id deterministically, and the extras deleted from the server.
- **Bootstrap migration** (`bootstrapMigrate: true` for products/pricing/users):
  on first run the server collection is empty (old data lived in the legacy
  DOCUMENT), so existing local rows are pushed up. The persistent `migratedKey`
  flag is set **only after a non-empty server snapshot confirms** the data landed —
  never right after a possibly-failed push — so a failed migration can't trigger a
  wipe. Customers do NOT bootstrap-migrate (their data already lived in `customers_v2`).
- **Login (`index.html`)** must have users *before* login: it loads
  `collection-sync.js` + `user-sync.js` and calls `UserSync.pullOnce()` — a one-shot
  **additive** pull (merges server accounts into local, never removes) that is
  time-boxed so it can never block or lock anyone out.
- **Diagnostics:** the **ตรวจซิงค์** button on `customers.html` calls
  `CustomerSync.diagnose()` (and appends `ProductSync`/`PricingSync` status) → an
  on-screen report with a copy button showing ready state, org id, local-vs-live-
  server counts, and a recent activity log. DevTools is disabled in release Tauri
  builds, so this on-screen report is the primary way to see what the sync is doing.

### Auth & Permissions (`auth.js`)

Session stored in sessionStorage (clears on tab close). SHA-256 hashed passwords. 47 granular permissions in `Auth.PERMS`; Admin role bypasses all checks. First login forces a password change.

```javascript
if (!Auth.can('invoice_delete')) { /* deny */ }
```

**`Auth.logout()`** clears both `sessionStorage[AUTH_KEY]` and `sessionStorage['wt_sync_session_pulled']` (forcing a full Firestore pull on the next login) and also deletes `_lastDocTs['users_cfg']` from `localStorage['wt_sync_doc_ts']` (forcing `users_cfg` to be re-fetched even if the server timestamp hasn't changed). This ensures that a newly-created user account on one device is visible to other devices immediately after their next login.

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

Network-First for HTML; Cache-First for assets. `nav.js`, `sync.js`, `connection-status.js`, and `settings.js` are always Network-Only so fixes apply immediately without an SW update cycle. Cache version is bumped by `pages.yml` on every deploy. `sw.js` handles the `sync` event (tag `sync-pending-writes`) for Background Sync.

### Drive Backup (`drive-store.js` + `drive-db-sync.js`)

Google Drive OAuth token stored in sessionStorage; cached in IndexedDB (`idb.js`). DB key writes are debounced at 5 s and uploaded to Drive.

### Local Folder Sync (`local-folder-sync.js`)

Optional mirror of all DB keys to a user-selected local directory via the **File System Access API**. Each key is saved as a separate JSON file (e.g. `wt_invoices.json`). The directory handle is persisted in IndexedDB so it survives page reloads (browser may re-prompt once per session after restart — browser security requirement).

Public API (all async unless noted):

| Method | Description |
|---|---|
| `LocalFolderSync.init()` | Load handle + attach events — called by `nav.js` |
| `LocalFolderSync.selectFolder()` | `showDirectoryPicker()` then `writeAll()` |
| `LocalFolderSync.reconnect()` | Re-request permission (requires user gesture) |
| `LocalFolderSync.disconnect()` | Forget folder, clear IDB handle |
| `LocalFolderSync.writeAll()` | Flush every DB key to folder immediately |
| `LocalFolderSync.queueWrite(key, val)` | Debounced write (3 s) — called by `DB._set()` |
| `LocalFolderSync.restore()` | Read folder, return map of key → parsed value |
| `LocalFolderSync.getStatus()` | Returns `{ connected, folderName, … }` (sync) |

Window events: `localfolder:connected`, `localfolder:disconnected`, `localfolder:permissionlost`.

Guarded with `if (!window.LocalFolderSync)` so it is safe to load twice.

### Image Compression (`utils.js`)

**`Utils.compressImage(file, maxPx=1200, quality=0.82)`** — Promise-based canvas downscale utility. Accepts a `File` object, scales it down to fit within `maxPx × maxPx` while preserving aspect ratio, and resolves with a JPEG `data:` URL. All image inputs in the app (`versions.html`, `returns.html`, `cap-stock.html`, `payments.html`) use this before building base64 strings. Always `await` it and wrap the call in `try/catch` so a single bad file doesn't abort a multi-file loop.

```javascript
// Default (1200 px, 0.82 quality)
const b64 = await Utils.compressImage(file);

// Custom
const b64 = await Utils.compressImage(file, 900, 0.70);
```

### Image Offload Store (`image-store.js` + `IDB.images`) — RAM reduction (v1.0.16x)

Base64 images embedded in invoice/payment records dominated RAM (`DB._cache`
held ~88 MB of base64). `image-store.js` moves images OUT of the cached records
and loads them lazily.

- **`window.Images`** API:
  - `Images.store(base64, opts)` → writes to local IndexedDB (`wt_images_v1`
    store via `IDB.images`) **and** Firestore `images/{id}` collection, returns a
    short reference string `"img:<id>"`. `opts.requireRemote: true` makes it throw
    if the Firestore push fails (used by migration so base64 is never stripped
    before the server confirms).
  - `Images.resolve(value)` → returns the base64. Resolves `"img:<id>"` via
    in-session memo (max 24) → IDB → Firestore; passes through inline `data:` URLs
    unchanged. `Images.isRef(v)` / `Images.isInline(v)` classify a value.
  - `Images.del(value)` → removes from IDB + Firestore.
- **New IndexedDB store:** `idb.js` adds `wt_images_v1` (separate DB from
  `wt_data_v1`), exposed as `IDB.images` (`.set/.get/.delete`).
- **Phase 1 (stop new growth):** `payments.html` image upload paths offload to
  `Images.store()` (when Drive not configured) and render `img:<id>` refs lazily
  via `data-imgref` attributes resolved on display. Same for invoice signed images.
- **Phase 2 (migrate existing):** Settings card "ลดหน่วยความจำ — ย้ายรูปเก่าออกจาก
  RAM" → `migrateImagesToStore()` in `settings.js`. Iterates payment images
  (`transferImage`/`chequeImage`/`signedImage`/`imageHistory[].image`) and invoice
  `signedImage`, calls `Images.store(b64, {requireRemote:true})`, strips the inline
  base64 only after server-confirm. **Stops on first failure** (quota/offline) and
  is resumable by pressing the button again.
- **`sw.js`:** `image-store.js` and `idb.js` are **Network-Only** (never served
  stale) — the `requireRemote` safety guard must always be the latest code.

> **Gotcha:** `scripts/bump-version.js` does NOT auto-bump `?v=` for JS files added
> mid-stream (it scans a fixed list). New files like `image-store.js` rely on the
> Network-Only entry in `sw.js` instead. If you add a new always-fresh JS file,
> add it to the `sw.js` Network-Only list.

### Delta Sync (`sync.js`) — Firestore read-quota reduction (v1.0.166)

A full COLLECTIONS pull on every login re-read all ~950 invoices (~1,160 reads).
Delta sync pulls **only records changed since the last pull**.

- **Cursor:** `_DELTA_KEY = 'wt_sync_delta_ts'` persists per-collection
  `{ full, cursor }` in localStorage (`_loadDeltaState`/`_saveDeltaState`).
- **Delta path:** in `_pullAll()` COLLECTIONS, if a cursor exists and < 24 h since
  the last **full** pull → query `where('_ts', '>', cursor - 1h)` (1 h overlap
  guards clock skew). Otherwise a full pull runs.
- **Backstop:** a full pull is forced every **24 h** and the cursor is recorded as
  `{ full: _fullStart, cursor: _fullStart }`.
- **Safety:** if local is empty but `_serverIds.size > 5`, delta is skipped and a
  full pull runs (`_needFull = true`) — never trust an empty local against a
  populated server. On any delta query error it falls through to a full pull.
- **Cross-device:** other devices' changes carry a newer `_ts`, so each device's
  next delta query picks them up; the real-time `onSnapshot` listener still
  delivers live changes within a session.

### Customer balance & overpayment allocation (v1.0.167–169)

- **`DB.getCustomerBalance(custId)`** → `{ net, owed, over, owedCount, overCount }`.
  Per invoice **number**, computes `page-1 totalAmount − getInvoicePaidAmount(num)`;
  positive diffs sum into `owed`, negative into `over`; `net = owed − over`. This is
  the single source of truth — the **invoice-create warning bar** and the
  **customers.html card badge** both use it (same formula). The card shows ONE net
  badge: `net > 0` → red "ค้างสุทธิ ฿X"; `net < 0` → green "ชำระเกินสุทธิ ฿X";
  `net ≈ 0` → no badge.
- **Overpayment multi-invoice allocation (`payments.html`):** when a payment
  exceeds the invoice total, an overpay modal lets the user cut the excess across
  other outstanding invoices (oldest first). `pendingOverpayData.diff` tracks the
  remaining excess; the modal stays open and re-renders (`_renderOverpayBody`) after
  each cut. `applyOverpayToOutstanding()` = manual per-invoice; `autoApplyOverpay()`
  = auto all-oldest-first until excess = 0. `closeOverpay(createNew)` only redirects
  to invoice-create if `Math.abs(diff) > 0.01` remains.

## Key Conventions

- **No reactivity:** The DOM is not auto-synced to data. After writing to DB, call render functions explicitly.
- **New localStorage key:** Define in `DB.K.*` in `db.js`, add to the snapshot key list in `DB.snapshot()`, and add to `Sync.DOCUMENTS` (or `COLLECTIONS`) in `sync.js`. If it should never sync to Firestore, add it to `Sync.NO_SYNC` instead. **For per-record master data that must add/edit/delete reliably across devices, prefer a `CollectionSync.create({...})` instance (see "Single-Source-of-Truth Sync Modules") instead of the `sync.js` DOCUMENT/COLLECTION path — and add a `DB._set` hook + load it in `nav.js` + Network-Only in `sw.js`.**
- **New permission:** Add to `Auth.PERMS` in `auth.js`, check with `Auth.can('key')`.
- **Storing objects vs arrays:** Object sub-keys inside a DOCUMENT are silently clobbered when another device syncs. Give any independently-managed data its own top-level `wt_*` key (see `wt_transfer_accounts`).
- **Never read localStorage directly in sync.js:** Always use `this._localRead(lsKey)` — it handles LZString decompression and IDB overflow transparently.
- **Customer brand registration:** Always call `DB.addBrandToCustomer(custId, brand)` — never write `brands[]` directly via `DB.updateCustomer()`, which would clobber other fields on the customer object.
- **Date validation:** `Utils.parseBEToISO(str)` returns `''` (falsy) on failure. After calling it, check the return value and call `Utils.showAlert(...)` if empty — never silently fall back to today's date.
- **Error logging:** Uncaught errors go to `DB.logError()` → `wt_errors`; visible in Settings → Troubleshoot.
- **Print layout:** A5 invoice format defined with `@media print` rules in `style.css`.
- **Date filtering:** Invoice list and sync pull use Buddhist Era dates (BE = CE + 543) via `bedate.js`. Use `Utils.parseBEToISO()` / `Utils.formatDateTH()`.
- **`window.DB` AND `window.IDB` are `undefined` — use the bare name.** `db.js` declares `const DB = {…}` and `idb.js` declares `const IDB = (…)()` — both lexical globals NOT attached to `window` (a top-level `const` in a classic script does not become a `window` property). `window.Sync` and `window.CustomerSync` etc. ARE on `window` (assigned explicitly), but **`DB` and `IDB` are not**. Never guard with `window.DB ? …` / `window.IDB ? …` — it always takes the false branch. Use the bare name or `typeof DB !== 'undefined'` / `typeof IDB !== 'undefined'`. The `window.DB` form silently disabled the customer backstop for several releases; the `window.IDB` form (v1.0.85 and earlier) silently disabled `sync.js` `_lsWrite()` cache+HDD writes (Firestore-pulled invoices vanished after navigation/logout) and `local-folder-sync.js` handle persistence (the folder path showed as "gone" on every reload). Fixed in v1.0.86. The PDF-folder card never had the bug because it used bare `IDB`.
- **`DB.getX()` returns the cache array by reference — never diff against db's "prev".** `DB.addCustomer/addProduct/upsertPrice/addUser` do `const a = DB.getX(); a.push(...); DB.saveX(a)`, which mutates the cached array **in place**. So in `DB._set` the captured previous value and the new value are the *same* mutated array (`prev === next`). Any per-record diff must compare against an independent baseline (the sync modules use `_serverFp`), not against db's prev — otherwise new adds are silently never pushed.
- **Destructive confirms must use `await Utils.confirm(...)`, never `confirm(...)`.** In the Tauri desktop app `window.confirm()` returns a Promise (truthy), so `if (!confirm(msg)) return;` never aborts and the action runs *without* waiting for Yes/No. `Utils.confirm(message, title)` returns a Promise resolving to a boolean (native blocking dialog in Tauri, `window.confirm` on web). Always `await` it and make the enclosing function `async`. For inline action strings, use `Utils.confirm(msg).then(ok => { if (ok) {…} })`.

## Sync safety rails & heavy-operation UX (June 2026, v1.0.130–146)

A multi-day data-loss incident (payments/invoices mass-deleted across devices)
added these guards. **Understand them before touching sync.**

- **Mass-delete guard (`sync.js _writeKey`, COLLECTIONS):** the set-difference
  deletion inference (`serverKnown − local`) is only safe when local data is
  COMPLETE. With an incomplete local array (interrupted pull / cold cache / flaky
  conn) it deleted everything the device merely didn't have. Now: if a single
  write would delete **> 5** records it is BLOCKED, logged as `SYNC-DEL-BLOCKED`,
  and the blocked ids are removed from `_serverIds` (so the warning doesn't recur
  forever). Small deletions (≤5) still propagate. There is a matching pull-side
  poison guard in `_applyTombstones` / `_filterArrayTombstones`.
- **Firestore 10 MiB request cap:** invoice/payment records embed base64 images
  (Drive is disabled in Tauri), so batches are flushed at **~1.5 MB or 200 ops**
  in `_writeKey` — without this every upload of imported invoices failed with
  `invalid-argument: Request payload size exceeds the limit`.
- **`DB.waitForHddWrites(timeoutMs)`** — awaits pending Tauri HDD writes
  (`_tauri._inflight`). Import (JSON+ZIP) calls it before reporting success, so a
  computer restart right after import can't lose still-queued data.
- **Blocking progress overlay (`Utils.blockingProgress` + `Utils.bpWatchUploads`):**
  full-screen blocker with per-step detail + real numbers for HEAVY ops only
  (import, "อัปโหลดที่ค้าง", multi-pay). Driven by `sync:writeprogress`
  ({key,done,total} per batch) and `db:hddprogress` ({remaining,initial}).
  Ordinary single saves keep the non-blocking top bar (`Sync._initUploadBar`).
- **Desktop close guard (`nav.js`):** `appWindow.onCloseRequested` blocks the X
  while logged in; the user confirms → full `Auth.logout()` (flushes uploads) →
  `index.html` hop in `utils.js` closes the window for real.
- **Admin Re-baseline tool (`settings.js runRebaseline`):** Danger Zone, type
  RESET → deletes invoices/payments/customers_v2/products_v2/pricing_v2/
  pricing_byproduct + data/ docs (keeps `users`/`users_cfg` + pdf_pages) directly
  via the Firestore API (bypasses the mass-delete guard on purpose). Used to wipe
  Firestore for a clean re-import.
- **Sync-status panel (`settings.js checkSyncStatus`):** local vs server counts.
  This build's compat Firestore has **no `count()`** → falls back to `.get().size`
  (a FULL read of the collection — expensive; don't spam it). Reads are the
  dominant Firestore cost; a full pull on every login re-reads all ~950 invoices.
  Long-term recommendation to the user: upgrade Firebase to **Blaze**.

### ⚠️ OPEN BUG (unresolved as of v1.0.146)
After a **PDF import on the WEB build (non-Tauri)**, local `wt_invoices` dropped
to **0** while the server kept all ~954 (the mass-delete guard logged
`SYNC-DEL-BLOCKED`, so the server was protected) — and a **logout/login full pull
did NOT restore local**. Note this is the WEB path: local lives in localStorage /
IDB-overflow (not HDD), so `_lsWrite`/`DB._set` go through the localStorage/IDB
branches, and the `SYNC-DEL-BLOCKED` came from `pdf-import.html`. v1.0.146 added a
diagnostic probe `SYNC-LOCAL-DROP` (in both `Sync._lsWrite` and `DB._set`) that
logs to the Error Log, with a call stack, any write shrinking
`wt_invoices`/`wt_payments` by >half from a >50-record array. **Next step: get the
`SYNC-LOCAL-DROP` line from the user's Error Log to identify the culprit path,
then fix.** (Was blocked on Firestore read-quota exhaustion from heavy
debugging — wait for daily reset / Blaze.)

## Troubleshooting Methodology (read before debugging a reported bug)

**Do NOT guess. Scope the problem with evidence first.** Several past bugs cost many
release cycles because fixes were shipped against a guessed cause. Follow this:

1. **Reproduce / observe before changing code.** Restate the exact symptom. If the
   report is ambiguous (e.g. "add disappears", "not sync"), ask the user a *focused*
   disambiguating question (`AskUserQuestion`) that splits the problem space — e.g.
   "does the new record appear on the OTHER device before you refresh?" (push-side vs
   read-side) — rather than assuming.
2. **Get real logs, not theories.** DevTools is **disabled in release Tauri builds**,
   so add an **on-screen diagnostic** (see the **ตรวจซิงค์** button / `*.diagnose()`
   pattern in the sync modules) that prints state + a recent action log with a copy
   button, ship it, and have the user paste the output. Instrument the suspect path
   (`_logLine`) before attempting a fix. A single real log line ("`applied: cache=96
   → getCustomers=0`") ends days of speculation.
3. **Verify your mental model against the running code, not the repo.** Confirm the
   user is actually on the version you fixed (`APP_VERSION` is shown on the login
   page and Settings) before concluding a fix "didn't work". Check that the code path
   you think runs actually runs (log it).
4. **When the data layer is suspect, prove where the value is lost** — cache vs
   `_get` vs the accessor vs the server **vs the OS/platform I/O boundary** — with
   explicit probes, before editing. The suspect list is NOT only app-layer code: a
   bug can live in **config/permissions** (e.g. the Tauri `fs` allowlist `scope`),
   not in `.js` at all. If reads come back empty and writes "succeed" but nothing
   persists, suspect the I/O/permission boundary **before** the app logic.
5. **One change at a time, then re-measure.** Don't stack multiple speculative fixes
   in one release; you won't know which mattered (or which regressed).
6. **Prefer an ACTIVE round-trip test over a PASSIVE state probe.** Reporting state
   (counts, a recent-action log — the `*.diagnose()` style) is necessary but often
   not sufficient: it shows *what* but not *why*. To pin an I/O failure, **exercise
   the suspect operation directly and surface its raw error** — write a probe file
   then read it back, and print the actual exception string on screen. The on-screen
   **ตรวจ HDD** button (`runHddCheck` in settings.js) is the canonical example: it
   surfaced `"path not allowed on the configured scope: …\data\wt_invoices.json"` —
   the exact `fs` scope bug that ~8 passive symptom-fixes never revealed.
7. **Audit error handlers in the suspect path — a swallowed error blinds every probe
   above it.** `_tauri.write` used `.catch(e => console.warn(...))`; `console.warn`
   is invisible in release Tauri, AND the caught rejection let `waitForHddWrites`
   report false success. So higher-layer probes (`SYNC-LOCAL-DROP` at the array-write
   layer) stayed silent while the real failure was eaten at the I/O layer. Before
   trusting "no probe fired", confirm the failing call isn't being caught-and-hidden.
8. **A working fallback can mask a broken primary for a long time.** HDD persistence
   was broken from day one but invisible because Firestore re-pulled the data into
   cache on every login — until the read quota ran out and exposed it. If a symptom
   only appears under a *special* condition (quota exhausted, offline, a specific
   device), suspect that a fallback was hiding a deeper failure, and **test the
   primary path in isolation** (e.g. read the HDD file directly, ignore the cache).

If you cannot clearly explain *why* a change fixes the observed log/behavior, you do
not yet understand the bug — gather more evidence instead of shipping.

> **Case study (v1.0.146→160, "invoices vanish / lost on restart"):** ~8 releases
> shipped symptom-guards (additive listener, empty-write skips, import-waits-for-ready)
> because probes were placed at the array-write layer while the value was actually
> lost at the Tauri `fs` permission boundary. The fix was a one-line config change —
> `fs.scope` `"$APPDATA/*"` → `"$APPDATA/**"` (a single-star glob doesn't cross `/`,
> so the two-levels-deep `data/wt_*.json` store was denied). Found only once an
> **active write+read round-trip test** printed the raw scope error on screen. The
> guards from those 8 releases were kept as defense-in-depth, but the root cause was
> config, surfaced by exercising I/O — not by reading more app logic. (Binary change:
> needed a fresh `.msi`, not the JS auto-update.)

## sessionStorage keys used by sync

| Key | Purpose |
|---|---|
| `wt_sync_session_pulled` | Session guard — set after first `_pullAll()`; cleared by `Auth.logout()` |
| `wt_sync_pull_ids` | JSON map of `colName → [id, …]`; persisted `_pullIds` for listener guard |
| `wt_cust_unacked` / `wt_prod_unacked` / `wt_price_unacked` / `wt_user_unacked` | Per-module set of record ids written locally but not yet server-acknowledged (see Single-Source-of-Truth Sync Modules) |

> Per-module bootstrap flags `wt_*_v2_migrated` are stored via `DB` (HDD-backed in Tauri), not sessionStorage.

## Git Note

The sandbox cannot remove Windows `.git/HEAD.lock` or `.git/index.lock` files. If a commit or checkout fails with a lock error, run in a local terminal:

```bash
del "C:\Users\APINUN_JP\Downloads\web app\.git\HEAD.lock"
del "C:\Users\APINUN_JP\Downloads\web app\.git\index.lock"
cd "C:\Users\APINUN_JP\Downloads\web app"
git add <files>
git commit -m "..."
git push origin main
```

## Tauri Desktop App (`src-tauri/`)

The app ships as a Windows `.exe`/`.msi` via **Tauri 1.x**. Key facts and gotchas:

### Detecting the desktop runtime — `window.IS_TAURI`
**Always use `window.IS_TAURI` (defined at the top of `utils.js`) — never `location.protocol === 'tauri:'` directly.**
The desktop origin differs by OS:
- macOS / Linux → `tauri://localhost` (`location.protocol === 'tauri:'`)
- **Windows → `https://tauri.localhost`** (`location.protocol === 'https:'`, hostname `tauri.localhost`)

A bare `location.protocol === 'tauri:'` check is **false on Windows**, silently disabling every desktop-only path (HDD storage, OAuth skips, update button, PC name). `IS_TAURI` is true for `tauri:`, `tauri.localhost`, or when `window.__TAURI__` is injected. `utils.js` loads first on every page, so the global is available to `db.js`/`sync.js`/etc. at early-guard time.

### HDD storage (replaces localStorage on desktop)
When `IS_TAURI`, all `wt_*` data lives in **plain JSON files in `%APPDATA%\<app>\data\`** + an in-memory `DB._cache`. localStorage is intentionally kept empty:
- `DB._tauri.init()` (called first in `preloadFromIDB()`) reads every `wt_*.json` from HDD into `DB._cache`. **It loads into the cache, not localStorage.**
- `DB._set()` Tauri branch writes cache → HDD (`_tauri.write`) → `Sync.push()` (Firestore still syncs!); it skips the localStorage/IDB path entirely.
- `DB.init()` Tauri branch wipes all localStorage keys (except `wt_last_user`, `wt_restore_pending`) on every launch so stale data from old builds can't trigger storage-full warnings.
- `DB.invalidate()` is a **no-op in Tauri** — the cache is authoritative (HDD-backed). On the web, invalidate forces a re-read from localStorage; in Tauri that would blank the just-written cache and return `[]` (this caused the "invoice list empty after PDF import" bug).
- `sync.js` `_lsWrite()` / `_localRead()` route to `DB._cache` + HDD in Tauri (not localStorage), so Firestore pulls/merges persist correctly.

### Firebase / Firestore in Tauri
Firestore sync **works** in the desktop app. `firebase-auth-compat.js` is loaded but `sync.js` calls `setPersistence(NONE)` in Tauri so the SDK does **not** create the hidden `[project].firebaseapp.com/__/auth/iframe` (Google rejects that iframe's `tauri://` / `tauri.localhost` origin → the "OAuth 2.0 policy" error). The login page (`index.html`) also loads Firebase + sync so Firestore users are pulled **before** login (otherwise accounts that exist only in Firestore can't authenticate).

### Google Drive is disabled in Tauri
Drive uses Google OAuth, which rejects desktop origins. `drive-config.js` is **excluded from the Tauri build** by `scripts/tauri-copy-dist.js` (which then writes a stub `drive-config.js` setting `GOOGLE_CLIENT_ID=''`, so `<script src>` doesn't get an HTML fallback → no `SyntaxError: Unexpected token '<'`). `DriveStore.init()` / `driveSignIn()` also early-return when `IS_TAURI`.

### Build pipeline
- `scripts/tauri-copy-dist.js` (run by `beforeBuildCommand`) copies web assets into `dist/`, excluding `node_modules`/`src-tauri`/mockups/`drive-config.js`/example files, and writes stub `drive-config.js` + `firebase-credentials.js`.
- `src-tauri/tauri.conf.json`: `withGlobalTauri: true`, `csp: null`, `distDir: "../dist"`, allowlist includes `os` (PC name), `dialog` (confirm/message/ask), `fs`, `path`, `window`; `updater.active: true` with `dialog: true`.
- `src-tauri/Cargo.toml`: tauri features include `updater`, `os-all`, the `dialog-*` set, `fs-*`, `path-all`.
- Dialogs: `window.confirm/alert/prompt` are native in Tauri and require the `dialog` allowlist entries (`confirm`, `message`, `ask`).

### Version sources — keep in sync with `npm run bump`
Three files carry the version: `package.json`, `src-tauri/tauri.conf.json` (drives the auto-update comparison), and `utils.js` `APP_VERSION` (the Settings card display, with an ISO timestamp for date+time). **Always run `node scripts/bump-version.js X.Y.Z` (`npm run bump X.Y.Z`)** to update all three at once, then commit + tag.

## Automatic Updates (Desktop) — release flow

The app checks `releases/latest/download/latest.json` on launch and prompts to install newer **signed** builds. Settings → เวอร์ชันโปรแกรม also has a manual **ตรวจสอบอัปเดต** button (`checkForUpdate()` → `window.__TAURI__.updater.checkUpdate()`; desktop only).

To cut a release:
```bash
npm run bump 1.0.6                 # syncs all 3 version files (ISO datetime label)
git add -A && git commit -m "release v1.0.6"
git tag v1.0.6 && git push origin main --tags
```
`.github/workflows/release-desktop.yml` (Windows runner, Node 24) builds, signs with `TAURI_PRIVATE_KEY`/`TAURI_KEY_PASSWORD` secrets, and publishes the GitHub Release + `latest.json`. The signing **public** key is embedded in `tauri.conf.json`; the **private** key lives only in the `TAURI_PRIVATE_KEY` secret and `src-tauri/.updater-private.key` (gitignored — **back it up; losing it breaks updates for all installed apps**).

> Binary-level changes (new allowlist entries, new Cargo features) require installing a freshly built `.msi` — they can't arrive purely through the asset-only auto-update from a build that predates them.

## Deployment

**Web app:** Push to `main` → `.github/workflows/pages.yml` injects `FIREBASE_TEAM_PASSWORD` into `firebase-config.js` and `GOOGLE_CLIENT_ID` into `drive-config.js` from GitHub Secrets, bumps the SW cache version, and deploys to GitHub Pages.

Required GitHub Secrets (Repo → Settings → Secrets and variables → Actions): `FIREBASE_TEAM_PASSWORD`, `GOOGLE_CLIENT_ID`.

**Desktop app:** Push a `v*` tag → `.github/workflows/release-desktop.yml` builds & signs the Windows installer and publishes a GitHub Release with `latest.json`. Secrets: `TAURI_PRIVATE_KEY`, `TAURI_KEY_PASSWORD`, plus `FIREBASE_TEAM_PASSWORD`. Full flow documented in "Automatic Updates (Desktop) — release flow" above.
