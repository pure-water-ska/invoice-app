// db.js - Data layer using localStorage

const DB = {
  K: {
    USERS:       'wt_users',
    CUSTOMERS:   'wt_customers',
    PRODUCTS:    'wt_products',
    PRICING:     'wt_pricing',
    INVOICES:    'wt_invoices',
    PAYMENTS:    'wt_payments',
    ACTIVITY:    'wt_activity',
    LOGINS:      'wt_logins',
    COUNTER:     'wt_inv_counter',
    SETTINGS:    'wt_settings',
    VERSIONS:    'wt_versions',
    PAY_METHODS:          'wt_pay_methods',
    TRANSFER_ACCOUNTS:    'wt_transfer_accounts',
    CAP_COLORS:           'wt_cap_colors',
    CAP_RECEIPTS:         'wt_cap_receipts',
    CAP_DEDUCTIONS:       'wt_cap_deductions',
    PRICE_HISTORY:        'wt_price_history',
    ERRORS:               'wt_errors',
    RETURNS:              'wt_returns'
  },

  // ── In-memory read cache — eliminates repeated JSON.parse on the same key ──
  // Invalidated by _set() and by DB.invalidate() (called from sync.js after
  // Firestore/Drive updates localStorage directly).
  _cache: {},

  // ── IndexedDB overflow tracking ───────────────────────────────────────────
  // When localStorage hits QuotaExceededError, large keys are moved to IDB.
  // _idbKeys  : Set of keys currently stored in IndexedDB (not localStorage).
  // _IDB_KEYS_LS : tiny localStorage entry that persists the set across reloads.
  // ready     : Promise that resolves once IDB-overflow data is in _cache.
  //             Pages that use heavy data should wait: DB.ready.then(render).
  _idbKeys: new Set(),
  _IDB_KEYS_LS: 'wt_idb_keys',
  _idbReady: false,
  ready: Promise.resolve(),

  // ── Tauri HDD storage ─────────────────────────────────────────────────────
  // When running in the Tauri desktop app (location.protocol === 'tauri:'), all
  // wt_* keys are stored as plain JSON files in %APPDATA%\wt-invoice\data\.
  // On startup _tauri.init() reads those files back into localStorage so the
  // rest of db.js works without modification.  _tauri.write() is called by
  // _set() on every write to keep HDD files in sync (fire-and-forget async).
  // localStorage is still used as the fast in-session cache; HDD files are
  // the durable source of truth — data survives even if WebView2 profile is reset.
  _tauri: {
    dataDir: null,
    async init() {
      if (!window.IS_TAURI) return;
      try {
        const { appDataDir, join } = window.__TAURI__.path;
        const { createDir, readDir, readTextFile } = window.__TAURI__.fs;
        const base = await appDataDir();
        this.dataDir = await join(base, 'data');
        await createDir(this.dataDir, { recursive: true });
        const files = await readDir(this.dataDir);
        let loaded = 0;
        for (const f of files) {
          if (!f.name?.startsWith('wt_') || !f.name.endsWith('.json')) continue;
          const key = f.name.slice(0, -5);   // strip .json → e.g. wt_invoices
          try {
            const json = await readTextFile(f.path);
            // Load directly into in-memory cache — do NOT write to localStorage.
            // localStorage is not used at all in Tauri; cache is the only fast
            // read layer and HDD files are the durable source of truth.
            DB._cache[key] = JSON.parse(json);
            loaded++;
          } catch (e) {
            console.warn('[DB][Tauri] Could not load', f.name, e);
          }
        }
        console.log(`[DB][Tauri] HDD storage loaded → ${this.dataDir} (${loaded} keys)`);

        // Apply any shadow copies that were written to sessionStorage but whose
        // HDD counterpart hadn't been confirmed before the last page reload.
        // These represent the latest in-memory state — override the stale HDD data.
        const PREFIX = 'wt_hdd_shadow_';
        const shadows = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(PREFIX)) shadows.push(k);
        }
        for (const sk of shadows) {
          const dataKey = sk.slice(PREFIX.length);
          try {
            const val = JSON.parse(sessionStorage.getItem(sk));
            DB._cache[dataKey] = val;
            // Re-issue the HDD write now that dataDir is available
            this.write(dataKey, val);
            console.log('[DB][Tauri] Applied shadow write for', dataKey);
          } catch {}
        }
      } catch (e) {
        console.error('[DB][Tauri] HDD init failed', e);
      }
    },
    write(key, val) {
      if (!this.dataDir || !window.IS_TAURI) return;
      const { join } = window.__TAURI__.path;
      const { writeTextFile } = window.__TAURI__.fs;
      join(this.dataDir, key + '.json')
        .then(p => writeTextFile(p, JSON.stringify(val)))
        .then(() => {
          // HDD write confirmed — clear the sessionStorage shadow copy so it
          // doesn't linger unnecessarily after a clean write.
          try { sessionStorage.removeItem('wt_hdd_shadow_' + key); } catch {}
        })
        .catch(e => console.warn('[DB][Tauri] Write failed', key, e));
    },
  },

  // ── LZ-string helpers: read raw localStorage and try to decompress ──────
  _lzRead(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    // Plain JSON stored before compression was added always starts with one of
    // these ASCII chars: [ { " t f n or a digit.  LZString output is offset +32
    // so its first char code is almost never in this set.
    // Guard: only attempt decompression when the first char is NOT a plain-JSON
    // starter, so we never accidentally garbage-parse old uncompressed data.
    if (typeof LZString !== 'undefined') {
      const fc = raw.charCodeAt(0);
      const isPlainJson = fc === 91 || fc === 123 || fc === 34 ||
                          fc === 116 || fc === 102 || fc === 110 ||
                          (fc >= 48 && fc <= 57);
      if (!isPlainJson) {
        try {
          const dec = LZString.decompressFromUTF16(raw);
          if (dec) return dec;
        } catch {}
      }
    }
    return raw; // plain JSON (pre-compression data) — read as-is
  },

  _get(key) {
    if (!Object.prototype.hasOwnProperty.call(this._cache, key)) {
      // IDB-overflow keys are not in localStorage — wait for preloadFromIDB()
      if (this._idbKeys.has(key)) return [];
      try { this._cache[key] = JSON.parse(this._lzRead(key)) || []; }
      catch { this._cache[key] = []; }
    }
    return this._cache[key];
  },
  _getObj(key, def) {
    if (!Object.prototype.hasOwnProperty.call(this._cache, key)) {
      // IDB-overflow keys are not in localStorage — wait for preloadFromIDB()
      if (this._idbKeys.has(key)) return def;
      try { const v = this._lzRead(key); this._cache[key] = v ? JSON.parse(v) : def; }
      catch { this._cache[key] = def; }
    }
    return this._cache[key] ?? def;
  },
  _set(key, val) {
    // ── Record deletions for tombstoning BEFORE the cache is overwritten ──────
    // Both the old (current cache) and new arrays are available here, so a
    // deleted record's ID can be tombstoned synchronously — independent of
    // whether Sync is ready (push) or the write is queued (enqueue). This is the
    // authoritative deletion-detection point that fixes "deleted record comes
    // back on refresh" for array DOCUMENTS (customers, products, users, …).
    const _hadPrev = Object.prototype.hasOwnProperty.call(this._cache, key);
    const _prevVal = _hadPrev ? this._cache[key] : undefined;
    if (window.Sync && typeof Sync._recordDocDeletions === 'function') {
      try { Sync._recordDocDeletions(key, _prevVal, val); } catch {}
    }

    // ── Customers: handled by the dedicated single-source-of-truth module ──────
    // customer-sync.js (not the general sync.js COLLECTIONS path) diffs prev→next
    // and pushes per-record upserts/deletes to customers_v2. We pass the OLD cache
    // value so it can compute exactly which records changed or were deleted.
    if (key === this.K.CUSTOMERS && window.CustomerSync) {
      try { CustomerSync.onLocalChange(_prevVal, val); } catch (e) { console.warn('[DB] CustomerSync.onLocalChange', e); }
    }
    // Products & pricing use the same single-source-of-truth modules (see
    // collection-sync.js). They are NOT in sync.js DOCUMENTS — these modules own them.
    if (key === this.K.PRODUCTS && window.ProductSync) {
      try { ProductSync.onLocalChange(_prevVal, val); } catch (e) { console.warn('[DB] ProductSync.onLocalChange', e); }
    }
    if (key === this.K.PRICING && window.PricingSync) {
      try { PricingSync.onLocalChange(_prevVal, val); } catch (e) { console.warn('[DB] PricingSync.onLocalChange', e); }
    }
    if (key === this.K.USERS && window.UserSync) {
      try { UserSync.onLocalChange(_prevVal, val); } catch (e) { console.warn('[DB] UserSync.onLocalChange', e); }
    }

    this._cache[key] = val;                      // update cache immediately

    // ── Tauri desktop: localStorage is never used — HDD is the only store ────
    // Cache (above) is the fast read layer; HDD JSON files are durable storage.
    // Skip all localStorage / IDB paths to keep localStorage empty, but STILL
    // push to Firestore so changes made on the desktop app reach other devices.
    if (window.IS_TAURI) {
      this._cache[key] = val;                      // keep in-memory cache current
      // Shadow-write to sessionStorage so a page reload (F5) before the async
      // HDD write finishes won't load stale data.  sessionStorage survives F5
      // within the same Tauri WebView process.  _tauri.init() applies these on
      // startup and _tauri.write() clears them once the HDD file is confirmed.
      try { sessionStorage.setItem('wt_hdd_shadow_' + key, JSON.stringify(val)); } catch {}
      if (this._tauri.dataDir) this._tauri.write(key, val);
      if (window.LocalFolderSync) LocalFolderSync.queueWrite(key, val);
      // Sync to Firestore (queued if sync.js not ready yet — flushed on init)
      if (window.Sync) {
        if (Sync.ready) Sync.push(key, val);
        else Sync._enqueue(key, val);
      } else if (key === 'wt_invoices' || key === 'wt_payments') {
        // Sync not loaded yet — log to error log so it appears in Settings → Troubleshoot
        try { this.logError(new Error('[Sync] window.Sync undefined at _set — push dropped for ' + key), 'db._set'); } catch {}
      }
      return;
    }

    let writeToIdb = this._idbKeys.has(key);     // already overflowed — skip localStorage

    if (!writeToIdb) {
      // Compress with LZString if available; plain JSON fallback keeps sync.js happy
      const json   = JSON.stringify(val);
      const stored = (typeof LZString !== 'undefined')
        ? LZString.compressToUTF16(json)
        : json;
      try {
        localStorage.setItem(key, stored);
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
          // localStorage is full — overflow this key to IndexedDB so data is
          // persisted across reloads without losing it.
          console.warn('[DB] localStorage full — overflowing', key, '→ IndexedDB');
          this._idbKeys.add(key);
          localStorage.removeItem(key);          // remove any partial write
          writeToIdb = true;
          this._persistIdbKeys();
          this._notifyIdbOverflow(key);
          // Record in error log (plain write, avoids re-entering _set)
          try {
            const raw  = localStorage.getItem(this.K.ERRORS);
            const errs = raw ? JSON.parse(raw) : [];
            errs.unshift({ type: 'IDB_OVERFLOW', message: `localStorage full — ${key} moved to IndexedDB`, ts: new Date().toISOString() });
            if (errs.length > 200) errs.length = 200;
            localStorage.setItem(this.K.ERRORS, JSON.stringify(errs));
          } catch {}
        } else {
          throw e;   // unexpected error — let it surface normally
        }
      }
    }

    // Write to IndexedDB if this key lives there
    if (writeToIdb && typeof IDB !== 'undefined') {
      IDB.data.set(key, val).catch(err => {
        console.error('[DB] IDB write failed for', key, err);
        this._warnQuota(key);  // fall back to red banner if IDB also fails
      });
    }

    // Push to Firestore sync if available (sync.js loaded + ready, or queue if not yet ready)
    if (window.Sync) {
      if (Sync.ready) Sync.push(key, val);
      else Sync._enqueue(key, val);              // flushed once Sync.init() completes
    }
    // Queue upload to Google Drive (debounced, no-op if Drive not connected)
    if (window.DriveDbSync) DriveDbSync.queueUpload(key, val);
    // Mirror to local folder (debounced, no-op if no folder selected)
    if (window.LocalFolderSync) LocalFolderSync.queueWrite(key, val);
  },

  // ── Local-only write: persist to cache + durable storage WITHOUT syncing ────
  // Used by on-open reconcilers (e.g. customers.html _ensureCustomersFromFirestore)
  // that apply *server truth* to the local copy. Pushing here would re-upload every
  // record with a fresh _ts, making the other device's listener fire "modified",
  // show an "edited" toast, run its own reconcile, and push back — an infinite
  // ping-pong that also drowns out genuine deletes. So: update local only, never
  // call Sync.push(). (Genuine user adds/deletes still go through _set → push.)
  setLocalOnly(key, val) {
    this._cache[key] = val;
    if (window.IS_TAURI) {
      try { sessionStorage.setItem('wt_hdd_shadow_' + key, JSON.stringify(val)); } catch {}
      if (this._tauri.dataDir) this._tauri.write(key, val);
      if (window.LocalFolderSync) LocalFolderSync.queueWrite(key, val);
      return;
    }
    if (this._idbKeys.has(key)) {
      if (typeof IDB !== 'undefined') IDB.data.set(key, val).catch(e => console.error('[DB] IDB local-only write failed', key, e));
    } else {
      try {
        const json = JSON.stringify(val);
        localStorage.setItem(key, (typeof LZString !== 'undefined') ? LZString.compressToUTF16(json) : json);
      } catch (e) { console.warn('[DB] setLocalOnly write failed', key, e); }
    }
    if (window.LocalFolderSync) LocalFolderSync.queueWrite(key, val);
  },

  // ── Storage quota handlers (banners removed — overflow handled silently) ────
  _warnQuota(key) {
    console.warn('[DB] quota: localStorage + IDB both full for key:', key);
  },
  _notifyIdbOverflow(key) {
    console.info('[DB] localStorage full — key overflowed to IndexedDB:', key || [...this._idbKeys].join(', '));
  },

  // ── Persist the _idbKeys set so it survives page reloads ─────────────────
  _persistIdbKeys() {
    const json = JSON.stringify([...this._idbKeys]);
    try {
      localStorage.setItem(this._IDB_KEYS_LS, json);
    } catch {
      // localStorage is completely full — store the key list in IDB itself
      if (typeof IDB !== 'undefined') IDB.data.set(this._IDB_KEYS_LS, [...this._idbKeys]).catch(() => {});
    }
  },


  // ── Async IDB preload — must complete before first render on pages with ───
  // heavy data (invoices, payments, etc.).  Call DB.ready.then(render).
  preloadFromIDB() {
    return (async () => {
      // Step 0: in Tauri, restore all HDD files → memory cache before anything else
      // (localStorage is never written in Tauri — HDD + cache are the storage stack).
      // Seeding/migration is deferred to HERE (after the cache reflects real HDD
      // data) so empty-cache false positives can't resurrect deleted records.
      if (window.IS_TAURI) {
        await this._tauri.init();
        this._seedAndMigrate();
      }

      // Step 1: restore _idbKeys from localStorage (tiny JSON — always fits)
      const stored = localStorage.getItem(this._IDB_KEYS_LS);
      if (stored) {
        try { JSON.parse(stored).forEach(k => this._idbKeys.add(k)); }
        catch (e) { console.warn('[DB] Could not parse _idbKeys list', e); }
      } else if (typeof IDB !== 'undefined') {
        // Fallback: key list was itself stored in IDB (localStorage was 100% full)
        try {
          const idbList = await IDB.data.get(this._IDB_KEYS_LS);
          if (Array.isArray(idbList)) idbList.forEach(k => this._idbKeys.add(k));
        } catch {}
      }

      // Step 2: load all IDB-overflow data into _cache
      if (this._idbKeys.size > 0 && typeof IDB !== 'undefined') {
        try {
          const all = await IDB.data.getAll();
          for (const [k, v] of Object.entries(all)) {
            if (k === this._IDB_KEYS_LS) continue;  // skip the key list itself
            this._cache[k] = v;
            this._idbKeys.add(k);                   // ensure set is complete
          }
          console.log(`[DB] Loaded ${this._idbKeys.size} key(s) from IndexedDB:`, [...this._idbKeys].join(', '));
        } catch (e) {
          console.error('[DB] Failed to preload from IndexedDB', e);
        }
      }

      this._idbReady = true;
      window.dispatchEvent(new CustomEvent('db:ready'));
    })();
  },

  // Called by sync.js when Firestore/Drive writes data directly to localStorage.
  // IDB-overflow keys are NOT cleared — their cache entry IS the truth
  // (there is no localStorage copy to fall back to for those keys).
  invalidate(key) {
    // Tauri: localStorage is never written — the in-memory cache (HDD-backed)
    // IS the source of truth, exactly like IDB-overflow keys. sync.js already
    // updated the cache via _lsWrite() before calling invalidate(); deleting the
    // entry here would force _get() to fall back to the (empty) localStorage and
    // return [], blanking the list until the next HDD reload. So: no-op in Tauri.
    if (window.IS_TAURI) return;
    if (key) {
      if (!this._idbKeys.has(key)) delete this._cache[key];
    } else {
      // Full clear: preserve IDB-overflow entries
      for (const k of Object.keys(this._cache)) {
        if (!this._idbKeys.has(k)) delete this._cache[k];
      }
    }
  },

  // ─── SETTINGS ────────────────────────────────────────────────────────────────
  getSettings() {
    return this._getObj(this.K.SETTINGS, {
      companyName: 'เพียวจตุรพร',
      address: '21 หมู่ 2 ถนนถวัลย์ ตำบลบ้านพรุ อำเภอหาดใหญ่ จังหวัดสงขลา 90250',
      phone: '082-2965453',
      taxId: '0992000796640',
      logoText: '',
      showHeader: true,
      sessionTimeoutMin: 30,   // idle auto-logout (minutes). 0 = disabled
    });
  },
  saveSettings(s) { this._set(this.K.SETTINGS, s); },
  getReceivers() { const s = this.getSettings(); return Array.isArray(s.receivers) ? s.receivers : []; },
  saveReceivers(arr) { const s = this.getSettings(); s.receivers = arr; this.saveSettings(s); },
  getTransferAccounts() {
    // Stored in its own key (wt_transfer_accounts) so a settings sync from another device
    // can never wipe the list.  One-time migration: if the old location (settings.transferAccounts)
    // has data and the new key is empty, promote it automatically.
    const stored = this._getObj(this.K.TRANSFER_ACCOUNTS, null);
    if (Array.isArray(stored)) return stored;
    // Migration: pull from old settings location, save to new key, clear old location
    const s = this.getSettings();
    if (Array.isArray(s.transferAccounts) && s.transferAccounts.length > 0) {
      const migrated = s.transferAccounts;
      this._set(this.K.TRANSFER_ACCOUNTS, migrated);
      delete s.transferAccounts;
      this.saveSettings(s);
      console.log('[DB] Migrated transferAccounts → wt_transfer_accounts');
      return migrated;
    }
    return [];
  },
  saveTransferAccounts(arr) { this._set(this.K.TRANSFER_ACCOUNTS, arr); },

  // ─── PAYMENT METHODS ─────────────────────────────────────────────────────────
  getPayMethods() {
    const stored = this._getObj('wt_pay_methods', null);
    if (!stored || !stored.length) return ['เงินสด', 'โอน', 'เช็ค'];
    const cleaned = stored.filter(m => m && m.trim().length >= 2);
    if (cleaned.length !== stored.length) this._set('wt_pay_methods', cleaned);
    return cleaned.length ? cleaned : ['เงินสด', 'โอน', 'เช็ค'];
  },
  savePayMethods(arr) { this._set('wt_pay_methods', arr); },

  // ─── USERS ───────────────────────────────────────────────────────────────────
  getUsers() { return this._get(this.K.USERS); },
  saveUsers(u) { this._set(this.K.USERS, u); },
  getUserById(id) { return this.getUsers().find(u => u.id === id) || null; },
  getUserByUsername(u) { return this.getUsers().find(x => x.username === u) || null; },
  addUser(u) { const a = this.getUsers(); a.push(u); this.saveUsers(a); },
  updateUser(id, patch) {
    const a = this.getUsers();
    const i = a.findIndex(u => u.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveUsers(a); return a[i]; }
    return null;
  },
  deleteUser(id) { this.saveUsers(this.getUsers().filter(u => u.id !== id)); },

  // ─── CUSTOMERS ───────────────────────────────────────────────────────────────
  getCustomers() { return this._get(this.K.CUSTOMERS); },
  saveCustomers(c) { this._set(this.K.CUSTOMERS, c); },
  getCustomerById(id) { return this.getCustomers().find(c => c.id === id) || null; },
  addCustomer(c) { const a = this.getCustomers(); a.push(c); this.saveCustomers(a); },
  updateCustomer(id, patch) {
    const a = this.getCustomers();
    const i = a.findIndex(c => c.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveCustomers(a); return a[i]; }
    return null;
  },
  deleteCustomer(id) { this.saveCustomers(this.getCustomers().filter(c => c.id !== id)); },

  // Register a brand name against a customer record, keeping the brands array
  // and the legacy scalar brand field in sync.  Idempotent — safe to call even
  // if the brand is already present.  Centralises what was previously inline
  // mutation logic scattered across saveVersion() and similar callers.
  addBrandToCustomer(custId, brand) {
    if (!custId || !brand) return;
    const cust = this.getCustomerById(custId);
    if (!cust) return;
    const existing = Array.isArray(cust.brands) && cust.brands.length
      ? cust.brands
      : cust.brand ? [cust.brand] : [];
    if (existing.includes(brand)) return;          // already registered — no-op
    const updated = [...existing, brand];
    this.updateCustomer(custId, { brands: updated, brand: updated[0] });
  },

  // ─── BRAND/SIZE VERSIONS ─────────────────────────────────────────────────────
  getVersions()      { return this._get(this.K.VERSIONS); },
  saveVersions(v)    { this._set(this.K.VERSIONS, v); },
  addVersion(v)      { const a = this.getVersions(); a.unshift(v); this.saveVersions(a); },
  updateVersion(id, patch) {
    const a = this.getVersions();
    const i = a.findIndex(v => v.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveVersions(a); return a[i]; }
    return null;
  },
  deleteVersion(id)  { this.saveVersions(this.getVersions().filter(v => v.id !== id)); },

  // ─── PRODUCTS ────────────────────────────────────────────────────────────────
  getProducts() { return this._get(this.K.PRODUCTS); },
  saveProducts(p) { this._set(this.K.PRODUCTS, p); },
  getProductById(id) { return this.getProducts().find(p => p.id === id) || null; },
  addProduct(p) { const a = this.getProducts(); a.push(p); this.saveProducts(a); },
  updateProduct(id, patch) {
    const a = this.getProducts();
    const i = a.findIndex(p => p.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveProducts(a); return a[i]; }
    return null;
  },
  deleteProduct(id) { this.saveProducts(this.getProducts().filter(p => p.id !== id)); },

  // ─── PRICING ─────────────────────────────────────────────────────────────────
  getPricing() { return this._get(this.K.PRICING); },
  savePricing(p) { this._set(this.K.PRICING, p); },
  getPrice(productId, customerId, shippingMethod) {
    const list = this.getPricing();
    const exact = list.find(p => p.productId === productId && p.customerId === customerId && p.shippingMethod === shippingMethod);
    if (exact) return exact.price;
    const byCust = list.find(p => p.productId === productId && p.customerId === customerId && !p.shippingMethod);
    if (byCust) return byCust.price;
    const byShip = list.find(p => p.productId === productId && !p.customerId && p.shippingMethod === shippingMethod);
    if (byShip) return byShip.price;
    const def = list.find(p => p.productId === productId && !p.customerId && !p.shippingMethod);
    if (def) return def.price;
    const prod = this.getProductById(productId);
    return prod ? (prod.defaultPrice || 0) : 0;
  },
  upsertPrice(productId, customerId, shippingMethod, price) {
    const list = this.getPricing();
    const idx = list.findIndex(p =>
      p.productId === productId &&
      (p.customerId || '') === (customerId || '') &&
      (p.shippingMethod || '') === (shippingMethod || '')
    );
    const entry = { id: idx >= 0 ? list[idx].id : Utils.uuid(), productId, customerId: customerId || '', shippingMethod: shippingMethod || '', price: parseFloat(price) || 0 };
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    this.savePricing(list);
  },
  deletePrice(id) { this.savePricing(this.getPricing().filter(p => p.id !== id)); },

  // ─── INVOICES ────────────────────────────────────────────────────────────────
  getInvoices() { return this._get(this.K.INVOICES); },
  saveInvoices(v) { this._set(this.K.INVOICES, v); },
  getInvoiceById(id) { return this.getInvoices().find(v => v.id === id) || null; },
  getInvoicesByNumber(num) { return this.getInvoices().filter(v => v.invoiceNumber === num); },
  addInvoice(v) { const a = this.getInvoices(); a.unshift(v); this.saveInvoices(a); },
  updateInvoice(id, patch) {
    const a = this.getInvoices();
    const i = a.findIndex(v => v.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveInvoices(a); return a[i]; }
    return null;
  },
  deleteInvoice(id) { this.saveInvoices(this.getInvoices().filter(v => v.id !== id)); },

  generateInvoiceNumber() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String((now.getFullYear() + 543) % 100).padStart(2, '0');
    const dateKey = `${now.getFullYear()}-${mm}-${dd}`;
    const counters = this._getObj(this.K.COUNTER, {});
    counters[dateKey] = (counters[dateKey] || 0) + 1;
    this._set(this.K.COUNTER, counters);
    return `${dd}${mm}${yy}-${String(counters[dateKey]).padStart(3, '0')}`;
  },

  peekNextInvoiceNumber() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String((now.getFullYear() + 543) % 100).padStart(2, '0');
    const dateKey = `${now.getFullYear()}-${mm}-${dd}`;
    const counters = this._getObj(this.K.COUNTER, {});
    const next = (counters[dateKey] || 0) + 1;
    return `${dd}${mm}${yy}-${String(next).padStart(3, '0')}`;
  },

  // ── Date-aware invoice numbering ───────────────────────────────────────────
  // The number prefix (DDMMYY, BE year) follows the chosen invoice DATE, not
  // "today". The running NNN continues from the highest existing number on that
  // date (covers PDF imports too) and the per-date counter — whichever is larger.
  _invNumParts(isoDate) {
    let y, m, dd;
    if (isoDate && /^\d{4}-\d{2}-\d{2}/.test(isoDate)) {
      [y, m, dd] = isoDate.slice(0, 10).split('-');
    } else {
      const d = new Date();
      y = String(d.getFullYear()); m = String(d.getMonth() + 1).padStart(2, '0'); dd = String(d.getDate()).padStart(2, '0');
    }
    const yy = String((parseInt(y, 10) + 543) % 100).padStart(2, '0');
    return { dd, mm: m, yy, dateKey: `${y}-${m}-${dd}`, prefix: `${dd}${m}${yy}-` };
  },
  _maxRunningForPrefix(prefix) {
    let max = 0;
    for (const inv of this.getInvoices()) {
      const n = inv.invoiceNumber || '';
      if (n.indexOf(prefix) === 0) {
        const run = parseInt(n.slice(prefix.length), 10);
        if (!isNaN(run) && run > max) max = run;
      }
    }
    return max;
  },
  peekNextInvoiceNumberForDate(isoDate) {
    const { prefix, dateKey } = this._invNumParts(isoDate);
    const counters = this._getObj(this.K.COUNTER, {});
    const next = Math.max(counters[dateKey] || 0, this._maxRunningForPrefix(prefix)) + 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  },
  generateInvoiceNumberForDate(isoDate) {
    const { prefix, dateKey } = this._invNumParts(isoDate);
    const counters = this._getObj(this.K.COUNTER, {});
    const next = Math.max(counters[dateKey] || 0, this._maxRunningForPrefix(prefix)) + 1;
    counters[dateKey] = next;
    this._set(this.K.COUNTER, counters);
    return `${prefix}${String(next).padStart(3, '0')}`;
  },

  // Price valid AS OF a given date, from the wt_price_history timeline.
  // Same fallback chain as getPrice (exact → by customer → by shipping →
  // default), but each level uses the latest history entry on/before the date.
  // Falls back to the current getPrice if no history exists before that date.
  getPriceAsOf(productId, customerId, shippingMethod, isoDate) {
    if (!isoDate) return this.getPrice(productId, customerId, shippingMethod);
    const cutoff = isoDate.slice(0, 10) + 'T23:59:59.999';
    const hist = this.getPriceHistory();
    const latestFor = (cid, ship) => {
      let best = null;
      for (const h of hist) {
        if (h.productId !== productId) continue;
        if ((h.customerId || '') !== (cid || '')) continue;
        if ((h.shippingMethod || '') !== (ship || '')) continue;
        const at = (h.changedAt || '').slice(0, 23);
        if (at && at <= cutoff && (!best || at > best.at)) best = { at, price: h.price };
      }
      return best ? best.price : null;
    };
    let p = latestFor(customerId, shippingMethod);
    if (p == null) p = latestFor(customerId, '');
    if (p == null) p = latestFor('', shippingMethod);
    if (p == null) p = latestFor('', '');
    return (p != null) ? p : this.getPrice(productId, customerId, shippingMethod);
  },

  // ─── PAYMENTS ────────────────────────────────────────────────────────────────
  getPayments() { return this._get(this.K.PAYMENTS); },
  savePayments(p) { this._set(this.K.PAYMENTS, p); },
  getPaymentsByInvoice(invoiceNumber) {
    return this.getPayments().filter(p => p.invoiceNumber === invoiceNumber);
  },
  getPaymentsByCustomer(customerId) {
    return this.getPayments().filter(p => p.customerId === customerId);
  },
  addPayment(p) { const a = this.getPayments(); a.unshift(p); this.savePayments(a); },
  updatePayment(id, patch) {
    const a = this.getPayments();
    const i = a.findIndex(p => p.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.savePayments(a); return a[i]; }
    return null;
  },
  deletePayment(id) { this.savePayments(this.getPayments().filter(p => p.id !== id)); },

  getInvoicePaidAmount(invoiceNumber) {
    return this.getPaymentsByInvoice(invoiceNumber)
      .filter(p => !p.cancelled)
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  },

  // ─── CAP STOCK ───────────────────────────────────────────────────────────────
  getCapColors()           { return this._get(this.K.CAP_COLORS); },
  saveCapColors(v)         { this._set(this.K.CAP_COLORS, v); },
  addCapColor(v)           { const a = this.getCapColors(); a.push(v); this.saveCapColors(a); },
  updateCapColor(id, p)    { const a = this.getCapColors(); const i = a.findIndex(x => x.id === id); if (i >= 0) { a[i] = {...a[i], ...p}; this.saveCapColors(a); return a[i]; } return null; },
  deleteCapColor(id)       { this.saveCapColors(this.getCapColors().filter(c => c.id !== id)); },

  getCapReceipts()         { return this._get(this.K.CAP_RECEIPTS); },
  saveCapReceipts(v)       { this._set(this.K.CAP_RECEIPTS, v); },
  addCapReceipt(v)         { const a = this.getCapReceipts(); a.unshift(v); this.saveCapReceipts(a); },
  deleteCapReceipt(id)     { this.saveCapReceipts(this.getCapReceipts().filter(r => r.id !== id)); },

  getCapDeductions()       { return this._get(this.K.CAP_DEDUCTIONS); },
  saveCapDeductions(v)     { this._set(this.K.CAP_DEDUCTIONS, v); },
  addCapDeduction(v)       { const a = this.getCapDeductions(); a.unshift(v); this.saveCapDeductions(a); },
  removeCapDeductionsByInvoice(invNum) {
    this.saveCapDeductions(this.getCapDeductions().filter(d => d.invoiceNumber !== invNum));
  },
  getCapCurrentStock(colorId) {
    const receipts   = this.getCapReceipts().filter(r => r.colorId === colorId);
    const deductions = this.getCapDeductions().filter(d => d.colorId === colorId);
    const inQty  = receipts.reduce((s, r) => s + (r.qty || 0), 0);
    const outQty = deductions.reduce((s, d) => s + (d.qty || 0), 0);
    return inQty - outQty;
  },

  // ─── PRICE HISTORY ───────────────────────────────────────────────────────────
  getPriceHistory()        { return this._get(this.K.PRICE_HISTORY); },
  savePriceHistory(v)      { this._set(this.K.PRICE_HISTORY, v); },
  addPriceHistory(v)       { const a = this.getPriceHistory(); a.unshift(v); this.savePriceHistory(a); },
  getPriceHistoryFor(productId, customerId, shippingMethod) {
    return this.getPriceHistory().filter(h =>
      h.productId === productId &&
      (h.customerId || '') === (customerId || '') &&
      (h.shippingMethod || '') === (shippingMethod || '')
    );
  },

  // ─── ACTIVITY LOG ────────────────────────────────────────────────────────────
  getActivity() { return this._get(this.K.ACTIVITY); },
  logActivity(userId, username, action, details) {
    const log = this.getActivity();
    log.unshift({ id: Utils.uuid(), userId, username, action, details: details || {}, timestamp: new Date().toISOString() });
    // Auto-archive entries older than 2 years
    const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 2);
    const cutoffIso = cutoff.toISOString();
    const old  = log.filter(l => l.timestamp < cutoffIso);
    const keep = log.filter(l => l.timestamp >= cutoffIso);
    if (old.length) {
      const arch = this._get('wt_activity_archive');
      this._set('wt_activity_archive', [...old, ...arch].slice(0, 10000));
    }
    if (keep.length > 500) keep.splice(500);
    this._set(this.K.ACTIVITY, keep);
  },

  // ─── ACTIVITY ARCHIVE ────────────────────────────────────────────────────────
  getActivityArchive() { return this._get('wt_activity_archive'); },
  clearActivityArchive() { this._set('wt_activity_archive', []); },
  archiveOldLogs(months = 6) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffIso = cutoff.toISOString();
    const all  = this.getActivity();
    const old  = all.filter(l => l.timestamp < cutoffIso);
    const keep = all.filter(l => l.timestamp >= cutoffIso);
    if (!old.length) return { archived: 0, remaining: keep.length };
    const arch = this.getActivityArchive();
    this._set('wt_activity_archive', [...old, ...arch].slice(0, 10000));
    this._set(this.K.ACTIVITY, keep);
    return { archived: old.length, remaining: keep.length };
  },

  // ─── INVOICE ARCHIVE ─────────────────────────────────────────────────────────
  // Archives invoices that are:
  //   • older than `months` months (based on createdAt / date field)
  //   • fully paid OR overpaid  (paidAmount >= totalAmount)
  // Uploads them as a JSON file to Google Drive (if connected), then removes
  // from the local invoices array.  Returns a result object with counts.
  async archiveOldInvoices(months = 3) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffIso = cutoff.toISOString();

    const all = this.getInvoices();
    const toArchive = [];
    const toKeep    = [];

    for (const inv of all) {
      const dateStr = inv.createdAt || inv.date || '';
      if (!dateStr || dateStr >= cutoffIso) { toKeep.push(inv); continue; }

      // Calculate paid total (sum of non-cancelled payments)
      const paid  = this.getInvoicePaidAmount(inv.invoiceNumber);
      const total = parseFloat(inv.totalAmount || inv.total || 0);

      if (total > 0 && paid >= total - 0.005) {
        toArchive.push(inv);
      } else {
        toKeep.push(inv);
      }
    }

    if (!toArchive.length) return { archived: 0, remaining: toKeep.length, driveId: null };

    // Try to upload to Google Drive
    let driveId = null;
    if (window.DriveStore?.ready) {
      try {
        const stamp   = new Date().toISOString().slice(0, 10);
        const json    = JSON.stringify(toArchive, null, 2);
        const blob    = new Blob([json], { type: 'application/json' });
        const result  = await DriveStore.upload(blob, `invoice-archive-${stamp}.json`, {});
        driveId = result?.driveId || null;
      } catch (e) {
        console.warn('[DB.archiveOldInvoices] Drive upload failed:', e.message);
      }
    }

    // Remove archived invoices from local storage
    this.saveInvoices(toKeep);

    // Log the action
    if (typeof Auth !== 'undefined') {
      const u = Auth.getSession();
      this.logActivity(u?.id || '', u?.username || 'system', 'archive_invoices', {
        archived: toArchive.length,
        months,
        driveId,
      });
    }

    return { archived: toArchive.length, remaining: toKeep.length, driveId };
  },

  // ─── LOGIN HISTORY ───────────────────────────────────────────────────────────
  getLogins() { return this._get(this.K.LOGINS); },
  logLogin(userId, username, success, geo = {}, deviceInfo = {}) {
    const log = this.getLogins();
    log.unshift({
      id: Utils.uuid(), userId, username, success,
      ip: geo.ip || null,
      city: geo.city || null, region: geo.region || null, country: geo.country || null,
      browser: deviceInfo.browser || null, os: deviceInfo.os || null, device: deviceInfo.device || null,
      timestamp: new Date().toISOString()
    });
    if (log.length > 1000) log.splice(1000);
    this._set(this.K.LOGINS, log);
  },

  // ─── INIT ────────────────────────────────────────────────────────────────────
  init() {
    // ── Tauri desktop: wipe localStorage entirely (keep only safe keys) ──────
    // Data lives in HDD files + memory cache.  localStorage is not written by
    // this build, but older builds (and sync.js metadata writes) could fill it.
    // Clear everything EXCEPT:
    //   wt_last_user      — login form pre-fill
    //   wt_restore_pending — unclean-exit banner
    //   wt_sync_pending   — offline Firestore write queue (beforeunload-enqueued
    //                       writes from the previous session must survive the wipe
    //                       so _flushQueueNow() can push them before _pullAll()
    //                       reads stale data back — e.g. a delete that looks like
    //                       it "came back" after a refresh)
    //   wt_sync_tombstones — deleted-record IDs; if wiped, a delete that hasn't
    //                       fully propagated to Firestore is restored by _pullAll()
    //                       (the "deleted customer comes back on refresh" bug)
    if (window.IS_TAURI) {
      // wt_sync_sids — persisted "ids ever seen on the server" per collection.
      // Must survive the wipe: it's how _pullAll tells a record DELETED on the
      // server (was in the set, now gone → drop) from one created locally and
      // not yet synced (never in the set → push). Without it, a deleted record
      // looks "new" on the next launch and gets re-uploaded ("delete comes back").
      // wt_device_label — this device's name (shown in the Firestore card). It is
      // device-local (never synced) and tiny, so keep it in localStorage and protect
      // it from the wipe. This avoids the HDD-load/cache-poison timing that left it
      // blank after restart (the "PC name gone on restart" bug).
      const _keep = new Set(['wt_last_user', 'wt_restore_pending', 'wt_sync_pending', 'wt_sync_tombstones', 'wt_sync_sids', 'wt_device_label']);
      const _allLs = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !_keep.has(k)) _allLs.push(k);
      }
      _allLs.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      // Mark LZ migration done so the loop below is skipped on empty storage
      try { localStorage.setItem('wt_lz_migrated', '1'); } catch {}
    }

    // ── One-time LZString migration ─────────────────────────────────────────
    // Compresses any plain-JSON wt_* keys written before compression was added.
    // Collect keys first to avoid modifying localStorage while iterating it.
    if (!localStorage.getItem('wt_lz_migrated') && typeof LZString !== 'undefined') {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wt_')) keys.push(k);
      }
      let migrated = 0;
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const fc = raw.charCodeAt(0);
        // Plain JSON first chars: [ { " t f n or digit (LZString output starts much higher)
        if (fc === 91 || fc === 123 || fc === 34 ||
            fc === 116 || fc === 102 || fc === 110 ||
            (fc >= 48 && fc <= 57)) {
          try { localStorage.setItem(key, LZString.compressToUTF16(raw)); migrated++; }
          catch (e) { console.warn('[DB] LZ migration failed for', key, e.message); }
        }
      }
      localStorage.setItem('wt_lz_migrated', '1');
      this._cache = {}; // invalidate cache — re-read from now-compressed storage
      if (migrated) console.log(`[DB] LZString migration: compressed ${migrated} legacy keys`);
    }

    // Seed defaults + migrate settings.
    // ⚠️ In Tauri this MUST run AFTER the HDD data is loaded into the cache
    // (preloadFromIDB → _tauri.init). If it runs now, the cache looks EMPTY
    // (HDD not loaded yet), every "if length === 0" seed fires, and _set writes
    // those defaults into the sessionStorage shadow — which _tauri.init then
    // applies OVER the real HDD data, resurrecting deleted records (the
    // "delete all customers → they come back + Customer synced" bug). So on
    // Tauri we defer; on web the cache is already valid from localStorage.
    if (!window.IS_TAURI) this._seedAndMigrate();

    // ── Kick off async IDB preload ────────────────────────────────────────────
    // Resolves almost instantly when no keys have overflowed.
    // Pages that render heavy data should await: DB.ready.then(render)
    this.ready = this.preloadFromIDB();

    // If overflow was already active from a prior session, show the warning
    // banner on every page load — not just at the moment overflow first occurs.
    this.ready.then(() => {
      if (this._idbKeys.size > 0) this._notifyIdbOverflow('');
    });
  },

  // Seed default catalog + migrate settings. Idempotent and safe to call once
  // per launch. Catalog seeding (products/customers/pricing) is gated behind a
  // PERSISTENT flag (wt_seed_done) stored in the DB store — HDD-backed in Tauri,
  // localStorage on web — so it runs only on the very first run ever and a
  // user's deletion is never undone on the next launch.
  _seedAndMigrate() {
    // Admin login always ensured (recovery — you can never be locked out)
    if (this.getUsers().length === 0) {
      this.addUser({
        id: Utils.uuid(),
        username: 'admin',
        password: Utils.hashPassword('admin1234'),
        name: 'ผู้ดูแลระบบ',
        role: 'admin',
        active: true,
        createdAt: new Date().toISOString()
      });
    }

    // ── Customers are NO LONGER auto-seeded/restored ─────────────────────────
    // The hardcoded customer list re-created customers on every empty/fresh
    // install, which made "delete all" appear to never stick (and resurrected
    // data after a reinstall). Customer master data now lives ONLY in Firestore
    // (customers_v2) and syncs down — the app never auto-creates customers. A
    // truly empty list stays empty. (_seedCustomers/_defaultCustomers are kept
    // as methods for a manual one-off restore if ever needed, but are not called
    // automatically.)
    //
    // Products/pricing: keep the one-time first-run seed (small reference data,
    // not the source of the delete pain). Gated by wt_seed_done.
    if (this._getObj('wt_seed_done', false) !== true) {
      if (this.getProducts().length === 0)  this._seedProducts();
      if (this.getPricing().length === 0)   this._seedPricing();
      this._set('wt_seed_done', true);
    }

    // ── migrate company info (replace placeholder / old demo values) ──────────
    const OLD_NAMES = ['บริษัท/ร้าน ของคุณ', 'บริษัท โกลด์สตาร์วอเตอร์เทคโนโลยี จำกัด'];
    const cur = this.getSettings();
    if (!cur.companyName || OLD_NAMES.includes(cur.companyName)) {
      this.saveSettings({
        ...cur,
        companyName: 'เพียวจตุรพร',
        address:     '21 หมู่ 2 ถนนถวัลย์ ตำบลบ้านพรุ อำเภอหาดใหญ่ จังหวัดสงขลา 90250',
        phone:       '082-2965453',
        taxId:       '0992000796640',
        showHeader:  true,
      });
    }
    const cfg = this.getSettings();
    // One-time migration: reset showHeader to false (new default is hidden).
    // Store flag inside settings so it survives Tauri HDD wiping localStorage.
    if (!cfg._headerDefaultV2) {
      this.saveSettings({ ...cfg, showHeader: false, _headerDefaultV2: true });
    } else if (cfg.showHeader === undefined) {
      this.saveSettings({ ...cfg, showHeader: false });
    }
    if (!cfg.autoBackup) {
      this.saveSettings({ ...cfg, autoBackup: { enabled: true, interval: 'daily', lastBackupAt: null } });
    }
  },

  _seedProducts() {
    const products = [
      { name: 'ขวด PET 350 มล.',          unitSize: 200  },
      { name: 'ขวด PET 350 มล. เกลี้ยง',  unitSize: 216  },
      { name: 'ขวด PET 500 มล.',          unitSize: 180  },
      { name: 'ขวด PET 600 มล.',          unitSize: 192  },
      { name: 'ขวด PET 600 มล. ห่อเล็ก', unitSize: 156  },
      { name: 'ขวด PET 600 มล. เกลี้ยง',  unitSize: 192  },
      { name: 'ขวด PET 830 มล.',          unitSize: 165  },
      { name: 'ขวด PET 1500 มล.',         unitSize: 102  },
      { name: 'ฝาขวด PET',               unitSize: 10500 },
      { name: 'ถุงขวด 350(ใส)',           unitSize: 25   },
      { name: 'ถุงขวด 600(ขุ่น)',          unitSize: 30   },
      { name: 'ถุงขวด 600(ใส)',           unitSize: 30   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด A',  unitSize: 25   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด B',  unitSize: 30   },
      { name: 'ถุงขวด 830(ใส)',           unitSize: 30   },
      { name: 'ถุงขวด 1500',             unitSize: 25   },
      { name: 'ฝาถัง 20 ลิตร',           unitSize: 1    },
      { name: 'ถังน้ำ 20 ลิตร',           unitSize: 1    },
      { name: 'PVC 350 (13.5x15)',        unitSize: 30   },
      { name: 'PVC 600 (16.5x16.5)',      unitSize: 30   },
      { name: 'PVC 830 (18.5x16)',        unitSize: 30   },
      { name: 'PVC 1500 (18.5x16)',       unitSize: 30   },
      { name: 'ฟิล์มม้วน',               unitSize: 1    },
      { name: 'บล็อกสกรีน 350 มล.',       unitSize: 1    },
      { name: 'บล็อกสกรีน 600 มล.',       unitSize: 1    },
      { name: 'บล็อกสกรีน 830 มล.',       unitSize: 1    },
      { name: 'บล็อกสกรีน 1500 มล.',      unitSize: 1    },
      { name: 'บล็อกสกรีน 20 ลิตร',       unitSize: 1    },
      { name: 'สีสกรีน',                  unitSize: 1    },
      { name: 'ค่าจัดส่ง',               unitSize: 1    },
      { name: 'ฝาถังใส',                 unitSize: 1    },
      { name: 'หักคืน',                  unitSize: 1    },
    ];
    const now = new Date().toISOString();
    products.forEach(p => {
      this.addProduct({ id: Utils.uuid(), name: p.name, unitSize: p.unitSize, defaultPrice: 0, createdAt: now });
    });
  },

  // Canonical default customer list with DETERMINISTIC ids (cust-seed-N by index).
  // Single source of truth used by both seeding and id-normalisation.
  _defaultCustomers() {
    const now = new Date().toISOString();
    const note = (text) => [{ id: Utils.uuid(), text, createdAt: now, createdBy: 'ระบบ' }];
    const customers = [
      { name: 'สงขลา เฮลส์ตรี๊',                    address: '56/4 ม.4 ต.เขาหัวช้าง อ.เมือง จ.สงขลา',                   phone: '065-4038205, 080-5207586',  taxId: '',             brand: '', notes: [] },
      { name: 'เชากลอกการค้า',                        address: '140 ม.8 ต.ท่าช้าง อ.หาดใหญ่ จ.สงขลา',                     phone: '089-4638851, 089-7367983',  taxId: '',             brand: '', notes: note('ภายใน 15 วัน(ส่ง) หรือก่อนส่งรอบใหม่') },
      { name: 'เบสลา',                                address: '238 ป.ดังแปดเดรา ต.สะเดา จ.สงขลา',                         phone: '087-2964671',               taxId: '',             brand: '', notes: [] },
      { name: 'เย็นใจ',                               address: '18 ม.5 ต.นาทวี ต.พิลา อ.สะเดา จ.สงขลา',                   phone: '089-2997000, 074-541177',   taxId: '',             brand: '', notes: [] },
      { name: 'เอ เอ็ม',                              address: '344 ม.5 ต.คลองขุด อ.เมืองสตูล จ.สตูล 91000',               phone: '081-2751436, 083-9084449',  taxId: '',             brand: '', notes: [] },
      { name: 'เอ็น เอ็ค',                            address: '222 ม.8 ต.บ้านพรุ อ.หาดใหญ่ จ.สงขลา',                     phone: '081-2769000',               taxId: '',             brand: '', notes: [] },
      { name: 'เอ็น วาย',                             address: '63 ต.ราษฎรถิ่น ม.5 อ.เมือง จ.สงขลา',                       phone: '081-7018954, 081-7386390',  taxId: '',             brand: '', notes: [] },
      { name: 'เอฟ พี วอเตอร์',                       address: '90/6 ม.2 ต.คลองแห อ.หาดใหญ่ จ.สงขลา',                    phone: '086-5981132, 080-1392135',  taxId: '',             brand: '', notes: [] },
      { name: 'เอสตรัง',                              address: '192/2 ต.พะวง อ.เมือง จ.สงขลา 90100',                       phone: '090-9021031',               taxId: '',             brand: '', notes: [] },
      { name: 'โกมลทิพย์',                            address: '23 ม.7 ต.คลองแห อ.หาดใหญ่ จ.สงขลา 90110',                 phone: '081-1872239',               taxId: '',             brand: '', notes: [] },
      { name: 'โรส',                                   address: '99/2 ม.4 ต.บ้านพรุ อ.จะนะ จ.สงขลา',                       phone: '093-7843800, 080-0392671',  taxId: '',             brand: '', notes: [] },
      { name: 'กร่อยทิพย์',                           address: '239 ม.1 ต.นาทวี อ.นาทวี จ.สงขลา',                          phone: '089-9777719',               taxId: '',             brand: '', notes: [] },
      { name: 'ร่วมน้ำใจ',                            address: '1/3 ม.3 ต.บ้านดัก อ.ระแม จ.ยะลา',                          phone: '088-4883667',               taxId: '',             brand: '', notes: [] },
      { name: 'ชิม ชิม (สตูล)',                        address: '204 ม.3 ต.ท่าแหน อ.ท่าแหน จ.สตูล',                         phone: '086-9555842, 063-0167343',  taxId: '',             brand: '', notes: [] },
      { name: 'บจก.กูดสแตนดาร์ด',                    address: '28 ต.บ้านพรุ อ.หาดใหญ่ จ.สงขลา',                           phone: '074-266767',                taxId: '',             brand: '', notes: [] },
      { name: 'ตามสะเร็บ',                            address: '373/1 ม.11 ต.คำแพงเพชร อ.รัตภูมิ จ.สงขลา',                phone: '086-9574905, 086-9434226',  taxId: '',             brand: '', notes: [] },
      { name: 'ทรัพย์มณี',                            address: '130 ต.บ้านพรุ อ.หาดใหญ่ จ.สงขลา',                          phone: '085-6748014, 093-7626973',  taxId: '',             brand: '', notes: [] },
      { name: 'ทองภิบาลทรัพย์',                       address: '37/2 ม.6 ต.สำนักทาม อ.สิงหนคร จ.สงขลา 90330',              phone: '081-6796564, 094-8614994',  taxId: '',             brand: '', notes: [] },
      { name: 'ทิพย์พฤษา',                            address: '38/3 ม.5 ต.บ้านพรุ อ.บางกล่า จ.สงขลา',                    phone: '080-8692243, 074-384085',   taxId: '',             brand: '', notes: [] },
      { name: 'นครทราซีย์',                           address: '16/8 ม.7 ต.เกาะแต้ว อ.เมือง จ.สงขลา',                     phone: '081-9598256, 089-2942970',  taxId: '',             brand: '', notes: [] },
      { name: 'บจก.ยูนิตคอมนาย',                      address: '86/125 ต.คลองแห อ.หาดใหญ่ จ.สงขลา 90110',                  phone: '089-6551965',               taxId: '',             brand: '', notes: [] },
      { name: 'บ้าซาร์',                              address: '305 ม.1 ต.เขาขาว จ.สตูล',                                  phone: '086-2995219, 086-2955999',  taxId: '',             brand: '', notes: [] },
      { name: 'บ้านนุสสิม',                           address: '190/13 ต.สะเดา จ.สงขลา',                                    phone: '086-9857665',               taxId: '',             brand: '', notes: [] },
      { name: 'นีลส์',                                address: '183 ม.5 ต.พนางตุง อ.เมือง จ.พัทลุง 93000',                 phone: '096-8346070, 074-670723',   taxId: '',             brand: '', notes: [] },
      { name: 'บูซา',                                  address: '23/2 ม.2 ต.ขาม',                                            phone: '082-8328353, 090-2257473',  taxId: '',             brand: '', notes: [] },
      { name: 'ปรีซา วอเตอร์ แอนด์ ไอซ์',             address: '86/381 ต.คลองแห อ.หาดใหญ่ จ.สงขลา',                        phone: '089-2957737, 093-7152323',  taxId: '',             brand: '', notes: [] },
      { name: 'ปากน้ำวอเตอร์',                        address: '137/1 ม.12 ต.รัตภูมิ อ.ควนเนียง จ.สงขลา',                  phone: '063-8094938, 081-6786416',  taxId: '',             brand: '', notes: [] },
      { name: 'พรทิพย์',                              address: '298 ต.คลองน้อย อ.เมือง จ.พัทลุง',                           phone: '082-4306106, 074-610661',   taxId: '',             brand: '', notes: [] },
      { name: 'พลอยใส',                               address: '63/3 ม.8 ต.วังใหญ่ อ.สิงหนคร จ.สงขลา',                     phone: '097-2260335, 090-3274056',  taxId: '',             brand: '', notes: [] },
      { name: 'พอเพียง',                              address: '55/5 ม.5 อ.สิงหนคร จ.สงขลา',                               phone: '089-7331744, 087-2961188',  taxId: '',             brand: '', notes: [] },
      { name: 'ที ที อีลสตรีกีป',                     address: '43/5 ม.4 ต.ปากรอ อ.สิงหนคร จ.สงขลา 90310',                 phone: '089-1470275',               taxId: '',             brand: '', notes: [] },
      { name: 'บีดี',                                  address: '149 ม.3 ต.พะตง อ.หาดใหญ่ จ.สงขลา 90250',                   phone: '086-2885617, 098-0179552',  taxId: '',             brand: '', notes: [] },
      { name: 'ร่วงข้าว',                             address: '15/2 ม.2 อ.สิงหนคร จ.สงขลา',                               phone: '091-8473055, 088-7845449',  taxId: '',             brand: '', notes: [] },
      { name: 'ริน',                                   address: '77 ม.3 อ.สิงหนคร จ.สงขลา 90190',                            phone: '085-0802212, 091-8495919',  taxId: '',             brand: '', notes: [] },
      { name: 'วอเตอร์กาแฟ',                          address: '55/1 ต.กูแม อ.บ้านพรุ จ.สงขลา 90250',                       phone: '081-9576852, 074-280535',   taxId: '',             brand: '', notes: [] },
      { name: 'ศรีกรีสรถพรรดิ์',                      address: '137 ม.9 ต.เขาขาว อ.รัตภูมิ จ.สงขลา',                       phone: '089-1953399, 089-1977999',  taxId: '',             brand: '', notes: [] },
      { name: 'ตรีอามาสบ้านพรุ',                      address: '180/8 ม.5 ต.คำแพงเพชร อ.รัตภูมิ จ.สงขลา 90108',            phone: '083-6575500',               taxId: '',             brand: '', notes: [] },
      { name: 'อาไลหักส์',                            address: '',                                                            phone: '',                          taxId: '',             brand: '', notes: note('รอข้อมูลที่อยู่และเบอร์โทร') },
      { name: 'ทาก.ดวงโซดิเครี่ยสุริย',               address: '238 ม.8 ต.บิตง อ.ทุ่งยางแดง จ.ปัตตานี',                     phone: '081-8965692, 081-7664985',  taxId: '',             brand: '', notes: [] },
      { name: 'ทาก.บัมบู บ้วงเรศกัน',                 address: '64/1 ม.2 อ.สะเดา จ.สงขลา',                                  phone: '089-8707084, 074-398903',   taxId: '',             brand: '', notes: [] },
      { name: 'ทาก.อาซีทิพย์ปัมบุง',                  address: '89 ส.8 ต.ตลาดหน้า อ.หาดใหญ่ จ.สงขลา',                      phone: '084-2570402, 082-4942891',  taxId: '',             brand: '', notes: [] },
      { name: 'หมากเพชร',                             address: '90 ม.3 ต.จะทิ้งพระ อ.สิงหนคร จ.สงขลา',                     phone: '089-4651101',               taxId: '',             brand: '', notes: [] },
      { name: 'อลาวาทิน',                             address: '10/2 ม.7 ต.ปากบาง อ.จะนะ จ.สงขลา',                         phone: '089-8760495, 096-0258729',  taxId: '',             brand: '', notes: [] },
      { name: 'อนุกิจ',                               address: '204 ม.3 ต.ท่าแหน อ.ท่าแหน จ.สตูล',                          phone: '089-6095164',               taxId: '',             brand: '', notes: [] },
      { name: 'อมาลิน',                               address: '73/7 ม.12 ต.ท่าช้าง อ.หาดใหญ่ จ.สงขลา 90110',               phone: '064-0651915, 064-0649539',  taxId: '',             brand: '', notes: note('เงินเข้าก่อนผลิต') },
      { name: 'อัมพร วอเตอร์',                        address: '40/7 ม.1 ต.สะกอม อ.จะนะ จ.สงขลา',                          phone: '082-8210985',               taxId: '',             brand: '', notes: [] },
      { name: 'กลุ่มออมทรัพย์เพื่อการผลิตปาน้ำนิต',  address: '300 ม.7 อ.รัตภูมิ จ.สงขลา',                                phone: '089-6576180',               taxId: '',             brand: '', notes: [] },
      { name: 'ขุมเย็น (นาทวี)',                       address: '31/1 ม.2 ต.นาทวี จ.สงขลา',                                  phone: '080-7161326',               taxId: '',             brand: '', notes: [] },
      { name: 'บจก.โพซิทีฟ (ประเทศไทย)',              address: '1 ม.2 ซ.พหลโยธิน อ.หาดใหญ่ จ.สงขลา',                       phone: '099-9372249',               taxId: '',             brand: '', notes: [] },
      { name: 'พันทิพย์',                             address: '83 ม.12 ต.ควนรู อ.รัตภูมิ จ.สงขลา 90180',                   phone: '074-256111',                taxId: '',             brand: '', notes: [] },
      { name: 'ขุมเย็น (บ้านโหนด)',                    address: '53 ม.6 ต.บ้านโหนด อ.นาทวี จ.สงขลา',                        phone: '088-3939277',               taxId: '',             brand: '', notes: [] },
      { name: 'ทาก.อาราเบีย-กี',                      address: '70/1 ม.4 ต.คลองทราย อ.นาทวี จ.สงขลา',                      phone: '089-0439998',               taxId: '',             brand: '', notes: [] },
      { name: 'แก้วสแดงสีดา',                         address: '80/1 ม.4 ต.ปลักหนู อ.สิงหนคร จ.สงขลา',                     phone: '087-8950894',               taxId: '',             brand: '', notes: [] },
      { name: 'โรงเรียนนาทวียานาคม',                  address: '100 ม.2 ต.คลองหอยโข่ง อ.นาทวี จ.สงขลา 90160',              phone: '074-371018',                taxId: '',             brand: '', notes: [] },
      { name: 'พี.เจ.คลีนวอเตอร์โปรดักส์',            address: '613 ม.2 ต.พะวง อ.เมือง จ.สงขลา 90100',                      phone: '074-802048, 080-8725468',   taxId: '',             brand: '', notes: [] },
      { name: 'กมลมล เจริยา',                         address: '204 ม.3 ต.ท่าแหน อ.ท่าแหน จ.สตูล',                          phone: '089-9748543',               taxId: '',             brand: '', notes: [] },
      { name: 'T&A Drinking Water',                    address: '5/14 ม.6 ต.รัษฎา อ.เมือง จ.สงขลา 83130',                   phone: '081-4944599',               taxId: '',             brand: '', notes: [] },
      { name: 'ขุมเย็น (น้ำน้อย)',                     address: '1 ม.6 ต.ท่าประดา อ.นาทวี จ.สงขลา 90160',                    phone: '093-3458563',               taxId: '',             brand: '', notes: [] },
      { name: 'อัมพร',                                address: '40/7 ม.4 ต.สะกอม อ.จะนะ จ.สงขลา',                          phone: '080-7064868',               taxId: '',             brand: '', notes: [] },
      { name: 'น้ำสะอาดรัตน์',                        address: '42/1 ม.4 ต.นาทวี อ.นาทวี จ.สงขลา 90310',                    phone: '088-3929385',               taxId: '',             brand: '', notes: [] },
      { name: 'เกาะนำรอนน้ำลิ้ม',                     address: '1 ม.6 ต.บ้านเหนือ อ.ควนเนียง จ.สงขลา',                     phone: '094-8057045',               taxId: '',             brand: '', notes: [] },
      { name: 'อบไม่แก่',                             address: '73/1 ม.7 ต.ท่าช้าง อ.หาดใหญ่ จ.สงขลา 90110',               phone: '089-5921565, 089-9772851',  taxId: '',             brand: '', notes: [] },
      { name: 'เอ็น คี',                              address: '29/2 ม.6 ต.บ้าหวี อ.จะนะ จ.สงขลา',                         phone: '089-7330580, 089-4620485',  taxId: '',             brand: '', notes: [] },
      { name: 'วิบูสาร',                              address: '95/4 ม.1 ต.วังใหญ่ อ.สิงหนคร จ.สงขลา',                     phone: '081-9032954, 081-4026706',  taxId: '',             brand: '', notes: [] },
      { name: 'ออมทรัพย์วังงาน',                      address: '',                                                            phone: '',                          taxId: '',             brand: '', notes: [] },
      { name: 'กัญญาวาร์',                            address: '17/2 ม.8 ต.วะโต อ.จะนะ จ.สงขลา',                           phone: '093-4152429, 085-6918507',  taxId: '',             brand: '', notes: [] },
      { name: 'ทาก.จินดาทิพย์',                       address: '35/11 ต.หาดทรายแก้ว อ.หาดใหญ่ จ.สงขลา',                    phone: '089-1094615, 095-4388887',  taxId: '',             brand: '', notes: [] },
      { name: 'บ้ำชน',                                address: '',                                                            phone: '',                          taxId: '',             brand: '', notes: [] },
      { name: 'โรงเรียนทุ่งหว้าวิทยาคม',              address: '90 หมู่1 ต.ทุ่งหว้า อ.นาทวี จ.สงขลา 90160',                 phone: '089-8796403, 085-5672905',  taxId: '',             brand: '', notes: [] },
      { name: 'ไรต์กลาร์ คาเฟ่',                      address: '40/7 ม.4 ต.สะกอม อ.จะนะ จ.สงขลา',                          phone: '081-479444, 074-556111',    taxId: '',             brand: '', notes: [] },
      { name: 'น้ำมินพาณิชย์',                        address: '127/308 ม.4 ต.คลองแห อ.หาดใหญ่ จ.สงขลา',                   phone: '098-8523293, 093-6953954',  taxId: '',             brand: '', notes: [] },
      { name: 'บริ้ง คอฟฟี่',                         address: '476 ม.3 ต.โตนดด้วน อ.พัทลุง จ.พัทลุง 93170',                phone: '065-9747892, 065-4932888',  taxId: '',             brand: '', notes: [] },
      { name: 'อาหารพลสพีก',                          address: '152/2 ม.2 ต.ปากพะยูน อ.ปากพะยูน จ.พัทลุง 93120',           phone: '084-1094064',               taxId: '',             brand: '', notes: [] },
      { name: 'สกา',                                   address: '222 หมู่3 ต.บ้านนา อ.บ้านนา จ.พัทลุง',                      phone: '095-4106559, 081-9576068',  taxId: '',             brand: '', notes: [] },
      { name: 'ตีรัย',                                address: '60 ม.11 บ้านทุ่งแม่ตลาด ต.บ้านนา อ.บ้านนา จ.พัทลุง',      phone: '081-3886974, 093-5169169',  taxId: '',             brand: '', notes: [] },
      { name: 'คีลีอัน วอเตอร์',                      address: '160/1 ม.3 ต.บ้านนา อ.บ้านนา จ.พัทลุง',                     phone: '081-6335029, 081-9895456',  taxId: '',             brand: '', notes: [] },
      { name: 'มดใจอาชาน',                            address: '500/5 หมู่5 ต.แม่ขรี อ.ตะโหมด จ.พัทลุง',                    phone: '089-8717994',               taxId: '',             brand: '', notes: [] },
      { name: 'อบไก้บสุทธิ์',                         address: '',                                                            phone: '085-5619798',               taxId: '',             brand: '', notes: [] },
      { name: 'สังทอง',                               address: '4/19 ม.6 ต.เขาหัวช้าง อ.เมือง จ.สงขลา',                    phone: '093-2799045',               taxId: '',             brand: '', notes: [] },
      { name: 'คูม เจาะจิกอลาซา',                    address: '',                                                            phone: '084-2596880, 082-6030253',  taxId: '',             brand: '', notes: [] },
      { name: 'คล',                                    address: '',                                                            phone: '',                          taxId: '',             brand: '', notes: [] },
      { name: 'ทาก.สุวรรณแก้ว',                       address: '83/6 ม.7 ต.กระแสสินธุ์ อ.สิงหนคร จ.สงขลา 90190',            phone: '063-9676056, 086-9683864',  taxId: '',             brand: '', notes: [] },
      { name: 'ไรต์กลาง',                             address: '70/1 ม.4 ต.คลองทราย อ.นาทวี จ.สงขลา',                      phone: '084-8486640, 088-3979959',  taxId: '',             brand: '', notes: [] },
      { name: 'ร้านเคหะดรัง',                         address: '24 ต.บ้านพรุ อ.หาดใหญ่ จ.สงขลา 90250',                      phone: '080-3840273, 064-3412218',  taxId: '',             brand: '', notes: note('ค้าง 1 ปี ไม่มีเงิน 1 เดือน') },
      { name: 'ท่าแหนปาใส',                           address: '189 ม.8 ต.ท่าแหน อ.ท่าแหน จ.สตูล 91150',                    phone: '080-3257990, 084-1415010',  taxId: '',             brand: '', notes: [] },
      { name: 'บจก. ดีจีน (ประเทศไทย)',               address: '6 ม.7 ซ.หน้าท่า ต.สะเดา อ.สะเดา จ.สงขลา',                  phone: '074-536818',                taxId: '0905557001788', brand: '', notes: [] },
      { name: 'น้ำมินนาไอร์แลนด์',                    address: '47/8 ม.7 ต.คลองแห อ.หาดใหญ่ จ.สงขลา',                      phone: '062-6966205',               taxId: '',             brand: '', notes: [] },
      { name: 'ตา',                                    address: '109/8 ม.1 ต.ดีลง ต.ยาง อ.ยะหา จ.ปัตตานี',                  phone: '063-9895698',               taxId: '',             brand: '', notes: [] },
      { name: 'น้ำไก่',                               address: '334 ม.4 ต.คำแพงเพชร อ.รัตภูมิ จ.สงขลา 90180',               phone: '064-8928598, 089-0049924',  taxId: '',             brand: '', notes: [] },
      { name: 'บจก.โกลด์สตาร์วอเตอร์เทคโนโลยี',      address: '91 ถ.บ้านพรุธานี10 ต.บ้านพรุ อ.หาดใหญ่ จ.สงขลา',           phone: '063-4962764, 096-6292544',  taxId: '',             brand: '', notes: note('จ่าย 50% ก่อน หลังส่งอีก 50%') },
      { name: 'ประกาศน้ำสีลัน',                       address: '90 ม.2 ต.คลองหอยโข่ง อ.รัตภูมิ จ.สงขลา 90105',              phone: '089-3985117',               taxId: '',             brand: '', notes: [] },
      { name: 'จิมทซัม',                              address: '103 ต.คลองอู่เรือ ต.บ้านพรุ จ.สงขลา',                       phone: '082-2961321',               taxId: '',             brand: '', notes: [] },
      { name: 'กุ๊กี้',                               address: '9/4 ม.6 ต.หูแร่ อ.คลองหอยโข่ง จ.สงขลา',                    phone: '081-6097394, 089-5958100',  taxId: '',             brand: '', notes: [] },
      { name: 'นาซา',                                  address: '119/1 ม.3 ต.ทุ่งใหญ่ อ.หาดใหญ่ จ.สงขลา',                   phone: '088-2371435, 099-7464614',  taxId: '',             brand: '', notes: [] },
      { name: 'กทิพย์',                               address: '46/3 ม.4 ต.โตนดด้วน อ.เมือง จ.สงขลา',                      phone: '089-0367919, 087-2909540',  taxId: '',             brand: '', notes: [] },
      { name: 'อาหมัด',                               address: '',                                                            phone: '062-2265759',               taxId: '',             brand: '', notes: [] },
      { name: 'ยิ้มแย้ม',                             address: '146 ม.14 ต.สตูล อ.เมืองสตูล จ.สตูล',                         phone: '099-4782177, 087-4752493',  taxId: '',             brand: '', notes: [] },
      { name: 'H2O ป้าก',                             address: '',                                                            phone: '099-9584119',               taxId: '',             brand: '', notes: [] },
    ];
    // DETERMINISTIC ids — every device produces the SAME id for the same
    // customer (random uuids previously caused cross-device id mismatch → deletes
    // never propagated + re-seed duplicates).
    return customers.map((c, i) => ({ id: 'cust-seed-' + (i + 1), ...c, createdAt: now }));
  },

  _seedCustomers() {
    const seeded   = this._defaultCustomers();
    const existing = this.getCustomers();
    const haveIds  = new Set(existing.filter(c => c && c.id).map(c => c.id));
    this.saveCustomers([...existing, ...seeded.filter(c => !haveIds.has(c.id))]);
  },

  // ── One-time: normalise seed-customer ids to the deterministic scheme ──────
  // Devices that kept the OLD random-uuid seed customers have different ids for
  // the same customer than devices that restored the deterministic set → a
  // delete on one never matches the other. Remap by NAME to the canonical
  // deterministic id so every device converges. Custom (non-seed) customers are
  // left untouched. Returns true if anything changed.
  _normalizeCustomerIds() {
    const nameToId = new Map(this._defaultCustomers().map(c => [c.name, c.id]));
    const cur = this.getCustomers();
    let changed = false;
    const remapped = cur.map(c => {
      if (!c) return c;
      const detId = nameToId.get(c.name);
      if (detId && c.id !== detId) { changed = true; return { ...c, id: detId }; }
      return c;
    });
    if (!changed) return false;
    // De-dupe by id (a device might have had both a random-id and deterministic copy)
    const byId = new Map();
    remapped.forEach(c => { if (c && c.id) byId.set(c.id, c); });
    this.saveCustomers([...byId.values()]);
    return true;
  },

  _seedPricing() {
    const products = this.getProducts();
    const pid = (name) => { const p = products.find(x => x.name === name); return p ? p.id : null; };
    const prices = [
      { name: 'ขวด PET 350 มล.',          price: 1.25 },
      { name: 'ขวด PET 350 มล. เกลี้ยง',  price: 1.25 },
      { name: 'ขวด PET 500 มล.',          price: 1.30 },
      { name: 'ขวด PET 600 มล.',          price: 1.35 },
      { name: 'ขวด PET 600 มล. ห่อเล็ก', price: 1.40 },
      { name: 'ขวด PET 600 มล. เกลี้ยง',  price: 1.40 },
      { name: 'ขวด PET 830 มล.',          price: 1.40 },
      { name: 'ขวด PET 1500 มล.',         price: 2.90 },
      { name: 'ฝาขวด PET',               price: 0.15 },
      { name: 'ถุงขวด 350(ใส)',           price: 75   },
      { name: 'ถุงขวด 600(ขุ่น)',          price: 75   },
      { name: 'ถุงขวด 600(ใส)',           price: 70   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด A',  price: 92   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด B',  price: 68   },
      { name: 'ถุงขวด 830(ใส)',           price: 55   },
      { name: 'ถุงขวด 1500',             price: 60   },
      { name: 'ฝาถัง 20 ลิตร',           price: 5    },
      { name: 'ถังน้ำ 20 ลิตร',           price: 68   },
      { name: 'PVC 350 (13.5x15)',        price: 75   },
      { name: 'PVC 600 (16.5x16.5)',      price: 70   },
      { name: 'PVC 830 (18.5x16)',        price: 70   },
      { name: 'PVC 1500 (18.5x16)',       price: 70   },
      { name: 'ฟิล์มม้วน',               price: 65   },
      { name: 'บล็อกสกรีน 350 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 600 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 830 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 1500 มล.',      price: 700  },
      { name: 'บล็อกสกรีน 20 ลิตร',       price: 700  },
      { name: 'สีสกรีน',                  price: 500  },
      { name: 'ฝาถังใส',                 price: 5    },
    ];
    prices.forEach(item => {
      const productId = pid(item.name);
      if (productId) this.upsertPrice(productId, '', 'รับหน้าโรงงาน', item.price);
    });

    // Standard "จัดส่ง" prices (default for all customers unless overridden)
    const deliveryPrices = [
      { name: 'ขวด PET 350 มล.',          price: 1.35 },
      { name: 'ขวด PET 350 มล. เกลี้ยง',  price: 1.35 },
      { name: 'ขวด PET 600 มล.',          price: 1.45 },
      { name: 'ขวด PET 600 มล. ห่อเล็ก', price: 1.55 },
      { name: 'ขวด PET 600 มล. เกลี้ยง',  price: 1.55 },
      { name: 'ขวด PET 830 มล.',          price: 1.55 },
      { name: 'ขวด PET 1500 มล.',         price: 3.00 },
      { name: 'ฝาขวด PET',               price: 0.16 },
      { name: 'ถุงขวด 350(ใส)',           price: 75   },
      { name: 'ถุงขวด 600(ขุ่น)',          price: 75   },
      { name: 'ถุงขวด 600(ใส)',           price: 55   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด A',  price: 86   },
      { name: 'ถุงขวด 830(ขุ่น) เกรด B',  price: 62   },
      { name: 'ถุงขวด 830(ใส)',           price: 55   },
      { name: 'ถุงขวด 1500',             price: 55   },
      { name: 'ฝาถัง 20 ลิตร',           price: 5    },
      { name: 'ถังน้ำ 20 ลิตร',           price: 70   },
      { name: 'PVC 350 (13.5x15)',        price: 70   },
      { name: 'PVC 600 (16.5x16.5)',      price: 70   },
      { name: 'PVC 830 (18.5x16)',        price: 70   },
      { name: 'PVC 1500 (18.5x16)',       price: 70   },
      { name: 'ฟิล์มม้วน',               price: 65   },
      { name: 'บล็อกสกรีน 350 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 600 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 830 มล.',       price: 700  },
      { name: 'บล็อกสกรีน 1500 มล.',      price: 700  },
      { name: 'บล็อกสกรีน 20 ลิตร',       price: 700  },
      { name: 'สีสกรีน',                  price: 500  },
      { name: 'ฝาถังใส',                 price: 5    },
    ];
    deliveryPrices.forEach(item => {
      const productId = pid(item.name);
      if (productId) this.upsertPrice(productId, '', 'จัดส่ง', item.price);
    });

    // Per-customer "จัดส่ง" prices (customer-specific overrides)
    const customers = this.getCustomers();
    const cid = (name) => { const c = customers.find(x => x.name === name); return c ? c.id : null; };
    const custPrices = [
      // สงขลา เฮลส์ตรี๊ - higher pricing tier
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 350 มล.',          price: 1.55 },
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 350 มล. เกลี้ยง',  price: 1.55 },
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 600 มล. ห่อเล็ก', price: 1.40 },
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 600 มล. เกลี้ยง',  price: 1.40 },
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 830 มล.',          price: 1.55 },
      { c: 'สงขลา เฮลส์ตรี๊', p: 'ขวด PET 1500 มล.',         price: 2.95 },
      // เชากลอกการค้า - discount tier
      { c: 'เชากลอกการค้า', p: 'ขวด PET 350 มล.',          price: 1.15 },
      { c: 'เชากลอกการค้า', p: 'ขวด PET 350 มล. เกลี้ยง',  price: 1.15 },
      { c: 'เชากลอกการค้า', p: 'ขวด PET 600 มล.',          price: 1.25 },
      { c: 'เชากลอกการค้า', p: 'ขวด PET 830 มล.',          price: 1.30 },
      // เบสลา - discount tier
      { c: 'เบสลา', p: 'ขวด PET 350 มล.',          price: 1.15 },
      { c: 'เบสลา', p: 'ขวด PET 600 มล.',          price: 1.25 },
      { c: 'เบสลา', p: 'ขวด PET 600 มล. เกลี้ยง',  price: 1.40 },
      { c: 'เบสลา', p: 'ขวด PET 830 มล.',          price: 1.40 },
      { c: 'เบสลา', p: 'ขวด PET 1500 มล.',         price: 3.00 },
      // เย็นใจ
      { c: 'เย็นใจ', p: 'ขวด PET 600 มล. ห่อเล็ก', price: 1.45 },
      { c: 'เย็นใจ', p: 'ขวด PET 830 มล.',          price: 1.45 },
      { c: 'เย็นใจ', p: 'ขวด PET 1500 มล.',         price: 2.95 },
    ];
    custPrices.forEach(item => {
      const productId = pid(item.p);
      const customerId = cid(item.c);
      if (productId && customerId) this.upsertPrice(productId, customerId, 'จัดส่ง', item.price);
    });
  },

  // ─── RETURNS (รายการคืนสินค้า) ───────────────────────────────────────────────
  getReturns()          { return this._get(this.K.RETURNS); },
  saveReturns(v)        { this._set(this.K.RETURNS, v); },
  getReturnById(id)     { return this.getReturns().find(r => r.id === id) || null; },
  addReturn(r)          { const a = this.getReturns(); a.unshift(r); this.saveReturns(a); },
  updateReturn(id, patch) {
    const a = this.getReturns(), i = a.findIndex(r => r.id === id);
    if (i >= 0) { a[i] = { ...a[i], ...patch }; this.saveReturns(a); return a[i]; }
    return null;
  },
  deleteReturn(id)      { this.saveReturns(this.getReturns().filter(r => r.id !== id)); },
  // หา returns ที่ยังไม่ได้หักออกจากใบกำกับ (pendingDeduction)
  getPendingReturns()   { return this.getReturns().filter(r => !r.deductedInvoice); },

  // ─── ERROR LOG ───────────────────────────────────────────────────────────────
  getErrors()  { return this._get(this.K.ERRORS); },
  clearErrors(){ this._set(this.K.ERRORS, []); },
  logError(type, message, detail = {}) {
    try {
      const errors = this.getErrors();
      errors.unshift({
        id:        Date.now().toString(36),
        timestamp: new Date().toISOString(),
        type,
        message:   String(message).slice(0, 500),
        page:      typeof window !== 'undefined' ? window.location.pathname.split('/').pop() : '',
        user:      (() => { try { const s = JSON.parse(sessionStorage.getItem('wt_session')); return s ? s.username : 'guest'; } catch { return 'guest'; } })(),
        detail
      });
      // เก็บแค่ 200 รายการล่าสุด
      if (errors.length > 200) errors.length = 200;
      this._set(this.K.ERRORS, errors);
    } catch(e) { /* ป้องกัน infinite loop ถ้า logError เกิด error เอง */ }
  },

  // ─── AUTO BACKUP ─────────────────────────────────────────────────────────────
  isBackupDue() {
    const ab = (this.getSettings() || {}).autoBackup;
    if (!ab || !ab.enabled) return false;
    if (!ab.lastBackupAt) return true;
    const diffDays = (Date.now() - new Date(ab.lastBackupAt)) / 86400000;
    return diffDays >= ({ daily: 1, weekly: 7, monthly: 30 }[ab.interval] || 7);
  },

  markBackupDone() {
    const cfg = this.getSettings();
    if (!cfg.autoBackup) cfg.autoBackup = {};
    cfg.autoBackup.lastBackupAt = new Date().toISOString();
    this.saveSettings(cfg);
  },

  buildBackupPayload() {
    const d = { exportDate: new Date().toISOString(), exportVersion: '2.0' };
    d.settings   = this.getSettings();
    d.payMethods = this.getPayMethods();
    d.pricing    = this.getPricing();
    d.users      = this.getUsers().map(u => ({ ...u, password: '[HASHED]' }));
    d.customers  = this.getCustomers();
    d.products   = this.getProducts();
    d.invoices   = this.getInvoices();
    d.payments   = this.getPayments();
    d.versions   = this.getVersions();
    d.activity   = this.getActivity();
    d.logins     = this.getLogins();
    return d;
  },

  runAutoBackup(username) {
    if (!this.isBackupDue()) return;
    try {
      const json  = JSON.stringify(this.buildBackupPayload(), null, 2);
      const d     = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      const fn    = `auto_backup_${stamp}.json`;
      const blob  = new Blob([json], { type: 'application/json' });
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href = url; a.download = fn;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      this.markBackupDone();
      if (username) this.logActivity('system', username, 'Auto Backup', { file: fn });
    } catch(e) { console.warn('Auto backup failed:', e); }
  },

  // ─── DATA SNAPSHOTS ──────────────────────────────────────────────────────────
  // Stores up to 3 full-data snapshots in localStorage for quick rollback.
  // Excludes: activity logs, login history, JS errors (too large / non-critical).
  _SNAP_DATA_KEYS: [
    'wt_users','wt_customers','wt_products','wt_pricing','wt_invoices',
    'wt_payments','wt_inv_counter','wt_settings','wt_versions','wt_pay_methods',
    'wt_transfer_accounts','wt_cap_colors','wt_cap_receipts','wt_cap_deductions','wt_price_history','wt_returns'
  ],

  getSnapshots()       { return this._get('wt_snapshots'); },
  saveSnapshots(arr)   { this._set('wt_snapshots', arr); },

  createSnapshot(label, createdBy) {
    const data = {};
    this._SNAP_DATA_KEYS.forEach(k => {
      try {
        const v = localStorage.getItem(k);
        data[k] = v ? JSON.parse(v) : null;
      } catch { data[k] = null; }
    });
    const invs = Array.isArray(data.wt_invoices) ? data.wt_invoices : [];
    const snap = {
      id: Utils.uuid(),
      label: label || '',
      createdAt: new Date().toISOString(),
      appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION.version : '?',
      createdBy: createdBy || '',
      stats: {
        customers: Array.isArray(data.wt_customers) ? data.wt_customers.length : 0,
        invoices:  [...new Set(invs.map(i => i.invoiceNumber))].length,
        payments:  Array.isArray(data.wt_payments)  ? data.wt_payments.length  : 0,
        products:  Array.isArray(data.wt_products)  ? data.wt_products.length  : 0,
        returns:   Array.isArray(data.wt_returns)   ? data.wt_returns.length   : 0,
      },
      data,
    };
    const snaps = this.getSnapshots();
    snaps.unshift(snap);
    if (snaps.length > 3) snaps.splice(3);   // keep latest 3
    this.saveSnapshots(snaps);
    return snap;
  },

  rollbackToSnapshot(id) {
    const snap = this.getSnapshots().find(s => s.id === id);
    if (!snap || !snap.data) return false;
    Object.entries(snap.data).forEach(([k, v]) => {
      if (v !== null && v !== undefined) localStorage.setItem(k, JSON.stringify(v));
    });
    return true;
  },

  deleteSnapshot(id) {
    this.saveSnapshots(this.getSnapshots().filter(s => s.id !== id));
  },
};
