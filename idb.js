// idb.js — IndexedDB helper for persisting FileSystem directory handles across page loads
const IDB = (() => {
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

  return {
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
    }
  };
})();
