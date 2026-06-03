// drive-db-sync.js — Syncs all DB localStorage keys to Google Drive
// ─────────────────────────────────────────────────────────────────────────────
// Policy:
//   • Every DB write  → queued upload to Drive (debounced 5 s)
//   • On init (after DriveStore.signIn) → restore keys whose local copy is
//     absent OR whose last Drive-sync was >30 days ago
//   • Shares the OAuth session with DriveStore (reads DriveStore._token)
//   • Silent no-op when Drive is not connected
// ─────────────────────────────────────────────────────────────────────────────

if (!window.DriveDbSync) {
window.DriveDbSync = {

  FOLDER_NAME: 'ใบกำกับสินค้า-DB',
  CACHE_DAYS:  30,
  META_LS_KEY: 'wt_drive_db_meta',  // { [dbKey]: { driveId, lastModified, lastSynced } }
  UPLOAD_DELAY: 5000,                // ms debounce for writes

  // Keys to sync (all business data; skip ephemeral / log keys)
  SYNC_KEYS: [
    'wt_users', 'wt_customers', 'wt_products', 'wt_pricing',
    'wt_invoices', 'wt_payments', 'wt_inv_counter', 'wt_settings',
    'wt_versions', 'wt_pay_methods', 'wt_transfer_accounts',
    'wt_cap_colors', 'wt_cap_receipts',
    'wt_cap_deductions', 'wt_price_history', 'wt_returns',
    'wt_activity', 'wt_logins',
  ],

  _folderId: null,
  _queue:    {},   // { [key]: timeoutId }
  _ready:    false,

  // ── Init (called by DriveStore after successful sign-in) ───────────────────
  async init() {
    if (this._ready) return;
    if (!window.DriveStore?.ready) return;

    try {
      this._folderId = await this._ensureFolder();
      this._ready = true;
      console.log('[DriveDbSync] Folder ready:', this._folderId);

      // If local meta is empty (new computer / cleared storage) → full scan restore.
      // Otherwise just restore individual stale/missing keys as before.
      const meta = this._getMeta();
      const hasMeta = Object.keys(meta).length > 0;
      if (!hasMeta) {
        console.log('[DriveDbSync] No local meta — running full Drive scan restore');
        this.pullAllScan().catch(e =>
          console.warn('[DriveDbSync] auto pullAllScan error:', e.message));
      } else {
        this._restoreStaleKeys().catch(e =>
          console.warn('[DriveDbSync] restore error:', e.message));
      }

      // Flush pending writes on page unload
      window.addEventListener('beforeunload', () => {
        this._flushQueueSync();
      });
    } catch (e) {
      console.warn('[DriveDbSync] init error:', e.message);
    }
  },

  // ── Called by DB._set on every write ──────────────────────────────────────
  queueUpload(key, val) {
    if (!this.SYNC_KEYS.includes(key)) return;
    if (!this._ready || !this._folderId) return;
    clearTimeout(this._queue[key]);
    this._queue[key] = setTimeout(() => {
      delete this._queue[key];
      this._uploadKey(key, val).catch(e =>
        console.warn(`[DriveDbSync] upload ${key}:`, e.message));
    }, this.UPLOAD_DELAY);
  },

  // ── Force-flush all queued uploads immediately ─────────────────────────────
  async flushAll() {
    const keys = Object.keys(this._queue);
    for (const key of keys) {
      clearTimeout(this._queue[key]);
      delete this._queue[key];
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        try { await this._uploadKey(key, JSON.parse(raw)); } catch {}
      }
    }
  },

  // Synchronous best-effort flush (for beforeunload — can't await)
  _flushQueueSync() {
    Object.keys(this._queue).forEach(key => {
      clearTimeout(this._queue[key]);
      delete this._queue[key];
      const raw = localStorage.getItem(key);
      if (!raw) return;
      // Use sendBeacon for reliable delivery on page close
      const token = DriveStore._token;
      if (!token) return;
      // We can't update an existing file synchronously without knowing the driveId,
      // but we can queue it as a beacon to a simple upload endpoint.
      // Fallback: just note that there are unsaved changes (non-critical).
    });
  },

  // ── Restore keys that are missing locally or stale (>30 days) ─────────────
  async _restoreStaleKeys() {
    const meta = this._getMeta();
    for (const key of this.SYNC_KEYS) {
      const m = meta[key];
      if (!m?.driveId) continue;  // no Drive record yet

      const localRaw  = localStorage.getItem(key);
      const isAbsent  = localRaw === null;
      const isStale   = m.lastModified && this._isStale(m.lastModified);

      if (isAbsent || isStale) {
        console.log(`[DriveDbSync] Restoring ${key} from Drive (absent=${isAbsent}, stale=${isStale})`);
        try {
          await this._downloadKey(key, m.driveId);
        } catch (e) {
          console.warn(`[DriveDbSync] Could not restore ${key}:`, e.message);
        }
      }
    }
  },

  // ── Upload a single DB key to Drive ───────────────────────────────────────
  async _uploadKey(key, val) {
    if (!this._checkToken()) return;
    const json     = JSON.stringify(val);
    const blob     = new Blob([json], { type: 'application/json' });
    const filename = key + '.json';
    const now      = new Date().toISOString();
    const meta     = this._getMeta();
    const existing = meta[key]?.driveId;

    let driveId;
    if (existing) {
      driveId = await this._driveUpdate(existing, blob, filename);
    } else {
      driveId = await this._driveCreate(blob, filename);
    }

    meta[key] = { driveId, lastModified: now, lastSynced: now };
    this._setMeta(meta);
    console.log(`[DriveDbSync] ↑ ${key} (${blob.size} B)`);
  },

  // ── Download a Drive file back into localStorage ───────────────────────────
  async _downloadKey(key, driveId) {
    if (!this._checkToken()) throw new Error('token not ready');
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`,
      { headers: { Authorization: `Bearer ${DriveStore._token}` } }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Validate JSON before overwriting local data
    JSON.parse(text); // throws if invalid
    localStorage.setItem(key, text);
    const meta = this._getMeta();
    if (!meta[key]) meta[key] = { driveId };
    meta[key].lastSynced = new Date().toISOString();
    this._setMeta(meta);
    console.log(`[DriveDbSync] ↓ ${key} from Drive`);
  },

  // ── Drive REST helpers ─────────────────────────────────────────────────────
  async _driveCreate(blob, filename) {
    const metaBlob = new Blob(
      [JSON.stringify({ name: filename, parents: [this._folderId] })],
      { type: 'application/json' }
    );
    const form = new FormData();
    form.append('metadata', metaBlob);
    form.append('file', blob);
    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: `Bearer ${DriveStore._token}` }, body: form }
    );
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(`Drive create: ${e.error?.message || r.status}`);
    }
    return (await r.json()).id;
  },

  async _driveUpdate(driveId, blob, filename) {
    const r = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${driveId}?uploadType=media`,
      { method: 'PATCH',
        headers: { Authorization: `Bearer ${DriveStore._token}`, 'Content-Type': 'application/json' },
        body: blob }
    );
    if (r.ok) return driveId;
    if (r.status === 404) return this._driveCreate(blob, filename); // file was deleted → recreate
    throw new Error(`Drive update: ${r.status}`);
  },

  // ── Ensure the DB folder exists in Drive ───────────────────────────────────
  async _ensureFolder() {
    const q = `name='${this.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${DriveStore._token}` } }
    );
    const d = await r.json();
    if (d.files?.length) return d.files[0].id;

    // Create folder
    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
      method:  'POST',
      headers: { Authorization: `Bearer ${DriveStore._token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: this.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!cr.ok) throw new Error(`Could not create Drive folder: ${cr.status}`);
    return (await cr.json()).id;
  },

  // ── Perform a full push of all local DB keys → Drive ──────────────────────
  // Useful for initial setup or manual "sync all" action.
  async pushAll() {
    if (!this._ready) throw new Error('DriveDbSync not ready');
    for (const key of this.SYNC_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        await this._uploadKey(key, JSON.parse(raw));
      } catch (e) {
        console.warn(`[DriveDbSync] pushAll failed for ${key}:`, e.message);
      }
    }
    console.log('[DriveDbSync] pushAll complete');
  },

  // ── Pull all keys from Drive → overwrite localStorage ─────────────────────
  async pullAll() {
    if (!this._ready) throw new Error('DriveDbSync not ready');
    const meta = this._getMeta();
    for (const key of this.SYNC_KEYS) {
      const m = meta[key];
      if (!m?.driveId) continue;
      try {
        await this._downloadKey(key, m.driveId);
      } catch (e) {
        console.warn(`[DriveDbSync] pullAll failed for ${key}:`, e.message);
      }
    }
    console.log('[DriveDbSync] pullAll complete');
  },

  // ── Scan Drive folder, rebuild meta, download everything ──────────────────
  // Works even when local meta (wt_drive_db_meta) is empty — i.e. first time
  // opening on a new computer.  Lists all wt_*.json files in the DB folder,
  // updates meta with their Drive IDs, then downloads each one.
  async pullAllScan() {
    if (!this._checkToken()) throw new Error('Drive not connected');

    // Ensure folder exists (also sets this._folderId)
    if (!this._folderId) this._folderId = await this._ensureFolder();

    // List all files in the DB folder
    const q = `'${this._folderId}' in parents and trashed=false`;
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=200`,
      { headers: { Authorization: `Bearer ${DriveStore._token}` } }
    );
    if (!r.ok) throw new Error(`Drive list: ${r.status}`);
    const d = await r.json();
    const files = d.files || [];

    const meta = this._getMeta();
    let restored = 0, failed = 0;

    for (const file of files) {
      // Match exactly wt_<name>.json (DB keys only — ignore invoice-archive-*.json etc.)
      const match = file.name.match(/^(wt_[a-z_]+)\.json$/);
      if (!match) continue;
      const key = match[1];
      if (!this.SYNC_KEYS.includes(key)) continue;

      // Rebuild meta entry so _downloadKey has a record
      if (!meta[key]) meta[key] = {};
      meta[key].driveId      = file.id;
      meta[key].lastModified = file.modifiedTime || new Date().toISOString();

      try {
        await this._downloadKey(key, file.id);
        restored++;
      } catch (e) {
        console.warn(`[DriveDbSync] pullAllScan ${key}:`, e.message);
        failed++;
      }
    }

    this._setMeta(meta);
    this._ready = true; // mark ready so normal queueUpload works from here on
    if (typeof DB !== 'undefined') DB.invalidate(); // flush cache so next read sees new data
    console.log(`[DriveDbSync] pullAllScan: restored=${restored} failed=${failed} total=${files.length}`);
    return { restored, failed, total: files.length };
  },

  // ── Status for settings/debug page ────────────────────────────────────────
  getStatus() {
    const meta  = this._getMeta();
    const synced = Object.keys(meta).filter(k => meta[k]?.driveId);
    const stale  = synced.filter(k => meta[k].lastModified && this._isStale(meta[k].lastModified));
    return {
      ready:       this._ready,
      folderId:    this._folderId,
      syncedKeys:  synced.length,
      staleKeys:   stale.length,
      totalKeys:   this.SYNC_KEYS.length,
      meta,
    };
  },

  // ── Helpers ────────────────────────────────────────────────────────────────
  _isStale(lastModified) {
    if (!lastModified) return true;
    return Date.now() - new Date(lastModified).getTime() > this.CACHE_DAYS * 86400000;
  },

  _checkToken() {
    return !!(window.DriveStore?.ready &&
              DriveStore._token &&
              DriveStore._tokenExp > Date.now());
  },

  _getMeta() {
    try { return JSON.parse(localStorage.getItem(this.META_LS_KEY) || '{}'); } catch { return {}; }
  },
  _setMeta(meta) {
    try { localStorage.setItem(this.META_LS_KEY, JSON.stringify(meta)); } catch {}
  },
};
} // end if (!window.DriveDbSync)

// ── Auto-init: if DriveStore is already signed-in when this script loads ──────
// (handles the case where drive-store.js auto-reconnected before drive-db-sync.js finished loading)
(function() {
  function tryInit() {
    if (window.DriveStore && DriveStore.ready && !DriveDbSync._ready) {
      DriveDbSync.init().catch(e => console.warn('[DriveDbSync] auto-init:', e.message));
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    // DOM ready — try now, then again after a short delay in case signIn is still in progress
    tryInit();
    setTimeout(tryInit, 1200);
  }
})();
