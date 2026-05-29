// storage.js — Firebase Storage helpers for image upload / delete
// ─────────────────────────────────────────────────────────────────────────────
// Depends on firebase-storage-compat.js being loaded (nav.js loads it after
// firebase-firestore-compat.js, non-blocking). Gracefully falls back to the
// original base64 data URL when Firebase Storage is unavailable (offline /
// not configured / SDK not yet loaded).
//
// Usage:
//   const url = await AppStorage.upload('payments', b64DataUrl);
//   await  AppStorage.delete('https://firebasestorage.googleapis.com/...');
//   AppStorage.isUrl(s)   → true for https:// download URLs
// ─────────────────────────────────────────────────────────────────────────────

var AppStorage = (function () {
  'use strict';

  function _store() {
    if (!window.firebase || !firebase.apps.length) return null;
    try {
      // firebase.storage is registered by firebase-storage-compat.js
      if (typeof firebase.storage !== 'function') return null;
      return firebase.storage();
    } catch { return null; }
  }

  function _orgId() {
    try {
      return (typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.orgId)
        || 'main';
    } catch { return 'main'; }
  }

  return {
    /**
     * Upload a compressed image (data: URL) to Firebase Storage.
     * Returns the permanent HTTPS download URL on success, or the original
     * base64 string if Storage is not available / upload fails.
     *
     * @param {string} folder  Logical sub-folder: 'payments'|'returns'|'cap'|'versions'
     * @param {string} dataUrl  Output of Utils.compressImage()
     * @returns {Promise<string>}
     */
    async upload(folder, dataUrl) {
      if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl; // already URL or empty
      const store = _store();
      if (!store) return dataUrl;                                    // Storage not ready
      try {
        const path = `orgs/${_orgId()}/${folder}/${Utils.uuid()}.jpg`;
        const ref  = store.ref(path);
        await ref.putString(dataUrl, 'data_url');
        const url = await ref.getDownloadURL();
        console.log('[AppStorage] uploaded →', path);
        return url;
      } catch (e) {
        console.warn('[AppStorage] upload failed — using base64 fallback:', e.message);
        return dataUrl;
      }
    },

    /**
     * Delete a file from Firebase Storage by its download URL.
     * No-op for base64 strings or legacy drv|id|ts Drive references.
     */
    async delete(url) {
      if (!url || url.startsWith('data:') || url.startsWith('drv|')) return;
      const store = _store();
      if (!store) return;
      try { await store.refFromURL(url).delete(); } catch {}
    },

    /** True for Firebase Storage / CDN download URLs (https://...) */
    isUrl(s) { return typeof s === 'string' && s.startsWith('https://'); },
  };
})();
