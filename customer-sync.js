// customer-sync.js — self-contained, single-source-of-truth customer sync.
//
// WHY THIS EXISTS
// ----------------
// Customers used to be synced through the general sync.js machinery (first as a
// whole-array DOCUMENT, then as a COLLECTION).  Both carried a stack of competing
// safeguards — tombstones, _serverIds, _pullIds, union merges, fingerprint diffs,
// an on-open reconcile with known-ids + recency.  Those mechanisms fought each
// other: deletes were re-created by a reconcile/union running on stale data, and
// idle devices re-uploaded unchanged records (phantom "edited" toasts).
//
// THE CLEAN MODEL (this file)
// ---------------------------
// • Firestore collection `customers_v2`, one doc per customer (doc id = customer.id).
// • The Firestore SNAPSHOT is the single source of truth for the local copy.
//   With offline persistence enabled, the snapshot ALREADY includes this device's
//   own un-acknowledged writes (snap.metadata.hasPendingWrites), so it is correct
//   even offline — no separate "keep my un-pushed local adds" union is needed.
// • Local writes (add/edit/delete via DB) are diffed against the previous local
//   state and pushed per-record: changed/new → set(merge), removed → delete.
//   Because the local copy is kept equal to the server by the listener, "missing
//   from the new array" reliably means the user deleted it — so deletes are exact.
// • No tombstones, no _serverIds, no reconcile, no known-ids. The server is truth.
//
// Loaded by nav.js right after sync.js (everywhere), guarded against double-load.

if (!window.CustomerSync) window.CustomerSync = {
  COL:          'customers_v2',
  _ready:       false,
  _seeded:      false,        // first snapshot processed (suppresses startup toasts)
  _unsub:       null,
  _pending:     [],           // [ [prevArr, nextArr], … ] local diffs queued before ready
  _PEND_KEY:    'wt_cust_unacked',   // sessionStorage: ids written locally but not yet confirmed on the server
  _unacked:     null,         // Set<id> — local adds/edits awaiting server acknowledgement
  _RECENT_MS:   5 * 60 * 1000, // durable backstop: a local record created within this window
                               // and not yet on the server is kept + re-pushed, even if the
                               // sessionStorage un-acked set was lost (e.g. full app restart).

  _log:         [],           // diagnostic ring buffer (see diagnose())

  _stripMeta(r) { const { _by, _byName, _ts, ...rec } = r || {}; return rec; },
  _fp(r) { return JSON.stringify(this._stripMeta(r)); },
  _col() { return Sync._orgRef().collection(this.COL); },

  _logLine(msg) {
    const line = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '  ' + msg;
    this._log.push(line);
    if (this._log.length > 40) this._log.shift();
    console.log('[CustomerSync]', msg);
  },

  // On-screen diagnostic (DevTools is disabled in release Tauri builds). Returns a
  // text report including a LIVE server count so we can see whether pushes land.
  async diagnose() {
    const L = [];
    L.push('CustomerSync._ready : ' + this._ready);
    L.push('Sync defined        : ' + (typeof Sync !== 'undefined'));
    L.push('Sync.ready          : ' + (window.Sync && Sync.ready));
    L.push('Sync._db            : ' + !!(window.Sync && Sync._db));
    L.push('Sync._orgId         : ' + (window.Sync && Sync._orgId));
    L.push('deviceId            : ' + this._deviceId);
    L.push('un-acked ids        : ' + [...this._loadUnacked()].length);
    L.push('local customers     : ' + (((window.DB ? DB.getCustomers() : []) || []).length));
    // Read-path probe: compare raw cache vs what _get / getCustomers return.
    try {
      const ck = DB.K.CUSTOMERS;
      const cacheArr = DB._cache ? DB._cache[ck] : undefined;
      L.push('cache[CUST]         : ' + (Array.isArray(cacheArr) ? cacheArr.length : ('not-array:' + typeof cacheArr)));
      let g; try { g = DB._get(ck); } catch (e) { g = 'throw:' + e.message; }
      L.push('_get(CUST)          : ' + (Array.isArray(g) ? g.length : ('not-array:' + (g && g.slice ? g.slice(0,40) : typeof g))));
      L.push('getCustomers type   : ' + (() => { const r = DB.getCustomers(); return Array.isArray(r) ? ('array len ' + r.length) : (typeof r + ' = ' + JSON.stringify(r).slice(0,40)); })());
      L.push('_get src            : ' + DB._get.toString().replace(/\s+/g, ' ').slice(0, 170));
    } catch (e) { L.push('probe error: ' + (e.message || e)); }
    try {
      const snap = await this._col().get();
      L.push('SERVER customers    : ' + snap.size + '  (live get from customers_v2)');
    } catch (e) {
      L.push('SERVER get ERROR    : ' + (e.code || '') + ' ' + (e.message || e));
    }
    L.push('— recent activity —');
    L.push(...(this._log.length ? this._log.slice(-18) : ['(no activity logged)']));
    return L.join('\n');
  },

  // ── Un-acked local writes ─────────────────────────────────────────────────
  // A record we wrote locally is "un-acked" until a server snapshot confirms it.
  // The set is persisted to sessionStorage so it survives a page refresh (in the
  // Tauri WebView sessionStorage survives F5; on the web it survives same-tab
  // reloads).  This is what stops a just-added customer from vanishing when the
  // listener's first snapshot — delivered before our write is acknowledged, or
  // from a cache that didn't persist the write — arrives without that record.
  _loadUnacked() {
    if (this._unacked) return this._unacked;
    try { this._unacked = new Set(JSON.parse(sessionStorage.getItem(this._PEND_KEY) || '[]')); }
    catch { this._unacked = new Set(); }
    return this._unacked;
  },
  _saveUnacked() {
    try { sessionStorage.setItem(this._PEND_KEY, JSON.stringify([...this._loadUnacked()])); } catch {}
  },

  // Called from nav.js / on sync:ready. Idempotent.
  init() {
    if (this._ready) return;
    if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db || !window.firebase) return;
    this._db       = Sync._db;
    this._deviceId = Sync._deviceId;
    this._loadUnacked();
    this._ready = true;
    this._logLine('init: ready (orgId=' + Sync._orgId + ')');
    this._attach();
    // Flush any local changes that happened before we were ready (in order).
    const q = this._pending.splice(0);
    q.forEach(([p, n]) => { this._pushDiff(p, n).catch(e => console.warn('[CustomerSync] queued push', e)); });
    // Re-push records that were written locally last session but never confirmed
    // by the server (e.g. the app closed/refreshed before the write landed). This
    // guarantees a just-added customer actually reaches Firestore.
    {
      const localNow = (window.DB ? DB.getCustomers() : []) || [];
      const now = Date.now();
      const repush = localNow.filter(c => {
        if (!c || !c.id) return false;
        if (this._unacked.has(c.id)) return true;
        const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
        return t && (now - t < this._RECENT_MS);   // durable backstop
      });
      if (repush.length) {
        console.log('[CustomerSync] re-pushing', repush.length, 'un-confirmed local record(s)');
        this._pushDiff([], repush).catch(e => console.warn('[CustomerSync] re-push', e));
      }
    }
    console.log('[CustomerSync] ready');
  },

  // ── Live listener: snapshot → local copy (server is truth) ──────────────────
  _attach() {
    this._unsub = this._col().onSnapshot(
      { includeMetadataChanges: true },
      (snap) => {
        // EMPTY snapshot:
        //   • fromCache → the local Firestore cache may simply be cold (offline /
        //     first paint before the server reply). NOT a reliable "empty" signal —
        //     ignore it so we never wipe local customers on a cold start.
        //   • !fromCache → the SERVER genuinely has no customers (e.g. a purge, or a
        //     brand-new project). Apply emptiness locally. We do NOT auto-migrate
        //     local→server here: that would resurrect a deliberate purge.
        const unacked = this._loadUnacked();
        const fromCache = snap.metadata.fromCache;
        this._logLine(`snapshot: size=${snap.size} empty=${snap.empty} fromCache=${fromCache}`);

        if (snap.empty) {
          // Server genuinely empty (only trust a server snapshot, not a cold cache).
          // Still retain any un-acked local adds so a brand-new customer isn't wiped.
          if (!fromCache) {
            const extra = this._retainUnacked(new Set(), unacked);
            this._logLine(`SERVER EMPTY (!fromCache) → applying ${extra.length} (retained only)`);
            DB.setLocalOnly(DB.K.CUSTOMERS, extra);
            this._emit();
          } else {
            this._logLine('empty fromCache → ignored (no wipe)');
          }
          this._seeded = true;
          return;
        }

        // Build the canonical list from the snapshot, de-duplicating by name.
        // Duplicate uploads (same name, different doc id) are collapsed to the
        // smallest doc id — deterministic, so every device picks the same one —
        // and the extras are deleted from the server to stop them resyncing.
        const byName = new Map();
        const serverAckedIds = new Set();   // ids whose doc is confirmed BY THE SERVER (not a local pending write)
        snap.forEach(d => {
          const rec = this._stripMeta(d.data());
          rec.id = rec.id || d.id;
          // A doc with hasPendingWrites is only our own local write echoed back —
          // NOT server confirmation. Only count server-acked docs as "confirmed".
          if (!d.metadata.hasPendingWrites) serverAckedIds.add(rec.id);
          const key = rec.name != null ? 'n:' + String(rec.name) : 'i:' + d.id;
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push({ docId: d.id, rec });
        });
        const list = [];
        const dupDel = [];
        for (const arr of byName.values()) {
          arr.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
          list.push(arr[0].rec);
          for (let i = 1; i < arr.length; i++) dupDel.push(arr[i].docId);
        }
        const serverIds = new Set(list.map(c => c.id));

        // Confirm un-acked records ONLY once the SERVER has acknowledged them
        // (doc present without pendingWrites). Clearing on a pending/cached echo
        // was the bug: a refresh before the real server write lost the record.
        let unackedChanged = false;
        for (const id of [...unacked]) {
          if (serverAckedIds.has(id)) { unacked.delete(id); unackedChanged = true; }
        }
        // A server snapshot that explicitly removes a record clears its un-acked
        // flag too (it was deleted before it could be confirmed as an add).
        if (!fromCache) {
          snap.docChanges().forEach(ch => {
            if (ch.type === 'removed' && unacked.delete(ch.doc.id)) unackedChanged = true;
          });
        }
        if (unackedChanged) this._saveUnacked();

        // Apply server truth + still-un-acked local adds, WITHOUT pushing back.
        const finalList = this._retainUnacked(serverIds, unacked, list);
        DB.setLocalOnly(DB.K.CUSTOMERS, finalList);
        const after = ((window.DB ? DB.getCustomers() : []) || []).length;
        const ck = DB.K.CUSTOMERS;
        const cacheLen = (DB._cache && DB._cache[ck]) ? DB._cache[ck].length : 'none';
        const inIdb = (DB._idbKeys && typeof DB._idbKeys.has === 'function') ? DB._idbKeys.has(ck) : '?';
        this._logLine(`applied: server=${list.length} final=${finalList.length} key=${ck} cache=${cacheLen} idb=${inIdb} → getCustomers=${after}`);
        this._emit();

        // Clean up duplicate server docs (idempotent; both devices delete the same ids).
        if (dupDel.length) this._deleteDocs(dupDel);

        // Activity toasts for changes made on OTHER devices (after first snapshot).
        if (!this._seeded) { this._seeded = true; return; }
        let shown = 0;
        for (const ch of snap.docChanges()) {
          if (shown >= 3) break;
          const r = ch.doc.data();
          if (!r || r._by === this._deviceId) continue;       // our own echo
          if (ch.doc.metadata.hasPendingWrites) continue;       // not yet server-acked
          const action = ch.type === 'added' ? 'add' : ch.type === 'removed' ? 'del' : 'edit';
          if (Sync._activityToast) {
            Sync._activityToast({ typeKey: 'customers_v2', action,
              name: Sync._recordName('customers_v2', r), byName: r._byName });
          }
          shown++;
        }
      },
      (err) => console.warn('[CustomerSync] listener error:', err.code, err.message)
    );
  },

  _emit() {
    window.dispatchEvent(new CustomEvent('sync:updated', { detail: { key: 'wt_customers' } }));
    window.dispatchEvent(new CustomEvent('sync:pulled'));
  },

  // Append still-un-acked local records (not present in serverIds) to a server
  // list, reading their current data from the local copy. Returns the merged list.
  _retainUnacked(serverIds, unacked, baseList) {
    const list = Array.isArray(baseList) ? baseList.slice() : [];
    const localNow = (window.DB ? DB.getCustomers() : []) || [];
    const now = Date.now();
    for (const c of localNow) {
      if (!c || !c.id || serverIds.has(c.id)) continue;
      const isUnacked = unacked && unacked.has(c.id);
      const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
      const isRecent = t && (now - t < this._RECENT_MS);   // durable backstop for un-acked adds
      if (isUnacked || isRecent) list.push(c);
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
      console.log('[CustomerSync] removed', ids.length, 'duplicate server docs');
    } catch (e) { console.warn('[CustomerSync] dup cleanup failed', e); }
  },

  // ── Local change → Firestore (called by DB._set on every customer write) ────
  // prev/next are the customer arrays before/after the write. Because the local
  // copy is kept equal to the server by the listener, prev reflects server state,
  // so an id present in prev but absent in next is a genuine user deletion.
  onLocalChange(prev, next) {
    const pn = Array.isArray(prev) ? prev.length : 0;
    const nn = Array.isArray(next) ? next.length : 0;
    this._logLine(`onLocalChange prev=${pn} next=${nn} ready=${this._ready}`);
    this._pushDiff(prev, next).catch(e => this._logLine('push REJECTED: ' + (e.code || '') + ' ' + (e.message || e)));
  },

  async _pushDiff(prev, next) {
    if (!this._ready) { this._pending.push([prev, next]); this._logLine('not ready → queued diff'); return; }
    const prevArr = Array.isArray(prev) ? prev : [];
    const nextArr = Array.isArray(next) ? next : [];
    const prevMap = new Map(prevArr.filter(r => r && r.id).map(r => [r.id, this._fp(r)]));
    const nextIds = new Set(nextArr.filter(r => r && r.id).map(r => r.id));

    const upserts = nextArr.filter(r => r && r.id && prevMap.get(r.id) !== this._fp(r));
    const deletes = [...prevMap.keys()].filter(id => !nextIds.has(id));
    if (!upserts.length && !deletes.length) return;

    // Mark upserts as un-acked (retained until a server snapshot confirms them);
    // clear that flag for deletions. Persisted so a refresh can't lose a new add.
    const unacked = this._loadUnacked();
    upserts.forEach(r => unacked.add(r.id));
    deletes.forEach(id => unacked.delete(id));
    this._saveUnacked();

    const col = this._col();
    const meta = () => ({
      _by: this._deviceId,
      _byName: Sync._deviceName(),
      _ts: firebase.firestore.FieldValue.serverTimestamp(),
    });
    let batch = this._db.batch(), ops = 0;
    const commit = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };
    for (const r of upserts) {
      batch.set(col.doc(r.id), { ...this._stripMeta(r), ...meta() }, { merge: true });
      if (++ops >= 450) await commit();
    }
    for (const id of deletes) {
      batch.delete(col.doc(id));
      if (++ops >= 450) await commit();
    }
    if (ops > 0) {
      this._logLine(`committing ${upserts.length} upsert, ${deletes.length} delete …`);
      await batch.commit();
      this._logLine(`commit OK (${upserts.length} upsert, ${deletes.length} delete)`);
    }
  },
};

// Auto-init once sync.js signals ready (Firestore handle available).
window.addEventListener('sync:ready', () => { try { CustomerSync.init(); } catch (e) { console.warn('[CustomerSync] init', e); } });
// In case sync was already ready before this script loaded.
if (typeof Sync !== 'undefined' && Sync.ready) { try { CustomerSync.init(); } catch {} }
