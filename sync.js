// sync.js — Real-time Firestore sync engine
// ─────────────────────────────────────────────────────────────────────────────
// โหลดหลัง firebase-config.js (inject โดย nav.js อัตโนมัติ)
// ถ้าไม่มี FIREBASE_CONFIG → ทำงานเป็น no-op, ไม่กระทบ localStorage เดิมเลย
// ─────────────────────────────────────────────────────────────────────────────

const Sync = {
  ready:          false,
  _db:            null,
  _orgId:         null,
  _uid:           null,
  _online:        navigator.onLine,
  _unsubscribers: [],
  _skipInitialMs: 3000,       // ms to ignore incoming snapshots (= our own writes)
  _ignoreUntil:   0,          // epoch ms — listener ignores snapshots before this
  _pendingLsKey:  'wt_sync_pending',
  _lastSyncKey:   'wt_sync_lastAt',
  _tombstoneKey:  'wt_sync_tombstones',  // persists deleted IDs across page loads
  _tombstoneTTL:  5 * 60 * 1000,         // 5 minutes — auto-expire if purge never ran
  _serverIds:     {},                    // { [colName]: Set<id> } cached from last _pullAll
  _pushDebounce:  {},                    // { [lsKey]: timeoutId } — debounce rapid collection writes

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
    'wt_pay_methods':     'pay_methods',
    'wt_cap_colors':      'cap_colors',
    'wt_cap_receipts':    'cap_receipts',
    'wt_cap_deductions':  'cap_deductions',
    'wt_price_history':   'price_history',
    'wt_inv_counter':     'inv_counter',
  },

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

  // ── Show badge helper (always makes badge item visible) ───────────────────
  _showBadge(status, msg) {
    // Ensure badge item is visible
    const bi = document.getElementById('syncBadgeItem');
    if (bi) bi.style.display = '';
    this._badge(status);
    if (msg) console.log('[Sync]', msg);
  },

  // ── Initialize ─────────────────────────────────────────────────────────────
  async init() {
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

      // Use SESSION persistence — avoids cross-origin iframe that COOP headers block on GitHub Pages
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});

      // Sign in with shared team account
      console.log('[Sync] Step 3: signIn');
      const email = FIREBASE_CONFIG.teamEmail;
      const pass  = FIREBASE_CONFIG.teamPassword;
      if (email && pass) {
        await firebase.auth().signInWithEmailAndPassword(email, pass);
      } else {
        await firebase.auth().signInAnonymously();
      }
      this._uid = firebase.auth().currentUser?.uid || 'anon';
      console.log('[Sync] Step 4: signIn OK, uid=', this._uid);

      // Pull latest from Firestore → localStorage
      console.log('[Sync] Step 5: pullAll');
      await this._pullAll();
      console.log('[Sync] Step 6: pullAll done');

      // Real-time listeners
      console.log('[Sync] Step 7: setupListeners');
      this._setupListeners();
      console.log('[Sync] Step 8: listeners ready');

      // Mark ready BEFORE flushing queue — so _flushQueue() can proceed
      this.ready = true;
      this._showBadge('online', `✓ Ready (org: ${this._orgId}, uid: ${this._uid})`);
      window.dispatchEvent(new Event('sync:ready'));

      // Flush any queued writes from offline / pre-init period
      await this._flushQueue();

    } catch (e) {
      const msg = e.message || String(e);
      console.error('[Sync] Init failed:', msg);
      this._showBadge('error');
      const badge = document.getElementById('syncStatusBadge');
      if (badge) badge.title = 'Sync error: ' + msg + '\n(คลิกเพื่อลองใหม่)';
      // Store last error so Settings page can display it
      try { localStorage.setItem('wt_sync_last_error', JSON.stringify({ msg, ts: new Date().toISOString() })); } catch {}
      window.dispatchEvent(new CustomEvent('sync:error', { detail: msg }));
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
  },

  // ── Called by db._set() ────────────────────────────────────────────────────
  push(key, val) {
    if (!this.COLLECTIONS[key] && !this.DOCUMENTS[key]) return; // key not synced
    // Reset the ignore window so the listener won't re-apply our own write
    this._ignoreUntil = Date.now() + this._skipInitialMs;
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
      this._pushDebounce[key] = setTimeout(() => {
        // Read fresh value from DB cache at fire time (not the stale closure val)
        const fresh = window.DB ? DB._cache[key] ?? val : val;
        this._writeKey(key, fresh).catch(e => {
          console.warn('[Sync] push failed, queuing:', key, e.message);
          this._enqueue(key, fresh);
          this._badge('pending');
        });
      }, 600);
      return;
    }
    this._writeKey(key, val).catch(e => {
      console.warn('[Sync] push failed, queuing:', key, e.message);
      this._enqueue(key, val);
      this._badge('pending');
    });
  },

  // ── Write one key to Firestore ─────────────────────────────────────────────
  async _writeKey(key, val) {
    const base    = this._orgRef();
    const docName = this.DOCUMENTS[key];
    const colName = this.COLLECTIONS[key];

    if (docName) {
      // ── Document write ──────────────────────────────────────────────────
      await base.collection('data').doc(docName).set({
        d:  val,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        by: this._uid,
      });

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
      if (knownServerIds && knownServerIds.size > 0) {
        const syncDeleted = [...knownServerIds].filter(id => !localIds.has(id));
        if (syncDeleted.length > 0) {
          this._addTombstones(colName, syncDeleted);
          this._ignoreUntil = Date.now() + this._skipInitialMs;
        }
      }
      // Update cached server IDs to reflect the new local state
      this._serverIds[colName] = new Set(localIds);

      // ── ② Upsert remaining records to Firestore ───────────────────────────
      let batch = this._db.batch();
      let ops   = 0;
      const commit = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };

      for (const record of arr) {
        if (!record.id) continue;
        batch.set(colRef.doc(record.id), {
          ...record,
          _by: this._uid,
          _ts: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (++ops >= 490) await commit();
      }
      if (ops > 0) await batch.commit();

      // ── ③ Background purge: delete Firestore docs that were deleted locally ──
      // IMPORTANT: only delete docs that existed at _pullAll() time (knownServerIds).
      // Docs NOT in knownServerIds were added AFTER our pull — either by a later
      // push from this tab (rapid import race) or by another device. Deleting them
      // here would silently drop data that was just written.
      const purgeBase = new Set(knownServerIds || []);  // snapshot from pull time
      colRef.get().then(async snap => {
        const toDelete = snap.docs.filter(d =>
          !localIds.has(d.id) &&   // not in our current local array
          purgeBase.has(d.id)      // was on server at pull time → legitimately deleted
        );
        if (!toDelete.length) return;

        const purgeIds = toDelete.map(d => d.id);
        this._addTombstones(colName, purgeIds);
        this._ignoreUntil = Date.now() + this._skipInitialMs;

        let delBatch = this._db.batch();
        let delOps   = 0;
        for (const d of toDelete) {
          delBatch.delete(d.ref);
          if (++delOps >= 490) { await delBatch.commit(); delBatch = this._db.batch(); delOps = 0; }
        }
        if (delOps > 0) {
          await delBatch.commit();
          this._ignoreUntil = Date.now() + this._skipInitialMs;
        }
        this._clearTombstones(colName, purgeIds);
      }).catch(() => {});
    }

    localStorage.setItem(this._lastSyncKey, new Date().toISOString());
  },

  // ── Safe local read — handles LZString-compressed data ────────────────────
  // sync.js must NEVER read localStorage directly via JSON.parse(localStorage.getItem())
  // because DB._set() now compresses values with LZString.  Always use this helper.
  _localRead(lsKey) {
    if (window.DB) return DB._lzRead(lsKey);          // decompresses if needed
    return localStorage.getItem(lsKey);               // fallback (no DB yet)
  },

  // ── Pull ALL data from Firestore → localStorage (initial load) ─────────────
  async _pullAll() {
    const base = this._orgRef();

    // Documents
    const docPromises = Object.entries(this.DOCUMENTS).map(async ([lsKey, docName]) => {
      try {
        const doc = await base.collection('data').doc(docName).get();
        if (doc.exists && doc.data().d !== undefined) {
          // Write plain JSON — _lzRead first-char guard handles this on next read
          localStorage.setItem(lsKey, JSON.stringify(doc.data().d));
          if (window.DB) DB.invalidate(lsKey);
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
      try {
        const snap = await base.collection(colName).get();
        if (!snap.empty) {
          // Cache server IDs — used by _writeKey() to tombstone deletions synchronously
          this._serverIds[colName] = new Set(snap.docs.map(d => d.id));
          // Apply tombstones so recently-deleted records aren't restored on page reload
          const arr = this._applyTombstones(colName, snap.docs).map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          localStorage.setItem(lsKey, JSON.stringify(arr));
          if (window.DB) DB.invalidate(lsKey);
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
    // Notify pages that fresh data is available so they can re-render
    window.dispatchEvent(new CustomEvent('sync:pulled'));
    console.log('[Sync] Initial pull complete');
  },

  // ── Force-push ALL local data to Firestore (use after LZString migration) ──
  async pushAll() {
    if (!this.ready) throw new Error('Sync not ready');
    const allKeys = [...Object.keys(this.DOCUMENTS), ...Object.keys(this.COLLECTIONS)];
    let pushed = 0, failed = 0;
    for (const lsKey of allKeys) {
      try {
        const raw = this._localRead(lsKey);
        if (!raw) continue;
        const val = JSON.parse(raw);
        if (val === null || val === undefined) continue;
        await this._writeKey(lsKey, val);
        pushed++;
      } catch (e) {
        console.warn('[Sync] pushAll failed for', lsKey, e.message);
        failed++;
      }
    }
    console.log(`[Sync] pushAll: pushed=${pushed} failed=${failed}`);
    return { pushed, failed };
  },

  // ── Real-time listeners ────────────────────────────────────────────────────
  _setupListeners() {
    const base     = this._orgRef();
    // Use the instance property (reset by push()) instead of a one-time closure var
    this._ignoreUntil = Date.now() + this._skipInitialMs;

    const shouldSkip = (meta) => {
      // Skip during initial window AND after any push() call for _skipInitialMs
      if (Date.now() < this._ignoreUntil) return true;
      // Skip our own pending writes (will fire again when server confirms)
      if (meta?.hasPendingWrites) return true;
      // Skip events served from local cache (only process server-confirmed events)
      if (meta?.fromCache) return true;
      return false;
    };

    // Listen to document keys
    for (const [lsKey, docName] of Object.entries(this.DOCUMENTS)) {
      const unsub = base.collection('data').doc(docName)
        .onSnapshot({ includeMetadataChanges: true }, (doc) => {
          if (shouldSkip(doc.metadata)) return;
          if (!doc.exists || doc.data()?.d === undefined) return;
          localStorage.setItem(lsKey, JSON.stringify(doc.data().d));
          if (window.DB) DB.invalidate(lsKey);
          // Only notify when the write came from another user (not us)
          const writtenBy = doc.data().by;
          if (writtenBy && writtenBy !== this._uid) this._notifyUpdate(lsKey);
        });
      this._unsubscribers.push(unsub);
    }

    // Listen to collection keys
    for (const [lsKey, colName] of Object.entries(this.COLLECTIONS)) {
      const unsub = base.collection(colName)
        .onSnapshot({ includeMetadataChanges: true }, (snap) => {
          if (shouldSkip(snap.metadata)) return;
          // Apply tombstones — prevents pre-purge snapshots from restoring
          // records that were deleted locally but not yet purged from Firestore
          const arr = this._applyTombstones(colName, snap.docs).map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          localStorage.setItem(lsKey, JSON.stringify(arr));
          if (window.DB) DB.invalidate(lsKey);
          // Only notify when at least one changed doc came from another user
          const fromOther = snap.docChanges().some(c => {
            const by = c.doc.data()?._by;
            return by && by !== this._uid;
          });
          if (fromOther) this._notifyUpdate(lsKey);
        });
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
  },

  _getQueue() {
    try { return JSON.parse(localStorage.getItem(this._pendingLsKey)) || []; } catch { return []; }
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

    // Show toast
    if (label) {
      let toast = document.getElementById('syncToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'syncToast';
        toast.style.cssText = 'position:fixed;bottom:1rem;right:1rem;z-index:9999;min-width:180px;';
        toast.className = 'toast show align-items-center text-white border-0';
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
  },
};

// Auto-start on load (nav.js loads this script after Firebase SDK is ready)
Sync.init();
