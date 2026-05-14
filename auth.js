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

  async _fetchIP() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      return data.ip || null;
    } catch { return null; }
  },

  async login(username, password) {
    const user = DB.getUserByUsername(username);
    if (!user)        return { ok: false, msg: 'ไม่พบชื่อผู้ใช้' };
    if (!user.active) return { ok: false, msg: 'บัญชีถูกระงับการใช้งาน' };
    const ip = await this._fetchIP();
    if (user.password !== Utils.hashPassword(password)) {
      DB.logLogin(user.id, user.username, false, ip);
      return { ok: false, msg: 'รหัสผ่านไม่ถูกต้อง' };
    }
    const session = {
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: user.permissions || [],
      loginTime: new Date().toISOString()
    };
    sessionStorage.setItem(this.KEY, JSON.stringify(session));
    if (user.mustChangePw) sessionStorage.setItem('mustChangePw', '1');
    DB.logLogin(user.id, user.username, true, ip);
    DB.logActivity(user.id, user.username, 'เข้าสู่ระบบ', {});
    return { ok: true, user: session };
  },

  logout() {
    const s = this.session();
    if (s) DB.logActivity(s.userId, s.username, 'ออกจากระบบ', {});
    sessionStorage.removeItem(this.KEY);
    // Sign out of Firebase if sync is active
    try { if (window.firebase && firebase.apps.length) firebase.auth().signOut(); } catch {}
    window.location.href = 'index.html';
  },

  session() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)); } catch { return null; }
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

  // Check if current user has a specific permission key.
  // Admin always returns true; regular users must have the key in their permissions array.
  can(key) {
    const s = this.session();
    if (!s) return false;
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
