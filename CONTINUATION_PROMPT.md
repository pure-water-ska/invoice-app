# Ready-to-paste continuation prompt

Paste this entire block at the start of a new chat session.

---

## Project context

You are working on **ใบกำกับสินค้า** — a Thai-language invoice management PWA for a water distribution small business. Vanilla JS + Bootstrap 5.3.2, no framework, no bundler. Hosted on Netlify, auto-deployed from GitHub `main`. Primary storage is localStorage (`wt_*` keys) compressed with LZString. Optional real-time sync via Firestore; optional backup via Google Drive.

The project folder is: `C:\Users\APINUN_JP\Downloads\web app`

The full architecture is documented in `CLAUDE.md` in that folder — **always read it at the start of every session.**

---

## UI/UX workflow rule (non-negotiable)

**Always show an interactive mockup (`mcp__visualize__show_widget`) BEFORE writing any code for new UI features.**  
Wait for explicit approval ("ทำเลย" / "do it") before touching any source file.

---

## Security constraint

`firebase-credentials.js` is gitignored. It contains `FIREBASE_CONFIG.teamPassword = "abf88a5893"`. **Never commit it.** It is for local dev only.

---

## Git lock workaround

The sandbox cannot remove Windows lock files. If any git operation (commit, checkout, reset) fails with a lock error, tell the user to run locally:

```bash
del "C:\Users\APINUN_JP\Downloads\web app\.git\HEAD.lock"
del "C:\Users\APINUN_JP\Downloads\web app\.git\index.lock"
```

Then retry the git command in a local terminal.

---

## Current codebase state (as of last session — 2026-05-27)

All changes below are already committed to `main` (latest commit: `a52cf9a`).

### What was built / fixed across the last two sessions

**sync.js — invoice list disappearing (root fix)**
- `_savePullIds(colName)` / `_loadSavedPullIds(colName)` helpers persist `_pullIds` to `sessionStorage['wt_sync_pull_ids']` immediately after `_pullAll()` fills them from Firestore.
- `_seedStateFromLocalStorage()` and the COL_SKIP path both restore `_pullIds` from sessionStorage (not from all local IDs). This prevents un-synced local invoices from being treated as Firestore deletions on page navigation.

**sync.js — DOCUMENT listener keeps `_lastDocTs` current**
- After processing a remote DOCUMENT snapshot, the listener updates `localStorage['wt_sync_doc_ts'][docName]` to the server timestamp. Without this, the delta-skip optimisation in `_pullAll()` would block re-fetching a document that changed between page navigations.

**auth.js — new users can't sign in on other devices**
- `Auth.logout()` now clears `sessionStorage['wt_sync_session_pulled']` (forces a full Firestore pull on the next login) and deletes `_lastDocTs['users_cfg']` (forces `users_cfg` to be re-fetched even if the server timestamp hasn't advanced). Both are required for a freshly-created user to be visible on other devices immediately.

**db.js — IndexedDB overflow**
- When `localStorage.setItem()` throws `QuotaExceededError`, `DB._set()` silently moves the key to IndexedDB (`wt_data_v1` store, `idb.js`). The overflowed key set is tracked in `DB._idbKeys` (a `Set`) and persisted to `localStorage['wt_idb_keys']`. All read paths (`DB._get`, `DB._getArray`, `sync._localRead`, `sync._lsWrite`) respect `_idbKeys`.

**db.js — `DB.addBrandToCustomer(custId, brand)`**
- Idempotent helper that appends a brand to a customer's `brands[]` array (migrating from the legacy scalar `brand` field if needed). All pages that register a brand must call this instead of calling `DB.updateCustomer()` directly.

**sync.js — NO_SYNC list**
- `Sync.NO_SYNC = new Set(['wt_activity', 'wt_logins', 'wt_errors'])` — these keys are saved locally but never pushed to or pulled from Firestore.

**utils.js — `Utils.compressImage(file, maxPx=1200, quality=0.82)`**
- Promise-based canvas downscale utility. Returns a JPEG `data:` URL. All image inputs in the app use this — `versions.html`, `returns.html`, `cap-stock.html`, `payments.html`.

**versions.html — four fixes**
- `loadVerImage()` is async and uses `Utils.compressImage`.
- `imgPreviewHtml()` passes `this.src` directly to `openLightbox()`.
- `openLightbox(fullSrc)` receives the URL directly (no DOM query).
- `saveVersion()` explicitly validates the raw date input and calls `Utils.showAlert('รูปแบบวันที่ไม่ถูกต้อง ...')` on failure instead of silently falling back to today's date.

**local-folder-sync.js — new file**
- Mirrors all DB keys to a user-selected local directory via the File System Access API. Each key saved as `wt_<name>.json`. Folder handle persisted in IndexedDB. Public API: `init()`, `selectFolder()`, `reconnect()`, `disconnect()`, `writeAll()`, `queueWrite(key, val)`, `restore()`, `getStatus()`. Guarded with `if (!window.LocalFolderSync)`.

---

## Key files and their roles

| File | Role |
|---|---|
| `db.js` | All localStorage/IDB read-write; `DB.K.*` key constants |
| `sync.js` | Firestore bidirectional sync; COLLECTIONS + DOCUMENTS |
| `auth.js` | Session, SHA-256 passwords, 47 permissions |
| `idb.js` | IndexedDB `wt_data_v1` key-value store |
| `utils.js` | Shared utilities incl. `Utils.compressImage`, `Utils.parseBEToISO` |
| `nav.js` | Navbar, SW registration, dark mode, loads `sync.js` |
| `sw.js` | Service Worker — Network-First HTML, Cache-First assets |
| `local-folder-sync.js` | File System Access API local folder mirror |
| `bedate.js` | Buddhist Era ↔ ISO date helpers |
| `style.css` | Global styles incl. A5 print layout |
| `CLAUDE.md` | Full architecture reference — read every session |

---

## How to start a new task

1. Read `CLAUDE.md` from the project folder.
2. If the task involves new UI, show a mockup first.
3. Check `git status` / `git diff HEAD --name-only` to confirm the working tree is clean.
4. Make changes, syntax-check JS files with `node --check <file>`, then commit.
