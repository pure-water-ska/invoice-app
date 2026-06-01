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

  _stripMeta(r) { const { _by, _byName, _ts, ...rec } = r || {}; return rec; },
  _fp(r) { return JSON.stringify(this._stripMeta(r)); },
  _col() { return Sync._orgRef().collection(this.COL); },

  // Called from nav.js / on sync:ready. Idempotent.
  init() {
    if (this._ready) return;
    if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db || !window.firebase) return;
    this._db       = Sync._db;
    this._deviceId = Sync._deviceId;
    this._ready = true;
    this._attach();
    // Flush any local changes that happened before we were ready (in order).
    const q = this._pending.splice(0);
    q.forEach(([p, n]) => { this._pushDiff(p, n).catch(e => console.warn('[CustomerSync] queued push', e)); });
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
        if (snap.empty) {
          if (!snap.metadata.fromCache) {
            DB.setLocalOnly(DB.K.CUSTOMERS, []);
            this._emit();
          }
          this._seeded = true;
          return;
        }

        // Build the canonical list from the snapshot, de-duplicating by name.
        // Duplicate uploads (same name, different doc id) are collapsed to the
        // smallest doc id — deterministic, so every device picks the same one —
        // and the extras are deleted from the server to stop them resyncing.
        const byName = new Map();
        snap.forEach(d => {
          const rec = this._stripMeta(d.data());
          rec.id = rec.id || d.id;
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

        // Apply server truth to the local copy WITHOUT pushing back.
        DB.setLocalOnly(DB.K.CUSTOMERS, list);
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
    this._pushDiff(prev, next).catch(e => console.warn('[CustomerSync] push', e));
  },

  async _pushDiff(prev, next) {
    if (!this._ready) { this._pending.push([prev, next]); return; }
    const prevArr = Array.isArray(prev) ? prev : [];
    const nextArr = Array.isArray(next) ? next : [];
    const prevMap = new Map(prevArr.filter(r => r && r.id).map(r => [r.id, this._fp(r)]));
    const nextIds = new Set(nextArr.filter(r => r && r.id).map(r => r.id));

    const upserts = nextArr.filter(r => r && r.id && prevMap.get(r.id) !== this._fp(r));
    const deletes = [...prevMap.keys()].filter(id => !nextIds.has(id));
    if (!upserts.length && !deletes.length) return;

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
    if (ops > 0) await batch.commit();
    console.log(`[CustomerSync] pushed ${upserts.length} upsert, ${deletes.length} delete`);
  },
};

// Auto-init once sync.js signals ready (Firestore handle available).
window.addEventListener('sync:ready', () => { try { CustomerSync.init(); } catch (e) { console.warn('[CustomerSync] init', e); } });
// In case sync was already ready before this script loaded.
if (typeof Sync !== 'undefined' && Sync.ready) { try { CustomerSync.init(); } catch {} }
