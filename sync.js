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
  _skipInitialMs: 2500,       // ms to ignore incoming snapshots (= our own writes)
  _pendingLsKey:  'wt_sync_pending',
  _lastSyncKey:   'wt_sync_lastAt',

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

  // ── Initialize ─────────────────────────────────────────────────────────────
  async init() {
    if (typeof FIREBASE_CONFIG === 'undefined' || !FIREBASE_CONFIG.apiKey ||
        FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...')) {
      console.log('[Sync] No valid Firebase config — local-only mode');
      return;
    }

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

      // Flush any queued writes from offline period
      await this._flushQueue();

      this.ready = true;
      this._badge('online');
      // Show sync badge in navbar
      const bi = document.getElementById('syncBadgeItem');
      if (bi) bi.style.display = '';

      console.log(`[Sync] ✓ Ready (org: ${this._orgId}, uid: ${this._uid})`);

    } catch (e) {
      console.error('[Sync] Init failed:', e.message || e);
      this._badge('error');
    }

    // Online / offline
    window.addEventListener('online', async () => {
      this._online = true;
      this._badge('online');
      await this._flushQueue();
    });
    window.addEventListener('offline', () => {
      this._online = false;
      this._badge('offline');
    });
  },

  // ── Called by db._set() ────────────────────────────────────────────────────
  push(key, val) {
    if (!this.COLLECTIONS[key] && !this.DOCUMENTS[key]) return; // key not synced
    if (!this.ready || !this._online) {
      this._enqueue(key, val);
      return;
    }
    this._writeKey(key, val).catch(e => {
      console.warn('[Sync] push failed, queuing:', key, e.message);
      this._enqueue(key, val);
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
      // ── Collection write (diff-based to minimise writes) ────────────────
      const arr = Array.isArray(val) ? val : [];
      const colRef = base.collection(colName);

      // Fetch current IDs in Firestore
      const snap = await colRef.select().get();   // .select() = IDs only, fast
      const firestoreIds = new Set(snap.docs.map(d => d.id));
      const localIds     = new Set(arr.filter(r => r.id).map(r => r.id));

      let batch = this._db.batch();
      let ops   = 0;

      const commit = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };

      // Upsert new / changed records
      for (const record of arr) {
        if (!record.id) continue;
        batch.set(colRef.doc(record.id), {
          ...record,
          _by: this._uid,
          _ts: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (++ops >= 490) await commit();
      }

      // Delete removed records
      for (const id of firestoreIds) {
        if (!localIds.has(id)) {
          batch.delete(colRef.doc(id));
          if (++ops >= 490) await commit();
        }
      }
      if (ops > 0) await batch.commit();
    }

    localStorage.setItem(this._lastSyncKey, new Date().toISOString());
  },

  // ── Pull ALL data from Firestore → localStorage (initial load) ─────────────
  async _pullAll() {
    const base = this._orgRef();

    // Documents
    const docPromises = Object.entries(this.DOCUMENTS).map(async ([lsKey, docName]) => {
      try {
        const doc = await base.collection('data').doc(docName).get();
        if (doc.exists && doc.data().d !== undefined) {
          localStorage.setItem(lsKey, JSON.stringify(doc.data().d));
        }
      } catch (e) { console.warn('[Sync] pull doc:', docName, e.message); }
    });

    // Collections
    const colPromises = Object.entries(this.COLLECTIONS).map(async ([lsKey, colName]) => {
      try {
        const snap = await base.collection(colName).get();
        if (!snap.empty) {
          const arr = snap.docs.map(d => {
            const { _by, _ts, ...rec } = d.data();
            return rec;
          });
          localStorage.setItem(lsKey, JSON.stringify(arr));
        }
      } catch (e) { console.warn('[Sync] pull col:', colName, e.message); }
    });

    await Promise.all([...docPromises, ...colPromises]);
    this._triggerRerender();
    console.log('[Sync] Initial pull complete');
  },

  // ── Real-time listeners ────────────────────────────────────────────────────
  _setupListeners() {
    const base     = this._orgRef();
    let ignoreUntil = Date.now() + this._skipInitialMs;

    const shouldSkip = (meta) => {
      // Skip if within initial window OR if the write came from this tab
      if (Date.now() < ignoreUntil) return true;
      if (meta?.hasPendingWrites)    return true;   // our own write in progress
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
          const arr = snap.docs.map(d => {
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

// ── Auto-initialize ───────────────────────────────────────────────────────────
Sync.init().catch(e => console.error('[Sync]', e));
