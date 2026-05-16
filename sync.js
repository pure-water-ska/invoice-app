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
  _tombstoneTTL:  5 * 60 * 1000,         // 5 minutes — clear after purge confirmed

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
      return;
    }

    // Show badge immediately so user knows sync is starting
    this._showBadge('pending', 'Connecting to Firestore...');

    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      this._db    = firebase.firestore();
      this._orgId = FIREBASE_CONFIG.orgId || 'main';

      // Sign in with shared team account
      const email = FIREBASE_CONFIG.teamEmail;
      const pass  = FIREBASE_CONFIG.teamPassword;
      if (email && pass) {
        await firebase.auth().signInWithEmailAndPassword(email, pass);
      } else {
        await firebase.auth().signInAnonymously();
      }
      this._uid = firebase.auth().currentUser?.uid || 'anon';

      // Enable offline persistence (Firestore has its own offline cache too)
      await this._db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
          console.warn('[Sync] Persistence:', err.code);
        }
      });

      // Pull latest from Firestore → localStorage
      await this._pullAll();

      // Real-time listeners
      this._setupListeners();

      // Mark ready BEFORE flushing queue — so _flushQueue() can proceed
      this.ready = true;
      this._showBadge('online', `✓ Ready (org: ${this._orgId}, uid: ${this._uid})`);

      // Flush any queued writes from offline / pre-init period
      await this._flushQueue();

    } catch (e) {
      console.error('[Sync] Init failed:', e.message || e);
      this._showBadge('error');
      // Show error detail in badge tooltip
      const badge = document.getElementById('syncStatusBadge');
      if (badge) badge.title = 'Sync error: ' + (e.message || e) + '\n(คลิกเพื่อลองใหม่)';
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
      const arr    = Array.isArray(val) ? val : [];
      const colRef = base.collection(colName);
      const total  = arr.filter(r => r.id).length;

      // Upsert only — no deletion (keeps writes fast; deleted records are
      // excluded from _pullAll because _pullAll overwrites localStorage in full)
      let batch = this._db.batch();
      let ops   = 0;
      let written = 0;
      const commit = async () => {
        await batch.commit();
        batch = this._db.batch(); ops = 0;
      };

      for (const record of arr) {
        if (!record.id) continue;
        batch.set(colRef.doc(record.id), {
          ...record,
          _by: this._uid,
          _ts: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        written++;
        if (total > 50 && typeof Utils !== 'undefined')
          Utils.showProgress(`บันทึก ${colName} (${written}/${total})`, Math.round((written / total) * 100));
        if (++ops >= 490) await commit();
      }
      if (ops > 0) await batch.commit();

      // Purge records that were removed locally (deleted invoices/payments).
      // ① Tombstone the IDs first (persisted to localStorage) — this prevents
      //   _pullAll() on the next page from restoring them even if the purge
      //   hasn't finished yet (e.g. user navigates away mid-purge).
      // ② Actually delete from Firestore in the background.
      // ③ Clear tombstones only after the Firestore delete succeeds.
      const localIds = new Set(arr.filter(r => r.id).map(r => r.id));
      colRef.get().then(async snap => {
        const toDelete = snap.docs.filter(d => !localIds.has(d.id));
        if (!toDelete.length) return;

        const deleteIds = toDelete.map(d => d.id);
        this._addTombstones(colName, deleteIds);     // ① persist tombstones NOW
        this._ignoreUntil = Date.now() + this._skipInitialMs; // extend ignore window

        let delBatch = this._db.batch();
        let delOps   = 0;
        for (const d of toDelete) {
          delBatch.delete(d.ref);
          if (++delOps >= 490) {
            await delBatch.commit();
            delBatch = this._db.batch(); delOps = 0;
          }
        }
        if (delOps > 0) {
          await delBatch.commit();                   // ② Firestore delete done
          this._ignoreUntil = Date.now() + this._skipInitialMs;
        }
        this._clearTombstones(colName, deleteIds);   // ③ purge confirmed — clean up
      }).catch(() => {}); // background — ignore errors
    }

    localStorage.setItem(this._lastSyncKey, new Date().toISOString());
  },

  // ── Pull ALL data from Firestore → localStorage (initial load) ─────────────
  async _pullAll() {
    const base  = this._orgRef();
    const total = Object.keys(this.DOCUMENTS).length + Object.keys(this.COLLECTIONS).length;
    let done    = 0;
    const tick  = (name) => {
      done++;
      if (typeof Utils !== 'undefined')
        Utils.showProgress(`โหลดข้อมูล Cloud: ${name} (${done}/${total})`, Math.round((done / total) * 100));
    };

    // Documents
    const docPromises = Object.entries(this.DOCUMENTS).map(async ([lsKey, docName]) => {
      try {
        const doc = await base.collection('data').doc(docName).get();
        if (doc.exists && doc.data().d !== undefined) {
          localStorage.setItem(lsKey, JSON.stringify(doc.data().d));
        }
      } catch (e) { console.warn('[Sync] pull doc:', docName, e.message); }
      tick(docName);
    });

    // Collections
    const colPromises = Object.entries(this.COLLECTIONS).map(async ([lsKey, colName]) => {
      try {
        const snap = await base.collection(colName).get();
        if (!snap.empty) {
          // Firestore has data → overwrite localStorage
          // Apply tombstones so recently-deleted records aren't restored
          const arr = this._applyTombstones(colName, snap.docs).map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          localStorage.setItem(lsKey, JSON.stringify(arr));
        } else {
          // Firestore empty → bootstrap: push local data up to Firestore
          try {
            const localArr = JSON.parse(localStorage.getItem(lsKey) || '[]');
            if (Array.isArray(localArr) && localArr.length > 0) {
              console.log(`[Sync] Bootstrap: pushing ${localArr.length} ${colName} records to Firestore`);
              await this._writeKey(lsKey, localArr);
            }
          } catch (be) { console.warn('[Sync] bootstrap push failed:', colName, be.message); }
        }
      } catch (e) { console.warn('[Sync] pull col:', colName, e.message); }
      tick(colName);
    });

    await Promise.all([...docPromises, ...colPromises]);
    if (typeof Utils !== 'undefined') Utils.hideProgress();
    this._triggerRerender();
    console.log('[Sync] Initial pull complete');
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
          this._notifyUpdate(lsKey);
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
          this._notifyUpdate(lsKey);
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
        toast.setAttribute('style',
          'position:fixed;bottom:70px;right:16px;z-index:9990;min-width:200px;' +
          'background:#198754;color:#fff;border-radius:10px;padding:9px 16px;' +
          'font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
          'transition:opacity .4s;pointer-events:none');
        document.body.appendChild(toast);
      }
      toast.textContent = `🔄 ${label} อัปเดตจากผู้ใช้อื่น`;
      toast.style.opacity = '1';
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
    }

    // Re-render current page (works for pages with global render() function)
    this._triggerRerender();
  },

  _triggerRerender() {
    if (typeof window.render === 'function') {
      try { window.render(); } catch {}
    }
  },

  // ── Manual pull (user-triggered refresh from Firestore) ───────────────────
  async pull() {
    if (!this.ready) return;
    this._badge('pending');
    try {
      await this._pullAll();
      this._badge('online');
    } catch (e) {
      console.error('[Sync] manual pull failed:', e);
      this._badge('error');
    }
  },

  // ── Push ALL local data to Firestore (force full upload) ──────────────────
  async pushAll() {
    if (!this.ready) { console.warn('[Sync] pushAll called before ready'); return; }
    this._badge('pending');
    console.log('[Sync] pushAll: uploading all local data to Firestore...');
    try {
      const allKeys = [
        ...Object.keys(this.COLLECTIONS),
        ...Object.keys(this.DOCUMENTS),
      ];
      const total = allKeys.length;
      for (let i = 0; i < total; i++) {
        const key = allKeys[i];
        const label = this.COLLECTIONS[key] || this.DOCUMENTS[key] || key;
        if (typeof Utils !== 'undefined') Utils.showProgress(`อัปโหลด Cloud: ${label} (${i + 1}/${total})`, Math.round(((i + 1) / total) * 100));
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const val = JSON.parse(raw);
          await this._writeKey(key, val);
          console.log('[Sync] pushAll:', key, '✓');
        } catch (e) {
          console.warn('[Sync] pushAll error for', key, ':', e.message);
        }
      }
      if (typeof Utils !== 'undefined') Utils.hideProgress();
      this._badge('online');
      localStorage.setItem(this._lastSyncKey, new Date().toISOString());
      console.log('[Sync] pushAll complete ✓');
    } catch (e) {
      if (typeof Utils !== 'undefined') Utils.hideProgress();
      console.error('[Sync] pushAll failed:', e);
      this._badge('error');
    }
  },

  // ── Status info for troubleshoot / settings ────────────────────────────────
  getStatus() {
    const pending = this._getQueue().length;
    const lastAt  = localStorage.getItem(this._lastSyncKey);
    return {
      ready:   this.ready,
      online:  this._online,
      pending,
      orgId:   this._orgId,
      uid:     this._uid,
      lastAt,
    };
  },
};

// Expose globally — `const Sync` above is a lexical binding, NOT a window property,
// so `window.Sync` would otherwise be undefined (breaks nav.js badge + connection modal).
window.Sync = Sync;

// ── Auto-initialize ───────────────────────────────────────────────────────────
Sync.init().catch(e => console.error('[Sync]', e));
