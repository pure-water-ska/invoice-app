// sw.js — Service Worker for offline caching & app update detection
// ──────────────────────────────────────────────────────────────────
// ⚠️  เมื่อ deploy version ใหม่ ให้อัปเดต CACHE_VERSION ให้ตรงกับ APP_VERSION ใน utils.js
//     เพื่อให้ browser ล้าง cache เก่าและดาวน์โหลดไฟล์ใหม่ทั้งหมด

const CACHE_VERSION  = 'v1.0.14';
const STATIC_CACHE   = `wt-static-${CACHE_VERSION}`;
const RUNTIME_CACHE  = `wt-runtime-${CACHE_VERSION}`;

// ── App shell: ไฟล์ที่ pre-cache ตอน install ──────────────────────────────────
// ⚠️  ห้าม pre-cache ไฟล์ HTML ที่นี่!
//     เหตุผล: cache.add() ในช่วง install จะถูก intercept โดย SW เก่า (ที่ยังเป็น controller)
//     ซึ่งอาจส่งกลับ HTML ที่ truncated/stale จาก cache เก่า
//     HTML จะถูก cache โดยอัตโนมัติครั้งแรกที่โหลดผ่าน Network-First fetch handler
const APP_SHELL = [
  // Scripts & styles (safe to pre-cache — small, never served from old SW cache)
  // ⚠️  nav.js, sync.js, and settings.js are intentionally excluded — served Network-Only
  //     so badge/sync/settings fixes are ALWAYS picked up immediately without a SW update cycle.
  './utils.js',
  './db.js',
  './auth.js',
  './bedate.js',
  './idb.js',
  './drive-store.js',
  './drive-db-sync.js',
  './style.css',
  './manifest.json',
  // Vendor assets (self-hosted — avoids Edge Tracking Prevention blocking jsdelivr.net)
  './vendor/bootstrap.min.css',
  './vendor/bootstrap.bundle.min.js',
  './vendor/bootstrap-icons.min.css',
  './vendor/fonts/bootstrap-icons.woff2',
  './vendor/fonts/bootstrap-icons.woff',
  './vendor/html2canvas.min.js',
  // flatpickr (B.E. date picker)
  'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.js',
  // QR code generator (used in payment summary print)
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
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

    // nav.js, sync.js, connection-status.js, and settings.js are always fetched from
    // network so fixes take effect immediately without requiring an SW update cycle.
    const isNetworkOnly = isHTML ||
                          url.pathname.endsWith('/nav.js') ||
                          url.pathname.endsWith('/sync.js') ||
                          url.pathname.endsWith('/customer-sync.js') ||
                          url.pathname.endsWith('/collection-sync.js') ||
                          url.pathname.endsWith('/product-sync.js') ||
                          url.pathname.endsWith('/pricing-sync.js') ||
                          url.pathname.endsWith('/pricing-grouped-sync.js') ||
                          url.pathname.endsWith('/user-sync.js') ||
                          url.pathname.endsWith('/db.js') ||
                          url.pathname.endsWith('/connection-status.js') ||
                          url.pathname.endsWith('/image-store.js') ||
                          url.pathname.endsWith('/idb.js') ||
                          url.pathname.endsWith('/settings.js');

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
          }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
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
    event.respondWith(fetch(request).catch(() => caches.match(request).then(c => c || new Response('', { status: 503, statusText: 'Offline' }))));
  }
});

// ── MESSAGE: triggered by clients ─────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── BACKGROUND SYNC: flush pending Firestore writes ───────────────────────────
// Triggered by the browser when connectivity is restored, even if the page was
// backgrounded or closed since the write was queued.
// Strategy: we can't use the Firestore SDK here (no Firebase in the SW context),
// so we forward the wake-up to all open clients by posting FLUSH_PENDING_WRITES.
// The page's sync.js then calls _flushQueue() which replays the localStorage queue.
// Browsers without Background Sync support (Safari, Firefox) fall back to
// Firestore's own built-in offline write queue + the window 'online' listener.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-writes') {
    event.waitUntil(
      self.clients
        .matchAll({ includeUncontrolled: true, type: 'window' })
        .then((clients) => {
          if (clients.length === 0) {
            // No open tabs — Firestore's own offline queue will flush when next opened
            console.log('[SW] Background Sync: no clients to notify');
            return;
          }
          clients.forEach((client) =>
            client.postMessage({ type: 'FLUSH_PENDING_WRITES' })
          );
          console.log(`[SW] Background Sync: notified ${clients.length} client(s)`);
        })
    );
  }
});
