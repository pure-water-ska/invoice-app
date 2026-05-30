// nav.js - Navigation bar generator

// Apply dark mode early (before paint) to prevent flash
(function() {
  if (localStorage.getItem('wt_dark_mode') === '1') {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
  }
})();

// ── PWA Install prompt capture ────────────────────────────────────────────────
(function() {
  var _pwaPrompt = null;

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    _pwaPrompt = e;
    _showPwaBtn();
  });

  window.addEventListener('appinstalled', function() {
    _pwaPrompt = null;
    _hidePwaBtn();
  });

  function _showPwaBtn() {
    // May be called before Nav.render() — retry if button container not yet ready
    function tryShow() {
      var btn = document.getElementById('pwaInstallBtn');
      if (!btn) { setTimeout(tryShow, 400); return; }
      btn.style.display = '';
    }
    tryShow();
  }

  function _hidePwaBtn() {
    var btn = document.getElementById('pwaInstallBtn');
    if (btn) btn.style.display = 'none';
  }

  window._pwaInstall = function() {
    if (!_pwaPrompt) return;
    _pwaPrompt.prompt();
    _pwaPrompt.userChoice.then(function(result) {
      if (result.outcome === 'accepted') {
        _pwaPrompt = null;
        _hidePwaBtn();
      }
    });
  };
})();

// ── Service Worker Registration & Update Banner ──────────────────────────────
(function() {
  if (!('serviceWorker' in navigator)) return;

  // ── Desktop app: NO service worker ───────────────────────────────────────
  // A SW caches assets (db.js, etc.) Cache-First. In the desktop app the SW
  // cache is frozen at whatever was first cached and is NOT busted by an
  // auto-update, so it keeps serving STALE pre-fix JS even after the app
  // updates — every db.js fix silently fails to load. The desktop app loads
  // from the local bundle and needs no offline cache, so unregister any SW and
  // purge its caches, then never register one. nav.js is Network-Only so this
  // freshly-loaded copy runs even when an old SW is still active.
  if (window.IS_TAURI) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
    }
    return;
  }

  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./sw.js').then(function(reg) {

      // New SW waiting → show update banner
      function showUpdateBanner(worker) {
        const id = 'swUpdateBanner';
        if (document.getElementById(id)) return;
        const div = document.createElement('div');
        div.id = id;
        div.setAttribute('style',
          'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:#0d6efd;' +
          'color:#fff;text-align:center;padding:10px 16px;font-size:13px;font-weight:600;' +
          'display:flex;align-items:center;justify-content:center;gap:12px');
        div.innerHTML =
          '<span>🔄 มีการอัปเดตใหม่พร้อมใช้งาน</span>' +
          '<button style="background:#fff;color:#0d6efd;border:none;border-radius:4px;' +
          'padding:4px 14px;font-size:13px;font-weight:700;cursor:pointer"' +
          ' onclick="(function(){navigator.serviceWorker.controller && ' +
          'navigator.serviceWorker.controller.postMessage(\'SKIP_WAITING\');' +
          'location.reload();})()">' +
          'อัปเดตทันที</button>' +
          '<button style="background:transparent;border:1px solid rgba(255,255,255,.5);' +
          'border-radius:4px;padding:4px 10px;font-size:12px;color:#fff;cursor:pointer"' +
          ' onclick="document.getElementById(\'swUpdateBanner\').remove()">ทีหลัง</button>';
        document.body.appendChild(div);
      }

      if (reg.waiting) showUpdateBanner(reg.waiting);
      reg.addEventListener('updatefound', function() {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', function() {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });

      // Reload when SW activates after user clicks update
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function() {
        if (!refreshing) { refreshing = true; location.reload(); }
      });

    }).catch(function(err) {
      console.warn('[SW] registration failed:', err);
    });
  });
})();

// ── Online / Offline indicator ────────────────────────────────────────────────
(function() {
  function showOfflineBanner() {
    const id = 'offlineBanner';
    if (document.getElementById(id)) return;
    const div = document.createElement('div');
    div.id = id;
    div.setAttribute('style',
      'position:fixed;top:0;left:0;right:0;z-index:99997;background:#6c757d;' +
      'color:#fff;text-align:center;padding:6px 16px;font-size:12px;font-weight:600');
    div.textContent = '📴 ไม่มีการเชื่อมต่ออินเทอร์เน็ต — ใช้งาน Offline Mode';
    document.body.appendChild(div);
    // Push page content down
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || 0) + 32) + 'px';
  }
  function hideOfflineBanner() {
    const el = document.getElementById('offlineBanner');
    if (el) {
      document.body.style.paddingTop = Math.max(0, parseInt(document.body.style.paddingTop || 0) - 32) + 'px';
      el.remove();
    }
  }
  window.addEventListener('online',  function() {
    hideOfflineBanner();
    // Check for SW update when coming back online
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => { if (reg) reg.update(); });
    }
  });
  window.addEventListener('offline', showOfflineBanner);
  if (!navigator.onLine) showOfflineBanner();
})();

// ── Load Firebase SDK + sync.js (only if firebase-config.js exists) ──────────
(function loadFirebaseSync() {
  function loadScript(src, cb, errCb) {
    const s = document.createElement('script');
    s.src = src;
    s.onload  = cb  || function(){};
    s.onerror = errCb || function(){};
    document.head.appendChild(s);
  }

  // Show / update the sync badge (works even before sync.js loads)
  function setSyncBadge(text, cls) {
    // Badge item might not be in DOM yet if Nav.render() hasn't run — retry
    function tryShow() {
      const bi = document.getElementById('syncBadgeItem');
      const badge = document.getElementById('syncStatusBadge');
      if (!bi || !badge) { setTimeout(tryShow, 200); return; }
      bi.style.display = '';
      badge.textContent = text;
      badge.className = 'badge ' + cls + ' ms-2 py-1 px-2';
      badge.style.fontSize = '10px';
    }
    tryShow();
  }

  // v9.23.0 = last v9 release — use compat packages which include
  // enableIndexedDbPersistence().  Firebase v10 removed this API from the compat
  // layer, breaking offline cache and causing every onSnapshot() to hit the server
  // for its initial snapshot (very expensive for large invoice collections).
  const FB_VER = '9.23.0';
  const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VER}`;

  // Hide badge helper (for when Firebase is not configured)
  function hideSyncBadge() {
    function tryHide() {
      const bi = document.getElementById('syncBadgeItem');
      if (!bi) { setTimeout(tryHide, 200); return; }
      bi.style.display = 'none';
    }
    tryHide();
  }

  // Try loading firebase-config.js; if it doesn't exist, stop (offline-only mode)
  loadScript('./firebase-config.js', function() {
    if (typeof FIREBASE_CONFIG === 'undefined' || !FIREBASE_CONFIG.apiKey ||
        FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...')) {
      hideSyncBadge(); // Not configured — hide badge
      return;
    }

    // Try loading local credentials override (firebase-credentials.js)
    // Gitignored — only exists on local dev machines (localhost / 127.0.0.1).
    // Skip entirely on GitHub Pages / Netlify to avoid a console 404.
    const _isLocal = ['localhost','127.0.0.1'].includes(location.hostname) ||
                     location.protocol === 'file:' || window.IS_TAURI;
    if (_isLocal) {
      loadScript('./firebase-credentials.js', startFirebaseSDK, startFirebaseSDK);
    } else {
      startFirebaseSDK();
    }

    function startFirebaseSDK() {
    // Firebase IS configured — show badge immediately
    setSyncBadge('⏳ Connecting…', 'bg-warning text-dark');

    function onSDKError() {
      setSyncBadge('⚠ Sync ✗', 'bg-danger');
    }

    // Inner function: load Firestore SDK then the rest of the sync stack.
    // Called directly in Tauri (no auth-compat) or after auth-compat on web.
    function loadFirestoreAndSync() {
      loadScript(`${FB_BASE}/firebase-firestore-compat.js`, function() {
        // Ensure idb.js is available — some pages include it as a static <script>,
        // others don't.  sync.js and db.js both rely on IDB for device-ID storage
        // and localStorage-overflow data.  Load it here if not already present.
        function loadSyncStack() {
          // Load local-folder-sync.js (IDB is guaranteed loaded at this point)
          // then connection-status.js, then sync.js
          function afterFolderSync() {
            if (window.LocalFolderSync) LocalFolderSync.init();
            loadScript('./connection-status.js', function() {
              loadScript('./sync.js', null, onSDKError);
            }, function() {
              loadScript('./sync.js', null, onSDKError);
            });
          }
          if (!window.LocalFolderSync) {
            loadScript('./local-folder-sync.js', afterFolderSync, afterFolderSync);
          } else {
            afterFolderSync();
          }
        }
        if (typeof IDB === 'undefined') {
          loadScript('./idb.js', loadSyncStack, loadSyncStack);
        } else {
          loadSyncStack();
        }
      }, onSDKError);
    }

    // firebase-auth-compat.js is loaded on ALL platforms (including Tauri).
    // In Tauri, sync.js calls setPersistence(NONE) before signing in, which
    // prevents the SDK from creating the hidden __/auth/iframe session manager
    // (that iframe is rejected by Google's OAuth policy for tauri:// origins).
    loadScript(`${FB_BASE}/firebase-app-compat.js`, function() {
      loadScript(`${FB_BASE}/firebase-auth-compat.js`, loadFirestoreAndSync, onSDKError);
    }, onSDKError);
    } // end startFirebaseSDK
  }, function() {
    hideSyncBadge(); // firebase-config.js not found — local-only mode, hide badge
  });
})();

// ── Load Local Folder Sync (also active without Firebase) ────────────────────
// When Firebase IS configured, local-folder-sync.js is loaded by the Firebase
// sync stack above (after idb.js is guaranteed ready).
// When Firebase is NOT configured (offline-only mode), this block loads both
// idb.js and local-folder-sync.js independently so the feature still works.
(function loadLocalFolderSyncFallback() {
  // Guard: if the Firebase chain already loaded it, do nothing
  if (window.LocalFolderSync) return;

  function loadScript(src, cb, errCb) {
    const s = document.createElement('script');
    s.src = src; s.onload = cb || function(){}; s.onerror = errCb || function(){};
    document.head.appendChild(s);
  }

  function loadLFS() {
    if (window.LocalFolderSync) { LocalFolderSync.init(); return; }
    loadScript('./local-folder-sync.js', function() {
      if (window.LocalFolderSync) LocalFolderSync.init();
    });
  }

  // Wait up to 2 s to see if the Firebase chain loads it first; if not, load
  // idb.js + local-folder-sync.js ourselves.
  var waited = 0;
  var iv = setInterval(function() {
    waited += 200;
    if (window.LocalFolderSync) { clearInterval(iv); return; } // Firebase chain beat us
    if (waited >= 2000) {
      clearInterval(iv);
      if (typeof IDB !== 'undefined') {
        loadLFS();
      } else {
        loadScript('./idb.js', loadLFS, function() {});
      }
    }
  }, 200);
})();

// ── Load Google Drive store on every page (only if drive-config.js exists) ───
// Some pages (pdf-import, settings) also include drive-store.js statically; both
// drive-config.js (window assignment) and drive-store.js (guarded) are safe to
// load twice. Loading here makes DriveStore + GOOGLE_CLIENT_ID available on
// dashboard etc. so the post-login connection modal can show/connect Drive.
// NOTE: skipped in the Tauri desktop app — Google OAuth rejects tauri:// origins.
(function loadDriveStoreGlobal() {
  if (window.IS_TAURI) return;   // Drive not available in Tauri desktop app
  function loadScript(src, cb, errCb) {
    const s = document.createElement('script');
    s.src = src;
    s.onload  = cb  || function(){};
    s.onerror = errCb || function(){};
    document.head.appendChild(s);
  }
  loadScript('./drive-config.js', function() {
    if (typeof GOOGLE_CLIENT_ID === 'undefined' || typeof GOOGLE_CLIENT_ID !== 'string' ||
        !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_ID.includes('.apps.')) return; // not configured

    // Load drive-store.js (guarded — safe to double-load)
    function afterDriveStore() {
      // Load drive-db-sync.js (guarded — safe to double-load)
      if (!window.DriveDbSync) loadScript('./drive-db-sync.js');
    }

    if (window.DriveStore) {
      // Already loaded by a page's static <script> — just load db-sync
      afterDriveStore();
    } else {
      loadScript('./drive-store.js', afterDriveStore); // sets window.DriveStore + auto-inits
    }
  }, function() { /* drive-config.js missing — Drive disabled, silent */ });
})();

// CDN fallback check — runs after all scripts load
window.addEventListener('load', function() {
  if (typeof window.bootstrap !== 'undefined') return;
  const div = document.createElement('div');
  div.setAttribute('style',
    'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#dc3545;' +
    'color:#fff;text-align:center;padding:10px 16px;font-size:13px;font-weight:600');
  div.innerHTML = '⚠️ ไม่สามารถโหลด Bootstrap JS ได้ — กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต ' +
    '(<a href="#" style="color:#fff;text-decoration:underline" onclick="location.reload()">โหลดซ้ำ</a>)';
  document.body.appendChild(div);
});

const Nav = {
  toggleDark() {
    const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-bs-theme');
      localStorage.setItem('wt_dark_mode', '0');
    } else {
      document.documentElement.setAttribute('data-bs-theme', 'dark');
      localStorage.setItem('wt_dark_mode', '1');
    }
    const icon = document.getElementById('darkModeIcon');
    if (icon) icon.className = `bi bi-${isDark ? 'moon-stars-fill' : 'sun-fill'}`;
  },

  render(active) {
    const s = Auth.session();
    if (!s) return;
    const cfg = DB.getSettings();
    const links = [
      { id: 'dashboard',       href: 'dashboard.html',      icon: 'speedometer2',    label: 'Dashboard',        perm: 'dashboard' },
      { id: 'invoices',        href: 'invoices.html',       icon: 'receipt',         label: 'ใบกำกับสินค้า',    perm: 'invoices' },
      { id: 'invoice-create',  href: 'invoice-create.html', icon: 'plus-circle',     label: 'สร้างใบใหม่',      perm: 'invoice_create' },
      { id: 'payments',        href: 'payments.html',       icon: 'cash-coin',       label: 'ชำระเงิน',         perm: 'payments' },
      { id: 'customers',       href: 'customers.html',      icon: 'people',          label: 'ลูกค้า',           perm: 'customers' },
      { id: 'products',        href: 'products.html',       icon: 'box-seam',        label: 'สินค้า',           perm: 'products' },
      { id: 'pricing',         href: 'pricing.html',        icon: 'tags',            label: 'ราคาสินค้า',       perm: 'pricing' },
      { id: 'reports',         href: 'reports.html',        icon: 'bar-chart-line',  label: 'รายงาน',           perm: 'reports' },
      { id: 'versions',        href: 'versions.html',       icon: 'tag',             label: 'ฉลากขวด',          perm: 'versions' },
      { id: 'cap-stock',       href: 'cap-stock.html',      icon: 'box2-heart',      label: 'สต๊อกฝาขวด',       perm: 'cap_stock' },
      { id: 'returns',         href: 'returns.html',        icon: 'arrow-return-left', label: 'คืนสินค้า',        perm: 'returns' },
      { id: 'help',            href: 'help.html',           icon: 'question-circle',   label: 'คู่มือ' },
    ];
    const adminLinks = [
      { id: 'users',           href: 'users.html',          icon: 'person-gear',             label: 'จัดการผู้ใช้' },
      { id: 'pdf-import',      href: 'pdf-import.html',     icon: 'file-earmark-pdf',        label: 'นำเข้า PDF' },
      { id: 'price-import',    href: 'price-import.html',   icon: 'file-earmark-excel',      label: 'นำเข้าราคา Excel' },
      { id: 'customer-import', href: 'customer-import.html',icon: 'person-lines-fill',       label: 'นำเข้าลูกค้า' },
      { id: 'snapshots',       href: 'snapshots.html',      icon: 'layers',                  label: 'Snapshots' },
      { id: 'troubleshoot',    href: 'troubleshoot.html',   icon: 'tools',                   label: 'วินิจฉัยระบบ' },
      { id: 'history',         href: 'history.html',        icon: 'clock-history',           label: 'ประวัติ' },
      { id: 'settings',        href: 'settings.html',       icon: 'gear',                    label: 'ตั้งค่า' },
    ];

    // Check if backup is overdue (admin only) — show warning badge on settings link
    const backupOverdue = (() => {
      if (!Auth.isAdmin()) return false;
      try {
        const ab = (DB.getSettings() || {}).autoBackup;
        if (!ab || !ab.enabled) return false;
        if (!ab.lastBackupAt) return true;
        const diffDays = (Date.now() - new Date(ab.lastBackupAt)) / 86400000;
        return diffDays >= ({ daily: 1, weekly: 7, monthly: 30 }[ab.interval] || 7);
      } catch { return false; }
    })();

    const makeLinks = (arr) => arr
      .filter(l => !l.perm || Auth.can(l.perm))
      .map(l => {
        const badge = (l.id === 'settings' && backupOverdue)
          ? ' <span class="badge bg-warning text-dark ms-1" style="font-size:9px;vertical-align:middle"><i class="bi bi-exclamation-triangle-fill"></i> สำรอง</span>'
          : '';
        return `
      <li class="nav-item">
        <a class="nav-link ${active === l.id ? 'active' : ''}" href="${l.href}">
          <i class="bi bi-${l.icon} me-1"></i>${l.label}${badge}
        </a>
      </li>`;
      }).join('');

    const html = `
<nav class="navbar navbar-expand-lg navbar-dark bg-primary sticky-top shadow-sm">
  <div class="container-fluid">
    <a class="navbar-brand fw-bold" href="dashboard.html">
      <i class="bi bi-droplet-fill me-1"></i>${cfg.companyName || 'ระบบใบกำกับ'}
      ${Auth.isAdmin() ? `<span class="badge bg-white bg-opacity-25 fw-normal ms-1" style="font-size:10px;vertical-align:middle">${APP_VERSION.label}</span>` : ''}
    </a>
    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#mainNav">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="mainNav">
      <ul class="navbar-nav me-auto mb-2 mb-lg-0 flex-wrap">
        ${makeLinks(links)}
        ${Auth.isAdmin() ? makeLinks(adminLinks) : ''}
        ${!Auth.isAdmin() && (Auth.can('export_backup') || Auth.can('import_backup') || Auth.can('export_zip') || Auth.can('import_zip')) ? `
      <li class="nav-item">
        <a class="nav-link ${active === 'settings' ? 'active' : ''}" href="settings.html">
          <i class="bi bi-gear me-1"></i>ตั้งค่า
        </a>
      </li>` : ''}
      </ul>
      <ul class="navbar-nav ms-auto align-items-center">
        <li class="nav-item me-1" id="syncBadgeItem">
          <span id="syncStatusBadge" class="badge bg-secondary ms-2 py-1 px-2"
                style="font-size:10px;cursor:pointer" title="คลิก: ดึงข้อมูลจาก Cloud | Shift+คลิก: อัปโหลดทุกอย่างขึ้น Cloud"
                onclick="if(!window.Sync||!Sync.ready)return;
                  if(event.shiftKey){if(confirm('อัปโหลดข้อมูลทั้งหมดจากเครื่องนี้ขึ้น Cloud ใช่หรือไม่?'))Sync.pushAll().then(()=>{if(typeof render==='function')render();});}
                  else{Sync.pull().then(()=>{if(typeof render==='function')render();});}">⏳ Sync</span>
        </li>
        ${window.IS_TAURI ? '' : `<li class="nav-item me-1" id="driveBadgeItem" style="display:none">
          <span id="driveBadge" class="badge bg-secondary ms-1 py-1 px-2" style="font-size:10px;cursor:pointer"
                onclick="location.href='settings.html'" title="Google Drive — คลิกเพื่อตั้งค่า">☁ Drive</span>
        </li>`}
        <li class="nav-item me-1" id="pwaInstallBtn" style="display:none">
          <button class="btn btn-sm btn-outline-light px-2 py-1" onclick="window._pwaInstall && _pwaInstall()" title="ติดตั้งแอปบนเครื่อง">
            <i class="bi bi-download me-1"></i>ติดตั้งแอป
          </button>
        </li>
        <li class="nav-item me-1">
          <button class="btn btn-link nav-link px-2 py-1" onclick="Nav.toggleDark()" title="สลับ Dark / Light Mode" style="font-size:1.1rem">
            <i class="bi bi-${document.documentElement.getAttribute('data-bs-theme')==='dark'?'sun-fill':'moon-stars-fill'}" id="darkModeIcon"></i>
          </button>
        </li>
        <li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" data-bs-toggle="dropdown">
            <i class="bi bi-person-circle me-1"></i>${s.name}
          </a>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><span class="dropdown-item-text text-muted small">${s.username} (${s.role === 'admin' ? 'ผู้ดูแล' : 'ผู้ใช้'})</span></li>
            <li><hr class="dropdown-divider"></li>
            <li><a class="dropdown-item" href="#" onclick="Auth.logout()"><i class="bi bi-box-arrow-right me-1"></i>ออกจากระบบ</a></li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</nav>`;

    const el = document.getElementById('navContainer');
    if (el) el.innerHTML = html;

    _checkOverdueAlert();
    _startIdleTimer();

    // Force password change for first-time users (set by users.html on creation)
    if (sessionStorage.getItem('mustChangePw') === '1') {
      setTimeout(_showChangePwOverlay, 200);
      return; // don't show connection modal yet — will show after pw change
    }

    // Connection modal removed — Drive is web-only, sync status visible in navbar badge
    if (sessionStorage.getItem('justLoggedIn')) {
      sessionStorage.removeItem('justLoggedIn');
    }
  }
};

// ── Force password change overlay (first login after account creation) ────────
function _showChangePwOverlay() {
  var isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  var bg  = isDark ? '#1c2128' : '#ffffff';
  var txt = isDark ? '#c9d1d9' : '#212529';
  var brd = isDark ? '#30363d' : '#dee2e6';

  var overlay = document.createElement('div');
  overlay.id = 'changePwOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,.65);' +
    'display:flex;align-items:center;justify-content:center;padding:1rem';

  overlay.innerHTML =
    '<div style="background:' + bg + ';border-radius:14px;padding:1.75rem;max-width:380px;' +
    'width:100%;box-shadow:0 16px 48px rgba(0,0,0,.35)">' +

    '<div style="text-align:center;margin-bottom:1.25rem">' +
    '<div style="font-size:2.5rem;margin-bottom:.5rem">🔐</div>' +
    '<div style="font-weight:700;font-size:1.05rem;color:' + txt + '">กรุณาเปลี่ยนรหัสผ่าน</div>' +
    '<div style="font-size:13px;color:#6b7280;margin-top:.35rem">' +
    'บัญชีของคุณถูกสร้างโดยผู้ดูแลระบบ<br>กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน</div></div>' +

    '<div id="cpw-alert" style="display:none;background:#fee2e2;color:#991b1b;border-radius:8px;' +
    'padding:8px 12px;font-size:13px;margin-bottom:1rem"></div>' +

    '<div style="margin-bottom:.85rem">' +
    '<label style="font-size:13px;font-weight:600;color:' + txt + ';display:block;margin-bottom:4px">รหัสผ่านใหม่</label>' +
    '<input id="cpw-new" type="password" placeholder="อย่างน้อย 6 ตัวอักษร" ' +
    'style="width:100%;padding:8px 12px;border:1px solid ' + brd + ';border-radius:8px;' +
    'font-size:14px;background:' + (isDark?'#0d1117':bg) + ';color:' + txt + ';box-sizing:border-box"></div>' +

    '<div style="margin-bottom:1.25rem">' +
    '<label style="font-size:13px;font-weight:600;color:' + txt + ';display:block;margin-bottom:4px">ยืนยันรหัสผ่านใหม่</label>' +
    '<input id="cpw-confirm" type="password" placeholder="พิมพ์ซ้ำเพื่อยืนยัน" ' +
    'style="width:100%;padding:8px 12px;border:1px solid ' + brd + ';border-radius:8px;' +
    'font-size:14px;background:' + (isDark?'#0d1117':bg) + ';color:' + txt + ';box-sizing:border-box"></div>' +

    '<button id="cpw-save" ' +
    'style="width:100%;padding:10px;background:#0d6efd;color:#fff;border:none;border-radius:8px;' +
    'font-size:14px;font-weight:600;cursor:pointer">บันทึกรหัสผ่าน</button>' +
    '</div>';

  document.body.appendChild(overlay);

  function showErr(msg) {
    var el = document.getElementById('cpw-alert');
    el.textContent = msg; el.style.display = '';
  }

  document.getElementById('cpw-save').addEventListener('click', function() {
    var pw1 = document.getElementById('cpw-new').value;
    var pw2 = document.getElementById('cpw-confirm').value;
    if (pw1.length < 6) { showErr('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'); return; }
    if (pw1 !== pw2)    { showErr('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }

    var s = Auth.session();
    if (!s) return;
    DB.updateUser(s.userId, { password: Utils.hashPassword(pw1), mustChangePw: false });
    sessionStorage.removeItem('mustChangePw');

    overlay.style.transition = 'opacity .3s';
    overlay.style.opacity = '0';
    setTimeout(function() {
      if (overlay.parentNode) overlay.remove();
      if (sessionStorage.getItem('justLoggedIn')) {
        sessionStorage.removeItem('justLoggedIn');
      }
    }, 350);
  });

  // Enter key submits
  [document.getElementById('cpw-new'), document.getElementById('cpw-confirm')].forEach(function(el) {
    el.addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('cpw-save').click(); });
  });
}

// ── Connection modal (shown once per session, right after login) ──────────────
function _showConnectionModal() {
  if (sessionStorage.getItem('connModalDone')) return;
  if (window.IS_TAURI) { sessionStorage.setItem('connModalDone', '1'); return; } // not needed in Tauri

  var isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  var bg    = isDark ? '#1c2128' : '#ffffff';
  var txt   = isDark ? '#c9d1d9' : '#212529';
  var brd   = isDark ? '#30363d' : '#dee2e6';
  var rowBg = isDark ? '#0d1117' : '#f8f9fa';

  // ── Dynamic config checks ─────────────────────────────────────────────────
  // Evaluated at call-time (not at modal-init) so firebase-config.js / drive-config.js
  // have time to finish loading before we decide the service is "not configured".
  function isFbCfg() {
    return typeof FIREBASE_CONFIG !== 'undefined' &&
           FIREBASE_CONFIG.apiKey &&
           !FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...');
  }
  function isDrCfg() {
    return typeof GOOGLE_CLIENT_ID !== 'undefined' &&
           typeof GOOGLE_CLIENT_ID === 'string' &&
           GOOGLE_CLIENT_ID.includes('.apps.');
  }

  // Google-branded button HTML
  var gBtn =
    '<button id="cm-dr-btn" style="display:flex;align-items:center;gap:6px;' +
    'background:#fff;border:1px solid #dadce0;border-radius:6px;padding:5px 12px;' +
    'font-size:12px;font-weight:600;color:#3c4043;cursor:pointer;flex-shrink:0;white-space:nowrap">' +
    '<svg width="14" height="14" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.05 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.55-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
    'เข้าสู่ระบบ Google</button>';

  var overlay = document.createElement('div');
  overlay.id = 'connModal';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99994;background:rgba(0,0,0,.55);' +
    'display:flex;align-items:center;justify-content:center;padding:1rem';

  // Whether the File System Access API is available (desktop Chrome / Edge)
  var canPickDir = typeof window.showDirectoryPicker === 'function';

  // Folder row button style
  var folderBtnStyle =
    'background:#0d6efd;color:#fff;border:none;border-radius:6px;' +
    'padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap';

  overlay.innerHTML =
    '<div style="background:' + bg + ';border-radius:14px;padding:1.5rem;max-width:420px;' +
    'width:100%;box-shadow:0 16px 48px rgba(0,0,0,.3)">' +

    '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:1.25rem">' +
    '<i class="bi bi-plug-fill" style="color:#0d6efd;font-size:1.1rem"></i>' +
    '<span style="font-weight:700;font-size:1rem;color:' + txt + '">การเชื่อมต่อระบบ</span></div>' +

    // Firebase row
    '<div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;' +
    'border:1px solid ' + brd + ';border-radius:10px;margin-bottom:.75rem;background:' + rowBg + '">' +
    '<span style="font-size:1.4rem;width:2rem;text-align:center">☁️</span>' +
    '<div style="flex:1;min-width:0">' +
    '<div style="font-weight:700;font-size:13px;color:' + txt + '">Firebase Sync</div>' +
    '<div id="cm-fb-st" style="font-size:12px;color:#d97706;margin-top:2px">⏳ กำลังเชื่อมต่อ...</div></div>' +
    '<button id="cm-fb-btn" class="btn btn-sm btn-danger" ' +
    'style="display:none;flex-shrink:0;font-size:12px;padding:3px 10px;white-space:nowrap">ลองใหม่</button></div>' +

    // Drive row
    '<div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;' +
    'border:1px solid ' + brd + ';border-radius:10px;margin-bottom:.75rem;background:' + rowBg + '">' +
    '<span style="font-size:1.4rem;width:2rem;text-align:center">📁</span>' +
    '<div style="flex:1;min-width:0">' +
    '<div style="font-weight:700;font-size:13px;color:' + txt + '">Google Drive</div>' +
    '<div id="cm-dr-st" style="font-size:12px;color:#d97706;margin-top:2px">⏳ กำลังตรวจสอบ...</div></div>' +
    gBtn + '</div>' +

    // PDF Folder row (only when File System API available)
    (canPickDir ?
    '<div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;' +
    'border:1px solid ' + brd + ';border-radius:10px;margin-bottom:.75rem;background:' + rowBg + '">' +
    '<span style="font-size:1.4rem;width:2rem;text-align:center">📄</span>' +
    '<div style="flex:1;min-width:0">' +
    '<div style="font-weight:700;font-size:13px;color:' + txt + '">โฟลเดอร์บันทึก PDF</div>' +
    '<div id="cm-pdf-st" style="font-size:12px;color:#d97706;margin-top:2px">⏳ กำลังตรวจสอบ...</div></div>' +
    '<button id="cm-pdf-btn" style="display:none;' + folderBtnStyle + '">เลือก</button></div>'
    : '') +

    // Backup Folder row (only when File System API available)
    (canPickDir ?
    '<div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;' +
    'border:1px solid ' + brd + ';border-radius:10px;margin-bottom:.75rem;background:' + rowBg + '">' +
    '<span style="font-size:1.4rem;width:2rem;text-align:center">💾</span>' +
    '<div style="flex:1;min-width:0">' +
    '<div style="font-weight:700;font-size:13px;color:' + txt + '">โฟลเดอร์สำรองข้อมูล</div>' +
    '<div id="cm-backup-st" style="font-size:12px;color:#d97706;margin-top:2px">⏳ กำลังตรวจสอบ...</div></div>' +
    '<button id="cm-backup-btn" style="display:none;' + folderBtnStyle + '">เลือก</button></div>'
    : '') +

    '<div id="cm-offline-row" style="display:none;margin-top:.25rem">' +
    '<button id="cm-offline-btn" class="btn btn-secondary btn-sm w-100">' +
    '<i class="bi bi-wifi-off me-1"></i>ทำงานออฟไลน์</button></div>' +

    '<div id="cm-offline-msg" style="display:none;text-align:center;font-size:12px;' +
    'color:#6c757d;padding:.6rem 0 0;line-height:1.6">' +
    '<i class="bi bi-info-circle me-1"></i>ระบบจะอัพเดทข้อมูลเมื่อระบบกลับมาออนไลน์</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setSt(id, text, color) {
    var el = document.getElementById('cm-' + id + '-st');
    if (el) { el.textContent = text; el.style.color = color; }
  }
  function hideBtn(id) {
    var el = document.getElementById('cm-' + id + '-btn');
    if (el) el.style.display = 'none';
  }
  function showOfflineBtn() {
    var r = document.getElementById('cm-offline-row');
    if (r) r.style.display = '';
  }
  function closeModal() {
    sessionStorage.setItem('connModalDone', '1');
    overlay.style.transition = 'opacity .3s';
    overlay.style.opacity = '0';
    setTimeout(function() { if (overlay.parentNode) overlay.remove(); }, 350);
  }

  // ── checkAllDone: uses dynamic checks every time ───────────────────────────
  // fbResolved/drResolved/pdfResolved/backupResolved track each service's final state.
  var fbResolved = false, drResolved = false;
  var pdfResolved = !canPickDir, backupResolved = !canPickDir; // skip if API unavailable
  function checkAllDone() {
    if (fbResolved && drResolved && pdfResolved && backupResolved) setTimeout(closeModal, 700);
  }

  // ── Inline IDB helper (reads/writes directory handles stored by settings.js) ─
  function _idbOpen() {
    return new Promise(function(res, rej) {
      var req = indexedDB.open('wt_handles_v1', 1);
      req.onupgradeneeded = function(e) { e.target.result.createObjectStore('handles'); };
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror   = function(e) { rej(e.target.error); };
    });
  }
  function _idbGet(key) {
    return _idbOpen().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('handles', 'readonly');
        var req = tx.objectStore('handles').get(key);
        req.onsuccess = function(e) { res(e.target.result || null); };
        req.onerror   = function(e) { rej(e.target.error); };
      });
    }).catch(function() { return null; });
  }
  function _idbSet(key, val) {
    return _idbOpen().then(function(db) {
      return new Promise(function(res, rej) {
        var tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(val, key);
        tx.oncomplete = res;
        tx.onerror = function(e) { rej(e.target.error); };
      });
    }).catch(function() {});
  }

  // ── Folder check & pick buttons (only if canPickDir) ──────────────────────
  if (canPickDir) {
    // Check PDF folder
    _idbGet('pdf_dir').then(function(h) {
      if (h) {
        setSt('pdf', '✓ ' + h.name, '#16a34a');
        pdfResolved = true; checkAllDone();
      } else {
        setSt('pdf', 'ยังไม่ได้เลือก — กรุณาเลือกโฟลเดอร์', '#d97706');
        var btn = document.getElementById('cm-pdf-btn');
        if (btn) btn.style.display = '';
      }
    });

    // Check Backup folder
    _idbGet('backup_dir').then(function(h) {
      if (h) {
        setSt('backup', '✓ ' + h.name, '#16a34a');
        backupResolved = true; checkAllDone();
      } else {
        setSt('backup', 'ยังไม่ได้เลือก — กรุณาเลือกโฟลเดอร์', '#d97706');
        var btn = document.getElementById('cm-backup-btn');
        if (btn) btn.style.display = '';
      }
    });

    // PDF pick button
    var pdfBtn = document.getElementById('cm-pdf-btn');
    if (pdfBtn) pdfBtn.addEventListener('click', function() {
      window.showDirectoryPicker({ mode: 'readwrite' }).then(function(h) {
        return _idbSet('pdf_dir', h).then(function() {
          setSt('pdf', '✓ ' + h.name, '#16a34a');
          pdfBtn.style.display = 'none';
          pdfResolved = true; checkAllDone();
        });
      }).catch(function(e) { if (e.name !== 'AbortError') console.warn('[connModal] pdf dir:', e); });
    });

    // Backup pick button
    var backupBtn = document.getElementById('cm-backup-btn');
    if (backupBtn) backupBtn.addEventListener('click', function() {
      window.showDirectoryPicker({ mode: 'readwrite' }).then(function(h) {
        return _idbSet('backup_dir', h).then(function() {
          setSt('backup', '✓ ' + h.name, '#16a34a');
          backupBtn.style.display = 'none';
          backupResolved = true; checkAllDone();
        });
      }).catch(function(e) { if (e.name !== 'AbortError') console.warn('[connModal] backup dir:', e); });
    });
  }

  // ── ทำงานออฟไลน์ button ───────────────────────────────────────────────────
  document.getElementById('cm-offline-btn').addEventListener('click', function() {
    this.style.display = 'none';
    document.getElementById('cm-offline-msg').style.display = '';
    setTimeout(closeModal, 2200);
  });

  // ── Drive connect button (visible immediately) ────────────────────────────
  var drBtn = document.getElementById('cm-dr-btn');
  function doDriveSignIn() {
    drBtn.disabled = true;
    setSt('dr', '⏳ กำลังเชื่อมต่อ...', '#d97706');
    if (!window.DriveStore) {
      setSt('dr', '✗ Drive ยังไม่พร้อม', '#dc2626');
      drBtn.disabled = false; showOfflineBtn(); return;
    }
    DriveStore.signIn()
      .then(function() {
        setSt('dr', '✓ เชื่อมต่อแล้ว', '#16a34a');
        hideBtn('dr'); drResolved = true; checkAllDone();
      })
      .catch(function() {
        setSt('dr', '✗ เชื่อมต่อไม่ได้', '#dc2626');
        drBtn.disabled = false; showOfflineBtn();
      });
  }
  drBtn.addEventListener('click', doDriveSignIn);

  // ── Firebase polling ──────────────────────────────────────────────────────
  var fbTimerRef = { t: null };
  var fbPolls = 0;
  function startFbPoll() {
    return setInterval(function() {
      fbPolls++;
      // Keep waiting for firebase-config.js to load (up to ~3s)
      if (!isFbCfg()) {
        if (fbPolls <= 6) return;
        // Still no config after 3s → not configured
        clearInterval(fbTimerRef.t);
        setSt('fb', '— ไม่ได้ตั้งค่า', '#9ca3af');
        fbResolved = true; checkAllDone(); return;
      }
      if (window.Sync && Sync.ready) {
        clearInterval(fbTimerRef.t);
        setSt('fb', '✓ เชื่อมต่อแล้ว', '#16a34a');
        hideBtn('fb'); fbResolved = true; checkAllDone();
      } else if (fbPolls >= 30) { // ~15 seconds timeout
        clearInterval(fbTimerRef.t);
        setSt('fb', '✗ เชื่อมต่อไม่ได้', '#dc2626');
        document.getElementById('cm-fb-btn').style.display = '';
        showOfflineBtn();
      }
    }, 500);
  }
  document.getElementById('cm-fb-btn').addEventListener('click', function() {
    setSt('fb', '⏳ กำลังเชื่อมต่อ...', '#d97706');
    hideBtn('fb'); fbPolls = 0;
    clearInterval(fbTimerRef.t); fbTimerRef.t = startFbPoll();
  });
  fbTimerRef.t = startFbPoll();

  // ── Drive polling (detect background auto-reconnect) ──────────────────────
  var drPolls = 0;
  var drTimer = setInterval(function() {
    drPolls++;
    // Wait for drive-config.js to load (up to ~3s)
    if (!isDrCfg()) {
      if (drPolls <= 6) return;
      clearInterval(drTimer);
      setSt('dr', '— ไม่ได้ตั้งค่า', '#9ca3af');
      hideBtn('dr'); drResolved = true; checkAllDone(); return;
    }
    if (window.DriveStore && DriveStore.ready) {
      clearInterval(drTimer);
      setSt('dr', '✓ เชื่อมต่อแล้ว', '#16a34a');
      hideBtn('dr'); drResolved = true; checkAllDone();
    } else if (drPolls >= 6) { // 3 seconds — show button, stop polling (user clicks)
      clearInterval(drTimer);
      setSt('dr', 'กดปุ่มเพื่อเข้าสู่ระบบ', '#6b7280');
      showOfflineBtn();
      // drResolved stays false — don't auto-close; wait for user action
    }
  }, 500);
}


function _checkOverdueAlert() {
  const today = new Date().toISOString().slice(0,10);
  const key = 'wt_overdue_check_date';
  if (localStorage.getItem(key) === today) return;
  localStorage.setItem(key, today);

  const custs = DB.getCustomers();
  const invoices = DB.getInvoices();
  const violations = [];

  custs.forEach(c => {
    const pt = c.payTerms;
    if (!pt || (!pt.maxBills && !pt.maxDays)) return;
    const custInvs = invoices.filter(i => i.customerId === c.id);
    const uniqNums = [...new Set(custInvs.map(i => i.invoiceNumber))];
    const unpaidNums = uniqNums.filter(num => {
      const inv = custInvs.find(i => i.invoiceNumber === num);
      return inv && DB.getInvoicePaidAmount(num) < (parseFloat(inv.totalAmount)||0);
    });
    const msgs = [];
    if (pt.maxBills && unpaidNums.length > pt.maxBills)
      msgs.push(`ค้างชำระ ${unpaidNums.length} บิล (เกินกำหนด ${pt.maxBills} บิล)`);
    if (pt.maxDays && unpaidNums.length > 0) {
      const now = Date.now();
      const oldestTs = Math.min(...unpaidNums.map(num => {
        const inv = custInvs.find(i => i.invoiceNumber === num);
        return inv ? new Date(inv.createdAt).getTime() : now;
      }));
      const days = Math.floor((now - oldestTs) / 86400000);
      if (days > pt.maxDays) msgs.push(`ค้างนาน ${days} วัน (เกินกำหนด ${pt.maxDays} วัน)`);
    }
    if (msgs.length) violations.push({ name: c.name, msgs });
  });

  if (!violations.length) return;

  // Inject modal
  const modalId = 'overdueAlertModal';
  let el = document.getElementById(modalId);
  if (!el) {
    el = document.createElement('div');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="modal fade" id="${modalId}" tabindex="-1">
      <div class="modal-dialog modal-dialog-centered modal-lg">
        <div class="modal-content">
          <div class="modal-header bg-danger text-white">
            <h5 class="modal-title"><i class="bi bi-exclamation-triangle-fill me-2"></i>แจ้งเตือน: ลูกค้าค้างชำระเกินกำหนด (${violations.length} ราย)</h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body p-0">
            <table class="table table-sm mb-0">
              <thead class="table-light"><tr><th>#</th><th>ลูกค้า</th><th>รายละเอียด</th></tr></thead>
              <tbody>
                ${violations.map((v,i) => `<tr>
                  <td class="text-muted">${i+1}</td>
                  <td class="fw-semibold">${v.name}</td>
                  <td class="text-danger small">${v.msgs.join('<br>')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <a href="customers.html" class="btn btn-outline-primary btn-sm">ดูรายชื่อลูกค้า</a>
            <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">ปิด</button>
          </div>
        </div>
      </div>
    </div>`;
  // Show after bootstrap is ready
  setTimeout(() => {
    try { new bootstrap.Modal(document.getElementById(modalId)).show(); } catch(e) {}
  }, 600);
}

// ── Idle session timeout ──────────────────────────────────────────────────────
// Auto-logout after N minutes of inactivity (default 30, 0 = disabled).
// Configured via DB.getSettings().sessionTimeoutMin.
// Shows a yellow warning banner 2 minutes before expiry; any user activity resets the timer.
;(function() {
  var _active  = false;
  var _warnEl  = null;
  var _lastAct = Date.now();
  var _timeoutMs = 0;

  function _reset() {
    _lastAct = Date.now();
    if (_warnEl) { _warnEl.remove(); _warnEl = null; }
  }

  function _logout() {
    if (_warnEl) { _warnEl.remove(); _warnEl = null; }
    if (window.Auth) Auth.logout();
    window.location.href = 'index.html';
  }

  function _warn(minsLeft) {
    if (_warnEl || !document.body) return;
    var isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    _warnEl = document.createElement('div');
    _warnEl.style.cssText =
      'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:99990;' +
      'background:' + (isDark ? '#332900' : '#fff3cd') + ';color:' + (isDark ? '#ffc' : '#664d03') + ';' +
      'border:1px solid #ffc107;border-radius:12px;padding:13px 20px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.25);font-size:14px;font-family:Sarabun,sans-serif;' +
      'display:flex;align-items:center;gap:12px;max-width:420px;width:90%';
    _warnEl.innerHTML =
      '<i class="bi bi-clock-history fs-5"></i>' +
      '<div><strong>เซสชันจะหมดอายุใน ' + minsLeft + ' นาที</strong><br>' +
      '<span style="font-size:12px;opacity:.8">เลื่อนเมาส์หรือกดปุ่มใดก็ได้เพื่อต่อเวลา</span></div>' +
      '<button onclick="this.parentElement.remove()" ' +
      'style="margin-left:auto;flex-shrink:0;background:none;border:1px solid currentColor;' +
      'border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;color:inherit">OK</button>';
    document.body.appendChild(_warnEl);
  }

  function _tick() {
    if (!window.Auth || !Auth.session()) return;  // logged out elsewhere
    var elapsed   = Date.now() - _lastAct;
    var remaining = _timeoutMs - elapsed;
    if (remaining <= 0)              { _logout(); return; }
    if (remaining <= 2 * 60 * 1000) { _warn(Math.ceil(remaining / 60000)); }
    else if (_warnEl)                { _warnEl.remove(); _warnEl = null; }
    setTimeout(_tick, 15000);        // check every 15 s
  }

  window._startIdleTimer = function() {
    if (_active) return;
    var mins = 30;
    try { var s = DB.getSettings(); if (s.sessionTimeoutMin !== undefined) mins = s.sessionTimeoutMin; } catch {}
    if (!mins || mins <= 0) return;   // 0 = disabled
    _timeoutMs = mins * 60 * 1000;
    _active    = true;
    _lastAct   = Date.now();
    ['mousemove','keydown','mousedown','touchstart','scroll','click']
      .forEach(function(e) { document.addEventListener(e, _reset, { passive: true }); });
    setTimeout(_tick, 15000);
  };
})();

function _startIdleTimer() { if (typeof window._startIdleTimer === 'function') window._startIdleTimer(); }

// ── Auto restore point: save marker on browser close so login page can offer download ──
// A full download is not possible in beforeunload (browsers block it).
// Instead we save a tiny marker to localStorage; the login page detects it and
// offers a "ดาวน์โหลดไฟล์สำรอง" button before the user re-enters their password.
// The marker is removed by Auth.logout() so it only appears after an unclean close.
(function() {
  window.addEventListener('beforeunload', function() {
    if (!window.Auth || !Auth.session()) return;
    try {
      const cfg = window.DB ? (DB.getSettings() || {}) : {};
      if (cfg.autoRestorePoint?.onClose === false) return;
      const s = Auth.session();
      localStorage.setItem('wt_restore_pending', JSON.stringify({
        savedAt: new Date().toISOString(),
        username: s ? s.username : '',
      }));
    } catch(e) {}
  });
})();
