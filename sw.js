// sw.js — Service Worker for offline caching & app update detection
// ──────────────────────────────────────────────────────────────────
// ⚠️  เมื่อ deploy version ใหม่ ให้อัปเดต CACHE_VERSION ให้ตรงกับ APP_VERSION ใน utils.js
//     เพื่อให้ browser ล้าง cache เก่าและดาวน์โหลดไฟล์ใหม่ทั้งหมด

const CACHE_VERSION  = 'v1.2.9';
const STATIC_CACHE   = `wt-static-${CACHE_VERSION}`;
const RUNTIME_CACHE  = `wt-runtime-${CACHE_VERSION}`;

// ── App shell: ไฟล์ที่ pre-cache ตอน install ──────────────────────────────────
// ⚠️  ห้าม pre-cache ไฟล์ HTML ที่นี่!
//     เหตุผล: cache.add() ในช่วง install จะถูก intercept โดย SW เก่า (ที่ยังเป็น controller)
//     ซึ่งอาจส่งกลับ HTML ที่ truncated/stale จาก cache เก่า
//     HTML จะถูก cache โดยอัตโนมัติครั้งแรกที่โหลดผ่าน Network-First fetch handler
const APP_SHELL = [
  // Scripts & styles (safe to pre-cache — small, never served from old SW cache)
  // ⚠️  nav.js and sync.js are intentionally excluded — served Network-Only (see fetch handler)
  //     so badge/sync fixes are ALWAYS picked up immediately without a SW update cycle.
  './utils.js',
  './db.js',
  './auth.js',
  './bedate.js',
  './idb.js',
  './drive-store.js',
  './drive-db-sync.js',
  './settings.js',
  './style.css',
  './manifest.json',
  // CDN — Bootstrap
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  // html2canvas
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  // flatpickr (B.E. date picker)
  'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.js',
];

// ── INSTALL: pre-cache app shell ───────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // addAll fails silently per resource — wrap individually so one CDN miss
      // doesn't abort the whole install
      return Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] cache miss: ${url}`, err))
        )
      );
    })
  );
  // Take control immediately — don't wait for old SW to finish
  self.skipWaiting();
});

// ── ACTIVATE: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(k => k.startsWith('wt-') && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map(k => {
            console.log(`[SW] deleting old cache: ${k}`);
            return caches.delete(k);
          })
      )
    )
  );
  // Claim all open clients immediately
  self.clients.claim();
});

// ── FETCH: serve from cache, fall back to network ─────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  const isLocalFile = url.origin === self.location.origin;
  const isCDN       = url.hostname.includes('jsdelivr.net') ||
                      url.hostname.includes('googleapis.com') ||
                      url.hostname.includes('gstatic.com');
  const isFont      = url.hostname.includes('fonts.g');

  if (isLocalFile) {
    const isHTML = request.destination === 'document' ||
                   url.pathname.endsWith('.html');

    // nav.js and sync.js are always fetched from network so badge/sync fixes
    // take effect immediately without requiring users to go through an SW update cycle.
    const isNetworkOnly = isHTML ||
                          url.pathname.endsWith('/nav.js') ||
                          url.pathname.endsWith('/sync.js');

    if (isNetworkOnly) {
      // ── HTML / nav.js / sync.js: Network-Only, no caching ────────────────────
      event.respondWith(
        fetch(new Request(request.url, { cache: 'no-store' }))
          .catch(() => caches.match(request).then(c => c || caches.match('./index.html')))
      );
    } else {
      // ── JS/CSS/other local: Cache-First ──────────────────────────────────────
      event.respondWith(
        caches.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response && response.status === 200) {
              const cloned = response.clone();
              caches.open(STATIC_CACHE).then(c => c.put(request, cloned));
            }
            return response;
          }).catch(() => null);
        })
      );
    }

  } else if (isCDN || isFont) {
    // ── CDN/Fonts: Stale-While-Revalidate ────────────────────────────────────
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request)
            .then((response) => {
              if (response && response.status === 200) {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(() => cached);          // offline fallback to stale cache
          // Return cached immediately, but update in background
          return cached || networkFetch;
        })
      )
    );

  } else {
    // ── Other external: Network-First ─────────────────────────────────────────
    event.respondWith(fetch(request).catch(() => caches.match(request)));
  }
});

// ── MESSAGE: triggered by clients ─────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
