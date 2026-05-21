// connection-status.js — Firestore fromCache connection banner
// ─────────────────────────────────────────────────────────────────────────────
// Listens for `sync:connectionstate` events dispatched by sync.js whenever a
// snapshot's metadata.fromCache value changes.
//
// fromCache === true  → Firestore is serving data from its local IndexedDB cache
//                       (offline or reconnecting) — show the pending-sync banner.
// fromCache === false → Firestore confirmed a live server snapshot — hide banner.
//
// The banner is a non-blocking fixed bottom bar that sits ABOVE the SW update
// banner (z-index 99996 vs 99998 for the SW banner).  It has a manual close
// button so users can dismiss it without waiting for reconnection.
// ─────────────────────────────────────────────────────────────────────────────

var ConnectionStatus = {
  _bannerId: 'firestoreCacheBanner',
  _fromCache: false,

  init() {
    window.addEventListener('sync:connectionstate', (e) => {
      this._update(!!e.detail?.fromCache);
    });
  },

  _update(fromCache) {
    this._fromCache = fromCache;
    if (fromCache) {
      this._show();
    } else {
      this._hide();
    }
  },

  _show() {
    if (document.getElementById(this._bannerId)) return; // already visible

    const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';

    const div = document.createElement('div');
    div.id = this._bannerId;
    div.setAttribute('style',
      'position:fixed;bottom:0;left:0;right:0;z-index:99996;' +
      'background:' + (isDark ? '#92400e' : '#d97706') + ';' +
      'color:#fff;text-align:center;padding:8px 16px;font-size:13px;font-weight:600;' +
      'display:flex;align-items:center;justify-content:center;gap:8px;' +
      'box-shadow:0 -2px 8px rgba(0,0,0,.2)');

    div.innerHTML =
      '<span>⏳ รอการอัปเดต — การเปลี่ยนแปลงจะซิงค์เมื่อเชื่อมต่ออีกครั้ง</span>' +
      '<button id="' + this._bannerId + 'Close" ' +
      'style="background:transparent;border:1px solid rgba(255,255,255,.55);border-radius:4px;' +
      'padding:2px 9px;color:#fff;font-size:12px;cursor:pointer;flex-shrink:0" ' +
      'onclick="ConnectionStatus._hide()">✕</button>';

    document.body.appendChild(div);
  },

  _hide() {
    const el = document.getElementById(this._bannerId);
    if (el) el.remove();
  },
};

// Auto-initialise once the DOM is ready (nav.js loads this file dynamically so
// DOMContentLoaded may have already fired — fall back to immediate init).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ConnectionStatus.init());
} else {
  ConnectionStatus.init();
}
