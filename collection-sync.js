// collection-sync.js — reusable single-source-of-truth per-record Firestore sync.
//
// This is the generalised form of the logic proven in customer-sync.js. The
// Firestore collection is the single source of truth for a local DB array; local
// add/edit/delete are diffed against a server fingerprint map (NOT db's prev,
// which is unreliable because DB.addX mutates the cached array in place) and
// pushed per-record. No tombstones / _serverIds / reconcile / known-ids.
//
// CollectionSync.create(cfg) → an instance object with init()/onLocalChange()/diagnose().
//
// cfg = {
//   name:        'ProductSync'            // for logs + diagnose header
//   col:         'products_v2'            // Firestore collection name
//   toastType:   'products'               // key into Sync._ACTIVITY_TYPE/_recordName
//   unackedKey:  'wt_prod_unacked'        // sessionStorage key for the un-acked set
//   migratedKey: 'wt_prod_v2_migrated'    // DB key (HDD-backed) for the bootstrap flag
//   getLocal:    () => DB.getProducts()
//   setLocal:    (arr) => DB.setLocalOnly(DB.K.PRODUCTS, arr)
//   dedupKey:    (rec) => rec.name        // group key to collapse duplicate uploads (null = by id only)
//   bootstrapMigrate: true                // push existing local data up if the server collection is empty (first run)
// }

window.CollectionSync = window.CollectionSync || {
  create(cfg) {
    const inst = {
      cfg,
      _ready: false,
      _seeded: false,
      _migrated: false,
      _unsub: null,
      _pending: [],
      _unacked: null,
      _serverFp: new Map(),
      _log: [],
      _db: null,
      _deviceId: null,

      _stripMeta(r) { const { _by, _byName, _ts, ...rec } = r || {}; return rec; },
      _fp(r) { return JSON.stringify(this._stripMeta(r)); },
      _col() { return Sync._orgRef().collection(this.cfg.col); },
      _local() { try { return (this.cfg.getLocal() || []); } catch { return []; } },

      // ── Time-boxed trust window ───────────────────────────────────────────
      // A fresh onSnapshot() attach re-reads (and re-bills) every document in the
      // collection. Since nav.js loads this module on EVERY page, re-attaching on
      // every navigation was billing a full re-read of the whole collection per
      // page load — confirmed via the Firebase Usage tab (~300 reads/page load
      // across the 4 master-data collections; ~9,000 reads for 10 nav cycles
      // between customers/products/pricing). If a listener attached earlier THIS
      // session is still within _TRUST_MS, reuse its cached server fingerprint
      // instead of attaching again — onLocalChange() diffs against that fingerprint
      // either way, so local edits still push correctly. Real-time cross-device
      // updates on a page that skipped attaching are stale by up to _TRUST_MS.
      _TRUST_MS: 60000,
      _trustKey() { return 'wt_cs_trust_' + this.cfg.col; },
      _fpCacheKey() { return 'wt_cs_fp_' + this.cfg.col; },
      _markAttachTime() { try { sessionStorage.setItem(this._trustKey(), String(Date.now())); } catch {} },
      _withinTrustWindow() {
        try {
          const t = parseInt(sessionStorage.getItem(this._trustKey()) || '0', 10);
          return !!t && (Date.now() - t) < this._TRUST_MS;
        } catch { return false; }
      },
      _saveCachedFp() {
        try {
          const obj = {};
          for (const [id, fp] of this._serverFp) obj[id] = fp;
          sessionStorage.setItem(this._fpCacheKey(), JSON.stringify(obj));
        } catch {}
      },
      _loadCachedFp() {
        try {
          const raw = sessionStorage.getItem(this._fpCacheKey());
          if (raw == null) return null;
          return new Map(Object.entries(JSON.parse(raw)));
        } catch { return null; }
      },

      _logLine(msg) {
        const line = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '  ' + msg;
        this._log.push(line);
        if (this._log.length > 40) this._log.shift();
        console.log('[' + this.cfg.name + ']', msg);
      },

      _loadUnacked() {
        if (this._unacked) return this._unacked;
        try { this._unacked = new Set(JSON.parse(sessionStorage.getItem(this.cfg.unackedKey) || '[]')); }
        catch { this._unacked = new Set(); }
        return this._unacked;
      },
      _saveUnacked() {
        try { sessionStorage.setItem(this.cfg.unackedKey, JSON.stringify([...this._loadUnacked()])); } catch {}
      },

      _isMigrated() {
        if (this._migrated) return true;
        try { if (DB._getObj(this.cfg.migratedKey, false) === true) { this._migrated = true; } } catch {}
        return this._migrated;
      },
      _markMigrated() {
        if (this._migrated) return;
        this._migrated = true;
        try { DB._set(this.cfg.migratedKey, true); } catch {}
      },

      async diagnose() {
        const L = [];
        L.push(this.cfg.name + '._ready : ' + this._ready);
        L.push('Sync.ready          : ' + (window.Sync && Sync.ready));
        L.push('Sync._orgId         : ' + (window.Sync && Sync._orgId));
        L.push('migrated            : ' + this._isMigrated());
        L.push('un-acked ids        : ' + [...this._loadUnacked()].length);
        L.push('local count         : ' + this._local().length);
        L.push('listener attached   : ' + !!this._unsub + (this._unsub ? '' : (this._withinTrustWindow() ? ' (trust window active — reusing cached fingerprint)' : '')));
        try {
          const snap = await this._col().get();
          L.push('SERVER count        : ' + snap.size + '  (live get from ' + this.cfg.col + ')');
        } catch (e) {
          L.push('SERVER get ERROR    : ' + (e.code || '') + ' ' + (e.message || e));
        }
        L.push('— recent activity —');
        L.push(...(this._log.length ? this._log.slice(-18) : ['(no activity logged)']));
        return L.join('\n');
      },

      init() {
        if (this._ready) return;
        if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db || !window.firebase) return;
        this._db = Sync._db;
        this._deviceId = Sync._deviceId;
        this._loadUnacked();
        this._isMigrated();
        this._ready = true;
        this._logLine('init: ready (orgId=' + Sync._orgId + ')');
        const cachedFp = this._withinTrustWindow() ? this._loadCachedFp() : null;
        if (cachedFp) {
          this._serverFp = cachedFp;
          this._logLine('init: within trust window — skip re-attach, reuse cached fingerprint (' + cachedFp.size + ' ids)');
        } else {
          this._attach();
        }
        const q = this._pending.splice(0);
        q.forEach(n => { this._pushLocal(n).catch(e => console.warn('[' + this.cfg.name + '] queued push', e)); });
        if (this._unacked.size) {
          const repush = this._local().filter(r => r && r.id && this._unacked.has(r.id));
          if (repush.length) {
            this._logLine('re-pushing ' + repush.length + ' un-acked record(s)');
            this._commit(repush, []).catch(e => console.warn('[' + this.cfg.name + '] re-push', e));
          }
        }
      },

      _attach() {
        this._markAttachTime();
        this._unsub = this._col().onSnapshot(
          { includeMetadataChanges: true },
          (snap) => {
            const unacked = this._loadUnacked();
            const fromCache = snap.metadata.fromCache;
            this._logLine('snapshot: size=' + snap.size + ' empty=' + snap.empty + ' fromCache=' + fromCache);

            if (snap.empty) {
              if (!fromCache) {
                // Server genuinely empty. First-run bootstrap: if we still have local
                // data and have never migrated, push it up instead of wiping it.
                if (this.cfg.bootstrapMigrate && !this._isMigrated()) {
                  // First-run bootstrap. Push local up but DO NOT mark migrated yet —
                  // migrated is only set when a non-empty SERVER snapshot confirms the
                  // data actually landed. Otherwise a failed push + this flag would let
                  // a later empty snapshot wipe local data. Records are marked un-acked
                  // (retained) so local is never wiped in the meantime; if the push
                  // fails we simply re-bootstrap on the next empty server snapshot.
                  const local = this._local().filter(r => r && r.id);
                  if (local.length) {
                    this._logLine('bootstrap: migrating ' + local.length + ' local record(s) → ' + this.cfg.col);
                    local.forEach(r => unacked.add(r.id));
                    this._saveUnacked();
                    this._commit(local, []).catch(e => console.warn('[' + this.cfg.name + '] migrate', e));
                  }
                } else {
                  const extra = this._retain(new Set(), unacked);
                  this.cfg.setLocal(extra);
                  this._emit();
                }
                this._saveCachedFp();   // (empty) — lets a trust-window page reuse this state too
              }
              this._seeded = true;
              return;
            }

            // Build canonical list, de-duplicating by the configured group key.
            const byKey = new Map();
            const serverAckedIds = new Set();
            snap.forEach(d => {
              const rec = this._stripMeta(d.data());
              rec.id = rec.id || d.id;
              if (!d.metadata.hasPendingWrites) serverAckedIds.add(rec.id);
              let gk;
              try { gk = this.cfg.dedupKey ? this.cfg.dedupKey(rec) : null; } catch { gk = null; }
              const key = (gk != null && gk !== '') ? 'k:' + gk : 'i:' + d.id;
              if (!byKey.has(key)) byKey.set(key, []);
              byKey.get(key).push({ docId: d.id, rec });
            });
            const list = [];
            const dupDel = [];
            for (const arr of byKey.values()) {
              arr.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
              list.push(arr[0].rec);
              for (let i = 1; i < arr.length; i++) dupDel.push(arr[i].docId);
            }
            const serverIds = new Set(list.map(r => r.id));

            let unackedChanged = false;
            for (const id of [...unacked]) {
              if (serverAckedIds.has(id)) { unacked.delete(id); unackedChanged = true; }
            }
            if (!fromCache) {
              snap.docChanges().forEach(ch => {
                if (ch.type === 'removed' && unacked.delete(ch.doc.id)) unackedChanged = true;
              });
            }
            if (unackedChanged) this._saveUnacked();

            if (!fromCache) {
              const fp = new Map();
              for (const r of list) { if (r && r.id) fp.set(r.id, this._fp(r)); }
              this._serverFp = fp;
              this._markMigrated();   // server has data → bootstrap no longer needed
              this._saveCachedFp();
            }

            const finalList = this._retain(serverIds, unacked, list);
            this.cfg.setLocal(finalList);
            this._logLine('applied: server=' + list.length + ' final=' + finalList.length + ' → local=' + this._local().length);
            this._emit();

            if (dupDel.length) this._deleteDocs(dupDel);

            if (!this._seeded) { this._seeded = true; return; }
            let shown = 0;
            for (const ch of snap.docChanges()) {
              if (shown >= 3) break;
              const r = ch.doc.data();
              if (!r || r._by === this._deviceId) continue;
              if (ch.doc.metadata.hasPendingWrites) continue;
              const action = ch.type === 'added' ? 'add' : ch.type === 'removed' ? 'del' : 'edit';
              if (Sync._activityToast) {
                Sync._activityToast({ typeKey: this.cfg.toastType, action,
                  name: Sync._recordName(this.cfg.toastType, r), byName: r._byName });
              }
              shown++;
            }
          },
          (err) => console.warn('[' + this.cfg.name + '] listener error:', err.code, err.message)
        );
      },

      // One-shot additive pull — used by the login page so server-only accounts
      // are present BEFORE login, without waiting for the async listener. Merges
      // server records into local (NEVER removes local-only records → can't lock
      // anyone out). Returns the server count (or -1 on error).
      async pullOnce() {
        try {
          if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db) return 0;
          if (!this._db) { this._db = Sync._db; this._deviceId = Sync._deviceId; }
          const snap = await this._col().get();
          if (snap.empty) return 0;
          const byKey = new Map();
          snap.forEach(d => {
            const rec = this._stripMeta(d.data());
            rec.id = rec.id || d.id;
            let gk; try { gk = this.cfg.dedupKey ? this.cfg.dedupKey(rec) : null; } catch { gk = null; }
            const key = (gk != null && gk !== '') ? 'k:' + gk : 'i:' + d.id;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push({ docId: d.id, rec });
          });
          const list = [];
          for (const arr of byKey.values()) {
            arr.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
            list.push(arr[0].rec);
          }
          const serverIds = new Set(list.map(r => r.id));
          const local = this._local();
          const merged = [...list, ...local.filter(r => r && r.id && !serverIds.has(r.id))];
          this.cfg.setLocal(merged);
          const fp = new Map();
          for (const r of list) { if (r && r.id) fp.set(r.id, this._fp(r)); }
          this._serverFp = fp;
          if (list.length) this._markMigrated();
          this._logLine('pullOnce: server=' + list.length + ' → local=' + this._local().length);
          return list.length;
        } catch (e) { console.warn('[' + this.cfg.name + '] pullOnce', e); return -1; }
      },

      _emit() {
        window.dispatchEvent(new CustomEvent('sync:updated', { detail: { key: this.cfg.lsKey } }));
        window.dispatchEvent(new CustomEvent('sync:pulled'));
      },

      _retain(serverIds, unacked, baseList) {
        const list = Array.isArray(baseList) ? baseList.slice() : [];
        if (!unacked || !unacked.size) return list;
        for (const r of this._local()) {
          if (r && r.id && unacked.has(r.id) && !serverIds.has(r.id)) list.push(r);
        }
        return list;
      },

      async _deleteDocs(ids) {
        try {
          const col = this._col();
          let batch = this._db.batch(), ops = 0;
          for (const id of ids) {
            batch.delete(col.doc(id));
            if (++ops >= 450) { await batch.commit(); batch = this._db.batch(); ops = 0; }
          }
          if (ops > 0) await batch.commit();
          this._logLine('removed ' + ids.length + ' duplicate server docs');
        } catch (e) { console.warn('[' + this.cfg.name + '] dup cleanup failed', e); }
      },

      onLocalChange(prev, next) {
        this._logLine('onLocalChange next=' + (Array.isArray(next) ? next.length : 0) + ' ready=' + this._ready);
        this._pushLocal(next).catch(e => this._logLine('push REJECTED: ' + (e.code || '') + ' ' + (e.message || e)));
      },

      async _pushLocal(next) {
        if (!this._ready) { this._pending.push(next); this._logLine('not ready → queued'); return; }
        const nextArr = Array.isArray(next) ? next : [];
        const nextById = new Map(nextArr.filter(r => r && r.id).map(r => [r.id, r]));
        const fp = this._serverFp || new Map();
        const upserts = nextArr.filter(r => r && r.id && fp.get(r.id) !== this._fp(r));
        const deletes = [...fp.keys()].filter(id => !nextById.has(id));
        if (!upserts.length && !deletes.length) return;
        const unacked = this._loadUnacked();
        upserts.forEach(r => unacked.add(r.id));
        deletes.forEach(id => unacked.delete(id));
        this._saveUnacked();
        await this._commit(upserts, deletes);
      },

      async _commit(upserts, deletes) {
        if (!upserts.length && !deletes.length) return;
        const col = this._col();
        const meta = () => ({
          _by: this._deviceId,
          _byName: Sync._deviceName(),
          _ts: firebase.firestore.FieldValue.serverTimestamp(),
        });
        let batch = this._db.batch(), ops = 0;
        const flush = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };
        for (const r of upserts) {
          batch.set(col.doc(r.id), { ...this._stripMeta(r), ...meta() }, { merge: true });
          if (++ops >= 450) await flush();
        }
        for (const id of deletes) {
          batch.delete(col.doc(id));
          if (++ops >= 450) await flush();
        }
        if (ops > 0) {
          this._logLine('committing ' + upserts.length + ' upsert, ' + deletes.length + ' delete …');
          await batch.commit();
          this._logLine('commit OK (' + upserts.length + ' upsert, ' + deletes.length + ' delete)');
        }
      },
    };

    // Auto-init when sync becomes ready.
    window.addEventListener('sync:ready', () => { try { inst.init(); } catch (e) { console.warn('[' + cfg.name + '] init', e); } });
    if (typeof Sync !== 'undefined' && Sync.ready) { try { inst.init(); } catch {} }
    return inst;
  },
};
