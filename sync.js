// sync.js — Real-time Firestore sync engine
// ─────────────────────────────────────────────────────────────────────────────
// โหลดหลัง firebase-config.js (inject โดย nav.js อัตโนมัติ)
// ถ้าไม่มี FIREBASE_CONFIG → ทำงานเป็น no-op, ไม่กระทบ localStorage เดิมเลย
// ─────────────────────────────────────────────────────────────────────────────

var Sync = {
  ready:          false,
  _db:            null,
  _orgId:         null,
  _uid:           null,
  // Per-device UUID — unique per browser instance, persisted in IndexedDB
  // (survives localStorage.clear()).  Loaded asynchronously by _initDeviceId()
  // at the very start of init() before any Firestore calls.
  // Used instead of _uid to detect "my own echo" vs "remote change" because
  // all devices share the same Firebase team account (same _uid everywhere).
  _deviceId:      null,
  _online:        navigator.onLine,
  _unsubscribers: [],
  _skipInitialMs: 800,        // ms to ignore incoming snapshots (= our own writes)
  _ignoreUntil:   {},         // { [lsKey]: epoch ms } — per-key ignore window
  _pendingLsKey:  'wt_sync_pending',
  _lastSyncKey:   'wt_sync_lastAt',
  _lastPulledKey: 'wt_sync_lastPulledAt', // set at end of every successful _pullAll(); used for delta optimisation
  _tombstoneKey:  'wt_sync_tombstones',  // persists deleted IDs across page loads
  _tombstoneTTL:  30 * 60 * 1000,        // 30 minutes — auto-expire if purge never ran
  _serverIds:     {},                    // { [colName]: Set<id> } cached from last _pullAll
  _pullIds:       {},                    // { [colName]: Set<id> } IDs seen at _pullAll time — used by listener to distinguish "new this session" vs "deleted on another device"
  _lastPushedIds: {},                    // { [colName]: Set<id> } IDs from the most recent push() call — used to detect same-debounce-window add→delete (where ADD is cancelled and _serverIds never gets the new ID)
  _pushDebounce:  {},                    // { [lsKey]: timeoutId } — debounce rapid collection writes
  _docDebounce:   {},                    // { [lsKey]: timeoutId } — debounce DOCUMENTS writes (opt ①)
  _pendingWrite:  {},                    // { [lsKey]: boolean } — true while a debounced write is in-flight; listener skips snapshots during this window to avoid overwriting just-modified local data (e.g. cancelled payment)
  _lastFromCache: undefined,             // last known snapshot.metadata.fromCache value — deduplicates sync:connectionstate events
  _lastDocJson:   {},                    // { [lsKey]: string } — JSON fingerprint of last written DOCUMENT; skip write if unchanged (opt ②)
  _lastSyncedRecs:{},                    // { [colName]: Map<id,string> } — JSON fingerprint per record; diff to send only changed records (opt ③)
  ARCHIVE_MONTHS:    6,                  // invoices older than this are not fetched on page load (date-filtered _pullAll)
  _persistedSidsKey: 'wt_sync_sids',    // localStorage key for per-collection Set<id> that survives page reloads — enables tombstone-deletion of archived invoices outside the pull window

  // ── Large collections → one Firestore doc per record ──────────────────────
  // (avoids 1 MB Firestore document limit for busy businesses)
  COLLECTIONS: {
    'wt_invoices':  'invoices',
    'wt_payments':  'payments',
  },

  // ── Small/medium collections → one Firestore document holds the whole array ─
  DOCUMENTS: {
    'wt_customers':       'customers',
    'wt_products':        'products',
    'wt_pricing':         'pricing',
    'wt_settings':        'settings',
    'wt_users':           'users_cfg',      // avoid name clash with Firebase auth
    'wt_returns':         'returns',
    'wt_versions':        'versions',
    'wt_pay_methods':          'pay_methods',
    'wt_transfer_accounts':    'transfer_accounts',
    'wt_cap_colors':      'cap_colors',
    'wt_cap_receipts':    'cap_receipts',
    'wt_cap_deductions':  'cap_deductions',
    'wt_price_history':   'price_history',
    'wt_inv_counter':     'inv_counter',
    'wt_activity':        'activity_log',   // activity log — local-only (see NO_SYNC)
    'wt_logins':          'login_log',      // login history — local-only (see NO_SYNC)
  },

  // ── Keys excluded from Firestore sync ─────────────────────────────────────
  // These stay in localStorage only — never pushed or pulled from Firestore.
  //
  // Rationale:
  //   wt_activity / wt_logins — append-only logs that grow without bound.
  //     Storing them as DOCUMENTS means every new log entry rewrites the ENTIRE
  //     growing array to Firestore.  After 3 months the payload can be 2,000+
  //     records per write.  No device needs to see another device's activity
  //     feed in real time, so the sync provides zero value.
  //   wt_errors — local debug log; no value syncing it.
  //
  // To re-enable sync for any key, remove it from this Set and add it back to
  // DOCUMENTS (and the corresponding Firestore doc comment).
  NO_SYNC: new Set([
    'wt_activity',
    'wt_logins',
    'wt_errors',
  ]),

  // ── Tombstones: persist deleted record IDs so _pullAll + listener won't restore them ──
  _getTombstones(colName) {
    try {
      const all = JSON.parse(localStorage.getItem(this._tombstoneKey) || '{}');
      return all[colName] || {};
    } catch { return {}; }
  },

  _addTombstones(colName, ids) {
    try {
      const all = JSON.parse(localStorage.getItem(this._tombstoneKey) || '{}');
      if (!all[colName]) all[colName] = {};
      const now = Date.now();
      ids.forEach(id => { all[colName][id] = now; });
      localStorage.setItem(this._tombstoneKey, JSON.stringify(all));
    } catch {}
  },

  _clearTombstones(colName, ids) {
    try {
      const all = JSON.parse(localStorage.getItem(this._tombstoneKey) || '{}');
      if (!all[colName]) return;
      ids.forEach(id => delete all[colName][id]);
      if (!Object.keys(all[colName]).length) delete all[colName];
      if (!Object.keys(all).length) localStorage.removeItem(this._tombstoneKey);
      else localStorage.setItem(this._tombstoneKey, JSON.stringify(all));
    } catch {}
  },

  // Filter a Firestore snap array through active tombstones for that collection
  _applyTombstones(colName, snapDocs) {
    const stones = this._getTombstones(colName);
    const now    = Date.now();
    return snapDocs.filter(d => {
      const t = stones[d.id];
      if (!t) return true;                    // not tombstoned — keep
      if (now - t > this._tombstoneTTL) {     // tombstone expired — allow through
        this._clearTombstones(colName, [d.id]);
        return true;
      }
      return false;                           // tombstoned — skip
    });
  },

  // ── Persisted server IDs — survive page reloads for archive tombstone correctness ──
  // _pullAll() only fetches the last ARCHIVE_MONTHS of invoices. Without persistence,
  // _serverIds[invoices] would only contain the recent window, so _writeKey() couldn't
  // detect deletions of older archived invoices and they'd silently linger in Firestore.
  // By persisting the full known-server-ID set to localStorage, every page load starts
  // with the complete picture regardless of how far back the archive window extends.
  _saveServerIds(colName) {
    try {
      const all = JSON.parse(localStorage.getItem(this._persistedSidsKey) || '{}');
      all[colName] = [...(this._serverIds[colName] || new Set())];
      localStorage.setItem(this._persistedSidsKey, JSON.stringify(all));
    } catch {}
  },

  _loadSavedServerIds(colName) {
    try {
      const all = JSON.parse(localStorage.getItem(this._persistedSidsKey) || '{}');
      return new Set(all[colName] || []);
    } catch { return new Set(); }
  },

  // ── Emit Firestore connection state (fromCache) for the connection banner ──
  // Called by every onSnapshot callback with the snapshot's metadata.fromCache value.
  // Deduplicates: only dispatches when the state actually changes so the banner
  // doesn't flicker on every snapshot delivery.
  _emitConnectionState(fromCache) {
    if (fromCache === this._lastFromCache) return;
    this._lastFromCache = fromCache;
    window.dispatchEvent(new CustomEvent('sync:connectionstate', { detail: { fromCache } }));
  },

  // ── Show badge helper (always makes badge item visible) ───────────────────
  _showBadge(status, msg) {
    // Ensure badge item is visible
    const bi = document.getElementById('syncBadgeItem');
    if (bi) bi.style.display = '';
    this._badge(status);
    if (msg) console.log('[Sync]', msg);
  },

  // ── Load / generate device ID from IndexedDB ──────────────────────────────
  // IndexedDB is used instead of localStorage so the ID survives
  // Settings → Clear Data (which wipes localStorage).  A stable ID means
  // echo detection keeps working even after the user clears local data.
  //
  // Migration path: on first run after this upgrade the old ID is read from
  // localStorage and promoted to IndexedDB — no echo-suppression gap.
  async _initDeviceId() {
    const IDB_KEY = 'sync_device_id';
    const LS_KEY  = 'wt_sync_device_id';
    try {
      if (typeof IDB === 'undefined') throw new Error('IDB not loaded');
      // 1. Primary source: IndexedDB (durable across localStorage.clear())
      let id = await IDB.get(IDB_KEY);
      if (!id) {
        // 2. Migrate from localStorage if this device already has one
        id = localStorage.getItem(LS_KEY) || null;
      }
      if (!id) {
        // 3. Generate a brand-new ID
        id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      }
      // Always write to IDB so the ID is safe from future localStorage clears
      await IDB.set(IDB_KEY, id);
      // Keep a best-effort copy in localStorage as a fast read cache
      try { localStorage.setItem(LS_KEY, id); } catch {}
      this._deviceId = id;
      console.log('[Sync] Device ID ready (IDB):', id);
    } catch (e) {
      // IDB unavailable (private browsing with strict settings, or idb.js not yet loaded)
      if (e.message !== 'IDB not loaded') {
        console.warn('[Sync] IDB unavailable for device ID, using localStorage fallback:', e.message);
      }
      let id = localStorage.getItem(LS_KEY);
      if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        try { localStorage.setItem(LS_KEY, id); } catch {}
      }
      this._deviceId = id;
    }
  },

  // ── Initialize ─────────────────────────────────────────────────────────────
  async init() {
    // Load (or generate) device ID from IndexedDB first — must be ready before
    // any _writeKey() or listener echo-detection call.
    await this._initDeviceId();

    if (typeof FIREBASE_CONFIG === 'undefined' || !FIREBASE_CONFIG.apiKey ||
        FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...')) {
      console.log('[Sync] No valid Firebase config — local-only mode');
      window.dispatchEvent(new Event('sync:ready'));
      return;
    }

    // Show badge immediately so user knows sync is starting
    this._showBadge('pending', 'Connecting to Firestore...');

    try {
      console.log('[Sync] Step 1: initializeApp');
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      console.log('[Sync] Step 2: firestore()');
      this._db    = firebase.firestore();
      this._orgId = FIREBASE_CONFIG.orgId || 'main';

      // ── Enable IndexedDB offline persistence ─────────────────────────────
      // synchronizeTabs:false avoids the multi-tab primary-lock that blocked a
      // second device from connecting (both devices share the same Firebase team
      // account and both tried to claim the single-primary-tab IndexedDB lock).
      // With synchronizeTabs:false each tab/device keeps its own independent cache.
      // This makes onSnapshot() serve its initial snapshot from IndexedDB (free,
      // fromCache:true) instead of always fetching from the server.
      try {
        await this._db.enableIndexedDbPersistence({ synchronizeTabs: false });
        console.log('[Sync] IndexedDB persistence enabled');
      } catch (e) {
        // failed-precondition = another tab owns the lock (harmless with synchronizeTabs:false)
        // unimplemented       = browser doesn't support IndexedDB (Safari private mode, etc.)
        const known = ['failed-precondition', 'unimplemented'];
        if (known.includes(e.code)) {
          console.log('[Sync] Persistence:', e.code === 'unimplemented'
            ? 'not supported by this browser — running without cache'
            : 'lock conflict (another tab) — running without cache');
        } else {
          console.warn('[Sync] Persistence error:', e.code, e.message);
        }
      }

      // ── Listen for Background Sync wake-up from the Service Worker ───────
      // When a write was queued (offline) and the SW fires 'sync-pending-writes',
      // the SW posts FLUSH_PENDING_WRITES to all clients so they flush the queue.
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'FLUSH_PENDING_WRITES') {
            console.log('[Sync] Background Sync wake-up — flushing queue');
            this._flushQueue();
          }
        });
      }

      // ── Determine which Firebase account to use for this session (Phase 3) ──
      // Each app user gets their own Firebase Auth account provisioned by users.html.
      // sync.js reads the app session (sessionStorage) → user record → firebaseEmail /
      // firebasePassword.  Users not yet provisioned fall back to the shared teamEmail.
      // On the login page itself Auth.session() returns null → teamEmail is used.
      const _appSession = (window.Auth && Auth.session) ? Auth.session() : null;
      const _appUser    = (_appSession && window.DB) ? DB.getUserById(_appSession.userId) : null;
      const _fbEmail    = _appUser?.firebaseEmail    || FIREBASE_CONFIG.teamEmail;
      const _fbPass     = _appUser?.firebasePassword || FIREBASE_CONFIG.teamPassword;

      // Sign in so Firestore WebChannel has a valid ID token.
      // Firebase Auth persists credentials in IndexedDB across page loads.
      // We wait for the cached state to restore first — if already signed in,
      // no network request is needed, avoiding auth/network-request-failed errors
      // on flaky connections.
      console.log('[Sync] Step 3: restoreAuthState');
      // Race against a 3-second timeout so a slow/broken IndexedDB auth cache
      // doesn't hang the entire init (and leave the login button disabled forever).
      const restoredUser = await Promise.race([
        new Promise(resolve => {
          const unsub = firebase.auth().onAuthStateChanged(u => { unsub(); resolve(u); });
        }),
        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
      ]);
      console.log('[Sync] Step 4: auth state =', restoredUser ? restoredUser.email || 'anon' : 'none (timed out or fresh)');

      if (!restoredUser) {
        // No cached session — need a real network sign-in
        console.log('[Sync] Step 4b: signIn (network) →', _fbEmail || 'anonymous');
        if (_fbEmail && _fbPass) {
          await firebase.auth().signInWithEmailAndPassword(_fbEmail, _fbPass);
        } else {
          await firebase.auth().signInAnonymously();
        }
      } else if (_fbEmail && restoredUser.email !== _fbEmail) {
        // Cached session belongs to a different Firebase account — this happens
        // when a different app user logs in, or when a user's account was just
        // provisioned after they were already signed in via teamEmail.
        // Sign out of the stale session and authenticate with the correct account.
        console.log('[Sync] Step 4c: auth switch', restoredUser.email, '→', _fbEmail);
        await firebase.auth().signOut();
        if (_fbEmail && _fbPass) {
          await firebase.auth().signInWithEmailAndPassword(_fbEmail, _fbPass);
        } else {
          await firebase.auth().signInAnonymously();
        }
      }
      this._uid = firebase.auth().currentUser?.uid || 'anon';
      console.log('[Sync] Step 5a: signIn OK, uid=', this._uid);

      // Flush pending queue BEFORE pulling from Firestore so that any records
      // saved on the previous page (and enqueued via beforeunload) are already
      // in Firestore when _pullAll() reads it — preventing them being treated
      // as "missing" and then overwritten.
      console.log('[Sync] Step 6: pre-flush queue');
      await this._flushQueueNow();   // does NOT require this.ready = true
      console.log('[Sync] Step 7: pre-flush done');

      // Pull latest from Firestore → localStorage
      console.log('[Sync] Step 8: pullAll');
      await this._pullAll();
      console.log('[Sync] Step 9: pullAll done');

      // Real-time listeners
      console.log('[Sync] Step 10: setupListeners');
      this._setupListeners();
      console.log('[Sync] Step 11: listeners ready');

      // Mark ready BEFORE flushing queue — so _flushQueue() can proceed
      this.ready = true;
      this._showBadge('online', `✓ Ready (org: ${this._orgId}, uid: ${this._uid})`);
      window.dispatchEvent(new Event('sync:ready'));

      // Flush any remaining queued writes (belt + suspenders)
      await this._flushQueue();

    } catch (e) {
      const msg  = e.message || String(e);
      const code = e.code    || '';
      // Network errors (offline / Firebase unreachable) are not bugs — degrade silently.
      const isNetwork = code === 'auth/network-request-failed' ||
                        code === 'auth/timeout'                ||
                        msg.toLowerCase().includes('network')  ||
                        msg.toLowerCase().includes('timeout')  ||
                        msg.toLowerCase().includes('unreachable');
      if (isNetwork) {
        console.warn('[Sync] Network unavailable — local-only mode:', msg);
        // Clear any stale error stored from a previous failed attempt — network
        // issues are not bugs so we don't want the settings page to show failure.
        try { localStorage.removeItem('wt_sync_last_error'); } catch {}
        this._showBadge('offline');
      } else {
        console.error('[Sync] Init failed:', msg);
        this._showBadge('error');
        const badge = document.getElementById('syncStatusBadge');
        if (badge) badge.title = 'Sync error: ' + msg + '\n(คลิกเพื่อลองใหม่)';
        try { localStorage.setItem('wt_sync_last_error', JSON.stringify({ msg, ts: new Date().toISOString() })); } catch {}
        window.dispatchEvent(new CustomEvent('sync:error', { detail: msg }));
      }
      window.dispatchEvent(new Event('sync:ready')); // Unblock login page even on error
    }

    // Online / offline
    window.addEventListener('online', async () => {
      this._online = true;
      if (this.ready) this._showBadge('online');
      await this._flushQueue();
    });
    window.addEventListener('offline', () => {
      this._online = false;
      this._showBadge('offline');
    });

    // Save any pending debounced writes to the queue before page unloads.
    // Without this, navigating away within 600 ms of addInvoice() cancels the
    // debounce timeout and the record never reaches Firestore.  The queue is
    // flushed by _flushQueueNow() on the NEXT page before _pullAll() runs.
    window.addEventListener('beforeunload', () => {
      // Flush pending COLLECTIONS debounce timers
      for (const [key, timerId] of Object.entries(this._pushDebounce)) {
        if (timerId != null) {
          clearTimeout(timerId);
          delete this._pushDebounce[key];
          const val = (window.DB && DB._cache[key] !== undefined) ? DB._cache[key] : null;
          if (val !== null && val !== undefined) {
            this._enqueue(key, val);
          }
        }
      }
      // Flush pending DOCUMENTS debounce timers (opt ①)
      for (const [key, timerId] of Object.entries(this._docDebounce)) {
        if (timerId != null) {
          clearTimeout(timerId);
          delete this._docDebounce[key];
          const val = (window.DB && DB._cache[key] !== undefined) ? DB._cache[key] : null;
          if (val !== null && val !== undefined) {
            this._enqueue(key, val);
          }
        }
      }
    });
  },

  // ── Called by db._set() ────────────────────────────────────────────────────
  push(key, val) {
    if (!this.COLLECTIONS[key] && !this.DOCUMENTS[key]) return; // key not synced
    if (this.NO_SYNC.has(key)) return; // explicitly excluded from Firestore sync
    // Reset the ignore window for THIS key only so the listener won't echo our own write
    this._ignoreUntil[key] = Date.now() + this._skipInitialMs;
    if (!this.ready || !this._online) {
      this._enqueue(key, val);
      return;
    }
    // ── Debounce collection writes (invoices, payments) ───────────────────────
    // Rapid imports (PDF/Excel) call addInvoice() many times in a loop.
    // Without debounce each call triggers _writeKey → the background purge of
    // push N can race against push N+1 and DELETE the just-added record.
    // Debouncing 600 ms means the full batch lands in ONE write after the loop.
    if (this.COLLECTIONS[key]) {
      clearTimeout(this._pushDebounce[key]);

      // ── Track deletions across push() calls ───────────────────────────────
      // Problem: when the user adds Y and then deletes Y within the 600 ms debounce
      // window, the ADD debounce timer is cancelled by the DELETE push().  The DELETE
      // debounce then fires _writeKey([]) but _serverIds does NOT include Y (the ADD
      // write never ran), so syncDeletedIds = [] and Y is never deleted from Firestore.
      // The listener eventually fires a snapshot that includes Y, and it gets restored.
      //
      // Fix: compare the new val's IDs against the IDs from the PREVIOUS push() call.
      // Any ID present last time but absent now was just deleted — tombstone it
      // immediately and ensure _serverIds contains it so _writeKey issues a Firestore
      // delete even if the earlier ADD was cancelled.
      const colName   = this.COLLECTIONS[key];
      const newArr    = Array.isArray(val) ? val : [];
      const newIds    = new Set(newArr.filter(r => r.id).map(r => r.id));
      const prevIds   = this._lastPushedIds[colName] || new Set();
      const justDeletedIds = [...prevIds].filter(id => !newIds.has(id));
      if (justDeletedIds.length > 0) {
        // Tombstone immediately — prevents listener from restoring while write is pending
        this._addTombstones(colName, justDeletedIds);
        // Ensure _serverIds includes these IDs so _writeKey() can compute syncDeletedIds
        if (!this._serverIds[colName]) this._serverIds[colName] = new Set();
        justDeletedIds.forEach(id => this._serverIds[colName].add(id));
      }
      // Record the IDs being pushed so the NEXT push() can diff against them
      this._lastPushedIds[colName] = newIds;
      // Also add newly-seen IDs to _serverIds so later deletes (> 600 ms) are detected
      if (!this._serverIds[colName]) this._serverIds[colName] = new Set();
      newIds.forEach(id => this._serverIds[colName].add(id));

      // Mark write as pending so the listener ignores incoming snapshots that
      // still carry pre-write Firestore data (e.g. a snapshot showing a payment
      // as uncancelled that was queued before our cancel but delivered later).
      this._pendingWrite[key] = true;
      this._pushDebounce[key] = setTimeout(() => {
        // Clear the timer ID now so beforeunload won't re-enqueue already-written data.
        this._pushDebounce[key] = null;
        // Read fresh value from DB cache at fire time (not the stale closure val)
        const fresh = window.DB ? DB._cache[key] ?? val : val;
        this._writeKey(key, fresh)
          .then(() => { this._pendingWrite[key] = false; })
          .catch(e => {
            this._pendingWrite[key] = false;
            console.warn('[Sync] push failed, queuing:', key, e.message);
            this._enqueue(key, fresh);
            this._badge('pending');
          });
      }, 600);
      return;
    }
    // ── Opt ①②: Debounce DOCUMENTS writes + skip if content unchanged ──────────
    // Mirrors the COLLECTION debounce: collapses rapid saves into one Firestore write.
    // At fire time we also compare a JSON fingerprint — if nothing changed since the
    // last successful write (e.g. a settings re-render that didn't touch relevant keys,
    // or a page navigation that re-saves the same data) we skip the round-trip entirely.
    clearTimeout(this._docDebounce[key]);
    this._docDebounce[key] = setTimeout(() => {
      this._docDebounce[key] = null;
      const fresh     = window.DB ? (DB._cache[key] !== undefined ? DB._cache[key] : val) : val;
      const freshJson = JSON.stringify(fresh);
      if (freshJson === this._lastDocJson[key]) {
        console.log('[Sync] Doc unchanged, skip write:', this.DOCUMENTS[key]);
        return;
      }
      this._writeKey(key, fresh)
        .then(() => { this._lastDocJson[key] = freshJson; })
        .catch(e => {
          console.warn('[Sync] push failed, queuing:', key, e.message);
          this._enqueue(key, fresh);
          this._badge('pending');
        });
    }, 600);
  },

  // ── Write one key to Firestore ─────────────────────────────────────────────
  async _writeKey(key, val) {
    const base    = this._orgRef();
    const docName = this.DOCUMENTS[key];
    const colName = this.COLLECTIONS[key];

    if (docName) {
      const docRef = base.collection('data').doc(docName);

      if (Array.isArray(val)) {
        // ── Array document: replace the whole `d` field ──────────────────
        // Arrays have no meaningful sub-key identity — replace entirely.
        await docRef.set({
          d:  val,
          ts: firebase.firestore.FieldValue.serverTimestamp(),
          by: this._deviceId,
        });

      } else {
        // ── Object document (e.g. wt_settings, wt_inv_counter): field-path update ──
        // Instead of replacing the whole `d` object, write each sub-key via dot-notation
        // (`d.companyName`, `d.autoBackup`, …).  Firestore merges at the field level, so:
        //   • An old-app-version device saving settings without knowing about `autoBackup`
        //     leaves `d.autoBackup` in Firestore completely untouched.
        //   • Two devices editing different sub-keys simultaneously each keep their change.
        // Falls back to set() on 'not-found' (first bootstrap write for this org).
        const updates = {
          ts: firebase.firestore.FieldValue.serverTimestamp(),
          by: this._deviceId,
        };
        for (const [k, v] of Object.entries(val ?? {})) {
          updates[`d.${k}`] = v;
        }
        try {
          await docRef.update(updates);
        } catch (e) {
          if (e.code === 'not-found') {
            // Document doesn't exist yet — create it with the full value
            await docRef.set({ d: val, ts: firebase.firestore.FieldValue.serverTimestamp(), by: this._deviceId });
          } else { throw e; }
        }
      }

    } else if (colName) {
      // ── Collection write: upsert each record as its own Firestore doc ──────
      const arr      = Array.isArray(val) ? val : [];
      const colRef   = base.collection(colName);
      const localIds = new Set(arr.filter(r => r.id).map(r => r.id));

      // ── ① SYNCHRONOUS tombstone — must happen before any await ────────────
      // _serverIds was populated by _pullAll() on this page load. Comparing
      // it against the new array tells us exactly which IDs were deleted.
      // Writing to localStorage here (synchronously) means the tombstones
      // survive even if the user navigates away immediately afterward.
      const knownServerIds = this._serverIds[colName];
      let syncDeletedIds = [];
      if (knownServerIds && knownServerIds.size > 0) {
        syncDeletedIds = [...knownServerIds].filter(id => !localIds.has(id));
        if (syncDeletedIds.length > 0) {
          this._addTombstones(colName, syncDeletedIds);
        }
      }

      // ── Belt-and-suspenders: flush active tombstones even if _serverIds is empty ──
      // Covers the queue-flush path: user deletes a payment and navigates away within
      // the 600 ms debounce window → beforeunload enqueues the deletion → new page load
      // calls _flushQueueNow() BEFORE _pullAll(), so _serverIds is not populated yet.
      // Without this, syncDeletedIds stays empty and the record is never deleted from
      // Firestore — the tombstone blocks it for 5 min, then it silently comes back.
      // Tombstones ARE persisted to localStorage (in push()), so they survive page loads.
      const activeStones = this._getTombstones(colName);
      const stoneNow = Date.now();
      for (const [id, ts] of Object.entries(activeStones)) {
        if (stoneNow - ts <= this._tombstoneTTL && !localIds.has(id) && !syncDeletedIds.includes(id)) {
          syncDeletedIds.push(id);
        }
      }

      if (syncDeletedIds.length > 0) {
        this._ignoreUntil[key] = Date.now() + this._skipInitialMs;
      }

      // Update cached server IDs to reflect the new local state.
      // Invoices: MERGE into the persisted set instead of replacing it.
      // Replacing would erase archive IDs that are not currently in localStorage (those
      // outside the ARCHIVE_MONTHS pull window) on every write — tombstone detection for
      // archived invoices would then silently stop working.
      // Rule: only IDs in syncDeletedIds are removed; all others (including archive) are kept.
      if (colName === 'invoices') {
        const persisted = this._loadSavedServerIds(colName);
        syncDeletedIds.forEach(id => persisted.delete(id));   // remove just-deleted IDs
        localIds.forEach(id => persisted.add(id));             // add / refresh current IDs
        this._serverIds[colName] = persisted;
        this._saveServerIds(colName);
      } else {
        this._serverIds[colName] = new Set(localIds);
      }

      // ── Opt ③: diff against last-synced fingerprints — only write changed/new records ──
      // _lastSyncedRecs[colName] is a Map<id, jsonFingerprint> seeded by _pullAll() and
      // updated after every write.  If a record's content matches what was last written to
      // Firestore we skip its batch.set() entirely.
      // Records absent from the map (e.g. first write on a fresh page load that used the
      // delta-skip path) are treated as new and always written — same as current behaviour.
      const lastRecs  = this._lastSyncedRecs[colName] || new Map();
      const toUpsert  = arr.filter(r => {
        if (!r.id) return false;
        const prev = lastRecs.get(r.id);
        if (prev === undefined) return true;                // not yet seen → write
        const { _by, _ts, ...rClean } = r;
        return JSON.stringify(rClean) !== prev;             // content changed → write
      });

      // ── ② Upsert + delete in ONE atomic batch ────────────────────────────
      // Deletions are in the same batch as upserts so Firestore transitions
      // to the correct state atomically.  The old two-step approach (upsert
      // now, background-purge later) left a gap — any snapshot delivered
      // between "upsert complete" and "purge complete" could restore a
      // just-deleted record.  This was especially visible when the deleted
      // record was the ONLY payment: arr is empty, ops=0, batch.commit() was
      // never called at all, and the record stayed in Firestore indefinitely.
      let batch = this._db.batch();
      let ops   = 0;
      const commit = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };

      for (const record of toUpsert) {
        batch.set(colRef.doc(record.id), {
          ...record,
          _by: this._deviceId,   // per-device ID so remote devices can detect this isn't their own echo
          _ts: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (++ops >= 490) await commit();
      }

      // Delete records removed locally — in the same batch as the upserts.
      for (const id of syncDeletedIds) {
        batch.delete(colRef.doc(id));
        if (++ops >= 490) await commit();
      }

      if (ops > 0) {
        await batch.commit();
        // Extend the ignore window after the commit so the listener skips
        // our own echo (covers both the upserts and the deletes above).
        this._ignoreUntil[key] = Date.now() + this._skipInitialMs;
        // Tombstones served their purpose — Firestore now reflects the
        // deletion, so clear them to avoid false-blocking future restores.
        if (syncDeletedIds.length > 0) this._clearTombstones(colName, syncDeletedIds);
      }

      // Update fingerprint map for ALL current records so the NEXT push() can diff correctly.
      // Done unconditionally (even if ops === 0) so unchanged records also get seeded into
      // the map — without this, they'd be treated as new on every subsequent write.
      if (!this._lastSyncedRecs[colName]) this._lastSyncedRecs[colName] = new Map();
      const recFpMap = this._lastSyncedRecs[colName];
      for (const r of arr) {
        if (!r.id) continue;
        const { _by, _ts, ...rClean } = r;
        recFpMap.set(r.id, JSON.stringify(rClean));
      }
      for (const id of syncDeletedIds) recFpMap.delete(id);
      if (toUpsert.length > 0 || syncDeletedIds.length > 0) {
        console.log(`[Sync] ${colName}: ${toUpsert.length} upserted, ${syncDeletedIds.length} deleted, ${arr.length - toUpsert.length} unchanged (skipped)`);
      }
    }

    localStorage.setItem(this._lastSyncKey, new Date().toISOString());
  },

  // ── Seed _serverIds / _pullIds from localStorage without Firestore reads ────
  // Called by the session-guard skip in _pullAll() so the listener and _writeKey()
  // can still detect deletions correctly on this page.
  _seedStateFromLocalStorage() {
    for (const [lsKey, colName] of Object.entries(this.COLLECTIONS)) {
      try {
        const raw = this._localRead(lsKey);
        const localArr = JSON.parse(raw || '[]');
        if (Array.isArray(localArr)) {
          const ids = new Set(localArr.filter(r => r.id).map(r => r.id));
          if (colName === 'invoices') {
            const persisted = this._loadSavedServerIds(colName);
            ids.forEach(id => persisted.add(id));
            this._serverIds[colName] = persisted;
          } else {
            this._serverIds[colName] = new Set(ids);
          }
          this._pullIds[colName] = new Set(ids);
        }
      } catch {}
    }
    // Seed _lastDocJson fingerprints so the first save on this page doesn't
    // re-push data that's already identical to what's in Firestore.
    for (const [lsKey] of Object.entries(this.DOCUMENTS)) {
      if (this.NO_SYNC.has(lsKey)) continue;
      try {
        const raw = this._localRead(lsKey);
        if (raw && !this._lastDocJson[lsKey]) this._lastDocJson[lsKey] = raw;
      } catch {}
    }
  },

  // ── Safe local read — handles LZString-compressed data + IDB overflow ──────
  // sync.js must NEVER read localStorage directly via JSON.parse(localStorage.getItem())
  // because DB._set() compresses values with LZString.  Always use this helper.
  // For IDB-overflow keys the value lives in DB._cache (loaded by preloadFromIDB).
  _localRead(lsKey) {
    if (window.DB) {
      // IDB-overflow keys have no localStorage copy — read from _cache
      if (DB._idbKeys && DB._idbKeys.has(lsKey)) {
        const v = DB._cache[lsKey];
        return (v !== null && v !== undefined) ? JSON.stringify(v) : null;
      }
      return DB._lzRead(lsKey);                       // decompresses if needed
    }
    return localStorage.getItem(lsKey);               // fallback (no DB yet)
  },

  // ── Safe local write — writes app data to localStorage (or IDB on overflow) ─
  // All sync.js writes of wt_* data must go through this helper so that
  // IDB-overflow keys stay in IDB and DB._cache stays current.
  _lsWrite(lsKey, data) {
    // Always keep DB._cache current — reads within this tick see new data.
    // DB.invalidate() will be a no-op for IDB keys (they don't have a localStorage
    // copy to re-read from), so the cache set here is the lasting reference.
    if (window.DB) DB._cache[lsKey] = data;

    // Key already overflowed to IDB — write there, skip localStorage
    if (window.DB && DB._idbKeys && DB._idbKeys.has(lsKey)) {
      if (window.IDB) IDB.data.set(lsKey, data).catch(e => console.error('[Sync] IDB write failed', lsKey, e));
      return;
    }

    // Write plain JSON (DB._lzRead's first-char guard handles this on next read)
    try {
      localStorage.setItem(lsKey, JSON.stringify(data));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn('[Sync] localStorage full — overflowing', lsKey, '→ IndexedDB');
        if (window.DB) {
          DB._idbKeys.add(lsKey);
          DB._persistIdbKeys();
          DB._notifyIdbOverflow(lsKey);
        }
        if (window.IDB) IDB.data.set(lsKey, data).catch(err => console.error('[Sync] IDB write failed', lsKey, err));
      } else {
        throw e;
      }
    }
  },

  // ── Pull ALL data from Firestore → localStorage (initial load) ─────────────
  async _pullAll() {
    const base = this._orgRef();

    // ── Session-level guard ─────────────────────────────────────────────────
    // This is a multi-page app — every page navigation is a full page reload and
    // Sync.init() calls _pullAll() from scratch.  Without a session guard that
    // means a full Firestore read on EVERY page (14 doc reads + 1000+ collection
    // reads per navigation = quota exhausted in minutes for busy businesses).
    //
    // Fix: after the first successful _pullAll() in a browser session, store a
    // flag in sessionStorage (survives page navigations but clears on tab close
    // or browser restart).  Subsequent calls skip the Firestore reads entirely and
    // just seed state from localStorage — the real-time listeners already catch any
    // remote changes that happened between pages.
    const SESSION_PULLED_KEY = 'wt_sync_session_pulled';
    const sessionPulledAt = sessionStorage.getItem(SESSION_PULLED_KEY);
    if (sessionPulledAt) {
      console.log('[Sync] Session guard: skipping _pullAll() — already pulled this session, listeners are live');
      // Still need to seed _serverIds / _pullIds so the listener and _writeKey()
      // can detect deletions correctly on this page.
      this._seedStateFromLocalStorage();
      // Fire sync:pulled so pages listening for fresh data get their re-render.
      window.dispatchEvent(new CustomEvent('sync:pulled'));
      return;
    }

    // ── Delta pull timing ────────────────────────────────────────────────────
    // For DOCUMENTS: skip the Firestore .get() entirely if the doc hasn't changed
    // since our last pull (checked via the server ts field stored in _lastDocTs).
    // For COLLECTIONS: skip if pulled within the last 5 minutes (listeners catch
    // any remote changes; a full re-fetch is not necessary that frequently).
    const lastPulledAt  = localStorage.getItem(this._lastPulledKey);
    const lastPulledMs  = lastPulledAt ? new Date(lastPulledAt).getTime() : 0;
    const msSincePull   = Date.now() - lastPulledMs;
    const CLOCK_SKEW_MS = 5  * 1000;     // allow 5 s of server/client clock drift
    const COL_SKIP_MS   = 5  * 60 * 1000; // skip collection pull if done within last 5 min
    // Per-doc last-known server timestamps — loaded from localStorage so we can
    // skip the .get() call entirely when a doc hasn't changed since last pull.
    const _lastDocTs = JSON.parse(localStorage.getItem('wt_sync_doc_ts') || '{}');

    // Documents — skip .get() entirely for docs whose server ts predates last pull
    const docPromises = Object.entries(this.DOCUMENTS).map(async ([lsKey, docName]) => {
      if (this.NO_SYNC.has(lsKey)) return; // excluded from sync
      try {
        // Delta: if we have a cached server ts for this doc and it's before our
        // last pull time, skip the Firestore .get() — we already have the latest data.
        const cachedDocTs = _lastDocTs[docName] || 0;
        if (lastPulledMs > 0 && cachedDocTs > 0 && cachedDocTs < lastPulledMs - CLOCK_SKEW_MS) {
          console.log(`[Sync] Delta: skip .get() for ${docName} (cached ts ${new Date(cachedDocTs).toISOString()} ≤ last pull)`);
          return;   // 0 Firestore reads for this doc
        }
        const doc = await base.collection('data').doc(docName).get();
        if (doc.exists && doc.data().d !== undefined) {
          // Save server ts so we can skip this doc on the next page load
          const docTs = doc.data().ts?.toDate?.()?.getTime?.() ?? 0;
          if (docTs > 0) {
            _lastDocTs[docName] = docTs;
            try { localStorage.setItem('wt_sync_doc_ts', JSON.stringify(_lastDocTs)); } catch {}
          }
          // Delta: nothing changed — skip the write (we already paid for the read
          // above because the cached ts was absent/stale, but next time we can skip)
          if (lastPulledMs > 0 && docTs > 0 && docTs < lastPulledMs - CLOCK_SKEW_MS) {
            console.log(`[Sync] Delta: skip write for ${docName} (doc ts ≤ last pull)`);
            return;
          }
          const fsVal = doc.data().d;
          // For array documents (users, customers, products, etc.) merge with local data
          // so records created locally before sync was working are never lost on pull.
          if (Array.isArray(fsVal)) {
            try {
              const raw = this._localRead(lsKey);
              const localArr = JSON.parse(raw || '[]');
              if (Array.isArray(localArr) && localArr.length > 0) {
                const fsIds = new Set(fsVal.filter(r => r.id).map(r => r.id));
                const localOnly = localArr.filter(r => r.id && !fsIds.has(r.id));
                if (localOnly.length > 0) {
                  console.log(`[Sync] Doc merge: keeping ${localOnly.length} local-only ${docName} records`);
                  // Push local-only records into the Firestore doc immediately
                  const merged = [...fsVal, ...localOnly];
                  await this._writeKey(lsKey, merged);
                  this._lsWrite(lsKey, merged);
                  if (window.DB) DB.invalidate(lsKey);
                  this._lastDocJson[lsKey] = JSON.stringify(merged); // opt ②: seed fingerprint
                  return; // skip plain fsVal write below
                }
              }
            } catch {}
          }
          // Write via _lsWrite — handles IDB overflow transparently
          this._lsWrite(lsKey, fsVal);
          if (window.DB) DB.invalidate(lsKey);
          this._lastDocJson[lsKey] = JSON.stringify(fsVal); // opt ②: seed fingerprint so a re-save of pulled data is skipped
        } else {
          // Firestore doc missing → bootstrap: push local data up
          try {
            const raw = this._localRead(lsKey);
            if (raw) {
              const localVal = JSON.parse(raw);
              if (localVal !== null && localVal !== undefined) {
                console.log(`[Sync] Bootstrap doc: pushing ${docName} to Firestore`);
                await this._writeKey(lsKey, localVal);
              }
            }
          } catch (be) { console.warn('[Sync] bootstrap push doc failed:', docName, be.message); }
        }
      } catch (e) { console.warn('[Sync] pull doc:', docName, e.message); }
    });

    // Collections
    const colPromises = Object.entries(this.COLLECTIONS).map(async ([lsKey, colName]) => {
      // Delta: if we pulled recently, populate _serverIds/_pullIds from localStorage and
      // skip the Firestore round-trip — the real-time listener will have kept local data
      // current during navigation.  We can't do a partial query here because it can't
      // detect server-side deletions; a full pull or "skip + trust listener" is the choice.
      if (lastPulledMs > 0 && msSincePull < COL_SKIP_MS) {
        console.log(`[Sync] Delta: skip collection pull ${colName} (pulled ${Math.round(msSincePull / 1000)}s ago — trusting listener)`);
        try {
          const raw      = this._localRead(lsKey);
          const localArr = JSON.parse(raw || '[]');
          if (Array.isArray(localArr)) {
            const ids = new Set(localArr.filter(r => r.id).map(r => r.id));
            if (colName === 'invoices') {
              // Invoices: merge local IDs into the full persisted server-ID set so
              // _writeKey() can tombstone-delete archived records outside the pull window.
              const persisted = this._loadSavedServerIds(colName);
              ids.forEach(id => persisted.add(id));
              this._serverIds[colName] = persisted;
            } else {
              this._serverIds[colName] = new Set(ids);   // deletion detection in _writeKey()
            }
            this._pullIds[colName]   = new Set(ids);   // "new-this-session" guard in listener
          }
        } catch {}
        return;
      }
      // ── Invoice archive: seed _serverIds from persisted IDs before querying ──
      // _pullAll() only fetches the last ARCHIVE_MONTHS of invoices. Loading the
      // persisted set first ensures _writeKey() can tombstone-delete archived
      // invoices even though they won't appear in this page's date-filtered snapshot.
      if (colName === 'invoices') {
        this._serverIds[colName] = this._loadSavedServerIds(colName);
      }
      // ── Date-filtered Firestore query for invoices (archive window) ───────────
      // Regular collections are fetched in full; invoices are filtered to the last
      // ARCHIVE_MONTHS to stay within Firestore read quotas and page-load budgets.
      const cutoffISO = colName === 'invoices'
        ? new Date(Date.now() - this.ARCHIVE_MONTHS * 30.44 * 24 * 3600 * 1000).toISOString()
        : null;
      const colQuery = cutoffISO
        ? base.collection(colName).where('createdAt', '>=', cutoffISO)
        : base.collection(colName);
      try {
        const snap = await colQuery.get();
        if (!snap.empty) {
          // Cache server IDs — used by _writeKey() to tombstone deletions synchronously.
          // Invoices: MERGE fetched IDs into the seeded persisted set (not replace) so
          // archived records outside the 6-month window remain tombstone-trackable.
          if (colName === 'invoices') {
            snap.docs.forEach(d => this._serverIds[colName].add(d.id));
            this._saveServerIds(colName);
          } else {
            this._serverIds[colName] = new Set(snap.docs.map(d => d.id));
          }
          // Cache pull IDs — used by listener to tell "new this session" from "deleted on another device"
          this._pullIds[colName] = new Set(snap.docs.map(d => d.id));
          // Apply tombstones so recently-deleted records aren't restored on page reload
          const fsArr = this._applyTombstones(colName, snap.docs).map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          // MERGE: keep any local records not yet in Firestore (e.g. just-imported, race condition).
          // This prevents a navigating-away-too-quickly race from wiping locally-added records.
          //
          // IMPORTANT: for invoices the Firestore query is date-filtered (last ARCHIVE_MONTHS).
          // Records outside that window fall into two categories:
          //   (a) Archive-already-in-Firestore: knownServerIds.has(r.id) → keep locally, skip push
          //   (b) Newly imported with an old date (PDF import): NOT in knownServerIds → push to
          //       Firestore AND keep locally
          // The previous code used `createdAt < cutoffISO` to detect (a), but that also silently
          // dropped (b) — erasing PDF-imported old invoices the moment the user navigated away.
          try {
            const raw = this._localRead(lsKey);
            const localArr = JSON.parse(raw || '[]');
            if (Array.isArray(localArr) && localArr.length > 0) {
              const fsIds          = new Set(snap.docs.map(d => d.id));
              const stones         = this._getTombstones(colName);
              const knownServerIds = this._serverIds[colName] || new Set();
              const now = Date.now();
              const localOnly = localArr.filter(r =>
                r.id && !fsIds.has(r.id) &&
                (!stones[r.id] || now - stones[r.id] > this._tombstoneTTL)
              );
              if (localOnly.length > 0) {
                // Split: records already known to Firestore (outside archive window) vs genuinely new.
                // knownServerIds is seeded from the persisted ID set + this pull, so it covers all
                // IDs Firestore has ever held — even archived ones outside the date-filtered window.
                const toSync      = localOnly.filter(r => !knownServerIds.has(r.id)); // new → push
                const toKeepLocal = localOnly.filter(r =>  knownServerIds.has(r.id)); // archive → keep only
                console.log(`[Sync] Merge: ${toSync.length} new-to-Firestore + ${toKeepLocal.length} archive-local for ${colName}`);
                // Push genuinely-new records to Firestore so they survive the next pull
                for (const rec of toSync) {
                  try { await base.collection(colName).doc(rec.id).set({ ...rec, _by: this._deviceId, _ts: Date.now() }); } catch {}
                }
                const merged = [...fsArr, ...toSync, ...toKeepLocal];
                this._lsWrite(lsKey, merged);
                if (window.DB) DB.invalidate(lsKey);
                // opt ③: seed fingerprints from merged result
                if (!this._lastSyncedRecs[colName]) this._lastSyncedRecs[colName] = new Map();
                for (const r of merged) {
                  if (r.id) { const { _by, _ts, ...rc } = r; this._lastSyncedRecs[colName].set(r.id, JSON.stringify(rc)); }
                }
                return; // skip the plain fsArr write below
              }
            }
          } catch {}
          this._lsWrite(lsKey, fsArr);
          if (window.DB) DB.invalidate(lsKey);
          // opt ③: seed fingerprints from pulled Firestore records so the first write
          // after page load only sends records that actually changed locally.
          if (!this._lastSyncedRecs[colName]) this._lastSyncedRecs[colName] = new Map();
          for (const d of snap.docs) {
            const { _by, _ts, ...rec } = d.data();
            this._lastSyncedRecs[colName].set(d.id, JSON.stringify(rec));
          }
        } else {
          // Firestore empty → bootstrap: push local data up to Firestore
          // BUG-FIX: must use _localRead() — localStorage may contain LZString-compressed data
          try {
            const raw = this._localRead(lsKey);
            const localArr = JSON.parse(raw || '[]');
            if (Array.isArray(localArr) && localArr.length > 0) {
              console.log(`[Sync] Bootstrap: pushing ${localArr.length} ${colName} records to Firestore`);
              await this._writeKey(lsKey, localArr);
            }
          } catch (be) { console.warn('[Sync] bootstrap push failed:', colName, be.message); }
        }
      } catch (e) { console.warn('[Sync] pull col:', colName, e.message); }
    });

    await Promise.all([...docPromises, ...colPromises]);
    // Record timestamp of this successful pull — used by delta optimisation on the next page load
    try { localStorage.setItem(this._lastPulledKey, new Date().toISOString()); } catch {}
    // Mark session as pulled — subsequent page loads in this tab skip _pullAll() entirely
    try { sessionStorage.setItem(SESSION_PULLED_KEY, Date.now().toString()); } catch {}
    // Notify pages that fresh data is available so they can re-render
    window.dispatchEvent(new CustomEvent('sync:pulled'));
    console.log('[Sync] Initial pull complete');
  },

  // ── Force-push ALL local data to Firestore (use after LZString migration) ──
  async pushAll(onProgress) {
    if (!this.ready) throw new Error('Sync not ready');
    const allKeys = [...Object.keys(this.DOCUMENTS), ...Object.keys(this.COLLECTIONS)];
    const total = allKeys.length;
    let pushed = 0, failed = 0, skipped = 0;
    for (let i = 0; i < allKeys.length; i++) {
      const lsKey = allKeys[i];
      if (onProgress) onProgress({ done: i, total, current: lsKey, pushed, failed });
      try {
        const raw = this._localRead(lsKey);
        if (!raw) { skipped++; continue; }
        const val = JSON.parse(raw);
        if (val === null || val === undefined) { skipped++; continue; }
        await this._writeKey(lsKey, val);
        pushed++;
      } catch (e) {
        console.warn('[Sync] pushAll failed for', lsKey, e.message);
        failed++;
      }
    }
    if (onProgress) onProgress({ done: total, total, current: null, pushed, failed });
    console.log(`[Sync] pushAll: pushed=${pushed} skipped=${skipped} failed=${failed}`);
    return { pushed, failed };
  },

  // ── Real-time listeners ────────────────────────────────────────────────────
  _setupListeners() {
    const base     = this._orgRef();
    // Set per-key initial ignore window — only blocks echo for the key being written
    const now = Date.now();
    for (const key of [...Object.keys(this.DOCUMENTS), ...Object.keys(this.COLLECTIONS)]) {
      this._ignoreUntil[key] = now + this._skipInitialMs;
    }

    // Only block snapshots during the initial page-load window or right after a local write.
    // Note: synchronizeTabs:false means secondary tabs don't use fromCache, so both
    // DOCUMENTS and COLLECTIONS listeners can safely guard on fromCache (see below).
    const shouldSkip = (lsKey) => Date.now() < (this._ignoreUntil[lsKey] || 0);

    // Listen to document keys
    for (const [lsKey, docName] of Object.entries(this.DOCUMENTS)) {
      if (this.NO_SYNC.has(lsKey)) continue; // excluded from sync
      const unsub = base.collection('data').doc(docName)
        .onSnapshot(
          { includeMetadataChanges: true },   // fires on fromCache transitions too
          (doc) => {
            // Track fromCache BEFORE any guards so the banner always reflects reality
            this._emitConnectionState(doc.metadata.fromCache);
            if (shouldSkip(lsKey)) return;
            // Skip if this is a metadata-only event (e.g. pending write confirmed) — no data change
            if (!doc.metadata.hasPendingWrites && doc.metadata.fromCache) return;
            // Skip delayed echo: document was last written by this device
            if (doc.data()?.by === this._deviceId) return;
            if (!doc.exists || doc.data()?.d === undefined) return;

            const fsVal = doc.data().d;

            // For array documents (activity log, login log, users, etc.) MERGE
            // local-only entries rather than wholesale overwriting.
            // Scenario: Device A logs an activity; Device B then writes any document
            // keyed under this same Firestore doc → Device A's listener would replace
            // its local array with Device B's older version, silently losing A's entries.
            if (Array.isArray(fsVal)) {
              try {
                const raw = this._localRead(lsKey);
                const localArr = JSON.parse(raw || '[]');
                if (Array.isArray(localArr) && localArr.length > 0) {
                  const fsIds    = new Set(fsVal.filter(r => r && r.id).map(r => r.id));
                  const localOnly = localArr.filter(r => r && r.id && !fsIds.has(r.id));
                  if (localOnly.length > 0) {
                    // Local has entries not yet in this Firestore snapshot — merge them in
                    // and push the merged array back so Firestore stays canonical.
                    const merged = [...fsVal, ...localOnly];
                    this._lsWrite(lsKey, merged);
                    if (window.DB) DB.invalidate(lsKey);
                    this._notifyUpdate(lsKey);
                    // Push the merged array back to Firestore so all devices agree
                    this._writeKey(lsKey, merged).catch(e =>
                      console.warn('[Sync] Doc merge push failed:', docName, e.message)
                    );
                    return;
                  }
                }
              } catch {}
            }

            this._lsWrite(lsKey, fsVal);
            if (window.DB) DB.invalidate(lsKey);
            this._notifyUpdate(lsKey);
          },
          (err) => console.error('[Sync] Doc listener error:', docName, err.code, err.message)
        );
      this._unsubscribers.push(unsub);
    }

    // Listen to collection keys
    for (const [lsKey, colName] of Object.entries(this.COLLECTIONS)) {
      // ── Invoice archive: apply the same ARCHIVE_MONTHS window used in _pullAll() ──
      // Without this, the very first live snapshot delivers ALL historical invoices and
      // overwrites localStorage — completely bypassing the date-filtered _pullAll().
      // Both the pull query and the listener must use the same cutoff so they stay in sync.
      const listenerCutoffISO = colName === 'invoices'
        ? new Date(Date.now() - this.ARCHIVE_MONTHS * 30.44 * 24 * 3600 * 1000).toISOString()
        : null;
      const colRef = listenerCutoffISO
        ? base.collection(colName).where('createdAt', '>=', listenerCutoffISO)
        : base.collection(colName);
      const unsub = colRef
        .onSnapshot(
          { includeMetadataChanges: true },   // fires on fromCache transitions too
          async (snap) => {
          // Track fromCache BEFORE any guards so the banner always reflects reality
          this._emitConnectionState(snap.metadata.fromCache);
          if (shouldSkip(lsKey)) return;
          // Skip if a debounced local write is still pending — local state is
          // authoritative during this window and must not be overwritten by a
          // Firestore snapshot that predates our write (e.g. a snapshot showing
          // a payment as uncancelled that Firestore delivered after the 800 ms
          // _ignoreUntil window but before our debounced batch.commit() landed).
          if (this._pendingWrite[lsKey]) {
            console.log(`[Sync] Listener skip: pending local write for ${lsKey}`);
            return;
          }
          // Skip fromCache snapshots — Firestore IndexedDB cache may be stale or incomplete
          // after a reconnect.  When this fires after the 800 ms _ignoreUntil window, a stale
          // cache can deliver fewer docs than localStorage.  Because _pullIds is fully seeded
          // by _pullAll(), any "missing" IDs don't make it into localOnly and get silently
          // removed — causing the invoice list to briefly go blank until the server snapshot
          // arrives.  _pullAll() already handled the initial IndexedDB read, so skipping
          // fromCache here is safe.  With synchronizeTabs:false, updates from other devices
          // always arrive fromCache:false, so no real-time changes are lost.
          if (!snap.metadata.hasPendingWrites && snap.metadata.fromCache) {
            console.log(`[Sync] Col listener skip: fromCache snapshot for ${colName} (stale cache guard)`);
            return;
          }
          // Skip delayed echo: all changed docs were written by this device.
          // The time-based _ignoreUntil window can be too short when Firestore
          // queues a snapshot before our write but delivers it after the window
          // expires — this would restore a just-cancelled/deleted record.
          const docChanges = snap.docChanges();
          if (docChanges.length > 0 && docChanges.every(c => c.doc.data()?._by === this._deviceId)) return;
          // Apply tombstones — prevents snapshots from restoring records
          // that were tombstoned locally (belt-and-suspenders with the main batch)
          const fsArr = this._applyTombstones(colName, snap.docs).map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          // MERGE: keep any local-only records not yet confirmed by Firestore.
          // The listener fires ~3s after page load; a just-imported invoice may
          // be in localStorage but not yet in this snapshot (push race condition).
          //
          // IMPORTANT: only consider records added AFTER this page loaded (_pullIds).
          // Records that existed at pull time but are now gone from Firestore were
          // DELETED on another device — do NOT push them back (that is what caused
          // deleted payments to keep reappearing).
          let finalArr = fsArr;
          try {
            const raw = this._localRead(lsKey);
            const localArr = JSON.parse(raw || '[]');
            if (Array.isArray(localArr) && localArr.length > 0) {
              const fsIds    = new Set(snap.docs.map(d => d.id));
              const pullIds  = this._pullIds[colName] || new Set();
              const stones   = this._getTombstones(colName);
              const now      = Date.now();
              const localOnly = localArr.filter(r =>
                r.id && !fsIds.has(r.id) &&
                !pullIds.has(r.id) &&   // added AFTER page load — not a remote deletion
                (!stones[r.id] || now - stones[r.id] > this._tombstoneTTL)
              );
              if (localOnly.length > 0) {
                console.log(`[Sync] Listener merge: keeping ${localOnly.length} new-session ${colName} records (not pushing — next write will sync)`);
                // Do NOT push back here — pushing is what caused records deleted on
                // another device to be restored.  The next DB._set() call (debounced
                // write) will include these records and push them to Firestore naturally.
                finalArr = [...fsArr, ...localOnly];
              }
            }
          } catch {}
          this._lsWrite(lsKey, finalArr);
          if (window.DB) DB.invalidate(lsKey);
          if (snap.docChanges().length > 0) this._notifyUpdate(lsKey);
        },
          (err) => console.error('[Sync] Col listener error:', colName, err.code, err.message)
        );
      this._unsubscribers.push(unsub);
    }
  },

  // ── Offline queue ──────────────────────────────────────────────────────────
  _enqueue(key, val) {
    const q = this._getQueue();
    const i = q.findIndex(e => e.key === key);
    const entry = { key, val, ts: Date.now() };
    if (i >= 0) q[i] = entry; else q.push(entry);
    try { localStorage.setItem(this._pendingLsKey, JSON.stringify(q)); } catch {}
    this._badge('pending');
    // Register a Background Sync tag so the SW can wake the page (or prompt a
    // background flush) when connectivity resumes — even if the tab is backgrounded.
    // Falls back gracefully: browsers without SyncManager (Safari, Firefox) rely on
    // the existing window online/offline listeners + Firestore's own offline queue.
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then(reg => reg.sync.register('sync-pending-writes'))
        .catch(e => console.warn('[Sync] Background Sync register failed:', e.message));
    }
  },

  _getQueue() {
    try { return JSON.parse(localStorage.getItem(this._pendingLsKey)) || []; } catch { return []; }
  },

  // Flush queue without requiring this.ready — used during init before ready is set
  async _flushQueueNow() {
    if (!this._online) return;
    const q = this._getQueue();
    if (!q.length) return;
    console.log(`[Sync] Pre-flush: ${q.length} queued writes`);
    for (const { key, val } of q) {
      try {
        await this._writeKey(key, val);
      } catch (e) {
        console.warn('[Sync] pre-flush error:', key, e.message);
        return; // stop on error, queue stays intact for _flushQueue()
      }
    }
    localStorage.removeItem(this._pendingLsKey);
    console.log('[Sync] Pre-flush done ✓');
  },

  async _flushQueue() {
    if (!this.ready || !this._online) return;
    const q = this._getQueue();
    if (!q.length) return;
    console.log(`[Sync] Flushing ${q.length} queued writes`);
    for (const { key, val } of q) {
      try {
        await this._writeKey(key, val);
      } catch (e) {
        console.warn('[Sync] flush error:', key, e.message);
        return; // stop on error, retry next time
      }
    }
    localStorage.removeItem(this._pendingLsKey);
    this._badge('online');
    console.log('[Sync] Queue flushed ✓');
  },

  // ── Helpers ────────────────────────────────────────────────────────────────
  _orgRef() {
    return this._db.collection('orgs').doc(this._orgId);
  },

  _badge(status) {
    const el = document.getElementById('syncStatusBadge');
    if (!el) return;
    const MAP = {
      online:  { text: '☁ Sync',  cls: 'bg-success' },
      offline: { text: '📴 Offline', cls: 'bg-secondary' },
      pending: { text: '⏳ Syncing…', cls: 'bg-warning text-dark' },
      error:   { text: '⚠ Sync ✗',  cls: 'bg-danger' },
    };
    const s = MAP[status] || MAP.online;
    el.textContent = s.text;
    el.className   = `badge ${s.cls} ms-2 py-1 px-2`;
    el.style.fontSize = '10px';
  },

  _notifyUpdate(lsKey) {
    const label = {
      wt_invoices:  'ใบกำกับ',
      wt_payments:  'ชำระเงิน',
      wt_customers: 'ลูกค้า',
      wt_products:  'สินค้า',
      wt_pricing:   'ราคา',
      wt_returns:   'คืนสินค้า',
    }[lsKey];

    // Only show toast when the current page actually uses this key.
    // Prevents e.g. "คืนสินค้า synced" appearing on the invoices page.
    const page = (location.pathname.split('/').pop() || 'index.html').replace(/\?.*$/, '');
    const PAGE_KEYS = {
      'returns.html':   ['wt_returns'],
      'invoices.html':  ['wt_invoices'],
      'payments.html':  ['wt_invoices', 'wt_payments'],
      'products.html':  ['wt_products', 'wt_pricing'],
      'customers.html': ['wt_customers'],
      'dashboard.html': ['wt_invoices', 'wt_payments'],
    };
    const relevantKeys = PAGE_KEYS[page];
    const isRelevant   = !relevantKeys || relevantKeys.includes(lsKey);

    // Show toast
    if (label && isRelevant) {
      let toast = document.getElementById('syncToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'syncToast';
        toast.style.cssText = 'position:fixed;bottom:1rem;right:1rem;z-index:9999;min-width:180px;';
        toast.className = 'toast show align-items-center text-white bg-dark border-0';
        toast.setAttribute('role', 'alert');
        document.body.appendChild(toast);
      }
      toast.innerHTML = `
        <div class="d-flex">
          <div class="toast-body fw-semibold">
            <i class="bi bi-arrow-repeat me-1"></i>ซิงค์ <strong>${label}</strong> แล้ว
          </div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.closest('.toast').remove()"></button>
        </div>`;
      clearTimeout(toast._hide);
      toast._hide = setTimeout(() => toast.remove(), 3000);
    }

    // Update last-sync timestamp + snapshot counter for the settings card
    localStorage.setItem(this._lastSyncKey, new Date().toISOString());
    const cnt = (parseInt(localStorage.getItem('wt_sync_snap_count') || '0') + 1);
    localStorage.setItem('wt_sync_snap_count', String(cnt));

    // Notify any page that is listening for real-time remote changes
    window.dispatchEvent(new CustomEvent('sync:updated', { detail: { key: lsKey } }));
  },

  // ── Load archived invoices on demand ──────────────────────────────────────
  // Called by invoices.html when the user sets filterFrom older than ARCHIVE_MONTHS.
  // Queries Firestore with a date range, merges results into wt_invoices localStorage,
  // and updates the persisted server-ID set so future deletions of archive records work.
  //
  // @param {string} fromISO  — ISO date string for the lower bound (inclusive)
  // @param {string} [toISO]  — ISO date string for the upper bound (inclusive).
  //                            Defaults to the ARCHIVE_MONTHS cutoff so we only
  //                            fetch the truly "old" records not already in localStorage.
  // @returns {{ count: number }}  — number of NEW records merged into localStorage
  async loadArchive(fromISO, toISO) {
    if (!this.ready || !this._db) throw new Error('Sync not ready');
    const base = this._orgRef();
    const cutoffISO = new Date(Date.now() - this.ARCHIVE_MONTHS * 30.44 * 24 * 3600 * 1000).toISOString();
    const from = fromISO || '2000-01-01T00:00:00.000Z';
    const to   = toISO   || cutoffISO;

    console.log(`[Sync] loadArchive: ${from} → ${to}`);
    let q = base.collection('invoices').where('createdAt', '>=', from)
                                        .where('createdAt', '<=', to);
    const snap = await q.get();
    if (snap.empty) {
      console.log('[Sync] loadArchive: no records found');
      return { count: 0 };
    }

    const lsKey   = 'wt_invoices';
    const existing   = JSON.parse(this._localRead(lsKey) || '[]');
    const existingIds = new Set(existing.filter(r => r.id).map(r => r.id));
    const newRecords  = this._applyTombstones('invoices', snap.docs)
      .filter(d => !existingIds.has(d.id))
      .map(d => { const { _by, _ts, ...rec } = d.data(); return rec; });

    if (newRecords.length > 0) {
      const merged = [...existing, ...newRecords];
      this._lsWrite(lsKey, merged);
      if (window.DB) DB.invalidate(lsKey);
    }

    // Merge all fetched IDs into persisted server-ID set so future deletes of
    // archive records are detected correctly even if _pullAll() won't re-fetch them.
    if (!this._serverIds['invoices']) this._serverIds['invoices'] = new Set();
    snap.docs.forEach(d => this._serverIds['invoices'].add(d.id));
    this._saveServerIds('invoices');

    console.log(`[Sync] loadArchive: merged ${newRecords.length} new records (${snap.size} fetched)`);
    return { count: newRecords.length };
  },
};

// Auto-start on load (nav.js loads this script after Firebase SDK is ready)
Sync.init();
