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
  _lastDocIds:    {},                    // { [docName]: Set<id> } — IDs last seen for an array DOCUMENT; used to tombstone deletions so a pull/listener can't restore a deleted record (customers, products, …)
  _lastSyncedRecs:{},                    // { [colName]: Map<id,string> } — JSON fingerprint per record; diff to send only changed records (opt ③)
  _listenerSeeded:{},                   // { [colName]: boolean } — true after the initial onSnapshot delivery (all docs "added"); toasts suppressed until then
  ARCHIVE_MONTHS:    6,                  // invoices older than this are not fetched on page load (date-filtered _pullAll)
  _persistedSidsKey: 'wt_sync_sids',    // localStorage key for per-collection Set<id> that survives page reloads — enables tombstone-deletion of archived invoices outside the pull window

  // ── Large collections → one Firestore doc per record ──────────────────────
  // (avoids 1 MB Firestore document limit for busy businesses)
  COLLECTIONS: {
    'wt_invoices':  'invoices',
    'wt_payments':  'payments',
    // NOTE: wt_customers is intentionally NOT here. Customer sync is handled by a
    // dedicated, self-contained module (customer-sync.js) using the customers_v2
    // collection where the Firestore snapshot is the SINGLE source of truth — no
    // tombstones, no _serverIds, no reconcile/known-ids. The general sync.js
    // machinery (tombstones + union merge + _writeKey diff) fought itself for
    // customers and could neither delete reliably nor stop phantom re-uploads.
  },

  // ── Small/medium collections → one Firestore document holds the whole array ─
  DOCUMENTS: {
    // NOTE: wt_products & wt_pricing are intentionally NOT here. Like customers,
    // they are handled by dedicated single-source-of-truth modules
    // (product-sync.js / pricing-sync.js via collection-sync.js) using the
    // products_v2 / pricing_v2 collections. The old whole-array DOCUMENT sync
    // had the same in-place-mutation diff blindness that broke customer adds.
    'wt_settings':        'settings',
    // wt_users moved to its own single-source-of-truth module (user-sync.js,
    // users_v2). The old whole-array DOCUMENT sync shared the in-place-mutation
    // diff bug, so a newly added user didn't reliably reach other devices.
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
    // Propagate the deletion to other devices via Firestore
    this._fsPushDeletions(colName, ids);
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
    // Propagate the un-delete to other devices
    this._fsClearDeletions(colName, ids);
  },

  // ── Firestore-propagated deletions ─────────────────────────────────────────
  // Array DOCUMENTS (customers, users, products…) are stored whole. When one
  // device deletes a record, another device that still has it would re-merge it
  // back as a "local-only" record — so the delete never sticks across devices.
  // A shared doc data/_deletions records every deleted ID per docName; all
  // devices read it, drop those IDs, and never re-upload them. This is what
  // makes a delete on device A propagate to device B.
  _deletionsDoc: '_deletions',

  _fsDeletionsRef() {
    return this._orgRef().collection('data').doc(this._deletionsDoc);
  },

  // Record deletions in Firestore (best-effort, field-path merge so concurrent
  // device writes don't clobber each other).
  _fsPushDeletions(name, ids) {
    if (!this._db || !ids || !ids.length) return;
    try {
      const ref = this._fsDeletionsRef();
      const now = Date.now();
      const updates = { ts: firebase.firestore.FieldValue.serverTimestamp(), by: this._deviceId };
      ids.forEach(id => { updates[`d.${name}.${id}`] = now; });
      ref.update(updates).catch(() => {
        // Doc doesn't exist yet → create it
        const d = {}; d[name] = {}; ids.forEach(id => { d[name][id] = now; });
        ref.set({ d, ts: firebase.firestore.FieldValue.serverTimestamp(), by: this._deviceId }, { merge: true }).catch(() => {});
      });
    } catch {}
  },

  // Remove deletion entries (when a record with the same id is re-added)
  _fsClearDeletions(name, ids) {
    if (!this._db || !ids || !ids.length) return;
    try {
      const ref = this._fsDeletionsRef();
      const updates = {};
      ids.forEach(id => { updates[`d.${name}.${id}`] = firebase.firestore.FieldValue.delete(); });
      ref.update(updates).catch(() => {});
    } catch {}
  },

  // Merge a Firestore deletions map { docName: { id: ts } } INTO the local
  // tombstone store WITHOUT re-pushing (avoids a loop). Timestamps are refreshed
  // to "now" so a Firestore-sourced deletion never expires via the local TTL
  // while it still exists server-side. Returns the set of affected docNames.
  _mergeDeletionsLocal(dmap) {
    const affected = new Set();
    if (!dmap || typeof dmap !== 'object') return affected;
    try {
      const all = JSON.parse(localStorage.getItem(this._tombstoneKey) || '{}');
      const now = Date.now();
      for (const [name, ids] of Object.entries(dmap)) {
        if (!ids || typeof ids !== 'object') continue;
        if (!all[name]) all[name] = {};
        for (const id of Object.keys(ids)) {
          all[name][id] = now;           // refresh ts so TTL doesn't expire it
          affected.add(name);
        }
      }
      localStorage.setItem(this._tombstoneKey, JSON.stringify(all));
    } catch {}
    return affected;
  },

  // Fetch the Firestore deletions doc → merge into local store. Called early in
  // _pullAll so the document filters drop deleted records on every device.
  async _pullDeletions() {
    if (!this._db) return new Set();
    try {
      const doc = await this._fsDeletionsRef().get();
      if (doc.exists && doc.data() && doc.data().d) {
        return this._mergeDeletionsLocal(doc.data().d);
      }
    } catch (e) { console.warn('[Sync] pull deletions:', e.message); }
    return new Set();
  },

  // Push all local tombstones up to Firestore — covers deletions made while
  // offline or before sync was ready (e.g. tombstones written by DB._set).
  _flushTombstonesToFs() {
    if (!this._db) return;
    try {
      const all = JSON.parse(localStorage.getItem(this._tombstoneKey) || '{}');
      for (const [name, ids] of Object.entries(all)) {
        const idList = Object.keys(ids || {});
        if (idList.length) this._fsPushDeletions(name, idList);
      }
    } catch {}
  },

  // Filter a Firestore snap array through active tombstones for that collection
  _applyTombstones(colName, snapDocs) {
    const stones = this._getTombstones(colName);
    if (!Object.keys(stones).length) return snapDocs;
    const now  = Date.now();
    const keep = [], drop = [];
    for (const d of snapDocs) {
      const t = stones[d.id];
      if (!t) { keep.push(d); continue; }
      if (now - t > this._tombstoneTTL) { this._clearTombstones(colName, [d.id]); keep.push(d); continue; }
      drop.push(d);
    }
    // Poison guard (mirrors _filterArrayTombstones): never let tombstones remove
    // a bulk number of records from a server pull — that's leftover poison, not a
    // real delete. Keep everything and purge the poison.
    if (drop.length > this._MAX_AUTO_TOMBSTONE) {
      console.warn(`[Sync] Ignoring ${drop.length} ${colName} collection tombstones (bulk = poison)`);
      try { this._clearTombstones(colName, drop.map(d => d.id)); } catch {}
      return snapDocs;
    }
    return keep;
  },

  // Called synchronously by DB._set() BEFORE the cache is overwritten, with the
  // previous and next values for a key. For array DOCUMENTS it diffs the IDs and
  // tombstones any that were removed — and clears tombstones for re-added IDs.
  // Runs regardless of Sync.ready/_online, so a delete made offline or before
  // sync init still suppresses the record on the next pull/listener delivery.
  // Max records a single _set may tombstone. A genuine user deletion removes one
  // or a few records; a large drop (e.g. 8→1, 101→0) is virtually always a sync
  // artifact / divergent-device write, NOT 100 individual deletes. Auto-
  // tombstoning those poisoned the shared _deletions doc and wiped real data on
  // healthy devices (observed clobber war). Cap it so only small, plausibly-real
  // deletions propagate; bulk reductions are left to the safe UNION merge.
  _MAX_AUTO_TOMBSTONE: 3,

  _recordDocDeletions(key, prevVal, nextVal) {
    const docName = this.DOCUMENTS[key];
    if (!docName) return;                 // not a synced DOCUMENT
    if (this.NO_SYNC.has(key)) return;    // local-only (logs, errors)
    if (!Array.isArray(prevVal) || !Array.isArray(nextVal)) return;
    const nextIds = new Set(nextVal.filter(r => r && r.id).map(r => r.id));
    const deleted = prevVal.filter(r => r && r.id && !nextIds.has(r.id)).map(r => r.id);

    // A re-added ID (same id appears again) must clear its tombstone first.
    const stones  = this._getTombstones(docName);
    const readded = [...nextIds].filter(id => stones[id]);
    if (readded.length > 0) this._clearTombstones(docName, readded);
    this._lastDocIds[docName] = nextIds;

    if (deleted.length === 0) return;
    // GUARD: never auto-tombstone a bulk reduction — it's almost always a sync
    // artifact and propagating it deletes real data on other devices.
    if (deleted.length > this._MAX_AUTO_TOMBSTONE) {
      console.warn(`[Sync] Skipping bulk tombstone (${deleted.length} ${docName} removed in one save) — treating as divergence, not deletion. Union merge will preserve data.`);
      return;
    }
    this._addTombstones(docName, deleted);
    console.log(`[Sync] Tombstoned ${deleted.length} deleted ${docName} record(s)`);
  },

  // Filter a plain array of records (DOCUMENT arrays: customers, products, …)
  // through active tombstones keyed under `name`.  Used so a deleted record can
  // never be restored by a Firestore pull/listener that hasn't yet seen the
  // delete (the "deleted customer comes back on refresh" bug for DOCUMENTS).
  _filterArrayTombstones(name, arr) {
    if (!Array.isArray(arr)) return arr;
    const stones = this._getTombstones(name);
    if (!Object.keys(stones).length) return arr;
    const now = Date.now();
    const keep = [], drop = [];
    for (const r of arr) {
      if (!r || !r.id) { keep.push(r); continue; }
      const t = stones[r.id];
      if (!t) { keep.push(r); continue; }
      if (now - t > this._tombstoneTTL) { this._clearTombstones(name, [r.id]); keep.push(r); continue; }
      drop.push(r);
    }
    // POISON GUARD: a real delete removes one/a few records. If tombstones would
    // drop more than the cap, they are poison (e.g. an old delete-all that
    // tombstoned the whole list) — IGNORE them and keep the data, so the server's
    // records can never be wiped from a device on load (fixes "local=0 but
    // server=101 / customers missing in invoice page"). Self-heals every device.
    if (drop.length > this._MAX_AUTO_TOMBSTONE) {
      console.warn(`[Sync] Ignoring ${drop.length} ${name} tombstones (bulk = poison) — keeping all records`);
      // Also purge these poison tombstones so they stop interfering.
      try { this._clearTombstones(name, drop.map(r => r.id)); } catch {}
      return arr;
    }
    return keep;
  },

  // ── Server-confirmed IDs per array DOCUMENT ────────────────────────────────
  // Persisted in sessionStorage so they survive page navigation. A local record
  // that is MISSING from an incoming server snapshot is a DELETION if its id was
  // previously confirmed on the server (in this set) — vs a genuinely NEW local
  // record (created offline, never synced) if it was not. This is what lets a
  // delete on device A propagate to device B without B re-uploading the records.
  _knownDocIdsKey: 'wt_sync_known_doc_ids',
  _knownDocIds(name) {
    try {
      const all = JSON.parse(sessionStorage.getItem(this._knownDocIdsKey) || '{}');
      return new Set(all[name] || []);
    } catch { return new Set(); }
  },
  _setKnownDocIds(name, set) {
    try {
      const all = JSON.parse(sessionStorage.getItem(this._knownDocIdsKey) || '{}');
      all[name] = [...set];
      sessionStorage.setItem(this._knownDocIdsKey, JSON.stringify(all));
    } catch {}
  },
  _hasKnownDocIds(name) {
    try {
      const all = JSON.parse(sessionStorage.getItem(this._knownDocIdsKey) || '{}');
      return Array.isArray(all[name]);
    } catch { return false; }
  },

  // Apply a server array (from _pullAll or the listener) to local storage using
  // UNION + EXPLICIT-TOMBSTONE deletion. This is the only safe rule for a whole-
  // document array shared by multiple devices:
  //
  //   • A record present locally but MISSING from the incoming snapshot is KEPT
  //     (union) UNLESS it is explicitly tombstoned in the _deletions doc.
  //   • A record present in the snapshot is added.
  //   • Tombstoned records are dropped from the result.
  //
  // Why union (not "missing = deleted"): a device with stale/empty data pushes
  // its whole array too; if "missing = deleted" we would wipe the other device's
  // real records on receipt of that smaller array (observed: an empty device
  // pushing n=0 made the full device drop everything → clobber war + data loss).
  // Real deletions are carried explicitly by the _deletions doc, so union loses
  // nothing while still honouring deletes.
  _applyArrayDoc(lsKey, docName, fsVal) {
    if (!Array.isArray(fsVal)) fsVal = [];
    const fsIds = new Set(fsVal.filter(r => r && r.id).map(r => r.id));
    let localArr = [];
    try { localArr = JSON.parse(this._localRead(lsKey) || '[]'); } catch {}
    if (!Array.isArray(localArr)) localArr = [];

    // Union: server records + local records the server snapshot doesn't have.
    const localOnly = localArr.filter(r => r && r.id && !fsIds.has(r.id));
    let result = localOnly.length > 0 ? [...fsVal, ...localOnly] : fsVal;

    // Apply explicit deletions (the ONLY way a record is removed).
    result = this._filterArrayTombstones(docName, result);

    this._lsWrite(lsKey, result);
    if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
    const resultIds = new Set(result.filter(r => r && r.id).map(r => r.id));
    this._setKnownDocIds(docName, resultIds);
    this._lastDocIds[docName] = resultIds;
    this._lastDocJson[lsKey] = JSON.stringify(result);

    // Re-upload only when our union actually added something the server lacked,
    // OR when tombstones trimmed records still present in the snapshot — so all
    // devices converge. When result equals fsVal we DON'T re-push (prevents the
    // ping-pong write loop between devices).
    const changedVsServer = result.length !== fsVal.length ||
      result.some(r => r && r.id && !fsIds.has(r.id));
    if (changedVsServer) {
      this._writeKey(lsKey, result).catch(e =>
        console.warn('[Sync] array-doc reupload failed:', docName, e.message));
    }
    return result;
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

  // ── Persisted pull IDs — session-scoped, survive page navigation ─────────────
  // _pullIds must reflect exactly "IDs confirmed in Firestore at the start of this
  // session" (from the real _pullAll() Firestore query).  When _seedStateFromLocalStorage()
  // re-seeds _pullIds on each page navigation it must NOT include local-only records
  // (created after _pullAll(), not yet pushed) — those would be treated as
  // "deleted on another device" when the listener fires without them.
  // Solution: save the authoritative _pullIds to sessionStorage after every real
  // Firestore pull, and restore from sessionStorage on subsequent page loads.
  _savePullIds(colName) {
    try {
      const all = JSON.parse(sessionStorage.getItem('wt_sync_pull_ids') || '{}');
      all[colName] = [...(this._pullIds[colName] || new Set())];
      sessionStorage.setItem('wt_sync_pull_ids', JSON.stringify(all));
    } catch {}
  },

  _loadSavedPullIds(colName) {
    try {
      const all = JSON.parse(sessionStorage.getItem('wt_sync_pull_ids') || '{}');
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

    // ── Tauri: persist the device ID on the HDD-backed DB store ──────────────
    // localStorage is wiped on every Tauri launch, and IndexedDB has proven
    // unreliable in the WebView — so the old code regenerated a NEW id almost
    // every launch. An unstable deviceId breaks echo-suppression: a device no
    // longer recognises its OWN past writes, re-applies them as "remote", and
    // re-pushes — producing a clobber war between devices where a stale full
    // array overwrites a fresh one (changes don't stick across devices).
    // DB._get/_set is HDD-backed in Tauri (survives the wipe) and 'wt_device_id'
    // is NOT in DOCUMENTS/COLLECTIONS so it never syncs to Firestore.
    if (window.IS_TAURI && (typeof DB !== 'undefined')) {
      try {
        let id = DB._getObj('wt_device_id', null);
        if (!id || typeof id !== 'string') {
          id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          DB._set('wt_device_id', id);
        }
        this._deviceId = id;
        console.log('[Sync] Device ID ready (HDD, stable):', id);
        return;
      } catch (e) {
        console.warn('[Sync] HDD device-id failed, falling back:', e.message);
      }
    }

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
    // Wait for DB.preloadFromIDB() to complete before any Firestore work.
    // In Tauri this sets DB._tauri.dataDir — without this wait, _lsWrite()
    // skips HDD writes (dataDir is null) and pulled data is lost on restart.
    // On the web it ensures IDB-overflow keys are loaded before _pullAll() reads.
    if ((typeof DB !== 'undefined') && DB.ready) await DB.ready;

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
      // ignoreUndefinedProperties: a record with ANY undefined field makes
      // batch.set()/set() THROW ("Unsupported field value: undefined"), which
      // silently aborted the whole collection bootstrap — so customers_v2 stayed
      // EMPTY (0 docs) and deletes had nothing to act on / data "came back".
      // Messy migrated records often carry undefined fields; tell Firestore to
      // skip them instead of throwing. Must be set before any other Firestore use.
      try { this._db.settings({ ignoreUndefinedProperties: true }); }
      catch (e) { console.warn('[Sync] settings(ignoreUndefinedProperties) failed:', e.message); }
      this._orgId = FIREBASE_CONFIG.orgId || 'main';

      // ── Enable IndexedDB offline persistence ─────────────────────────────
      // synchronizeTabs:false avoids the multi-tab primary-lock that blocked a
      // second device from connecting (both devices share the same Firebase team
      // account and both tried to claim the single-primary-tab IndexedDB lock).
      // With synchronizeTabs:false each tab/device keeps its own independent cache.
      // This makes onSnapshot() serve its initial snapshot from IndexedDB (free,
      // fromCache:true) instead of always fetching from the server.
      //
      // enableIndexedDbPersistence exists in Firebase v8 and v9-compat.
      // Firebase v10 removed it (persistence is on by default there).
      // Guard with typeof so the app runs cleanly on any SDK version.
      if (typeof this._db.enableIndexedDbPersistence === 'function') {
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
      } else {
        // Firebase v10+: IndexedDB persistence is built-in, no explicit call needed.
        console.log('[Sync] IndexedDB persistence: SDK manages cache automatically');
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

      // ── Firebase Auth ─────────────────────────────────────────────────────────
      // Each app user gets their own Firebase Auth account provisioned by users.html.
      // sync.js reads the app session (sessionStorage) → user record → firebaseEmail /
      // firebasePassword.  Users not yet provisioned fall back to the shared teamEmail.
      // On the login page itself Auth.session() returns null → teamEmail is used.
      const _appSession = (window.Auth && Auth.session) ? Auth.session() : null;
      const _appUser    = (_appSession && (typeof DB !== 'undefined')) ? DB.getUserById(_appSession.userId) : null;
      const _fbEmail    = _appUser?.firebaseEmail    || FIREBASE_CONFIG.teamEmail;
      const _fbPass     = _appUser?.firebasePassword || FIREBASE_CONFIG.teamPassword;

      if (!window.IS_TAURI) {
        // ── Browser: full Auth with IndexedDB session persistence ──────────────
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

      } else {
        // ── Tauri: Auth WITHOUT persistence ─────────────────────────────────────
        // firebase-auth-compat.js IS loaded but we skip IndexedDB persistence.
        // With NONE persistence, the SDK does NOT create the hidden
        // [project].firebaseapp.com/__/auth/iframe used for session management —
        // which is the iframe Google rejects for tauri:// origins.
        // Sign in fresh each session (REST call, no Google OAuth involved).
        console.log('[Sync] Tauri: signing in without persistence');
        try {
          await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.NONE);
        } catch (e) {
          console.warn('[Sync] Tauri setPersistence failed (non-fatal):', e.message);
        }
        if (_fbEmail && _fbPass) {
          await firebase.auth().signInWithEmailAndPassword(_fbEmail, _fbPass);
        } else {
          await firebase.auth().signInAnonymously();
        }
        this._uid = firebase.auth().currentUser?.uid || 'anon-tauri';
        console.log('[Sync] Tauri auth OK, uid=', this._uid);
      }

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
          const val = ((typeof DB !== 'undefined') && DB._cache[key] !== undefined) ? DB._cache[key] : null;
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
          const val = ((typeof DB !== 'undefined') && DB._cache[key] !== undefined) ? DB._cache[key] : null;
          if (val !== null && val !== undefined) {
            this._enqueue(key, val);
          }
        }
      }
    });

    // Warn before refresh/close while an upload is still in flight — the
    // same-device "payment reverts after refresh" guard. Also paints the bar.
    window.addEventListener('beforeunload', (e) => {
      if (this.isUploading()) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    this._initUploadBar();
  },

  // ── Upload progress / busy state ────────────────────────────────────────────
  // "Busy" = any debounced collection/doc write pending, any in-flight commit,
  // or any queued (offline) write. Used by the upload bar + beforeunload guard.
  _uploadBusyCount() {
    let n = 0;
    for (const k in this._pendingWrite) if (this._pendingWrite[k]) n++;
    for (const k in this._pushDebounce)  if (this._pushDebounce[k] != null) n++;
    for (const k in this._docDebounce)   if (this._docDebounce[k] != null) n++;
    try { n += this._getQueue().length; } catch {}
    return n;
  },
  isUploading() { return this._uploadBusyCount() > 0; },
  _emitUploadState() {
    try {
      window.dispatchEvent(new CustomEvent('sync:uploadstate',
        { detail: { busy: this.isUploading(), count: this._uploadBusyCount() } }));
    } catch {}
  },
  _initUploadBar() {
    if (this._uploadBarInit) return; this._uploadBarInit = true;
    if (!document.getElementById('wtUploadBarCss')) {
      const st = document.createElement('style'); st.id = 'wtUploadBarCss';
      st.textContent = '@keyframes wtspin{to{transform:rotate(360deg)}}';
      (document.head || document.documentElement).appendChild(st);
    }
    let hideTimer = null;
    const onState = (e) => {
      let bar = document.getElementById('wtUploadBar');
      if (!bar) {
        if (!document.body) return;
        bar = document.createElement('div');
        bar.id = 'wtUploadBar';
        bar.style.cssText = 'position:fixed;left:0;right:0;z-index:1100;display:none;' +
          'align-items:center;gap:10px;padding:8px 16px;font-size:14px;' +
          'box-shadow:0 2px 6px rgba(0,0,0,.12);font-family:Sarabun,sans-serif';
        document.body.appendChild(bar);
      }
      const nav = document.querySelector('.navbar');
      bar.style.top = ((nav ? nav.offsetHeight : 52)) + 'px';
      const busy  = e.detail && e.detail.busy;
      const count = (e.detail && e.detail.count) || 0;
      if (busy) {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        bar.style.display = 'flex';
        bar.style.background = '#fff3cd'; bar.style.color = '#664d03';
        bar.style.borderBottom = '1px solid #ffe69c';
        bar.innerHTML =
          '<span style="width:16px;height:16px;border:2px solid #664d03;border-right-color:transparent;border-radius:50%;display:inline-block;animation:wtspin .7s linear infinite"></span>' +
          '<span><strong>กำลังอัปโหลดข้อมูล…</strong> อย่าเพิ่งปิดหรือรีเฟรชหน้านี้' +
          (count > 1 ? ' <span style="opacity:.7">(เหลือ ' + count + ' รายการ)</span>' : '') + '</span>';
      } else if (bar.style.display === 'flex') {
        // Flash "done" then auto-hide — only when the bar was actually showing.
        bar.style.background = '#d1e7dd'; bar.style.color = '#0f5132';
        bar.style.borderBottom = '1px solid #badbcc';
        bar.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i><strong>อัปโหลดข้อมูลครบแล้ว</strong> — ทำงานต่อได้เลย';
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { bar.style.display = 'none'; }, 2500);
      }
    };
    window.addEventListener('sync:uploadstate', onState);
    this._emitUploadState();
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
      this._emitUploadState();
      this._pushDebounce[key] = setTimeout(() => {
        // Clear the timer ID now so beforeunload won't re-enqueue already-written data.
        this._pushDebounce[key] = null;
        // Read fresh value from DB cache at fire time (not the stale closure val)
        const fresh = (typeof DB !== 'undefined') ? DB._cache[key] ?? val : val;
        this._writeKey(key, fresh)
          .then(() => { this._pendingWrite[key] = false; this._emitUploadState(); })
          .catch(e => {
            this._pendingWrite[key] = false;
            console.warn('[Sync] push failed, queuing:', key, e.message);
            this._enqueue(key, fresh);
            this._badge('pending');
            this._emitUploadState();
          });
      }, 600);
      return;
    }
    // (Deletion tombstoning for array DOCUMENTS happens earlier, in
    //  Sync._recordDocDeletions(), called synchronously by DB._set().)

    // ── Opt ①②: Debounce DOCUMENTS writes + skip if content unchanged ──────────
    // Mirrors the COLLECTION debounce: collapses rapid saves into one Firestore write.
    // At fire time we also compare a JSON fingerprint — if nothing changed since the
    // last successful write (e.g. a settings re-render that didn't touch relevant keys,
    // or a page navigation that re-saves the same data) we skip the round-trip entirely.
    clearTimeout(this._docDebounce[key]);
    this._docDebounce[key] = setTimeout(() => {
      this._docDebounce[key] = null;
      const fresh     = (typeof DB !== 'undefined') ? (DB._cache[key] !== undefined ? DB._cache[key] : val) : val;
      const freshJson = JSON.stringify(fresh);
      if (freshJson === this._lastDocJson[key]) {
        console.log('[Sync] Doc unchanged, skip write:', this.DOCUMENTS[key]);
        this._emitUploadState();
        return;
      }
      this._writeKey(key, fresh)
        .then(() => { this._lastDocJson[key] = freshJson; this._emitUploadState(); })
        .catch(e => {
          console.warn('[Sync] push failed, queuing:', key, e.message);
          this._enqueue(key, fresh);
          this._badge('pending');
          this._emitUploadState();
        });
    }, 600);
    this._emitUploadState();
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
          byName: this._deviceName(),
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
      //
      const preStones = this._getTombstones(colName);
      const stoneNow  = Date.now();
      const knownServerIds = this._serverIds[colName];
      let syncDeletedIds = [];
      if (knownServerIds && knownServerIds.size > 0) {
        syncDeletedIds = [...knownServerIds].filter(id => !localIds.has(id));
      }

      // ── Belt-and-suspenders: flush active tombstones even if _serverIds is empty ──
      // Covers the queue-flush path: user deletes a payment and navigates away within
      // the 600 ms debounce window → beforeunload enqueues the deletion → new page load
      // calls _flushQueueNow() BEFORE _pullAll(), so _serverIds is not populated yet.
      // Without this, syncDeletedIds stays empty and the record is never deleted from
      // Firestore — the tombstone blocks it for 5 min, then it silently comes back.
      for (const [id, ts] of Object.entries(preStones)) {
        if (stoneNow - ts <= this._tombstoneTTL && !localIds.has(id) && !syncDeletedIds.includes(id)) {
          syncDeletedIds.push(id);
        }
      }

      // ── MASS-DELETE GUARD (applies to EVERYTHING, tombstoned or not) ────────
      // "server has the id, local doesn't" is only a safe deletion signal when
      // local data is COMPLETE. If this device's local array is incomplete
      // (interrupted pull, cold cache, flaky connection), the set-difference
      // wipes every record this device merely doesn't have — observed in the
      // field as "deleting 79 of 95 payments on every save", flipping invoices
      // paid→unpaid on all devices.
      //
      // IMPORTANT: tombstones CANNOT be used to whitelist deletions here — each
      // mass-delete pass tombstoned its own inferred ids (and refreshed them on
      // every save, TTL 30 min), so a "tombstoned = explicit" exemption let the
      // very same 79-record wipe straight through (observed on v1.0.129).
      // Real user deletions are 1–2 records (multi-page invoice deletes are a
      // handful); anything above the threshold is treated as pathological:
      // blocked, logged, and its tombstones CLEARED so the poisoned stones can't
      // re-enter via the belt-and-suspenders loop on the next write.
      const MAX_DELETES_PER_WRITE = 5;
      if (syncDeletedIds.length > MAX_DELETES_PER_WRITE) {
        try {
          if (typeof DB !== 'undefined' && DB.logError) {
            const _ver = (typeof APP_VERSION !== 'undefined' && APP_VERSION.version) ? APP_VERSION.version : '?';
            DB.logError('SYNC-DEL-BLOCKED',
              `[v${_ver}] ${colName}: blocked ${syncDeletedIds.length} deletion(s) — local data likely incomplete ` +
              `(local=${localIds.size}, serverKnown=${knownServerIds ? knownServerIds.size : 0}). ` +
              `Sample: [${syncDeletedIds.slice(0, 8).join(', ')}]`);
          }
        } catch {}
        this._clearTombstones(colName, syncDeletedIds);  // disinfect poisoned stones
        syncDeletedIds = [];
      } else if (syncDeletedIds.length > 0) {
        this._addTombstones(colName, syncDeletedIds);
      }

      if (syncDeletedIds.length > 0) {
        this._ignoreUntil[key] = Date.now() + this._skipInitialMs;
        // ── DIAGNOSTIC (payments/invoices): record every Firestore deletion with its
        // call source, so a "data reverts on another device" bug can be traced on a
        // release build where DevTools is unavailable. Visible in Settings → Troubleshoot.
        try {
          if ((colName === 'payments' || colName === 'invoices') && typeof DB !== 'undefined' && DB.logError) {
            const src = (new Error().stack || '').split('\n').slice(2, 5).map(s => s.trim()).join(' ← ');
            const _ver2 = (typeof APP_VERSION !== 'undefined' && APP_VERSION.version) ? APP_VERSION.version : '?';
            DB.logError('SYNC-DEL',
              `[v${_ver2}] ${colName}: deleting ${syncDeletedIds.length} id(s) [${syncDeletedIds.slice(0, 8).join(', ')}] ` +
              `| local=${localIds.size} serverKnown=${(knownServerIds ? knownServerIds.size : 0)} | src: ${src}`);
          }
        } catch {}
      }

      // Update cached server IDs to reflect the new local state.
      // Invoices: MERGE into the persisted set (keeps archive ids outside the
      // window). Other collections: replace with current local ids.
      if (colName === 'invoices') {
        const persisted = this._loadSavedServerIds(colName);
        syncDeletedIds.forEach(id => persisted.delete(id));
        localIds.forEach(id => persisted.add(id));
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
          _byName: this._deviceName(),
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
          if (colName === 'invoices' || colName === 'payments') {
            const persisted = this._loadSavedServerIds(colName);
            ids.forEach(id => persisted.add(id));
            this._serverIds[colName] = persisted;
          } else {
            this._serverIds[colName] = new Set(ids);
          }
          // CRITICAL: restore _pullIds from sessionStorage (set by the real _pullAll() Firestore
          // query at session start) — NOT from all local IDs.  Local-only records (created after
          // _pullAll(), not yet pushed) must not be in _pullIds or the listener will treat their
          // absence from Firestore as "deleted on another device" and wipe them.
          this._pullIds[colName] = this._loadSavedPullIds(colName);
        }
      } catch {}
    }
    // Seed _lastDocJson fingerprints so the first save on this page doesn't
    // re-push data that's already identical to what's in Firestore.
    // Also seed _lastDocIds for array DOCUMENTS so the first delete after this
    // page load can correctly diff against the pre-delete ID set.
    for (const [lsKey, docName] of Object.entries(this.DOCUMENTS)) {
      if (this.NO_SYNC.has(lsKey)) continue;
      try {
        const raw = this._localRead(lsKey);
        if (raw && !this._lastDocJson[lsKey]) this._lastDocJson[lsKey] = raw;
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            this._lastDocIds[docName] = new Set(arr.filter(r => r && r.id).map(r => r.id));
          }
        }
      } catch {}
    }
  },

  // ── Safe local read — handles LZString-compressed data + IDB overflow ──────
  // sync.js must NEVER read localStorage directly via JSON.parse(localStorage.getItem())
  // because DB._set() compresses values with LZString.  Always use this helper.
  // For IDB-overflow keys the value lives in DB._cache (loaded by preloadFromIDB).
  _localRead(lsKey) {
    if ((typeof DB !== 'undefined')) {
      // Tauri: data lives in DB._cache (loaded from HDD), not localStorage
      if (window.IS_TAURI) {
        const v = DB._cache[lsKey];
        return (v !== null && v !== undefined) ? JSON.stringify(v) : null;
      }
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
    if ((typeof DB !== 'undefined')) DB._cache[lsKey] = data;

    // ── Tauri desktop: persist to HDD, never localStorage ────────────────────
    // Firestore-pulled data (invoices, payments, customers…) must NOT be written
    // to localStorage in the desktop app — that refills the ~5 MB budget that
    // DB.init() deliberately wiped, triggering the storage-full banner.
    // DB._cache (above) serves reads; HDD JSON files are the durable store.
    if (window.IS_TAURI) {
      // Shadow-write to sessionStorage BEFORE the async HDD write so that a
      // page navigation that happens before the HDD write completes doesn't lose
      // the data. DB._tauri.init() applies shadows on startup and clears them
      // once the HDD file is confirmed — same pattern as DB._set().
      // Without this, _pullAll() / listener writes survive in cache for the
      // current page but vanish on the next page load if navigation was fast.
      try { sessionStorage.setItem('wt_hdd_shadow_' + lsKey, JSON.stringify(data)); } catch {}
      if ((typeof DB !== 'undefined') && DB._tauri && DB._tauri.dataDir) DB._tauri.write(lsKey, data);
      return;
    }

    // Key already overflowed to IDB — write there, skip localStorage
    if ((typeof DB !== 'undefined') && DB._idbKeys && DB._idbKeys.has(lsKey)) {
      if (typeof IDB !== 'undefined') IDB.data.set(lsKey, data).catch(e => console.error('[Sync] IDB write failed', lsKey, e));
      return;
    }

    // Write plain JSON (DB._lzRead's first-char guard handles this on next read)
    try {
      localStorage.setItem(lsKey, JSON.stringify(data));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn('[Sync] localStorage full — overflowing', lsKey, '→ IndexedDB');
        if ((typeof DB !== 'undefined')) {
          DB._idbKeys.add(lsKey);
          DB._persistIdbKeys();
          DB._notifyIdbOverflow(lsKey);
        }
        if (typeof IDB !== 'undefined') IDB.data.set(lsKey, data).catch(err => console.error('[Sync] IDB write failed', lsKey, err));
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

    // ── First-session guard: clear stale doc timestamps ─────────────────────
    // _lastDocTs is persisted in localStorage across browser sessions. If another
    // device updated a doc while this tab was closed, our cached ts is stale and
    // the delta check below would silently skip that doc. Clearing it at the start
    // of each new session forces a fresh Firestore .get() for every DOCUMENT this
    // session — only ~14 extra reads per login, a negligible Firestore cost.
    try { localStorage.removeItem('wt_sync_doc_ts'); } catch {}

    // ── Cross-device deletions ───────────────────────────────────────────────
    // Pull the shared deletions doc FIRST (so the document filters below drop
    // records other devices deleted), then push our own local tombstones up
    // (covers deletes made offline / before sync was ready).
    await this._pullDeletions();
    this._flushTombstonesToFs();

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
    // (wt_sync_doc_ts was just cleared above, so this always starts as {} on a
    // new session; the delta optimisation only applies within the same session.)
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
          // For array documents (users, customers, products…) use the unified
          // apply that distinguishes remote DELETIONS from local-only additions
          // (so a delete on another device propagates and is not re-uploaded).
          if (Array.isArray(fsVal)) {
            this._applyArrayDoc(lsKey, docName, fsVal);
          } else {
            // Object document — write as-is
            this._lsWrite(lsKey, fsVal);
            if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
            this._lastDocJson[lsKey] = JSON.stringify(fsVal);
          }
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
            if (colName === 'invoices' || colName === 'payments') {
              // Archive collections: merge local IDs into the full persisted server-ID set so
              // _writeKey() can tombstone-delete records outside the archive window.
              const persisted = this._loadSavedServerIds(colName);
              ids.forEach(id => persisted.add(id));
              this._serverIds[colName] = persisted;
            } else {
              this._serverIds[colName] = new Set(ids);   // deletion detection in _writeKey()
            }
            // Restore _pullIds from sessionStorage — same logic as _seedStateFromLocalStorage().
            // Must NOT use local `ids` here: local-only records not yet in Firestore would be
            // treated as "deleted on another device" if they appear in _pullIds but not in the listener.
            this._pullIds[colName] = this._loadSavedPullIds(colName);
          }
        } catch {}
        return;
      }
      // Archive collections seed _serverIds from the persisted set (date-windowed
      // pull won't include archive ids). Other collections seed from the snapshot.
      if (colName === 'invoices' || colName === 'payments') {
        this._serverIds[colName] = this._loadSavedServerIds(colName);
      }
      // ── Date-filtered Firestore query for archive collections ─────────────────
      // Both invoices and payments are filtered to the last ARCHIVE_MONTHS to stay
      // within Firestore read quotas and page-load budgets.
      const cutoffISO = (colName === 'invoices' || colName === 'payments')
        ? new Date(Date.now() - this.ARCHIVE_MONTHS * 30.44 * 24 * 3600 * 1000).toISOString()
        : null;
      const colQuery = cutoffISO
        ? base.collection(colName).where('createdAt', '>=', cutoffISO)
        : base.collection(colName);
      try {
        const snap = await colQuery.get();
        if (!snap.empty) {
          // Cache server IDs — used by _writeKey() to tombstone deletions synchronously.
          // Archive collections: MERGE fetched IDs into the seeded persisted set (not replace)
          // so archived records outside the window remain tombstone-trackable.
          if (colName === 'invoices' || colName === 'payments') {
            snap.docs.forEach(d => this._serverIds[colName].add(d.id));
            this._saveServerIds(colName);
          } else {
            this._serverIds[colName] = new Set(snap.docs.map(d => d.id));
          }
          // Cache pull IDs — used by listener to tell "new this session" from "deleted on another device".
          // Also persist to sessionStorage so _seedStateFromLocalStorage() can restore the exact same set
          // on subsequent page navigations (instead of re-computing from all local IDs, which would
          // incorrectly include local-only records not yet pushed to Firestore).
          this._pullIds[colName] = new Set(snap.docs.map(d => d.id));
          this._savePullIds(colName);
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
            console.log(`[Sync] _pullAll merge ${colName}: local=${localArr.length} fs=${snap.docs.length}`);
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
                const isArchive = (colName === 'invoices' || colName === 'payments');
                // SAFE policy for _pullAll merge (no data loss, no resurrection):
                //   • Archive collections (invoices/payments): records that were on
                //     the server (in knownServerIds) but outside the date window are
                //     KEPT locally; genuinely-new ones are pushed.
                //   • Non-archive collections (customers, …): KEEP every local-only
                //     record locally, but NEVER re-upload it from the pull. Re-
                //     uploading was what resurrected deleted records on other
                //     devices ("delete comes back"). A genuinely-new record is
                //     pushed by its own DB._set→push, so we lose nothing. The
                //     real-time listener (pullIds-based) removes records actually
                //     deleted on another device. We never DROP here, so a transient
                //     or partial snapshot can never wipe local data.
                let toSync, toKeepLocal;
                if (isArchive) {
                  toSync      = localOnly.filter(r => !knownServerIds.has(r.id));
                  toKeepLocal = localOnly.filter(r =>  knownServerIds.has(r.id));
                  for (const rec of toSync) {
                    try { await base.collection(colName).doc(rec.id).set({ ...rec, _by: this._deviceId, _ts: Date.now() }); this._serverIds[colName].add(rec.id); } catch {}
                  }
                  if (toSync.length) this._saveServerIds(colName);
                } else {
                  toSync = [];
                  toKeepLocal = localOnly;   // keep all locally, never re-upload from a pull
                }
                console.log(`[Sync] Merge ${colName}: kept ${toKeepLocal.length} local${isArchive ? ', pushed ' + toSync.length : ' (no re-upload)'}`);
                const merged = [...fsArr, ...toSync, ...toKeepLocal];
                this._lsWrite(lsKey, merged);
                if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
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
          if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
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
            // CRITICAL: seed _pullIds with the bootstrapped ids. These records now
            // exist in Firestore (just pushed), so they ARE "present at session
            // start". Without this the listener treats every record as new-this-
            // session and re-adds any that another device deletes → deletes never
            // propagate on the bootstrap session (the customers_v2 migration case).
            const ids = new Set((Array.isArray(localArr) ? localArr : []).filter(r => r && r.id).map(r => r.id));
            this._serverIds[colName] = new Set(ids);
            this._pullIds[colName]   = new Set(ids);
            this._savePullIds(colName);
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

    // ── Real-time deletions listener ─────────────────────────────────────────
    // When another device deletes a record it writes to data/_deletions. Merge
    // those IDs into the local tombstone store and immediately filter them out
    // of the affected local DOCUMENT arrays so the deletion shows up live
    // (no refresh needed) and is never re-uploaded.
    const unsubDel = this._fsDeletionsRef().onSnapshot((doc) => {
      if (!doc.exists || !doc.data() || !doc.data().d) return;
      const delByName = doc.data().by === this._deviceId ? null : doc.data().byName;
      const affected = this._mergeDeletionsLocal(doc.data().d);
      if (!affected.size) return;
      // Map docName → lsKey so we can rewrite the local array
      const docToLs = {};
      // Skip NO_SYNC keys (wt_activity/wt_logins): legacy deletion tombstones for
      // activity_log/login_log (written by old builds before _recordDocDeletions
      // guarded NO_SYNC) must NOT filter local logs — that wiped all logs after
      // sign-in. Logs are local-only; the deletions machinery never touches them.
      for (const [lsKey, dn] of Object.entries(this.DOCUMENTS)) {
        if (this.NO_SYNC.has(lsKey)) continue;
        docToLs[dn] = lsKey;
      }
      let anyChange = false;
      affected.forEach(name => {
        const lsKey = docToLs[name];
        if (!lsKey) return;
        try {
          const arr = JSON.parse(this._localRead(lsKey) || '[]');
          if (!Array.isArray(arr)) return;
          const filtered = this._filterArrayTombstones(name, arr);
          if (filtered.length !== arr.length) {
            // Toast the records being removed (only for OTHER devices' deletes)
            if (delByName) {
              const removed = arr.filter(r => r && r.id && !filtered.some(f => f.id === r.id));
              removed.slice(0, 3).forEach(r => this._activityToast({
                typeKey: name, action: 'del', name: this._recordName(name, r), byName: delByName,
              }));
            }
            this._lsWrite(lsKey, filtered);
            if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
            this._lastDocJson[lsKey] = JSON.stringify(filtered);
            this._lastDocIds[name] = new Set(filtered.filter(r => r && r.id).map(r => r.id));
            anyChange = true;
          }
        } catch {}
      });
      if (anyChange) {
        window.dispatchEvent(new CustomEvent('sync:updated'));
        window.dispatchEvent(new CustomEvent('sync:pulled'));
      }
    }, (err) => console.warn('[Sync] deletions listener:', err.code, err.message));
    this._unsubscribers.push(unsubDel);

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

            // Update cached server timestamp so the delta skip in the next _pullAll()
            // stays accurate.  Without this, _lastDocTs holds the ts from the last
            // .get() call — if another device updated the document in the meantime the
            // listener would update localStorage but _lastDocTs would remain stale,
            // causing the next page-load's _pullAll() to incorrectly skip the document.
            const _listenerDocTs = doc.data().ts?.toDate?.()?.getTime?.() ?? 0;
            if (_listenerDocTs > 0) {
              try {
                const _allDocTs = JSON.parse(localStorage.getItem('wt_sync_doc_ts') || '{}');
                _allDocTs[docName] = _listenerDocTs;
                localStorage.setItem('wt_sync_doc_ts', JSON.stringify(_allDocTs));
              } catch {}
            }

            const fsVal = doc.data().d;
            const byName = doc.data().byName;

            if (Array.isArray(fsVal)) {
              // Diff incoming vs current local (BEFORE applying) to show activity
              // toasts: records newly present = add, content-changed = edit.
              let localBefore = [];
              try { localBefore = JSON.parse(this._localRead(lsKey) || '[]'); } catch {}
              const beforeById = new Map((Array.isArray(localBefore) ? localBefore : [])
                .filter(r => r && r.id).map(r => [r.id, JSON.stringify(r)]));

              const before = this._lastDocJson[lsKey];
              const result = this._applyArrayDoc(lsKey, docName, fsVal);
              const after  = JSON.stringify(result);
              if (after !== before) {
                // Emit toasts for adds/edits coming from the other device (cap 3)
                const changes = [];
                for (const r of fsVal) {
                  if (!r || !r.id) continue;
                  const prev = beforeById.get(r.id);
                  if (prev === undefined) changes.push({ action: 'add', rec: r });
                  else if (prev !== JSON.stringify(r)) changes.push({ action: 'edit', rec: r });
                  if (changes.length >= 3) break;
                }
                changes.forEach(c => this._activityToast({
                  typeKey: docName, action: c.action,
                  name: this._recordName(docName, c.rec), byName,
                }));
                this._notifyUpdate(lsKey);
              }
              return;
            }

            // Object document — skip if unchanged, else write.
            const freshDocJson = JSON.stringify(fsVal);
            if (this._lastDocJson[lsKey] === freshDocJson) return;
            this._lastDocJson[lsKey] = freshDocJson;
            this._lsWrite(lsKey, fsVal);
            if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
            this._notifyUpdate(lsKey);
          },
          (err) => console.error('[Sync] Doc listener error:', docName, err.code, err.message)
        );
      this._unsubscribers.push(unsub);
    }

    // Listen to collection keys
    for (const [lsKey, colName] of Object.entries(this.COLLECTIONS)) {
      // ── Archive collections: apply the same ARCHIVE_MONTHS window used in _pullAll() ──
      // Without this, the very first live snapshot delivers ALL historical records and
      // overwrites localStorage — completely bypassing the date-filtered _pullAll().
      // Both the pull query and the listener must use the same cutoff so they stay in sync.
      const listenerCutoffISO = (colName === 'invoices' || colName === 'payments')
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
          // Does this snapshot contain records we DON'T have locally? If so we are
          // MISSING data (e.g. a device whose list is empty while the server has
          // records). Applying missing records is pure addition (union) — always
          // safe — so we bypass the initial ignore-window and the fromCache guard
          // in that case, otherwise an empty device never populates from the server.
          let _hasMissing = false;
          try {
            const _localIds = new Set(JSON.parse(this._localRead(lsKey) || '[]').filter(r => r && r.id).map(r => r.id));
            _hasMissing = snap.docs.some(d => !_localIds.has(d.id));
          } catch {}
          if (!_hasMissing && shouldSkip(lsKey)) return;
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
          if (!_hasMissing && !snap.metadata.hasPendingWrites && snap.metadata.fromCache) {
            console.log(`[Sync] Col listener skip: fromCache snapshot for ${colName} (stale cache guard)`);
            return;
          }
          // Skip delayed echo: all changed docs were written by this device.
          // The time-based _ignoreUntil window can be too short when Firestore
          // queues a snapshot before our write but delivers it after the window
          // expires — this would restore a just-cancelled/deleted record.
          const docChanges = snap.docChanges();
          if (docChanges.length > 0 && docChanges.every(c => c.doc.data()?._by === this._deviceId)) return;
          // EXPLICIT removals: ids Firestore reports as type:"removed" were deleted
          // on the server. Remove them locally unconditionally — this is a reliable
          // signal (unlike the pullIds inference below, which fails to recognise a
          // delete when pullIds is missing the id, leaving the record on screen).
          // Only honor removals from a SERVER snapshot — a fromCache snapshot can
          // report spurious removals from a stale/incomplete cache.
          const removedIds = snap.metadata.fromCache ? new Set() : new Set(
            docChanges.filter(c => c.type === 'removed').map(c => c.doc.id)
          );
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
              const localOnly = localArr.filter(r => {
                if (!r.id || fsIds.has(r.id)) return false;
                if (removedIds.has(r.id)) return false;   // explicitly deleted on the server → drop
                if (stones[r.id] && now - stones[r.id] <= this._tombstoneTTL) return false;
                // Records OUTSIDE the archive window will never appear in this date-filtered
                // listener query — their absence is not a deletion signal, always keep them.
                if (listenerCutoffISO && (r.createdAt || '') < listenerCutoffISO) return true;
                // A fromCache snapshot can be stale/incomplete: right after a save,
                // hasPendingWrites bypasses the fromCache skip guard above, and on a
                // flapping connection (the "connecting" badge) the SDK cache may hold
                // only a subset of the server data (observed: 37 of 95 payments).
                // Treating absence-from-cache as "deleted on another device" dropped
                // the other records from local → invoices flipped paid→unpaid on
                // screen instantly after saving. Only a SERVER snapshot
                // (fromCache:false) is authoritative enough for that inference.
                if (snap.metadata.fromCache) return true;
                // For records inside the query window: only keep if added THIS session
                // (not in pullIds).  Records in pullIds that are missing from Firestore
                // were deleted on another device.
                return !pullIds.has(r.id);
              });
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
          if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
          // Suppress the toast on the very first server snapshot after the listener
          // attaches.  Firestore always reports every existing document as type:"added"
          // in docChanges() on the initial delivery — so docChanges().length > 0 is
          // always true even when nothing actually changed.  Only show the toast once
          // the listener is "seeded" (i.e. after the first snapshot has been processed).
          if (snap.docChanges().length > 0) {
            if (!this._listenerSeeded[colName]) {
              this._listenerSeeded[colName] = true; // mark seeded — next real change will toast
            } else {
              // Activity toasts for changes from OTHER devices (cap 3)
              let shown = 0;
              for (const ch of snap.docChanges()) {
                if (shown >= 3) break;
                const rec = ch.doc.data();
                if (!rec || rec._by === this._deviceId) continue;     // skip our own echo
                if (ch.doc.metadata.hasPendingWrites) continue;
                const action = ch.type === 'added' ? 'add' : ch.type === 'removed' ? 'del' : 'edit';
                this._activityToast({ typeKey: colName, action,
                  name: this._recordName(colName, rec), byName: rec._byName });
                shown++;
              }
              this._notifyUpdate(lsKey);
            }
          }
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
    this._emitUploadState();
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
        // After a successful Firestore write, bring local cache in sync with
        // what was just pushed.  Without this, _pullAll()'s merge logic reads
        // the stale pre-flush cache, sees the deleted record as "local-only",
        // and merges it back into the Firestore document — undoing the delete.
        this._lsWrite(key, val);
      } catch (e) {
        console.warn('[Sync] pre-flush error:', key, e.message);
        return; // stop on error, queue stays intact for _flushQueue()
      }
    }
    localStorage.removeItem(this._pendingLsKey);
    this._emitUploadState();
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
    this._emitUploadState();
    console.log('[Sync] Queue flushed ✓');
  },

  // Force every pending debounced write to commit NOW and wait for it, then drain
  // the offline queue. Called by Auth.logout() so a just-recorded payment can't be
  // lost when the next login does a fresh full pull. Time-boxed so it never hangs
  // logout — anything not committed in time is enqueued (and flushed next login).
  async flushNow() {
    const writes = [];
    const grab = (key) => (typeof DB !== 'undefined' && DB._cache[key] !== undefined) ? DB._cache[key] : null;
    for (const key of Object.keys(this._pushDebounce)) {
      if (this._pushDebounce[key] != null) {
        clearTimeout(this._pushDebounce[key]); this._pushDebounce[key] = null;
        const fresh = grab(key);
        if (fresh != null) {
          this._pendingWrite[key] = true;
          writes.push(this._writeKey(key, fresh)
            .then(() => { this._pendingWrite[key] = false; })
            .catch(() => { this._pendingWrite[key] = false; this._enqueue(key, fresh); }));
        }
      }
    }
    for (const key of Object.keys(this._docDebounce)) {
      if (this._docDebounce[key] != null) {
        clearTimeout(this._docDebounce[key]); this._docDebounce[key] = null;
        const fresh = grab(key);
        if (fresh != null) writes.push(this._writeKey(key, fresh).catch(() => this._enqueue(key, fresh)));
      }
    }
    this._emitUploadState();
    const timeout = (ms) => new Promise(r => setTimeout(r, ms));
    try { await Promise.race([Promise.all(writes), timeout(8000)]); } catch {}
    try { if (this.ready && this._online) await Promise.race([this._flushQueue(), timeout(5000)]); } catch {}
    this._emitUploadState();
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

  // ── Activity toasts ────────────────────────────────────────────────────────
  // Friendly name of THIS device, shown to other devices as the source of a
  // change. Set in Settings ("ชื่อเครื่องนี้"); stored in localStorage
  // (device-local, not synced, kept across the Tauri wipe). Falls back to the OS/platform label.
  _deviceName() {
    try {
      // Read directly from localStorage (kept across the Tauri wipe) — same source
      // as settings.js load/saveDeviceLabel, timing-free.
      const n = localStorage.getItem('wt_device_label') || '';
      if (n && typeof n === 'string') return n;
    } catch {}
    if (window.IS_TAURI) return 'เครื่องเดสก์ท็อป';
    return (location.hostname || 'อุปกรณ์');
  },

  _ACTIVITY_TYPE: {
    customers:    { label: 'ลูกค้า',      icon: 'bi-people' },
    customers_v2: { label: 'ลูกค้า',      icon: 'bi-people' },
    users_cfg:  { label: 'ผู้ใช้',         icon: 'bi-person-gear' },
    products:   { label: 'สินค้า',        icon: 'bi-box-seam' },
    pricing:    { label: 'ราคา',          icon: 'bi-tag' },
    price_history: { label: 'ประวัติราคา', icon: 'bi-tag' },
    versions:   { label: 'ฉลากขวด',       icon: 'bi-tag' },
    invoices:   { label: 'ใบกำกับ',        icon: 'bi-receipt' },
    payments:   { label: 'การชำระเงิน',    icon: 'bi-cash-coin' },
    returns:    { label: 'คืนสินค้า',      icon: 'bi-arrow-return-left' },
  },
  _ACTIVITY_ACTION: {
    add:  { verb: 'เพิ่ม',  color: '#37c871', icon: 'bi-plus-circle' },
    edit: { verb: 'แก้ไข', color: '#4f8cff', icon: 'bi-pencil' },
    del:  { verb: 'ลบ',    color: '#ff5c6c', icon: 'bi-trash' },
  },

  // Display name for a record of the given type.
  _recordName(typeKey, rec) {
    if (!rec) return '';
    switch (typeKey) {
      case 'customers':
      case 'customers_v2': return rec.name || rec.shopName || rec.id || '';
      case 'users_cfg': return rec.name || rec.username || rec.id || '';
      case 'products':  return rec.name || rec.id || '';
      case 'pricing':   return rec.customerName || rec.name || rec.id || '';
      case 'price_history': {
        // Price-history rows have no name field — resolve product/customer to
        // real names (was showing the raw UUID in the toast).
        try {
          const p = (typeof DB !== 'undefined') ? DB.getProductById(rec.productId) : null;
          const c = (typeof DB !== 'undefined' && rec.customerId) ? DB.getCustomerById(rec.customerId) : null;
          const nm = (p && p.name) || rec.productId || '';
          const cn = (c && c.name) ? ' (' + c.name + ')' : '';
          const pr = (rec.price != null) ? ' ' + Number(rec.price).toLocaleString('th-TH') + '฿' : '';
          return (nm + cn + pr).trim() || rec.id || '';
        } catch { return rec.id || ''; }
      }
      case 'versions':  return rec.name || rec.colorName || rec.id || '';
      case 'invoices':  return '#' + (rec.invoiceNumber || rec.id || '');
      case 'payments':  return (rec.amount != null ? Number(rec.amount).toLocaleString('th-TH') + ' บาท' : (rec.id || ''));
      default:          return rec.name || rec.id || '';
    }
  },

  // Cross-device activity toast. Routes through Utils.showToast so it shares the
  // same style/position as all other toasts (top-right, under the nav bar).
  // action ∈ add|edit|del → success|info|danger color.
  _activityToast({ typeKey, action, name, byName }) {
    try {
      const T = this._ACTIVITY_TYPE[typeKey] || { label: typeKey, icon: 'bi-arrow-repeat' };
      const A = this._ACTIVITY_ACTION[action] || this._ACTIVITY_ACTION.edit;
      const toastType = action === 'add' ? 'success' : action === 'del' ? 'danger' : 'info';
      const who = byName ? ` · ${this._esc(byName)}` : '';
      const msg = `<i class="bi ${T.icon} me-1"></i><strong>${A.verb}${T.label}</strong>`
                + (name ? `: ${this._esc(name)}` : '')
                + `<span style="opacity:.75;font-size:.85em">${who}</span>`;
      if (window.Utils && Utils.showToast) Utils.showToast(msg, toastType);
    } catch (e) { console.warn('[Sync] activity toast failed:', e.message); }
  },
  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); },

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
    // Only show toasts on pages that explicitly list the key.
    // Any page NOT listed here (login, invoice-create, settings, etc.) gets no toasts.
    const PAGE_KEYS = {
      'invoices.html':  ['wt_invoices'],
      'payments.html':  ['wt_invoices', 'wt_payments'],
      'returns.html':   ['wt_returns'],
      'products.html':  ['wt_products', 'wt_pricing'],
      'customers.html': ['wt_customers'],
      'dashboard.html': ['wt_invoices', 'wt_payments'],
    };
    void label; void page; void PAGE_KEYS;  // (kept for reference; rich activity toasts replace the old generic toast)

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
      if ((typeof DB !== 'undefined')) DB.invalidate(lsKey);
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
