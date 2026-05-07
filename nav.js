// nav.js - Navigation bar generator

// Apply dark mode early (before paint) to prevent flash
(function() {
  if (localStorage.getItem('wt_dark_mode') === '1') {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
  }
})();

// ── Service Worker Registration & Update Banner ──────────────────────────────
(function() {
  if (!('serviceWorker' in navigator)) return;

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
  const FB_VER = '10.7.1';
  const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VER}`;
  // Try loading firebase-config.js; if it doesn't exist, stop (offline-only mode)
  loadScript('./firebase-config.js', function() {
    if (typeof FIREBASE_CONFIG === 'undefined' || !FIREBASE_CONFIG.apiKey ||
        FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...')) return; // not configured
    loadScript(`${FB_BASE}/firebase-app-compat.js`, function() {
      loadScript(`${FB_BASE}/firebase-auth-compat.js`, function() {
        loadScript(`${FB_BASE}/firebase-firestore-compat.js`, function() {
          loadScript('./sync.js');
        });
      });
    });
  }, function() { /* firebase-config.js not found — local-only mode, OK */ });
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
        <li class="nav-item me-1" id="syncBadgeItem" style="display:none">
          <span id="syncStatusBadge" class="badge bg-secondary ms-2 py-1 px-2"
                style="font-size:10px;cursor:pointer" title="คลิก: ดึงข้อมูลจาก Cloud | Shift+คลิก: อัปโหลดทุกอย่างขึ้น Cloud"
                onclick="if(!window.Sync||!Sync.ready)return;
                  if(event.shiftKey){if(confirm('อัปโหลดข้อมูลทั้งหมดจากเครื่องนี้ขึ้น Cloud ใช่หรือไม่?'))Sync.pushAll().then(()=>{if(typeof render==='function')render();});}
                  else{Sync.pull().then(()=>{if(typeof render==='function')render();});}">☁ Sync</span>
        </li>
        <li class="nav-item me-1" id="driveBadgeItem" style="display:none">
          <span id="driveBadge" class="badge bg-secondary ms-1 py-1 px-2" style="font-size:10px;cursor:pointer"
                onclick="location.href='settings.html'" title="Google Drive — คลิกเพื่อตั้งค่า">☁ Drive</span>
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
    _checkStorageAlert();
    DB.runAutoBackup(s.username);
  }
};

function _checkStorageAlert() {
  try {
    let used = 0;
    for (const k in localStorage) {
      if (Object.prototype.hasOwnProperty.call(localStorage, k))
        used += (localStorage.getItem(k) || '').length * 2;
    }
    const pct = Math.min(100, (used / (5 * 1024 * 1024)) * 100);
    if (pct < 80) return;
    const id = 'storageAlertBanner';
    if (document.getElementById(id)) return;
    const cls = pct >= 95 ? 'danger' : 'warning';
    const msg = pct >= 95
      ? '<strong>อันตราย! ควร Export สำรองข้อมูลทันที</strong>'
      : 'ควรสำรองข้อมูลเร็วๆ นี้';
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = 'position:fixed;top:58px;left:0;right:0;z-index:1039';
    div.innerHTML = `<div class="alert alert-${cls} alert-dismissible mb-0 rounded-0 py-2 text-center" style="font-size:13px">
      <i class="bi bi-hdd-fill me-1"></i>พื้นที่จัดเก็บข้อมูล <strong>${pct.toFixed(1)}%</strong>
      (${(used/1024/1024).toFixed(2)} MB / ~5 MB) — ${msg}
      <a href="settings.html" class="btn btn-sm btn-${cls === 'danger' ? 'outline-light' : 'outline-dark'} ms-2 py-0">จัดการ</a>
      <button type="button" class="btn-close" onclick="document.getElementById('${id}').remove()"></button>
    </div>`;
    document.body.appendChild(div);
  } catch(e) {}
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
