// local-folder-sync.js
// Mirror-saves every DB key to a user-selected local folder via the
// File System Access API.  Each key is saved as a separate JSON file,
// e.g. wt_invoices.json.  The folder handle is persisted in IndexedDB
// so it survives page reloads without re-prompting (browser may still
// ask once per session after a restart — that is a browser security
// requirement, not a bug).
//
// Public API (all async unless noted):
//   LocalFolderSync.init()              — load handle + attach events (nav.js)
//   LocalFolderSync.selectFolder()      — showDirectoryPicker → writeAll
//   LocalFolderSync.reconnect()         — re-request permission (needs user gesture)
//   LocalFolderSync.disconnect()        — forget folder, clear IDB handle
//   LocalFolderSync.writeAll()          — flush every DB key to folder right now
//   LocalFolderSync.queueWrite(key,val) — debounced write (called by DB._set)
//   LocalFolderSync.restore()           — read folder → { key: parsed } map
//   LocalFolderSync.getStatus()         — sync { connected, folderName, … }  (sync)
//
// Events dispatched on window:
//   localfolder:connected     — { detail: { name } }
//   localfolder:disconnected
//   localfolder:permissionlost

const LocalFolderSync = (() => {
  const IDB_HANDLE_KEY = 'local_folder_handle';
  const DEBOUNCE_MS    = 3000;   // collapse rapid saves into one batch

  let _handle  = null;   // FileSystemDirectoryHandle | null
  let _permOk  = false;  // true once queryPermission / requestPermission → 'granted'
  let _queue   = {};     // { [lsKey]: value } — pending writes
  let _timer   = null;   // debounce timer handle

  /* ── Permission helpers ──────────────────────────────────────────────── */

  async function _checkPerm(h) {
    try { return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'; }
    catch { return false; }
  }

  async function _requestPerm(h) {
    try { return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'; }
    catch { return false; }
  }

  /* ── Write a single file ─────────────────────────────────────────────── */

  async function _writeFile(key, val) {
    if (!_handle || !_permOk) return;
    try {
      const fh = await _handle.getFileHandle(key + '.json', { create: true });
      const w  = await fh.createWritable();
      await w.write(new Blob([JSON.stringify(val, null, 2)], { type: 'application/json' }));
      await w.close();
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        // Permission was revoked while we were running — mark as disconnected
        _permOk = false;
        console.warn('[LocalFolderSync] Permission revoked for', _handle && _handle.name);
        window.dispatchEvent(new CustomEvent('localfolder:permissionlost'));
      } else {
        console.warn('[LocalFolderSync] Write failed:', key, e.message);
      }
    }
  }

  /* ── Flush the write queue ───────────────────────────────────────────── */

  async function _flush() {
    _timer = null;
    if (!_handle || !_permOk) return;
    const batch = _queue;
    _queue = {};
    for (const [key, val] of Object.entries(batch)) {
      await _writeFile(key, val);
    }
  }

  /* ── Collect current value for a key from DB ─────────────────────────── */

  function _readFromDB(key) {
    // Prefer in-memory cache (always up-to-date after a _set call)
    if (window.DB) {
      if (Object.prototype.hasOwnProperty.call(DB._cache, key)) return DB._cache[key];
      // Key not in cache — read from localStorage (handles LZString)
      if (!DB._idbKeys.has(key)) {
        try {
          const raw = DB._lzRead(key);
          return raw ? JSON.parse(raw) : undefined;
        } catch { return undefined; }
      }
      // IDB-overflow key: cache should have been populated by preloadFromIDB.
      // If not yet loaded, skip (it'll be written on next _set call).
      return undefined;
    }
    return undefined;
  }

  /* ── Public object ───────────────────────────────────────────────────── */

  const pub = {

    /**
     * Load handle from IDB, check stored permission, attach Firestore-sync
     * event listeners so the folder stays current after a pull or remote update.
     * Called once by nav.js after idb.js is ready.
     */
    async init() {
      if (!window.showDirectoryPicker) return;  // browser doesn't support API
      if (!window.IDB) return;                  // idb.js not loaded yet

      try { _handle = await IDB.get(IDB_HANDLE_KEY); } catch { _handle = null; }

      if (_handle) {
        // queryPermission does NOT require a user gesture — safe to call on load.
        // If the result is 'prompt' we keep the handle so the user can reconnect
        // with a single button click (Reconnect) rather than re-picking the folder.
        _permOk = await _checkPerm(_handle);
      }

      // After a full Firestore pull, mirror everything to the folder
      window.addEventListener('sync:pulled', async () => {
        if (!_handle || !_permOk) return;
        await pub.writeAll();
      });

      // When Firestore pushes a remote change for a specific key, update that file
      window.addEventListener('sync:updated', (e) => {
        if (!_handle || !_permOk) return;
        const key = e.detail && e.detail.key;
        if (!key) return;
        const val = _readFromDB(key);
        if (val !== undefined) pub.queueWrite(key, val);
      });
    },

    /**
     * Enqueue a write and reset the debounce timer.
     * Called from DB._set() after every localStorage/IDB write.
     */
    queueWrite(key, val) {
      if (!_handle || !_permOk) return;
      _queue[key] = val;
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => _flush(), DEBOUNCE_MS);
    },

    /**
     * Immediately write every DB key to the folder.
     * Reads from cache first; falls back to localStorage for uncached keys.
     */
    async writeAll() {
      if (!_handle || !_permOk) return;
      const keys = window.DB ? Object.values(DB.K) : [];
      let written = 0;
      for (const key of keys) {
        const val = _readFromDB(key);
        if (val !== undefined && val !== null) {
          await _writeFile(key, val);
          written++;
        }
      }
      console.log('[LocalFolderSync] writeAll: wrote', written, 'keys →', _handle.name);
    },

    /**
     * Show the directory picker, store the handle in IDB, then do a full write.
     * Must be called from a user-gesture handler.
     * @returns {string} The selected folder name.
     */
    async selectFolder() {
      if (!window.showDirectoryPicker) throw new Error('File System Access API not supported in this browser');
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      _handle = h;
      _permOk = true;
      if (window.IDB) await IDB.set(IDB_HANDLE_KEY, h);
      window.dispatchEvent(new CustomEvent('localfolder:connected', { detail: { name: h.name } }));
      await pub.writeAll();
      return h.name;
    },

    /**
     * Re-request permission on the existing handle.
     * Must be called from a user-gesture handler.
     * @returns {boolean} Whether permission was granted.
     */
    async reconnect() {
      if (!_handle) throw new Error('No folder selected — call selectFolder() first');
      _permOk = await _requestPerm(_handle);
      if (_permOk) {
        window.dispatchEvent(new CustomEvent('localfolder:connected', { detail: { name: _handle.name } }));
        await pub.writeAll();
      }
      return _permOk;
    },

    /**
     * Forget the folder: clear the IDB handle and stop all mirroring.
     */
    async disconnect() {
      _handle = null;
      _permOk = false;
      _queue  = {};
      if (_timer) { clearTimeout(_timer); _timer = null; }
      if (window.IDB) await IDB.set(IDB_HANDLE_KEY, null);
      window.dispatchEvent(new CustomEvent('localfolder:disconnected'));
    },

    /**
     * Read every *.json file in the folder and return a { key: parsed } map.
     * Useful for disaster-recovery restore in settings.
     * @returns {Object} map of key → parsed value
     */
    async restore() {
      if (!_handle) throw new Error('No folder selected');
      if (!_permOk) {
        _permOk = await _requestPerm(_handle);
        if (!_permOk) throw new Error('Permission denied — please grant access to the folder');
      }
      const result = {};
      for await (const [name, entry] of _handle.entries()) {
        if (entry.kind !== 'file' || !name.endsWith('.json')) continue;
        const key = name.slice(0, -5);   // strip .json suffix
        try {
          const file = await entry.getFile();
          const text = await file.text();
          result[key] = JSON.parse(text);
        } catch (e) {
          console.warn('[LocalFolderSync] Could not read', name, e.message);
        }
      }
      return result;
    },

    /**
     * Return current connection status (synchronous — no await needed).
     */
    getStatus() {
      return {
        supported:       !!window.showDirectoryPicker,
        connected:       !!_handle && _permOk,
        needsPermission: !!_handle && !_permOk,
        folderName:      _handle ? _handle.name : null,
      };
    },
  };

  return pub;
})();
