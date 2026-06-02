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
//   LocalFolderSync.selectFolder()      — showDirectoryPicker then writeAll
//   LocalFolderSync.reconnect()         — re-request permission (needs user gesture)
//   LocalFolderSync.disconnect()        — forget folder, clear IDB handle
//   LocalFolderSync.writeAll()          — flush every DB key to folder right now
//   LocalFolderSync.queueWrite(key,val) — debounced write (called by DB._set)
//   LocalFolderSync.restore()           — read folder, return map of key to parsed value
//   LocalFolderSync.getStatus()         — returns object with connected/folderName/etc (sync)
//
// Events dispatched on window:
//   localfolder:connected       detail: { name }
//   localfolder:disconnected
//   localfolder:permissionlost

// Guard: safe to load twice (Firebase chain + fallback IIFE may both request it).
if (!window.LocalFolderSync) {
  window.LocalFolderSync = (function () {

    var IDB_HANDLE_KEY = 'local_folder_handle';
    var DEBOUNCE_MS    = 3000;

    var _handle   = null;   // FileSystemDirectoryHandle or null
    var _permOk   = false;  // true once permission granted
    var _initDone = false;  // guard: init() runs only once per page load
    var _queue  = {};     // pending writes: { key: value }
    var _timer  = null;   // debounce handle

    // ── Permission helpers ────────────────────────────────────────────────

    async function _checkPerm(h) {
      try {
        return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
      } catch (e) {
        return false;
      }
    }

    async function _requestPerm(h) {
      try {
        return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
      } catch (e) {
        return false;
      }
    }

    // ── Write a single file ───────────────────────────────────────────────

    async function _writeFile(key, val) {
      if (!_handle || !_permOk) return;
      try {
        var fh = await _handle.getFileHandle(key + '.json', { create: true });
        var w  = await fh.createWritable();
        await w.write(new Blob([JSON.stringify(val, null, 2)], { type: 'application/json' }));
        await w.close();
      } catch (e) {
        if (e.name === 'NotAllowedError') {
          _permOk = false;
          console.warn('[LocalFolderSync] Permission revoked for', _handle && _handle.name);
          window.dispatchEvent(new CustomEvent('localfolder:permissionlost'));
        } else {
          console.warn('[LocalFolderSync] Write failed:', key, e.message);
        }
      }
    }

    // ── Flush the debounced write queue ───────────────────────────────────

    async function _flush() {
      _timer = null;
      if (!_handle || !_permOk) return;
      var batch   = _queue;
      _queue = {};
      var pairs = Object.entries(batch);
      for (var i = 0; i < pairs.length; i++) {
        await _writeFile(pairs[i][0], pairs[i][1]);
      }
    }

    // ── Read current value for a key from DB cache / localStorage ─────────

    function _readFromDB(key) {
      if (window.DB) {
        if (Object.prototype.hasOwnProperty.call(DB._cache, key)) {
          return DB._cache[key];
        }
        if (!DB._idbKeys.has(key)) {
          try {
            var raw = DB._lzRead(key);
            return raw ? JSON.parse(raw) : undefined;
          } catch (e) {
            return undefined;
          }
        }
      }
      return undefined;
    }

    // ── Public object ─────────────────────────────────────────────────────

    var pub = {

      // Load persisted handle, check permission, attach sync event listeners.
      // Called once by nav.js after idb.js is confirmed loaded.
      async init() {
        if (_initDone) return;          // nav.js may call init() multiple times
        _initDone = true;
        if (!window.showDirectoryPicker) return;
        if (!window.IDB)                 return;

        // Only overwrite _handle if IDB read succeeds — an IDB error must not
        // silently clear a handle that was just selected this session.
        try {
          const h = await IDB.get(IDB_HANDLE_KEY);
          _handle = h; // null if never set; valid handle if previously saved
        } catch (e) {
          // IDB unavailable — keep _handle as-is (null on fresh load)
          console.warn('[LocalFolderSync] IDB read failed:', e && e.message);
        }

        if (_handle) {
          // queryPermission does NOT need a user gesture — safe on page load.
          _permOk = await _checkPerm(_handle);
          // Notify UI so settings card re-renders with the persisted folder name.
          // Without this, renderLocalFolderCard() runs before init() completes and
          // sees _handle=null, showing "ไม่ได้เชื่อมต่อ" even though a folder was saved.
          if (_permOk) {
            window.dispatchEvent(new CustomEvent('localfolder:connected', { detail: { name: _handle.name } }));
          } else {
            // Handle exists but permission lapsed — show "⚠ ต้องการสิทธิ์" with folder name
            window.dispatchEvent(new CustomEvent('localfolder:permissionlost'));
          }
        }

        // After a full Firestore pull write everything to the folder.
        window.addEventListener('sync:pulled', async function () {
          if (!_handle || !_permOk) return;
          await pub.writeAll();
        });

        // When Firestore pushes a remote change for a specific key, mirror it.
        window.addEventListener('sync:updated', function (e) {
          if (!_handle || !_permOk) return;
          var key = e.detail && e.detail.key;
          if (!key) return;
          var val = _readFromDB(key);
          if (val !== undefined) pub.queueWrite(key, val);
        });
      },

      // Enqueue a write and reset the debounce timer.
      // Called from DB._set() after every data save.
      queueWrite(key, val) {
        if (!_handle || !_permOk) return;
        _queue[key] = val;
        if (_timer) clearTimeout(_timer);
        _timer = setTimeout(function () { _flush(); }, DEBOUNCE_MS);
      },

      // Write every DB key to the folder immediately.
      async writeAll() {
        if (!_handle || !_permOk) return;
        var keys    = window.DB ? Object.values(DB.K) : [];
        var written = 0;
        for (var i = 0; i < keys.length; i++) {
          var val = _readFromDB(keys[i]);
          if (val !== undefined && val !== null) {
            await _writeFile(keys[i], val);
            written++;
          }
        }
        console.log('[LocalFolderSync] writeAll: wrote', written, 'keys to', _handle.name);
      },

      // Show the directory picker, persist the handle, then writeAll.
      // Must be called from a user-gesture handler.
      async selectFolder() {
        if (!window.showDirectoryPicker) {
          throw new Error('File System Access API not supported');
        }
        var h = await window.showDirectoryPicker({ mode: 'readwrite' });
        _handle = h;
        _permOk = true;
        if (window.IDB) await IDB.set(IDB_HANDLE_KEY, h);
        window.dispatchEvent(new CustomEvent('localfolder:connected', { detail: { name: h.name } }));
        await pub.writeAll();
        return h.name;
      },

      // Re-request permission on an existing handle.
      // Must be called from a user-gesture handler.
      async reconnect() {
        // If init() hasn't populated _handle yet (race on settings load), reload
        // it from IDB so the reconnect button works even during that window.
        if (!_handle && window.IDB) {
          try { _handle = await IDB.get(IDB_HANDLE_KEY); } catch {}
        }
        if (!_handle) throw new Error('No folder selected — call selectFolder() first');
        _permOk = await _requestPerm(_handle);
        if (_permOk) {
          window.dispatchEvent(new CustomEvent('localfolder:connected', { detail: { name: _handle.name } }));
          await pub.writeAll();
        }
        return _permOk;
      },

      // Forget the folder and stop mirroring.
      async disconnect() {
        _handle = null;
        _permOk = false;
        _queue  = {};
        if (_timer) { clearTimeout(_timer); _timer = null; }
        if (window.IDB) await IDB.set(IDB_HANDLE_KEY, null);
        window.dispatchEvent(new CustomEvent('localfolder:disconnected'));
      },

      // Read every .json file from the folder and return { key: parsed } map.
      async restore() {
        if (!_handle) throw new Error('No folder selected');
        if (!_permOk) {
          _permOk = await _requestPerm(_handle);
          if (!_permOk) throw new Error('Permission denied');
        }
        var result = {};
        for await (var pair of _handle.entries()) {
          var name   = pair[0];
          var fEntry = pair[1];
          if (fEntry.kind !== 'file' || !name.endsWith('.json')) continue;
          var key = name.slice(0, -5);
          try {
            var f    = await fEntry.getFile();
            var text = await f.text();
            result[key] = JSON.parse(text);
          } catch (e) {
            console.warn('[LocalFolderSync] Could not read', name, e.message);
          }
        }
        return result;
      },

      // Return current status synchronously.
      getStatus() {
        return {
          supported:       !!window.showDirectoryPicker,
          connected:       !!_handle && _permOk,
          needsPermission: !!_handle && !_permOk,
          folderName:      _handle ? _handle.name : null
        };
      }

    }; // end pub

    return pub;

  }()); // end IIFE
} // end if (!window.LocalFolderSync)
