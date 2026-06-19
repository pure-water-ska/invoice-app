// idb.js — IndexedDB helpers
// IDB        — FileSystem directory handles (wt_handles_v1)
// IDB.data   — App key-value data store (wt_data_v1), used as overflow when localStorage is full

const IDB = (() => {
  // ── Handles store (directory handles for File System Access API) ──────────
  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('wt_handles_v1', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  // ── Data store (app key-value, overflow from localStorage) ───────────────
  let _dataDb = null;
  const _DATA_DB = 'wt_data_v1';
  const _DATA_STORE = 'data';

  function _openData() {
    if (_dataDb) return Promise.resolve(_dataDb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(_DATA_DB, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(_DATA_STORE);
      req.onsuccess = e => { _dataDb = e.target.result; resolve(_dataDb); };
      req.onerror = e => reject(e.target.error);
    });
  }

  const data = {
    /** Store any value (object, array, string) under key. */
    async set(key, value) {
      const db = await _openData();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_DATA_STORE, 'readwrite');
        const store = tx.objectStore(_DATA_STORE);
        if (value == null) store.delete(key); else store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
    },
    /** Retrieve value for key, or null if not found. */
    async get(key) {
      const db = await _openData();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_DATA_STORE, 'readonly');
        const req = tx.objectStore(_DATA_STORE).get(key);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror = e => reject(e.target.error);
      });
    },
    /** Return all {key, value} pairs in the store. */
    async getAll() {
      const db = await _openData();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_DATA_STORE, 'readonly');
        const store = tx.objectStore(_DATA_STORE);
        const results = {};
        const curReq = store.openCursor();
        curReq.onsuccess = e => {
          const cursor = e.target.result;
          if (cursor) { results[cursor.key] = cursor.value; cursor.continue(); }
          else resolve(results);
        };
        curReq.onerror = e => reject(e.target.error);
      });
    },
    /** Delete a key from the store. */
    async delete(key) {
      const db = await _openData();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_DATA_STORE, 'readwrite');
        tx.objectStore(_DATA_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
    }
  };

  // ── Images store (base64 blobs, kept OUT of DB._cache to save RAM) ────────
  // Its own database so preloadFromIDB()/IDB.data.getAll() never pull image blobs
  // into the in-memory cache. Loaded on demand by image-store.js (Images.get).
  let _imgDb = null;
  function _openImg() {
    if (_imgDb) return Promise.resolve(_imgDb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('wt_images_v1', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('images');
      req.onsuccess = e => { _imgDb = e.target.result; resolve(_imgDb); };
      req.onerror = e => reject(e.target.error);
    });
  }
  const images = {
    async set(id, base64) {
      const db = await _openImg();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        if (base64 == null) tx.objectStore('images').delete(id); else tx.objectStore('images').put(base64, id);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
    },
    async get(id) {
      const db = await _openImg();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').get(id);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror = e => reject(e.target.error);
      });
    },
    async delete(id) {
      const db = await _openImg();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
    }
  };

  return {
    // Handles store methods (unchanged)
    async set(key, value) {
      const db = await _open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        const store = tx.objectStore('handles');
        if (value == null) store.delete(key); else store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
    },
    async get(key) {
      const db = await _open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get(key);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror = e => reject(e.target.error);
      });
    },
    // Data store namespace
    data,
    // Images store namespace (separate DB, never loaded into DB._cache)
    images
  };
})();
