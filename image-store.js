// image-store.js — offload base64 images out of DB records to keep them out of the
// in-memory DB._cache (RAM). An image is stored as its own entity:
//   • local IndexedDB (IDB.images) for fast offline access — NEVER loaded into _cache
//   • Firestore `images/{id}` collection so it syncs across devices (loaded on demand)
// A record field that used to hold a base64 data URL now holds a small reference
// string "img:<id>" instead. Old records that still hold "data:..." keep working.
//
// Usage:
//   const ref = await Images.store(base64);   // returns "img:<id>"  (or '' if empty)
//   img.src   = await Images.resolve(value);  // value = "img:<id>" OR old "data:..." OR ''
//   await Images.del(value);                  // remove the underlying image
(function () {
  const COL = 'images';
  const PREFIX = 'img:';
  const _mem = new Map();   // small in-session memo (recently viewed) to avoid refetch

  function _memo(id, b64) {
    if (_mem.size > 24) _mem.clear();
    _mem.set(id, b64);
  }
  function _orgCol() {
    if (window.Sync && Sync.ready && typeof Sync._orgRef === 'function') {
      try { return Sync._orgRef().collection(COL); } catch (e) {}
    }
    return null;
  }

  const Images = {
    isRef(v) { return typeof v === 'string' && v.lastIndexOf(PREFIX, 0) === 0; },
    isInline(v) { return typeof v === 'string' && v.lastIndexOf('data:', 0) === 0; },

    // Store a base64 data URL and return a "img:<id>" reference. Writes the local
    // IDB copy FIRST (durable, offline) then pushes to Firestore best-effort. If the
    // Firestore push fails (offline/quota) the local copy still exists and a later
    // resolve on THIS device works; cross-device will fill in once it syncs.
    // opts.requireRemote: if true, THROW when the Firestore push fails — used by the
    // Phase-2 migration so it only strips the original base64 once the image is safely
    // on the server (cross-device + crash-safe). Normal saves omit it (local-first).
    async store(base64, opts) {
      if (!base64 || typeof base64 !== 'string') return base64 || '';
      if (this.isRef(base64)) return base64;                 // already a ref
      if (!this.isInline(base64)) return base64;             // not an image — leave as-is
      const id = (typeof Utils !== 'undefined' && Utils.uuid)
        ? Utils.uuid()
        : ('i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      try { if (typeof IDB !== 'undefined' && IDB.images) await IDB.images.set(id, base64); } catch (e) { console.warn('[Images] IDB set failed', e); }
      _memo(id, base64);
      let remoteOK = false;
      try {
        const col = _orgCol();
        if (col) { await col.doc(id).set({ data: base64, _ts: Date.now(), _by: (window.Sync && Sync._deviceId) || '' }); remoteOK = true; }
      } catch (e) { console.warn('[Images] Firestore put failed (kept local):', e.message); }
      if (opts && opts.requireRemote && !remoteOK) {
        try { if (typeof IDB !== 'undefined' && IDB.images) await IDB.images.delete(id); } catch (e) {}
        _mem.delete(id);
        throw new Error('image upload to server failed (offline/quota)');
      }
      return PREFIX + id;
    },

    // Resolve a stored value to a base64 data URL for display. Accepts a ref
    // ("img:<id>"), an old inline data URL, or ''. Returns '' if not found.
    async resolve(value) {
      if (!value) return '';
      if (this.isInline(value)) return value;                // legacy inline base64
      if (!this.isRef(value)) return value;                  // unknown — return as-is
      const id = value.slice(PREFIX.length);
      if (_mem.has(id)) return _mem.get(id);
      try {
        if (typeof IDB !== 'undefined' && IDB.images) {
          const b = await IDB.images.get(id);
          if (b) { _memo(id, b); return b; }
        }
      } catch (e) { console.warn('[Images] IDB get failed', e); }
      try {
        const col = _orgCol();
        if (col) {
          const doc = await col.doc(id).get();
          if (doc.exists && doc.data() && doc.data().data) {
            const b = doc.data().data;
            try { if (typeof IDB !== 'undefined' && IDB.images) await IDB.images.set(id, b); } catch (e) {}
            _memo(id, b);
            return b;
          }
        }
      } catch (e) { console.warn('[Images] Firestore resolve failed', e.message); }
      return '';
    },

    // Remove an image (local + Firestore). Safe on refs only; ignores inline/empty.
    async del(value) {
      if (!this.isRef(value)) return;
      const id = value.slice(PREFIX.length);
      _mem.delete(id);
      try { if (typeof IDB !== 'undefined' && IDB.images) await IDB.images.delete(id); } catch (e) {}
      try { const col = _orgCol(); if (col) await col.doc(id).delete(); } catch (e) {}
    }
  };

  window.Images = Images;
})();
