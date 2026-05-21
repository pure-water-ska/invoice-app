# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ใบกำกับสินค้า** — a Thai-language invoice management PWA for small businesses (water distribution). Runs entirely in the browser with no build step. Optional real-time sync via Firestore and backup via Google Drive.

- **Stack:** Vanilla JS + HTML + Bootstrap 5.3.2, no framework, no bundler
- **Hosting:** Netlify (static), deployed from GitHub on push to `main`
- **Offline-first:** Service Worker + localStorage as primary data store

## UI/UX Workflow Rule

**Always show an interactive mockup/example BEFORE writing any code for new UI features.**

- For any new page, modal, card, form, or visible UI change — build an interactive HTML mockup using `mcp__visualize__show_widget` first.
- Wait for explicit user approval ("ทำเลย" / "do it") before touching any source files.
- This rule applies even when the request sounds straightforward. Mockup first, code second.

## Running Locally

No install step. Serve the directory with any HTTP server:

```bash
python -m http.server 8000
# or
npx serve .
```

Open `index.html` (login page) in the browser. The app works fully offline without Firestore or Drive credentials.

**Optional Firebase sync:** Copy `firebase-config.example.js` → `firebase-credentials.js` and fill in the team password.

**Optional Drive backup:** Copy `drive-config.example.js` → `drive-config.js` and fill in `GOOGLE_CLIENT_ID`.

## Architecture

### Data Layer

`db.js` wraps localStorage with namespaced keys (`wt_*`). Every `DB._set()` call automatically queues a Firestore push and a Drive backup upload — the sync engines are no-ops when not configured.

- Collections (array per Firestore doc): `invoices`, `payments`
- Documents (single object): `customers`, `products`, `pricing`, `settings`, `users`, `returns`, etc.

### Sync Engines

- **`sync.js`** — Firestore bidirectional sync. Listens for remote changes → writes to localStorage. Debounces with a 2.5 s echo-prevention window.
- **`drive-store.js` + `drive-db-sync.js`** — Google Drive OAuth token in sessionStorage, uploads DB keys debounced at 5 s. Drive token cached in IndexedDB (`idb.js`).

### Hybrid Architecture (Online / Offline / Background Sync)

The sync layer implements a three-tier hybrid strategy:

**Layer 1 — Real-time listeners (`sync.js`)**
All Firestore reads use `onSnapshot()` with `{ includeMetadataChanges: true }`. Every snapshot callback inspects `snapshot.metadata.fromCache` to distinguish live server data from cached data. Do NOT use `navigator.onLine` for Firestore connection state — only `fromCache` is reliable (the network can be up but Firestore unreachable, or vice-versa).

**Layer 2 — Connection banner (`connection-status.js`)**
`sync.js` dispatches `sync:connectionstate` custom events whenever `fromCache` transitions between `true` and `false`. `ConnectionStatus` (in `connection-status.js`) listens for these events and shows/hides a non-blocking amber bottom banner:
- `fromCache === true` → banner visible: *"⏳ รอการอัปเดต — การเปลี่ยนแปลงจะซิงค์เมื่อเชื่อมต่ออีกครั้ง"*
- `fromCache === false` → banner dismissed automatically

`connection-status.js` is loaded by `nav.js` dynamically (Network-Only, same as `sync.js`) just before `sync.js`.

**Layer 3 — Background Sync (`sw.js` + `sync.js`)**
When a Firestore write fails and is enqueued (`sync._enqueue()`), the code registers a Background Sync tag via `navigator.serviceWorker.ready → reg.sync.register('sync-pending-writes')`. When the browser detects connectivity, `sw.js` handles the `sync` event and posts `{ type: 'FLUSH_PENDING_WRITES' }` to all open clients. Each client's `sync.js` then calls `_flushQueue()` to replay the localStorage write queue. Browsers without Background Sync support (Safari, Firefox) fall back to Firestore's own built-in offline write queue (enabled via `enableIndexedDbPersistence`) plus the existing `window online` listener.

**Firestore offline persistence**
`sync.js` calls `this._db.enableIndexedDbPersistence({ synchronizeTabs: false })` during `init()`. `synchronizeTabs: false` is required for multi-device safety — `synchronizeTabs: true` uses a single primary-tab lock that blocks a second device from connecting when both devices share the same Firebase team account.

### Auth & Permissions

`auth.js` — session stored in sessionStorage (clears on tab close). SHA-256 hashed passwords. 47 granular permissions in `Auth.PERMS`; Admin role bypasses all checks. First-login forces password change.

```javascript
if (!Auth.can('invoice_delete')) { /* deny */ }
```

### Pages

`index.html` (login) → `dashboard.html` → 44 feature pages. Each page must include this shell near the top:

```html
<script src="utils.js"></script>
<script src="db.js"></script>
<script src="auth.js"></script>
<div id="navContainer"></div>
<script src="nav.js"></script>
```

Then call `Nav.render('page-name')` in an inline script.

`nav.js` renders the navbar, handles PWA install prompt, Service Worker registration, connection status badge, and dark mode.

### Service Worker

`sw.js` uses Network-First for HTML, Cache-First for assets. `nav.js`, `sync.js`, `connection-status.js`, and `settings.js` are always Network-Only so fixes take effect immediately without an SW update cycle. Cache version is bumped by `netlify-build.sh` on every deploy so browsers clear stale assets. `sw.js` also handles the `sync` event (tag `sync-pending-writes`) for Background Sync.

## Key Conventions

- **No reactivity:** The DOM is not auto-synced to data. After writing to DB, call render functions explicitly.
- **New localStorage key:** Define it in `DB.K.*` inside `db.js`.
- **New permission:** Add to `Auth.PERMS` in `auth.js`, then check with `Auth.can('key')`.
- **Error logging:** Uncaught errors go to `DB.logError()` → `wt_errors` key; visible in Settings → Troubleshoot.
- **Print layout:** A5 invoice format defined with `@media print` rules in `style.css`.

## Deployment

Push to `main` → GitHub Actions triggers Netlify build → `netlify-build.sh` injects Firebase/Drive config from env vars and bumps the SW cache version.

Required Netlify environment variables: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`, `FIREBASE_ORG_ID`, `FIREBASE_TEAM_EMAIL`, `FIREBASE_TEAM_PASSWORD`, `GOOGLE_CLIENT_ID`.
