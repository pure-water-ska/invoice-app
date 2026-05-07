const session = Auth.require();
const _canSettings = Auth.isAdmin() || Auth.can('export_backup') || Auth.can('import_backup') || Auth.can('export_zip') || Auth.can('import_zip');
if (!_canSettings) { alert('คุณไม่มีสิทธิ์เข้าถึงหน้านี้'); location.href = 'dashboard.html'; }
DB.init();
Nav.render('settings');

window.addEventListener('DOMContentLoaded', () => {
  loadCompanySettings();
  loadAutoBackup();
  renderStorageBar();
  renderLogCounts();
  loadStats();
  loadVersionInfo();
  initFolderSettings();
  initZipSections();
  if (Auth.isAdmin()) renderErrorLog();
  ['companyName','address','phone'].forEach(id =>
    document.getElementById(id).addEventListener('input', updatePreview)
  );
});

/* ─── Folder Settings ──────────────────────────────────────────────────── */
async function initFolderSettings() {
  if (!window.showDirectoryPicker) {
    document.getElementById('fsApiAlert').classList.remove('d-none');
    document.getElementById('btnPickPdf').disabled    = true;
    document.getElementById('btnPickBackup').disabled = true;
    return;
  }
  const pdfH    = await IDB.get('pdf_dir');
  const backupH = await IDB.get('backup_dir');
  document.getElementById('pdfFolderName').value    = pdfH    ? pdfH.name    : '';
  document.getElementById('backupFolderName').value = backupH ? backupH.name : '';
}

async function pickFolder(type) {
  if (!window.showDirectoryPicker) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await IDB.set(type + '_dir', handle);
    document.getElementById(type + 'FolderName').value = handle.name;
    Utils.showAlert(`<i class="bi bi-check-circle me-1"></i>เลือก ${type === 'pdf' ? 'PDF' : 'Backup'} Folder: <strong>${handle.name}</strong> สำเร็จ`);
  } catch(e) {
    if (e.name !== 'AbortError') Utils.showAlert('เลือก Folder ล้มเหลว: ' + e.message, 'danger');
  }
}

async function clearFolder(type) {
  await IDB.set(type + '_dir', null);
  document.getElementById(type + 'FolderName').value = '';
  Utils.showAlert('ล้าง Folder แล้ว', 'info');
}

async function saveBackupToFolder(content, filename) {
  try {
    const handle = await IDB.get('backup_dir');
    if (!handle) return false;
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    const fh = await handle.getFileHandle(filename, { create: true });
    const w  = await fh.createWritable();
    await w.write(new Blob([content], { type: 'application/json' }));
    await w.close();
    return true;
  } catch(e) {
    console.warn('Backup folder save:', e);
    return false;
  }
}

/* ─── Company Settings ──────────────────────────────────────────────────── */
function loadCompanySettings() {
  const cfg = DB.getSettings();
  document.getElementById('companyName').value = cfg.companyName || '';
  document.getElementById('address').value     = cfg.address     || '';
  document.getElementById('phone').value       = cfg.phone       || '';
  document.getElementById('taxId').value       = cfg.taxId       || '';
  updatePreview();
}

function updatePreview() {
  document.getElementById('prev_name').textContent    = document.getElementById('companyName').value;
  document.getElementById('prev_address').textContent = document.getElementById('address').value;
  document.getElementById('prev_phone').textContent   = 'โทร. ' + document.getElementById('phone').value;
}

function saveCompanySettings() {
  const cfg = DB.getSettings();
  const upd = {
    ...cfg,
    companyName: document.getElementById('companyName').value.trim(),
    address:     document.getElementById('address').value.trim(),
    phone:       document.getElementById('phone').value.trim(),
    taxId:       document.getElementById('taxId').value.trim()
  };
  if (!upd.companyName) { Utils.showAlert('กรุณากรอกชื่อบริษัท/ร้าน', 'warning'); return; }
  DB.saveSettings(upd);
  DB.logActivity(session.userId, session.username, 'แก้ไขตั้งค่าระบบ', {});
  Utils.showAlert('บันทึกการตั้งค่าสำเร็จ');
  updatePreview();
}

/* ─── Auto Backup ───────────────────────────────────────────────────────── */
function loadAutoBackup() {
  const cfg  = DB.getSettings();
  const ab   = cfg.autoBackup || {};
  document.getElementById('abEnabled').checked       = !!ab.enabled;
  document.getElementById('abInterval').value        = ab.interval || 'weekly';
  document.getElementById('abAutoDownload').checked  = !!ab.autoDownload;
  updateAbUi();

  const statusEl = document.getElementById('abStatus');
  if (ab.lastBackupAt) {
    const due = isBackupDue();
    statusEl.innerHTML = `
      <i class="bi bi-${due ? 'exclamation-circle text-warning' : 'check-circle text-success'} me-1"></i>
      สำรองล่าสุด: <strong>${Utils.formatDateTimeTH(ab.lastBackupAt)}</strong>
      ${due ? '— <span class="text-warning fw-semibold">ถึงเวลาสำรองข้อมูลแล้ว!</span>' : '— อัปเดตล่าสุด'}`;
  } else {
    statusEl.innerHTML = `<i class="bi bi-exclamation-circle text-muted me-1"></i>ยังไม่เคยสำรองข้อมูล`;
  }

  // Check if auto-download should fire
  const ab2 = DB.getSettings().autoBackup || {};
  if (ab2.enabled && ab2.autoDownload && isBackupDue()) {
    exportFull();
  } else {
    renderBackupDueBanner();
  }
}

function updateAbUi() {
  const enabled = document.getElementById('abEnabled').checked;
  document.getElementById('abIntervalWrap').style.opacity    = enabled ? '1' : '0.4';
  document.getElementById('abAutoDownloadWrap').style.opacity = enabled ? '1' : '0.4';
}

function saveAutoBackupConfig() {
  const cfg = DB.getSettings();
  cfg.autoBackup = {
    enabled:      document.getElementById('abEnabled').checked,
    interval:     document.getElementById('abInterval').value,
    autoDownload: document.getElementById('abAutoDownload').checked,
    lastBackupAt: (cfg.autoBackup || {}).lastBackupAt || null
  };
  DB.saveSettings(cfg);
  DB.logActivity(session.userId, session.username, 'แก้ไขตั้งค่า Auto Backup', cfg.autoBackup);
  Utils.showAlert('บันทึกการตั้งค่า Auto Backup สำเร็จ');
  loadAutoBackup();
}

function isBackupDue() { return DB.isBackupDue(); }

function markBackupDone() {
  DB.markBackupDone();
  loadAutoBackup();
}

function renderBackupDueBanner() {
  const banner = document.getElementById('backupDueBanner');
  if (!banner || !isBackupDue()) { if (banner) banner.innerHTML = ''; return; }
  const ab = DB.getSettings().autoBackup;
  const intervalLabel = { daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน' }[ab.interval] || '';
  banner.innerHTML = `
    <div class="alert alert-warning alert-dismissible mb-0 rounded-0 d-flex align-items-center gap-3" role="alert">
      <i class="bi bi-exclamation-triangle-fill fs-5 flex-shrink-0"></i>
      <div class="flex-grow-1">
        <strong>ถึงเวลาสำรองข้อมูลแล้ว!</strong>
        ตั้งค่าไว้: <em>${intervalLabel}</em>
        ${ab.lastBackupAt ? ` — สำรองล่าสุด: ${Utils.formatDateTimeTH(ab.lastBackupAt)}` : ' — ยังไม่เคยสำรอง'}
      </div>
      <button class="btn btn-warning btn-sm flex-shrink-0" onclick="exportFull()">
        <i class="bi bi-download me-1"></i>Backup ทันที
      </button>
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>`;
}

/* ─── Storage Bar ───────────────────────────────────────────────────────── */
function renderStorageBar() {
  let used = 0;
  for (const k in localStorage) {
    if (k.startsWith('wt_')) used += (localStorage.getItem(k) || '').length * 2;
  }
  const limit = 5 * 1024 * 1024;
  const pct   = Math.min(100, (used / limit) * 100);
  const colorClass = pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-success';
  document.getElementById('storageBar').innerHTML = `
    <div class="d-flex justify-content-between text-muted small mb-1">
      <span><i class="bi bi-hdd me-1"></i>พื้นที่ localStorage ที่ใช้</span>
      <span>${fmtBytes(used)} / ~5 MB (${pct.toFixed(1)}%)</span>
    </div>
    <div class="progress" style="height:8px">
      <div class="progress-bar ${colorClass}" style="width:${pct.toFixed(1)}%"></div>
    </div>`;
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/* ─── Log Counts ────────────────────────────────────────────────────────── */
function renderLogCounts() {
  const acts = DB.getActivity();
  const arch = DB.getActivityArchive ? DB.getActivityArchive() : [];
  const logs = DB.getLogins();
  const archTxt = arch.length ? ` (archive: ${arch.length.toLocaleString('th-TH')})` : '';
  document.getElementById('activityLogCount').textContent = `${acts.length.toLocaleString('th-TH')} รายการ${archTxt}`;
  document.getElementById('loginLogCount').textContent    = `${logs.length.toLocaleString('th-TH')} รายการ`;
}

/* ─── Archive Logs ──────────────────────────────────────────────────────── */
function archiveLogs() {
  const arch = DB.getActivityArchive ? DB.getActivityArchive() : [];
  if (!confirm(`ย้าย Activity Log ที่เก่ากว่า 6 เดือนไปยัง Archive?\n(Archive ปัจจุบัน: ${arch.length} รายการ)`)) return;
  const result = DB.archiveOldLogs(6);
  if (result.archived === 0) {
    Utils.showAlert('ไม่มี Log ที่เก่ากว่า 6 เดือน', 'info'); return;
  }
  Utils.showAlert(`<i class="bi bi-archive me-1"></i>Archive สำเร็จ — ย้าย <strong>${result.archived}</strong> รายการ, เหลือ <strong>${result.remaining}</strong> รายการใน Log ปัจจุบัน`);
  renderLogCounts();
  renderStorageBar();
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toCSV(headers, rows) {
  const BOM    = '﻿'; // UTF-8 BOM — Excel จะอ่าน Thai ได้ถูกต้อง
  const escape = v => {
    const s = String(v ?? '').replace(/"/g, '""');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
  };
  return BOM + [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

/* ─── Manual Backup Exports ─────────────────────────────────────────────── */
function buildBackupPayload(opts = {}) {
  // opts: { includeLogs, includeData, includeConfig }
  const { includeLogs = true, includeData = true, includeConfig = true } = opts;
  const d = {
    exportDate:    new Date().toISOString(),
    exportVersion: '2.0'
  };
  if (includeConfig) {
    d.settings   = DB.getSettings();
    d.payMethods = DB.getPayMethods();
    d.pricing    = DB.getPricing();
  }
  if (includeData) {
    d.users      = DB.getUsers().map(u => ({ ...u, password: '[HASHED]' }));
    d.customers  = DB.getCustomers();
    d.products   = DB.getProducts();
    d.invoices   = DB.getInvoices();
    d.payments   = DB.getPayments();
    d.versions   = DB.getVersions();
  }
  if (includeLogs) {
    d.activity = DB.getActivity();
    d.logins   = DB.getLogins();
  }
  return d;
}

async function exportFull() {
  const data = buildBackupPayload({ includeLogs: true, includeData: true, includeConfig: true });
  const json = JSON.stringify(data, null, 2);
  const fn   = `backup_full_${dateStamp()}.json`;
  downloadFile(json, fn, 'application/json');
  const toDir = await saveBackupToFolder(json, fn);
  markBackupDone();
  DB.logActivity(session.userId, session.username, 'Export ข้อมูล (Full Backup)', {});
  Utils.showAlert(`<i class="bi bi-check-circle me-1"></i>Full Backup สำเร็จ${toDir ? ' — บันทึกไปยัง Backup Folder ด้วย' : ''}`);
  renderStorageBar();
}

async function exportDataOnly() {
  const data = buildBackupPayload({ includeLogs: false, includeData: true, includeConfig: true });
  const json = JSON.stringify(data, null, 2);
  const fn   = `backup_data_${dateStamp()}.json`;
  downloadFile(json, fn, 'application/json');
  const toDir = await saveBackupToFolder(json, fn);
  markBackupDone();
  DB.logActivity(session.userId, session.username, 'Export ข้อมูล (Data Only)', {});
  Utils.showAlert(`Export ข้อมูล (ไม่รวม Log) สำเร็จ${toDir ? ' — บันทึกไปยัง Backup Folder ด้วย' : ''}`);
}

async function exportLogsOnly() {
  const data = buildBackupPayload({ includeLogs: true, includeData: false, includeConfig: false });
  const json = JSON.stringify(data, null, 2);
  const fn   = `logs_${dateStamp()}.json`;
  downloadFile(json, fn, 'application/json');
  await saveBackupToFolder(json, fn);
  DB.logActivity(session.userId, session.username, 'Export Logs', {});
  Utils.showAlert('Export Logs สำเร็จ');
}

async function exportConfigOnly() {
  const data = buildBackupPayload({ includeLogs: false, includeData: false, includeConfig: true });
  const json = JSON.stringify(data, null, 2);
  const fn   = `config_${dateStamp()}.json`;
  downloadFile(json, fn, 'application/json');
  await saveBackupToFolder(json, fn);
  DB.logActivity(session.userId, session.username, 'Export Config', {});
  Utils.showAlert('Export Config สำเร็จ');
}

/* ─── Export Logs (CSV / JSON) ──────────────────────────────────────────── */
function exportActivityLog(fmt) {
  const logs = DB.getActivity();
  if (fmt === 'json') {
    downloadFile(JSON.stringify(logs, null, 2), `activity_log_${dateStamp()}.json`, 'application/json');
  } else {
    const headers = ['วันที่-เวลา', 'ชื่อผู้ใช้', 'การกระทำ', 'รายละเอียด'];
    const rows    = logs.map(l => [
      Utils.formatDateTimeTH(l.timestamp),
      l.username,
      l.action,
      JSON.stringify(l.details || {})
    ]);
    downloadFile(toCSV(headers, rows), `activity_log_${dateStamp()}.csv`, 'text/csv;charset=utf-8');
  }
  DB.logActivity(session.userId, session.username, 'Export Activity Log', { format: fmt });
  Utils.showAlert(`Export Activity Log (${fmt.toUpperCase()}) สำเร็จ`);
}

function exportLoginLog(fmt) {
  const logs = DB.getLogins();
  if (fmt === 'json') {
    downloadFile(JSON.stringify(logs, null, 2), `login_log_${dateStamp()}.json`, 'application/json');
  } else {
    const headers = ['วันที่-เวลา', 'ชื่อผู้ใช้', 'สถานะ'];
    const rows    = logs.map(l => [
      Utils.formatDateTimeTH(l.timestamp),
      l.username,
      l.success ? 'สำเร็จ' : 'ล้มเหลว'
    ]);
    downloadFile(toCSV(headers, rows), `login_log_${dateStamp()}.csv`, 'text/csv;charset=utf-8');
  }
  DB.logActivity(session.userId, session.username, 'Export Login Log', { format: fmt });
  Utils.showAlert(`Export Login Log (${fmt.toUpperCase()}) สำเร็จ`);
}

/* ─── Import / Restore ──────────────────────────────────────────────────── */
function importData(input, mode) {
  const file = input.files[0];
  if (!file) return;
  const modeLabel = mode === 'overwrite' ? 'เขียนทับข้อมูลทั้งหมด ⚠️' : 'เพิ่มข้อมูลใหม่ (Merge)';
  if (!confirm(`Import ไฟล์: "${file.name}"\nโหมด: ${modeLabel}\n\nดำเนินการต่อหรือไม่?`)) {
    input.value = ''; return;
  }
  if (mode === 'overwrite' && !confirm('⚠️ ยืนยันอีกครั้ง — ข้อมูลเดิมทั้งหมดจะถูกแทนที่!')) {
    input.value = ''; return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      // ── JSON structure validation ──────────────────────────────────────────
      let data;
      try { data = JSON.parse(e.target.result); } catch(pe) {
        throw new Error('ไฟล์ JSON ไม่ถูกต้อง (parse error): ' + pe.message);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('ไฟล์ไม่ใช่ JSON object ที่ถูกต้อง');
      const knownKeys = ['customers','invoices','products','payments','versions','settings','users'];
      if (!knownKeys.some(k => data[k])) throw new Error('ไฟล์ไม่มีข้อมูลที่รู้จัก (ไม่พบ customers/invoices/products ฯลฯ)');
      if (mode === 'overwrite') {
        const totalRec = (data.customers?.length||0)+(data.invoices?.length||0)+(data.products?.length||0)+(data.payments?.length||0);
        if (totalRec === 0) throw new Error('ไฟล์มีข้อมูลว่างเปล่า ไม่สามารถ Overwrite ได้');
      }

      // ── Snapshot counts BEFORE import ─────────────────────────────────────
      const before = {
        customers: DB.getCustomers().length,
        products:  DB.getProducts().length,
        invoices:  DB.getInvoices().length,
        payments:  DB.getPayments().length,
      };

      // Settings & config (always merge/update, never blank out)
      if (data.settings)   DB.saveSettings({ ...DB.getSettings(), ...data.settings });
      if (data.payMethods) DB.savePayMethods(data.payMethods);
      if (data.pricing)    DB.savePricing(data.pricing);

      const importCol = (arr, getAll, saveAll, addOne) => {
        if (!arr) return 0;
        if (mode === 'overwrite') { saveAll(arr); return arr.length; }
        const ids = new Set(getAll().map(x => x.id));
        let n = 0;
        arr.forEach(item => { if (!ids.has(item.id)) { addOne(item); n++; } });
        return n;
      };

      const c = {
        customers: importCol(data.customers, () => DB.getCustomers(), DB.saveCustomers.bind(DB), DB.addCustomer.bind(DB)),
        products:  importCol(data.products,  () => DB.getProducts(),  DB.saveProducts.bind(DB),  DB.addProduct.bind(DB)),
        invoices:  importCol(data.invoices,  () => DB.getInvoices(),  DB.saveInvoices.bind(DB),  DB.addInvoice.bind(DB)),
        payments:  importCol(data.payments,  () => DB.getPayments(),  DB.savePayments.bind(DB),  DB.addPayment.bind(DB)),
        versions:  importCol(data.versions,  () => DB.getVersions(),  DB.saveVersions.bind(DB),  DB.addVersion.bind(DB)),
      };

      // ── Snapshot counts AFTER import + integrity check ─────────────────────
      const after = {
        customers: DB.getCustomers().length,
        products:  DB.getProducts().length,
        invoices:  DB.getInvoices().length,
        payments:  DB.getPayments().length,
      };
      const losses = [];
      if (after.customers < before.customers) losses.push(`ลูกค้า ${before.customers}→${after.customers}`);
      if (after.products  < before.products)  losses.push(`สินค้า ${before.products}→${after.products}`);
      if (after.invoices  < before.invoices)  losses.push(`ใบกำกับ ${before.invoices}→${after.invoices}`);
      if (after.payments  < before.payments)  losses.push(`ชำระ ${before.payments}→${after.payments}`);

      DB.logActivity(session.userId, session.username, 'Import ข้อมูล', { file: file.name, mode, before, after });
      const modeText = mode === 'overwrite' ? 'Overwrite' : 'Merge';
      Utils.showAlert(
        `Import สำเร็จ [${modeText}] — ` +
        `ลูกค้า: ${c.customers}, สินค้า: ${c.products}, ` +
        `ใบกำกับ: ${c.invoices}, ชำระ: ${c.payments}, ฉลาก: ${c.versions}`
      );
      if (losses.length) {
        setTimeout(() => Utils.showAlert(
          `<i class="bi bi-exclamation-triangle-fill me-1"></i><strong>ตรวจพบข้อมูลลดลงหลัง Import</strong> — ${losses.join(', ')} — กรุณาตรวจสอบ`, 'warning'
        ), 200);
      }
      loadCompanySettings();
      loadStats();
      renderStorageBar();
      renderLogCounts();
    } catch (err) {
      Utils.showAlert('<i class="bi bi-x-circle me-1"></i>ไม่สามารถ Import ได้: ' + err.message, 'danger');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

/* ─── ZIP Section Visibility ────────────────────────────────────────────── */
async function initZipSections() {
  if (!Auth.isAdmin()) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  }
  if (Auth.can('export_backup')) {
    document.getElementById('exportBackupCard').style.display = '';
  }
  if (Auth.can('import_backup')) {
    document.getElementById('importBackupCard').style.display = '';
  }
  if (Auth.can('export_zip')) {
    document.getElementById('zipExportCard').style.display = '';
    const h = await IDB.get('pdf_dir');
    const el = document.getElementById('zipPdfFolderInfo');
    el.innerHTML = h
      ? `<i class="bi bi-folder2-open me-1 text-warning"></i>PDF Folder: <strong>${h.name}</strong>`
      : '<i class="bi bi-exclamation-triangle me-1 text-danger"></i>ยังไม่ได้ตั้ง PDF Folder — จะ Export เฉพาะข้อมูล ไม่รวม PDF';
  }
  if (Auth.can('import_zip')) {
    document.getElementById('zipImportCard').style.display = '';
  }
  // Google Drive card — show for admin always
  if (Auth.isAdmin()) {
    document.getElementById('driveCard').style.display = '';
    initDriveCard();
  }
}

/* ─── Google Drive UI ────────────────────────────────────────────────────── */
async function initDriveCard() {
  const hasConfig = typeof GOOGLE_CLIENT_ID !== 'undefined' && GOOGLE_CLIENT_ID &&
                    GOOGLE_CLIENT_ID.includes('.apps.googleusercontent.com');
  if (!hasConfig) {
    document.getElementById('driveNoConfig').classList.remove('d-none');
    return;
  }
  document.getElementById('driveStats').classList.remove('d-none');
  await refreshDriveStats();
  // If was previously signed in, auto-reconnect silently
  if (localStorage.getItem('wt_drive_signed_in') === '1' && window.DriveStore && !DriveStore.ready) {
    updateDriveUI(false); // show sign-in button
  } else {
    updateDriveUI(window.DriveStore?.ready || false);
  }
}

function updateDriveUI(isReady) {
  document.getElementById('driveSignInBtn').classList.toggle('d-none', isReady);
  document.getElementById('driveSignOutBtn').classList.toggle('d-none', !isReady);
  document.getElementById('driveStatusIcon').textContent = isReady ? '✅' : '☁';
  document.getElementById('driveStatusText').textContent = isReady ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้เชื่อมต่อ';
  document.getElementById('driveStatusBox').className = `border rounded p-3 text-center ${isReady ? 'border-success bg-success bg-opacity-10' : ''}`;
  if (isReady) {
    document.getElementById('driveFileListWrap').style.display = '';
    renderDriveFileList();
  } else {
    document.getElementById('driveFileListWrap').style.display = 'none';
  }
}

async function refreshDriveStats() {
  if (!window.DriveStore) return;
  const s = await DriveStore.getStatus();
  document.getElementById('driveFileCount').textContent   = s.fileCount;
  document.getElementById('driveCachedCount').textContent = s.recentCount;
  document.getElementById('driveCacheSize').textContent   = s.cacheMB + ' MB';
}

function renderDriveFileList() {
  if (!window.DriveStore) return;
  const meta = DriveStore.getAllMeta()
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, 50);
  const tbody = document.getElementById('driveFileListBody');
  if (!meta.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">ยังไม่มีไฟล์</td></tr>';
    return;
  }
  tbody.innerHTML = meta.map(m => {
    const isRecent = DriveStore._isRecent(m.uploadedAt);
    const sizeTxt  = m.size ? (m.size > 1048576 ? (m.size/1048576).toFixed(1)+' MB' : Math.round(m.size/1024)+' KB') : '—';
    return `<tr>
      <td class="small"><i class="bi bi-file-earmark-pdf text-danger me-1"></i>${esc(m.filename)}</td>
      <td class="small">${m.invoiceNumber ? `<code>${esc(m.invoiceNumber)}</code>` : '—'}</td>
      <td class="small">${m.uploadedAt ? Utils.formatDateTH(m.uploadedAt) : '—'}</td>
      <td class="small">${sizeTxt}</td>
      <td class="text-center">${isRecent ? '<span class="badge bg-success" style="font-size:10px">●</span>' : '<span class="badge bg-secondary" style="font-size:10px">Drive</span>'}</td>
      <td class="text-center">
        <button class="btn btn-xs btn-outline-primary me-1" style="padding:1px 6px;font-size:11px"
                onclick="driveOpenFile('${m.driveId}','${m.uploadedAt || ''}','${esc(m.mimeType || 'application/pdf')}')">
          <i class="bi bi-eye"></i>
        </button>
        <button class="btn btn-xs btn-outline-danger" style="padding:1px 6px;font-size:11px"
                onclick="driveDeleteFile('${m.driveId}','${esc(m.filename)}')">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function driveSignIn() {
  const btn = document.getElementById('driveSignInBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังเชื่อมต่อ...';
  try {
    await DriveStore.signIn();
    updateDriveUI(true);
    await refreshDriveStats();
    Utils.showAlert('เชื่อมต่อ Google Drive สำเร็จ ✅', 'success');
  } catch (e) {
    Utils.showAlert('เชื่อมต่อ Google Drive ไม่สำเร็จ: ' + e.message, 'danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-google me-1"></i>เข้าสู่ระบบ Google';
  }
}

function driveSignOut() {
  if (!confirm('ออกจากระบบ Google Drive?\n(ไฟล์ที่อัปโหลดแล้วยังอยู่ใน Drive)')) return;
  DriveStore.signOut();
  updateDriveUI(false);
}

async function driveOpenFile(driveId, uploadedAt, mimeType) {
  if (!DriveStore.ready) {
    Utils.showAlert('กรุณาเข้าสู่ระบบ Google Drive ก่อน', 'warning'); return;
  }
  try {
    const url = await DriveStore.getFileURL(driveId, uploadedAt || undefined);
    const win = window.open('', '_blank');
    if (mimeType === 'application/pdf') {
      win.document.write(`<html><body style="margin:0"><iframe src="${url}" width="100%" height="100%" frameborder="0"></iframe></body></html>`);
    } else {
      win.document.write(`<html><body style="margin:0;display:flex;justify-content:center;background:#111"><img src="${url}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`);
    }
  } catch (e) {
    Utils.showAlert('โหลดไฟล์ไม่สำเร็จ: ' + e.message, 'danger');
  }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function driveDeleteFile(driveId, filename) {
  if (!confirm(`ลบไฟล์ "${filename}" ออกจาก Google Drive?\nไฟล์จะหายถาวร`)) return;
  try {
    await DriveStore.deleteFile(driveId);
    await refreshDriveStats();
    renderDriveFileList();
    Utils.showAlert('ลบไฟล์สำเร็จ', 'info');
  } catch (e) {
    Utils.showAlert('ลบไม่สำเร็จ: ' + e.message, 'danger');
  }
}

/* ─── ZIP Export / Import ───────────────────────────────────────────────── */
async function exportZip() {
  if (!Auth.can('export_zip')) { Utils.showAlert('ไม่มีสิทธิ์ Export ZIP', 'danger'); return; }
  if (typeof JSZip === 'undefined') { Utils.showAlert('โหลด JSZip ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต', 'danger'); return; }

  const zip = new JSZip();
  const data = buildBackupPayload({ includeLogs: true, includeData: true, includeConfig: true });
  zip.file('backup.json', JSON.stringify(data, null, 2));

  let pdfCount = 0;
  const dirHandle = await IDB.get('pdf_dir');
  if (dirHandle) {
    try {
      const perm = await dirHandle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        const pdfFolder = zip.folder('pdfs');
        for await (const [name, handle] of dirHandle.entries()) {
          if (handle.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
            const file = await handle.getFile();
            pdfFolder.file(name, await file.arrayBuffer());
            pdfCount++;
          }
        }
      }
    } catch(e) { console.warn('exportZip PDF:', e); }
  }

  Utils.showAlert('<i class="bi bi-hourglass-split me-1"></i>กำลังสร้างไฟล์ ZIP...', 'info');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const fn = `backup_zip_${dateStamp()}.zip`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);

  markBackupDone();
  DB.logActivity(session.userId, session.username, 'Export ZIP', { pdfs: pdfCount });
  Utils.showAlert(`<i class="bi bi-check-circle me-1"></i>Export ZIP สำเร็จ — ข้อมูล + PDF ${pdfCount} ไฟล์ → <strong>${fn}</strong>`);
  renderStorageBar();
}

async function importZip(input, mode) {
  if (!Auth.can('import_zip')) { Utils.showAlert('ไม่มีสิทธิ์ Import ZIP', 'danger'); return; }
  const file = input.files[0];
  if (!file) return;
  const modeLabel = mode === 'overwrite' ? 'เขียนทับข้อมูลทั้งหมด ⚠️' : 'เพิ่มข้อมูลใหม่ (Merge)';
  if (!confirm(`Import ZIP: "${file.name}"\nโหมด: ${modeLabel}\n\nดำเนินการต่อหรือไม่?`)) { input.value = ''; return; }
  if (mode === 'overwrite' && !confirm('⚠️ ยืนยันอีกครั้ง — ข้อมูลเดิมทั้งหมดจะถูกแทนที่!')) { input.value = ''; return; }

  try {
    Utils.showAlert('<i class="bi bi-hourglass-split me-1"></i>กำลังอ่านไฟล์ ZIP...', 'info');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());

    // ── Import JSON data ──
    const jsonEntry = zip.file('backup.json');
    if (!jsonEntry) throw new Error('ไม่พบไฟล์ backup.json ใน ZIP');
    const data = JSON.parse(await jsonEntry.async('string'));

    if (data.settings)   DB.saveSettings({ ...DB.getSettings(), ...data.settings });
    if (data.payMethods) DB.savePayMethods(data.payMethods);
    if (data.pricing)    DB.savePricing(data.pricing);

    const importCol = (arr, getAll, saveAll, addOne) => {
      if (!arr) return 0;
      if (mode === 'overwrite') { saveAll(arr); return arr.length; }
      const ids = new Set(getAll().map(x => x.id));
      let n = 0;
      arr.forEach(item => { if (!ids.has(item.id)) { addOne(item); n++; } });
      return n;
    };
    const c = {
      customers: importCol(data.customers, () => DB.getCustomers(), DB.saveCustomers.bind(DB), DB.addCustomer.bind(DB)),
      products:  importCol(data.products,  () => DB.getProducts(),  DB.saveProducts.bind(DB),  DB.addProduct.bind(DB)),
      invoices:  importCol(data.invoices,  () => DB.getInvoices(),  DB.saveInvoices.bind(DB),  DB.addInvoice.bind(DB)),
      payments:  importCol(data.payments,  () => DB.getPayments(),  DB.savePayments.bind(DB),  DB.addPayment.bind(DB)),
      versions:  importCol(data.versions,  () => DB.getVersions(),  DB.saveVersions.bind(DB),  DB.addVersion.bind(DB)),
    };

    // ── Import PDF files ──
    let pdfCount = 0, pdfSkipped = 0;
    const dirHandle = await IDB.get('pdf_dir');
    const pdfFolder = zip.folder('pdfs');
    if (pdfFolder && dirHandle) {
      try {
        const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          const tasks = [];
          pdfFolder.forEach((relPath, entry) => {
            if (!entry.dir && relPath.toLowerCase().endsWith('.pdf')) {
              tasks.push(entry.async('arraybuffer').then(async ab => {
                const fh = await dirHandle.getFileHandle(relPath, { create: true });
                const w  = await fh.createWritable();
                await w.write(ab); await w.close();
                pdfCount++;
              }).catch(() => { pdfSkipped++; }));
            }
          });
          await Promise.all(tasks);
        }
      } catch(e) { console.warn('importZip PDF:', e); }
    } else if (pdfFolder && !dirHandle) {
      pdfFolder.forEach((p, e) => { if (!e.dir) pdfSkipped++; });
    }

    DB.logActivity(session.userId, session.username, 'Import ZIP', { file: file.name, mode, pdfs: pdfCount });
    const modeText = mode === 'overwrite' ? 'Overwrite' : 'Merge';
    const pdfMsg = pdfCount > 0 ? `, PDF: ${pdfCount} ไฟล์` : (pdfSkipped > 0 ? ` (PDF ${pdfSkipped} ไฟล์ข้าม — ยังไม่ได้ตั้ง PDF Folder)` : '');
    Utils.showAlert(
      `<i class="bi bi-check-circle me-1"></i>Import ZIP สำเร็จ [${modeText}] — ` +
      `ลูกค้า: ${c.customers}, สินค้า: ${c.products}, ใบกำกับ: ${c.invoices}, ชำระ: ${c.payments}${pdfMsg}`
    );
    loadCompanySettings(); loadStats(); renderStorageBar(); renderLogCounts();
  } catch(err) {
    Utils.showAlert('ไฟล์ไม่ถูกต้อง: ' + err.message, 'danger');
  }
  input.value = '';
}

/* ─── Danger Zone ───────────────────────────────────────────────────────── */
function clearAllData() {
  if (!confirm('⚠️ ล้างข้อมูลทั้งหมด?\nการกระทำนี้ไม่สามารถกู้คืนได้!')) return;
  if (!confirm('ยืนยันอีกครั้ง — ลบข้อมูลทุกอย่างจริงหรือไม่?')) return;
  const cfg = DB.getSettings();
  Object.values(DB.K).forEach(k => localStorage.removeItem(k));
  DB.saveSettings(cfg);
  DB.init();
  Utils.showAlert('ล้างข้อมูลทั้งหมดแล้ว (ยกเว้นตั้งค่าบริษัทและ admin)', 'warning');
  loadStats();
  renderStorageBar();
  renderLogCounts();
}

/* ─── Error Log ─────────────────────────────────────────────────────────── */
function renderErrorLog() {
  const errors = DB.getErrors();
  const badge  = document.getElementById('errorLogBadge');
  if (badge) badge.textContent = errors.length || '';

  const container = document.getElementById('errorLogContainer');
  if (!container) return;

  if (!errors.length) {
    container.innerHTML = '<div class="text-muted small text-center py-4"><i class="bi bi-check-circle text-success me-1"></i>ไม่มี Error</div>';
    return;
  }

  const typeColor = { 'JS Error': 'danger', 'Unhandled Promise': 'warning', 'Manual': 'secondary' };

  container.innerHTML = `
    <div class="table-responsive" style="max-height:320px;overflow-y:auto">
      <table class="table table-sm table-hover mb-0" style="font-size:12px">
        <thead class="table-dark sticky-top">
          <tr>
            <th style="width:140px">วันที่-เวลา</th>
            <th style="width:130px">ประเภท</th>
            <th style="width:80px">หน้า</th>
            <th style="width:80px">ผู้ใช้</th>
            <th>ข้อความ</th>
            <th style="width:32px"></th>
          </tr>
        </thead>
        <tbody>
          ${errors.map((e, i) => `
            <tr>
              <td class="text-muted">${Utils.formatDateTimeTH(e.timestamp)}</td>
              <td><span class="badge bg-${typeColor[e.type]||'secondary'}">${e.type}</span></td>
              <td class="text-muted">${e.page||'-'}</td>
              <td class="text-muted">${e.user||'-'}</td>
              <td class="text-truncate" style="max-width:300px" title="${(e.message||'').replace(/"/g,'&quot;')}">${e.message||'-'}</td>
              <td>
                ${e.detail && Object.keys(e.detail).length
                  ? `<button class="btn btn-link btn-sm p-0" onclick="toggleErrorDetail('ed${i}')" title="รายละเอียด"><i class="bi bi-chevron-down"></i></button>`
                  : ''}
              </td>
            </tr>
            ${e.detail && Object.keys(e.detail).length ? `
            <tr id="ed${i}" style="display:none">
              <td colspan="6" class="bg-light">
                <pre class="mb-0 small text-muted" style="white-space:pre-wrap;font-size:11px">${JSON.stringify(e.detail, null, 2)}</pre>
              </td>
            </tr>` : ''}
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function toggleErrorDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function exportErrorLog() {
  const errors = DB.getErrors();
  if (!errors.length) { Utils.showAlert('ไม่มีข้อมูล Error Log', 'warning'); return; }
  const d    = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const blob = new Blob([JSON.stringify(errors, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `error_log_${stamp}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  Utils.showAlert('Export Error Log สำเร็จ');
}

function clearErrorLog() {
  if (!confirm(`ล้าง Error Log ทั้งหมด ${DB.getErrors().length} รายการ?`)) return;
  DB.clearErrors();
  DB.logActivity(session.userId, session.username, 'ล้าง Error Log', {});
  renderErrorLog();
  Utils.showAlert('ล้าง Error Log แล้ว', 'warning');
}

/* ─── Health Check ──────────────────────────────────────────────────────── */
function runHealthCheck() {
  const checks = [];

  const customers = DB.getCustomers();
  const products  = DB.getProducts();
  const invoices  = DB.getInvoices();
  const payments  = DB.getPayments();
  const custIds   = new Set(customers.map(c => c.id));
  const prodIds   = new Set(products.map(p => p.id));
  const invNums   = new Set(invoices.map(i => i.invoiceNumber));

  // ── localStorage usage ──
  let usedBytes = 0;
  for (const k in localStorage) {
    if (k.startsWith('wt_')) usedBytes += (localStorage.getItem(k) || '').length * 2;
  }
  const usedMB  = (usedBytes / 1048576).toFixed(2);
  const usedPct = Math.min(100, (usedBytes / (5 * 1048576)) * 100).toFixed(0);
  const storageColor = usedPct >= 80 ? 'danger' : usedPct >= 60 ? 'warning' : 'success';
  checks.push({
    label: 'พื้นที่ localStorage',
    status: storageColor === 'danger' ? 'error' : storageColor === 'warning' ? 'warn' : 'ok',
    detail: `${usedMB} MB / ~5 MB (${usedPct}%)`,
    extra: `<div class="progress mt-1" style="height:6px"><div class="progress-bar bg-${storageColor}" style="width:${usedPct}%"></div></div>`
  });

  // ── Duplicate customer IDs ──
  const custIdArr  = customers.map(c => c.id);
  const dupCustIds = custIdArr.filter((id, i) => custIdArr.indexOf(id) !== i);
  checks.push({
    label: 'ID ลูกค้าซ้ำ',
    status: dupCustIds.length ? 'error' : 'ok',
    detail: dupCustIds.length ? `พบ ${dupCustIds.length} รายการซ้ำ` : `ไม่พบ (${customers.length} ราย)`
  });

  // ── Invoices with missing customer ──
  const orphanInv = [...new Set(invoices.filter(i => i.customerId && !custIds.has(i.customerId)).map(i => i.invoiceNumber))];
  checks.push({
    label: 'ใบกำกับไม่มีข้อมูลลูกค้า',
    status: orphanInv.length ? 'warn' : 'ok',
    detail: orphanInv.length ? `${orphanInv.length} เลขที่: ${orphanInv.slice(0,3).join(', ')}${orphanInv.length>3?'…':''}` : `ไม่พบ`
  });

  // ── Invoice items with missing product ──
  const orphanProd = invoices.filter(i => i.productId && !prodIds.has(i.productId));
  const orphanProdNums = [...new Set(orphanProd.map(i => i.invoiceNumber))];
  checks.push({
    label: 'รายการสินค้าในใบกำกับไม่พบสินค้า',
    status: orphanProdNums.length ? 'warn' : 'ok',
    detail: orphanProdNums.length ? `${orphanProdNums.length} ใบ: ${orphanProdNums.slice(0,3).join(', ')}${orphanProdNums.length>3?'…':''}` : `ไม่พบ`
  });

  // ── Payments with missing invoice ──
  const orphanPay = payments.filter(p => !invNums.has(p.invoiceNumber));
  checks.push({
    label: 'การชำระเงินไม่มีใบกำกับอ้างอิง',
    status: orphanPay.length ? 'warn' : 'ok',
    detail: orphanPay.length ? `${orphanPay.length} รายการ` : `ไม่พบ`
  });

  // ── Invoices missing required fields ──
  const badInv = invoices.filter(i => !i.invoiceNumber || !i.createdAt || !i.totalAmount);
  checks.push({
    label: 'ใบกำกับข้อมูลไม่ครบ (เลขที่/วันที่/ยอด)',
    status: badInv.length ? 'error' : 'ok',
    detail: badInv.length ? `${badInv.length} รายการ` : `ไม่พบ`
  });

  // ── Customers missing name ──
  const noName = customers.filter(c => !c.name || !c.name.trim());
  checks.push({
    label: 'ลูกค้าไม่มีชื่อ',
    status: noName.length ? 'error' : 'ok',
    detail: noName.length ? `${noName.length} ราย` : `ไม่พบ`
  });

  // ── Negative payment amounts ──
  const negPay = payments.filter(p => parseFloat(p.amount) < 0);
  checks.push({
    label: 'ยอดชำระเงินติดลบ',
    status: negPay.length ? 'error' : 'ok',
    detail: negPay.length ? `${negPay.length} รายการ` : `ไม่พบ`
  });

  // ── Summary ──
  const errors = checks.filter(c => c.status === 'error').length;
  const warns  = checks.filter(c => c.status === 'warn').length;
  const summaryColor = errors ? 'danger' : warns ? 'warning' : 'success';
  const summaryIcon  = errors ? 'x-circle-fill' : warns ? 'exclamation-triangle-fill' : 'check-circle-fill';
  const summaryText  = errors ? `พบปัญหา ${errors} รายการ` : warns ? `พบข้อควรระวัง ${warns} รายการ` : 'ข้อมูลสมบูรณ์';

  const iconMap = { ok: 'check-circle-fill text-success', warn: 'exclamation-triangle-fill text-warning', error: 'x-circle-fill text-danger' };

  document.getElementById('healthCheckResult').innerHTML = `
    <div class="alert alert-${summaryColor} rounded-0 mb-0 d-flex align-items-center gap-2">
      <i class="bi bi-${summaryIcon} fs-5"></i>
      <strong>${summaryText}</strong>
      <span class="ms-auto text-muted small">ตรวจเมื่อ ${Utils.formatDateTimeTH(new Date().toISOString())}</span>
    </div>
    <table class="table table-sm table-hover mb-0">
      <thead class="table-light"><tr><th style="width:40%">รายการตรวจสอบ</th><th>ผล</th><th>รายละเอียด</th></tr></thead>
      <tbody>
        ${checks.map(c => `
          <tr>
            <td class="fw-semibold small">${c.label}</td>
            <td><i class="bi bi-${iconMap[c.status]}"></i></td>
            <td class="small text-muted">${c.detail}${c.extra||''}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  DB.logActivity(session.userId, session.username, 'Health Check', { errors, warns });
}

function loadVersionInfo() {
  document.getElementById('versionBadge').textContent = APP_VERSION.version;
  const d = new Date(APP_VERSION.date);
  document.getElementById('versionDate').textContent =
    `${d.getDate()} ${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][d.getMonth()]} ${d.getFullYear()+543}`;
  document.getElementById('versionDevice').textContent = window.location.hostname || 'localhost';
}

function compareVersion() {
  const other = document.getElementById('versionOther').value.trim();
  const el = document.getElementById('versionCompareResult');
  if (!other) { el.innerHTML = ''; return; }
  if (other === APP_VERSION.version) {
    el.innerHTML = '<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>เวอร์ชันตรงกัน — โปรแกรมเป็นรุ่นเดียวกัน</span>';
  } else {
    el.innerHTML = `<span class="text-danger"><i class="bi bi-exclamation-triangle-fill me-1"></i>เวอร์ชันไม่ตรงกัน — เครื่องนี้ <strong>${APP_VERSION.version}</strong> / เครื่องอื่น <strong>${other}</strong></span>`;
  }
}

function loadStats() {
  const items = [
    { label: 'ใบกำกับ',      count: [...new Set(DB.getInvoices().map(i => i.invoiceNumber))].length, icon: 'receipt',       color: 'primary' },
    { label: 'ลูกค้า',       count: DB.getCustomers().length,  icon: 'people',        color: 'success' },
    { label: 'สินค้า',       count: DB.getProducts().length,   icon: 'box-seam',      color: 'info' },
    { label: 'รายการชำระ',   count: DB.getPayments().length,   icon: 'cash-coin',     color: 'warning' },
    { label: 'ฉลากขวด',      count: DB.getVersions().length,   icon: 'tag',           color: 'secondary' },
    { label: 'ผู้ใช้งาน',    count: DB.getUsers().length,      icon: 'person-gear',   color: 'dark' },
    { label: 'Activity Log', count: DB.getActivity().length,   icon: 'clock-history', color: 'primary' },
    { label: 'Login Log',    count: DB.getLogins().length,     icon: 'shield-check',  color: 'success' },
  ];
  document.getElementById('statsRow').innerHTML = items.map(item => `
    <div class="col-6 col-md-3">
      <div class="border rounded p-2 text-center">
        <i class="bi bi-${item.icon} text-${item.color} d-block fs-4 mb-1"></i>
        <div class="fw-bold fs-5">${item.count.toLocaleString('th-TH')}</div>
        <div class="text-muted" style="font-size:11px">${item.label}</div>
      </div>
    </div>`).join('');
}