// auth.js - Authentication

const Auth = {
  KEY: 'wt_session',

  // Permission definitions — key, label, group
  // Admin bypasses all checks automatically.
  // Groups: เข้าถึงหน้า | ใบกำกับสินค้า | การชำระเงิน | ลูกค้า | สินค้าและราคา | ฉลากขวด | รายงาน
  PERMS: [
    // ─ เข้าถึงหน้า ─────────────────────────────────────────────
    { key: 'dashboard',       label: 'Dashboard',                   group: 'เข้าถึงหน้า' },
    { key: 'invoices',        label: 'ดูใบกำกับสินค้า',              group: 'เข้าถึงหน้า' },
    { key: 'payments',        label: 'ดูหน้าชำระเงิน',               group: 'เข้าถึงหน้า' },
    { key: 'customers',       label: 'ดูหน้าลูกค้า',                group: 'เข้าถึงหน้า' },
    { key: 'products',        label: 'ดูหน้าสินค้า',                group: 'เข้าถึงหน้า' },
    { key: 'pricing',         label: 'ดูหน้าราคาสินค้า',             group: 'เข้าถึงหน้า' },
    { key: 'reports',         label: 'ดูรายงาน',                    group: 'เข้าถึงหน้า' },
    { key: 'versions',        label: 'ดูฉลากขวด',                   group: 'เข้าถึงหน้า' },
    // ─ ใบกำกับสินค้า ───────────────────────────────────────────
    { key: 'invoice_create',  label: 'สร้างใบกำกับสินค้า',           group: 'ใบกำกับสินค้า' },
    { key: 'invoice_edit',    label: 'แก้ไขใบกำกับสินค้า',           group: 'ใบกำกับสินค้า' },
    { key: 'invoice_delete',  label: 'ลบใบกำกับสินค้า',              group: 'ใบกำกับสินค้า' },
    { key: 'invoice_void',    label: 'ยกเลิก / กู้คืนใบกำกับสินค้า', group: 'ใบกำกับสินค้า' },
    { key: 'invoice_print',   label: 'พิมพ์ / PDF ใบกำกับสินค้า',   group: 'ใบกำกับสินค้า' },
    // ─ การชำระเงิน ─────────────────────────────────────────────
    { key: 'payment_add',     label: 'บันทึกการชำระเงิน',            group: 'การชำระเงิน' },
    { key: 'payment_edit',    label: 'แก้ไขการชำระเงิน',             group: 'การชำระเงิน' },
    { key: 'payment_delete',  label: 'ลบการชำระเงิน',               group: 'การชำระเงิน' },
    // ─ ลูกค้า ──────────────────────────────────────────────────
    { key: 'customer_add',    label: 'เพิ่มลูกค้า',                 group: 'ลูกค้า' },
    { key: 'customer_edit',   label: 'แก้ไขลูกค้า',                group: 'ลูกค้า' },
    { key: 'customer_delete', label: 'ลบลูกค้า',                   group: 'ลูกค้า' },
    // ─ สินค้าและราคา ───────────────────────────────────────────
    { key: 'product_add',     label: 'เพิ่มสินค้า',                 group: 'สินค้าและราคา' },
    { key: 'product_edit',    label: 'แก้ไขสินค้า',                group: 'สินค้าและราคา' },
    { key: 'product_delete',  label: 'ลบสินค้า',                   group: 'สินค้าและราคา' },
    { key: 'pricing_edit',    label: 'แก้ไขราคาสินค้า',             group: 'สินค้าและราคา' },
    // ─ ฉลากขวด ─────────────────────────────────────────────────
    { key: 'version_add',     label: 'เพิ่มฉลากขวด',               group: 'ฉลากขวด' },
    { key: 'version_edit',    label: 'แก้ไขฉลากขวด',              group: 'ฉลากขวด' },
    { key: 'version_delete',  label: 'ลบฉลากขวด',                 group: 'ฉลากขวด' },
    // ─ สต๊อกฝาขวด ─────────────────────────────────────────────
    { key: 'cap_stock',       label: 'ดูสต๊อกฝาขวด',               group: 'สต๊อกฝาขวด' },
    { key: 'cap_stock_add',   label: 'บันทึกรับฝาขวด',             group: 'สต๊อกฝาขวด' },
    // ─ รายงาน ──────────────────────────────────────────────────
    { key: 'report_export',   label: 'Export / พิมพ์รายงาน',        group: 'รายงาน' },
    // ─ รายการคืนสินค้า ─────────────────────────────────────────
    { key: 'returns',        label: 'ดูรายการคืนสินค้า',          group: 'รายการคืนสินค้า' },
    { key: 'return_add',     label: 'บันทึกรายการคืนสินค้า',      group: 'รายการคืนสินค้า' },
    { key: 'return_edit',    label: 'แก้ไขรายการคืนสินค้า',       group: 'รายการคืนสินค้า' },
    { key: 'return_delete',  label: 'ลบรายการคืนสินค้า',          group: 'รายการคืนสินค้า' },
    // ─ สำรองข้อมูล ─────────────────────────────────────────────
    { key: 'export_backup',   label: 'Export ข้อมูล (JSON)',          group: 'สำรองข้อมูล' },
    { key: 'import_backup',   label: 'Import ข้อมูล (JSON)',          group: 'สำรองข้อมูล' },
    { key: 'export_zip',      label: 'Export ZIP (ข้อมูล + PDF)',     group: 'สำรองข้อมูล' },
    { key: 'import_zip',      label: 'Import ZIP (ข้อมูล + PDF)',     group: 'สำรองข้อมูล' },
  ],

  async _fetchGeoInfo() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('https://ip-api.com/json/?fields=status,query,city,regionName,country', { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data.status === 'success') {
        return { ip: data.query || null, city: data.city || null, region: data.regionName || null, country: data.country || null };
      }
      return { ip: null, city: null, region: null, country: null };
    } catch { return { ip: null, city: null, region: null, country: null }; }
  },

  _getDeviceInfo() {
    const ua = navigator.userAgent;
    let browser = 'Unknown', os = 'Unknown', device = 'Desktop';

    if (/Edg\//.test(ua))           browser = 'Edge ' + (ua.match(/Edg\/([\d.]+)/)||[])[1];
    else if (/OPR\//.test(ua))      browser = 'Opera ' + (ua.match(/OPR\/([\d.]+)/)||[])[1];
    else if (/Chrome\//.test(ua))   browser = 'Chrome ' + (ua.match(/Chrome\/([\d.]+)/)||[])[1];
    else if (/Firefox\//.test(ua))  browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)||[])[1];
    else if (/Safari\//.test(ua))   browser = 'Safari ' + (ua.match(/Version\/([\d.]+)/)||[])[1];

    if (/Windows NT/.test(ua))      os = 'Windows';
    else if (/Mac OS X/.test(ua))   os = 'macOS';
    else if (/Android/.test(ua))    os = 'Android';
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua))      os = 'Linux';

    if (/Mobi|Android/i.test(ua))   device = 'Mobile';
    else if (/Tablet|iPad/i.test(ua)) device = 'Tablet';

    return { browser, os, device };
  },

  async login(username, password) {
    const user = DB.getUserByUsername(username);
    if (!user)        return { ok: false, msg: 'ไม่พบชื่อผู้ใช้' };
    if (!user.active) return { ok: false, msg: 'บัญชีถูกระงับการใช้งาน' };
    const [geo, deviceInfo] = await Promise.all([this._fetchGeoInfo(), Promise.resolve(this._getDeviceInfo())]);
    if (user.password !== Utils.hashPassword(password)) {
      DB.logLogin(user.id, user.username, false, geo, deviceInfo);
      return { ok: false, msg: 'รหัสผ่านไม่ถูกต้อง' };
    }
    const session = {
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: user.permissions || [],
      mobileViewOnly: user.mobileViewOnly === true,
      loginTime: new Date().toISOString()
    };
    sessionStorage.setItem(this.KEY, JSON.stringify(session));
    if (user.mustChangePw) sessionStorage.setItem('mustChangePw', '1');
    DB.logLogin(user.id, user.username, true, geo, deviceInfo);
    DB.logActivity(user.id, user.username, 'เข้าสู่ระบบ', {});
    return { ok: true, user: session };
  },

  logout(reason) {
    const s = this.session();
    if (s) {
      DB.logActivity(s.userId, s.username, 'ออกจากระบบ', reason ? { reason } : {});
      // Auto-download backup on sign-out if daily backup is enabled
      try { DB.runAutoBackup(s.username); } catch {}
      // Auto restore point download on sign-out
      try {
        const cfg = ((typeof DB !== 'undefined') ? DB.getSettings() : null) || {};
        if (cfg.autoRestorePoint?.onLogout !== false) {
          const now = new Date();
          const beYear = now.getFullYear() + 543;
          const pad = n => String(n).padStart(2, '0');
          const fn = `restore-${beYear}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
          const blob = new Blob([JSON.stringify(DB.buildBackupPayload(), null, 2)], { type: 'application/json' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = fn;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        }
      } catch(e) { console.warn('[Auth] auto restore point failed:', e.message); }
    }
    // Finish clearing session + navigate. Deferred until pending uploads flush so
    // a just-recorded payment isn't lost when the next login does a fresh full pull.
    const finish = () => {
      // Normal logout — no pending restore point needed on next login
      try { localStorage.removeItem('wt_restore_pending'); } catch {}
      sessionStorage.removeItem(this.KEY);
      // Clear the sync session guard so the login page always does a fresh _pullAll()
      // and picks up any users added on another device while this session was active.
      sessionStorage.removeItem('wt_sync_session_pulled');
      // Invalidate the users_cfg delta timestamp so _pullAll() never skips fetching
      // wt_users on the next load — stale timestamps would cause the delta optimisation
      // to think the document is unchanged even when another device added a new user.
      try {
        var _docTs = JSON.parse(localStorage.getItem('wt_sync_doc_ts') || '{}');
        delete _docTs['users_cfg'];
        localStorage.setItem('wt_sync_doc_ts', JSON.stringify(_docTs));
      } catch {}
      sessionStorage.removeItem('mustChangePw');
      // Sign out of Firebase Auth if available (not loaded in Tauri — auth-compat skipped)
      try { if (window.firebase && firebase.apps.length && typeof firebase.auth === 'function') firebase.auth().signOut(); } catch {}
      window.location.href = 'index.html';
    };
    // Flush pending Firestore uploads BEFORE clearing the session guard / navigating.
    // flushNow() is time-boxed so logout can never hang.
    if (window.Sync && typeof Sync.flushNow === 'function') {
      Sync.flushNow().then(finish, finish);
    } else {
      finish();
    }
  },

  session() {
    try {
      const s = JSON.parse(sessionStorage.getItem(this.KEY));
      if (!s) return null;
      // Auto-expire session after 12 hours for security (belt-and-suspenders
      // since sessionStorage already clears on tab close).
      if (s.loginTime && Date.now() - new Date(s.loginTime).getTime() > 12 * 60 * 60 * 1000) {
        sessionStorage.removeItem(this.KEY);
        return null;
      }
      return s;
    } catch { return null; }
  },

  require() {
    const s = this.session();
    if (!s) { window.location.href = 'index.html'; return null; }
    return s;
  },

  isAdmin() {
    const s = this.session();
    return s && s.role === 'admin';
  },

  // Real mobile phone = touch device with a small screen (not just a narrow
  // desktop window). Used for the per-user "view-only on mobile" restriction.
  isMobile() {
    const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    return touch && window.innerWidth < 768;
  },

  // Mutation permission keys — blocked when a flagged user is on a mobile phone.
  // (Page-access/view keys like dashboard/invoices/customers are NOT here, so
  //  viewing still works.)
  MUTATION_PERMS: new Set([
    'invoice_create','invoice_edit','invoice_delete','invoice_void','invoice_print',
    'payment_add','payment_edit','payment_delete',
    'customer_add','customer_edit','customer_delete',
    'product_add','product_edit','product_delete','pricing_edit',
    'version_add','version_edit','version_delete',
    'cap_stock_add',
    'return_add','return_edit','return_delete',
    'export_backup','import_backup','export_zip','import_zip',
  ]),

  // True when the current user is flagged view-only AND is on a mobile phone.
  _mobileViewOnlyActive() {
    const s = this.session();
    if (!s) return false;
    let flagged = s.mobileViewOnly === true;
    // Live-read the user record so a just-changed flag applies without re-login.
    try {
      if (typeof DB !== 'undefined' && DB.getUserById) {
        const u = DB.getUserById(s.userId);
        if (u) flagged = u.mobileViewOnly === true;
      }
    } catch {}
    return flagged && this.isMobile();
  },

  // Check if current user has a specific permission key.
  // Admin always returns true; regular users must have the key in their permissions array.
  // EXCEPTION: a user flagged "view-only on mobile" (admin included) is denied
  // every mutation permission while on a phone — view permissions still pass.
  can(key) {
    const s = this.session();
    if (!s) return false;
    if (this.MUTATION_PERMS.has(key) && this._mobileViewOnlyActive()) return false;
    if (s.role === 'admin') return true;
    return (s.permissions || []).includes(key);
  },

  // Like require() but also checks a page-level permission key.
  // Redirects to dashboard with an alert if the user lacks access.
  requirePage(key) {
    const s = this.require();
    if (!s) return null;
    if (!this.can(key)) {
      alert('คุณไม่มีสิทธิ์เข้าถึงหน้านี้');
      window.location.href = 'dashboard.html';
      return null;
    }
    return s;
  }
};
