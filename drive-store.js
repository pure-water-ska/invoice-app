// drive-store.js — Google Drive file storage + local IndexedDB cache
// ─────────────────────────────────────────────────────────────────────────────
// ต้องการ: drive-config.js (มี GOOGLE_CLIENT_ID)
// ถ้าไม่มี → ทำงานเป็น no-op, ไม่กระทบระบบเดิม
//
// หลักการ:
//   • อัปโหลดทุกไฟล์ → Google Drive (folder "ใบกำกับสินค้า-Files")
//   • ไฟล์ ≤ 30 วัน  → cache ไว้ใน IndexedDB ด้วย (เปิดเร็ว, ออฟไลน์ได้)
//   • ไฟล์ > 30 วัน  → โหลดจาก Drive เมื่อต้องการ
//   • metadata        → localStorage "wt_drive_files"
// ─────────────────────────────────────────────────────────────────────────────

// Guarded + attached to window so it survives a double <script> load (some pages
// include drive-store.js statically; nav.js also loads it on every page) and so
// `window.DriveStore` checks (nav.js connection modal) actually see it.
if (!window.DriveStore) {
window.DriveStore = {
  ready:        false,
  _clientId:    null,
  _tokenClient: null,
  _token:       null,
  _tokenExp:    0,
  _folderId:    null,
  _idb:         null,

  FOLDER_NAME: 'ใบกำกับสินค้า-Files',
  CACHE_DAYS:  30,
  SCOPE:       'https://www.googleapis.com/auth/drive.file',
  IDB_NAME:    'wt_drive_v1',
  IDB_STORE:   'files',
  LS_KEY:      'wt_drive_files',

  // ── Initialize ─────────────────────────────────────────────────────────────
  async init() {
    // Google Drive OAuth uses web origins (https:// / http://). The Tauri desktop
    // app runs on tauri://localhost which Google rejects — skip Drive entirely.
    if (location.protocol === 'tauri:') return;

    // อ่าน GOOGLE_CLIENT_ID จาก window scope (โหลดจาก drive-config.js)
    const cid = (typeof GOOGLE_CLIENT_ID !== 'undefined') ? GOOGLE_CLIENT_ID : '';
    if (!cid || !cid.includes('.apps.')) {
      // ไม่มี config → silent no-op
      return;
    }
    this._clientId = cid;

    try {
      await this._openIDB();
      await this._cleanCache();
      await this._loadGIS();
      this._badge('offline');

      const wasSignedIn = localStorage.getItem('wt_drive_signed_in') === '1';
      if (wasSignedIn) {
        // Try restoring token from localStorage first — avoids OAuth popup on every page
        const cachedTok = localStorage.getItem('wt_dr_tok');
        const cachedExp = parseInt(localStorage.getItem('wt_dr_exp') || '0');
        const cachedFid = localStorage.getItem('wt_dr_fid');
        if (cachedTok && cachedExp > Date.now() + 30000) {
          try {
            this._token    = cachedTok;
            this._tokenExp = cachedExp;
            this._folderId = cachedFid || await this._ensureFolder();
            this.ready = true;
            this._badge('online');
            this._saveSignInState(true);
            if (window.DriveDbSync) DriveDbSync.init().catch(e => console.warn('[DriveDbSync]', e.message));
            console.log('[DriveStore] Restored from session cache ✓');
          } catch (e) {
            console.warn('[DriveStore] Session restore error:', e.message);
            this._tryReAuth();
          }
        } else {
          // Token expired or missing → full re-auth
          this._tryReAuth();
        }
      } else {
        // ยังไม่เคย sign-in → แสดง banner ให้กดเชื่อมต่อ
        this._showConnectBanner();
        console.log('[DriveStore] Initialized (not signed in yet)');
      }
    } catch (e) {
      console.warn('[DriveStore] init error:', e.message);
    }
  },

  // ── Sign In (shows Google popup) ───────────────────────────────────────────
  async signIn() {
    // อ่านค่าใหม่อีกครั้ง เผื่อ init() รันก่อน drive-config.js โหลดเสร็จ
    if (!this._clientId) {
      const cid = (typeof GOOGLE_CLIENT_ID !== 'undefined') ? GOOGLE_CLIENT_ID : '';
      if (cid && cid.includes('.apps.')) {
        this._clientId = cid;
        // init IDB/GIS ถ้ายังไม่ได้ทำ
        if (!this._idb) await this._openIDB();
        await this._loadGIS();
      } else {
        throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID — สร้างไฟล์ drive-config.js ก่อน');
      }
    }
    await this._loadGIS();

    // ซ่อน banner ระหว่าง sign-in
    const banner = document.getElementById('driveConnectBanner');
    if (banner) banner.remove();

    // ถ้าเคย authorize แล้ว → prompt:'' = ใช้ consent เดิม ไม่ต้องกด popup
    // ถ้าครั้งแรก → prompt:'consent' = แสดง consent screen
    const wasSignedIn = localStorage.getItem('wt_drive_signed_in') === '1';
    const promptMode  = wasSignedIn ? '' : 'consent';

    return new Promise((resolve, reject) => {
      this._tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this._clientId,
        scope:     this.SCOPE,
        callback:  async (resp) => {
          if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
          this._token    = resp.access_token;
          this._tokenExp = Date.now() + (parseInt(resp.expires_in) - 60) * 1000;
          // Cache token for this browser session so page navigations don't re-trigger OAuth
          try {
            localStorage.setItem('wt_dr_tok', this._token);
            localStorage.setItem('wt_dr_exp', String(this._tokenExp));
          } catch {}
          try {
            this._folderId = await this._ensureFolder();
            try { localStorage.setItem('wt_dr_fid', this._folderId); } catch {}
            this.ready = true;
            this._badge('online');
            this._saveSignInState(true);
            console.log('[DriveStore] Signed in ✓ folder:', this._folderId);
            // Init DB sync layer (load drive-db-sync.js if not yet loaded)
            if (window.DriveDbSync) {
              DriveDbSync.init().catch(e => console.warn('[DriveDbSync]', e.message));
            }
            resolve();
          } catch (e) { reject(e); }
        },
        error_callback: (e) => reject(new Error(e.type || 'OAuth error')),
      });
      this._tokenClient.requestAccessToken({ prompt: promptMode });
    });
  },

  // ── Sign Out ───────────────────────────────────────────────────────────────
  signOut() {
    if (this._token) {
      try { google.accounts.oauth2.revoke(this._token); } catch {}
    }
    this._token = null; this._tokenExp = 0;
    this._folderId = null; this.ready = false;
    this._badge('offline');
    this._saveSignInState(false);
    try { localStorage.removeItem('wt_dr_tok'); localStorage.removeItem('wt_dr_exp'); localStorage.removeItem('wt_dr_fid'); } catch {}
    this._showConnectBanner();
    console.log('[DriveStore] Signed out');
  },

  // ── Background re-auth (silent, no user-visible popup when prompt='') ──────
  _tryReAuth() {
    setTimeout(() => this.signIn().catch(e => {
      console.warn('[DriveStore] Auto-reconnect failed:', e.message);
      this._showConnectBanner();
    }), 800);
  },

  // ── Upload file → Drive + cache locally ───────────────────────────────────
  // Returns metadata object: { driveId, filename, mimeType, size, uploadedAt, ...extra }
  async upload(blob, filename, extra = {}) {
    this._checkReady();
    const driveId    = await this._driveUpload(blob, filename);
    const uploadedAt = new Date().toISOString();
    // Always cache fresh uploads
    await this._cachePut(driveId, blob, uploadedAt, filename);
    const meta = { driveId, filename, mimeType: blob.type || 'application/octet-stream',
                   size: blob.size, uploadedAt, ...extra };
    this._putMeta(meta);
    console.log('[DriveStore] Uploaded:', filename, driveId);
    return meta;
  },

  // ── Get file: cache first → Drive fallback ────────────────────────────────
  // uploadedAt: ISO string (to decide whether to cache)
  async getFile(driveId, uploadedAt) {
    // 1. Try local cache
    const cached = await this._cacheGet(driveId, uploadedAt);
    if (cached) return cached;

    // 2. Fetch from Drive
    if (!this.ready) throw new Error('ไฟล์ไม่อยู่ใน cache และยังไม่ได้เข้าสู่ระบบ Drive');
    const blob = await this._driveDownload(driveId);

    // 3. Cache if still within 30 days
    if (uploadedAt && this._isRecent(uploadedAt)) {
      await this._cachePut(driveId, blob, uploadedAt, '');
    }
    return blob;
  },

  // ── Get file as object URL (for <img src> / <iframe>) ─────────────────────
  async getFileURL(driveId, uploadedAt) {
    const blob = await this.getFile(driveId, uploadedAt);
    return URL.createObjectURL(blob);
  },

  // ── Delete from Drive + cache + metadata ──────────────────────────────────
  async deleteFile(driveId) {
    if (this.ready) {
      try { await this._driveDelete(driveId); } catch (e) {
        console.warn('[DriveStore] Drive delete error (may already be gone):', e.message);
      }
    }
    await this._cacheDelete(driveId);
    this._delMeta(driveId);
  },

  // ── List all metadata ──────────────────────────────────────────────────────
  getAllMeta()                    { return this._getMeta(); },
  getMetaFor(invoiceNumber)      { return this._getMeta().filter(m => m.invoiceNumber === invoiceNumber); },
  getMetaByDriveId(driveId)      { return this._getMeta().find(m => m.driveId === driveId) || null; },

  // ── Drive status / cache info (for settings page) ─────────────────────────
  async getStatus() {
    const meta    = this._getMeta();
    const recent  = meta.filter(m => this._isRecent(m.uploadedAt));
    const cacheBytes = await this._cacheSize();
    return {
      ready:        this.ready,
      clientId:     this._clientId || '(ไม่ได้ตั้งค่า)',
      fileCount:    meta.length,
      recentCount:  recent.length,
      cacheBytes,
      cacheMB:      (cacheBytes / 1048576).toFixed(1),
    };
  },

  // ── Google Drive REST API ──────────────────────────────────────────────────
  async _driveUpload(blob, filename) {
    const meta = { name: filename, parents: [this._folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);

    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: `Bearer ${this._token}` }, body: form }
    );
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(`Drive upload: ${e.error?.message || r.status}`);
    }
    return (await r.json()).id;
  },

  async _driveDownload(driveId) {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`,
      { headers: { Authorization: `Bearer ${this._token}` } }
    );
    if (!r.ok) throw new Error(`Drive download: ${r.status}`);
    return r.blob();
  },

  async _driveDelete(driveId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this._token}` } });
  },

  async _ensureFolder() {
    // Search existing
    const q = `name='${this.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${this._token}` } }
    );
    const d = await r.json();
    if (d.files?.length) return d.files[0].id;

    // Create
    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (await cr.json()).id;
  },

  // ── IndexedDB Cache ────────────────────────────────────────────────────────
  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.IDB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.IDB_STORE))
          db.createObjectStore(this.IDB_STORE, { keyPath: 'driveId' });
      };
      req.onsuccess = e => { this._idb = e.target.result; resolve(); };
      req.onerror   = e => reject(e.target.error);
    });
  },

  _idbTx(mode) {
    return this._idb.transaction(this.IDB_STORE, mode).objectStore(this.IDB_STORE);
  },

  _cachePut(driveId, blob, uploadedAt, filename) {
    if (!this._idb) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const store = this._idbTx('readwrite');
      const req = store.put({ driveId, blob, uploadedAt, filename, cachedAt: new Date().toISOString() });
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  },

  _cacheGet(driveId, uploadedAt) {
    if (!this._idb) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const req = this._idbTx('readonly').get(driveId);
      req.onsuccess = e => {
        const entry = e.target.result;
        if (!entry) { resolve(null); return; }
        // Check if still within 30-day window (based on upload date, not cache date)
        if (uploadedAt && !this._isRecent(uploadedAt)) { resolve(null); return; }
        resolve(entry.blob);
      };
      req.onerror = e => reject(e.target.error);
    });
  },

  _cacheDelete(driveId) {
    if (!this._idb) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const req = this._idbTx('readwrite').delete(driveId);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  },

  _cacheSize() {
    if (!this._idb) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      const req = this._idbTx('readonly').getAll();
      req.onsuccess = e => resolve(
        e.target.result.reduce((s, entry) => s + (entry.blob?.size || 0), 0)
      );
      req.onerror = e => reject(e.target.error);
    });
  },

  async _cleanCache() {
    if (!this._idb) return;
    const allMeta = this._getMeta();
    return new Promise((resolve, reject) => {
      const req = this._idbTx('readonly').getAll();
      req.onsuccess = async e => {
        const entries = e.target.result;
        const store   = this._idbTx('readwrite');
        let   cleaned = 0;
        for (const entry of entries) {
          const meta      = allMeta.find(m => m.driveId === entry.driveId);
          const uploadedAt = meta?.uploadedAt || entry.uploadedAt;
          if (!this._isRecent(uploadedAt)) {
            store.delete(entry.driveId);
            cleaned++;
          }
        }
        if (cleaned > 0) console.log(`[DriveStore] Cache cleaned: ${cleaned} entries`);
        resolve();
      };
      req.onerror = e => reject(e.target.error);
    });
  },

  // ── Metadata (localStorage) ────────────────────────────────────────────────
  _getMeta() {
    try { return JSON.parse(localStorage.getItem(this.LS_KEY) || '[]'); } catch { return []; }
  },
  _putMeta(meta) {
    const list = this._getMeta();
    const idx  = list.findIndex(m => m.driveId === meta.driveId);
    if (idx >= 0) list[idx] = meta; else list.push(meta);
    localStorage.setItem(this.LS_KEY, JSON.stringify(list));
  },
  _delMeta(driveId) {
    localStorage.setItem(this.LS_KEY,
      JSON.stringify(this._getMeta().filter(m => m.driveId !== driveId)));
  },

  // ── Helpers ────────────────────────────────────────────────────────────────
  _isRecent(uploadedAt) {
    if (!uploadedAt) return false;
    return (Date.now() - new Date(uploadedAt).getTime()) < this.CACHE_DAYS * 86400000;
  },

  _checkReady() {
    if (!this.ready) throw new Error('DriveStore ยังไม่ได้เข้าสู่ระบบ Google Drive');
  },

  _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src*="gsi/client"]')) {
        // Script already in DOM — wait for it
        const check = setInterval(() => {
          if (window.google?.accounts?.oauth2) { clearInterval(check); resolve(); }
        }, 100);
        return;
      }
      const s = document.createElement('script');
      s.src     = 'https://accounts.google.com/gsi/client';
      s.async   = true;
      s.defer   = true;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(s);
    });
  },

  _badge(status) {
    const item = document.getElementById('driveBadgeItem');
    if (item) item.style.display = '';
    const el = document.getElementById('driveBadge');
    if (!el) return;
    if (status === 'online') {
      el.textContent = '☁ Drive';
      el.className   = 'badge bg-success ms-1 py-1 px-2';
      // ซ่อน banner เมื่อเชื่อมต่อสำเร็จ
      const banner = document.getElementById('driveConnectBanner');
      if (banner) banner.remove();
    } else {
      el.textContent = '☁ Drive';
      el.className   = 'badge bg-secondary ms-1 py-1 px-2';
    }
  },

  // ── แสดง banner เชิญให้กดเชื่อมต่อ Drive (ครั้งแรก / session หมดอายุ) ────────
  _showConnectBanner() {
    // รอให้ DOM พร้อมก่อน
    const show = () => {
      if (document.getElementById('driveConnectBanner')) return; // มีอยู่แล้ว
      const banner = document.createElement('div');
      banner.id = 'driveConnectBanner';
      banner.setAttribute('style',
        'position:fixed;bottom:60px;right:16px;z-index:9980;' +
        'background:#fff;border:1px solid #dee2e6;border-radius:12px;' +
        'padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,.15);' +
        'display:flex;align-items:center;gap:10px;font-size:13px;max-width:280px');
      banner.innerHTML =
        '<span style="font-size:20px">☁</span>' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;color:#212529">เชื่อมต่อ Google Drive</div>' +
          '<div style="color:#6c757d;font-size:12px">สำรองไฟล์แนบอัตโนมัติ</div>' +
        '</div>' +
        '<button onclick="DriveStore.signIn().catch(()=>{})" ' +
          'style="background:#0d6efd;color:#fff;border:none;border-radius:6px;' +
          'padding:5px 12px;font-size:12px;cursor:pointer;white-space:nowrap">เชื่อมต่อ</button>' +
        '<button onclick="document.getElementById(\'driveConnectBanner\').remove()" ' +
          'style="background:none;border:none;color:#adb5bd;font-size:16px;cursor:pointer;' +
          'padding:0 2px;line-height:1">×</button>';
      document.body.appendChild(banner);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', show);
    } else {
      show();
    }
  },

  _saveSignInState(v) {
    try { localStorage.setItem('wt_drive_signed_in', v ? '1' : ''); } catch {}
  },
};

// ── Auto-initialize ───────────────────────────────────────────────────────────
window.DriveStore.init().catch(e => console.warn('[DriveStore]', e.message));
} // end if (!window.DriveStore)
