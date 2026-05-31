const session = Auth.require();
const _canSettings = Auth.isAdmin() || Auth.can('export_backup') || Auth.can('import_backup') || Auth.can('export_zip') || Auth.can('import_zip');
if (!_canSettings) { alert('คุณไม่มีสิทธิ์เข้าถึงหน้านี้'); location.href = 'dashboard.html'; }
DB.init();
Nav.render('settings');

window.addEventListener('DOMContentLoaded', () => {
  loadCompanySettings();
  loadAutoBackup();
  loadAutoRestorePoint();
  renderStorageBar();
  renderStorageCleanup();
  renderLogCounts();
  loadStats();
  loadVersionInfo();
  initFolderSettings();
  initZipSections();
  renderLocalFolderCard();
  if (Auth.isAdmin()) renderErrorLog();
  renderFsStatus();
  window.addEventListener('sync:error', renderFsStatus);
  window.addEventListener('sync:ready', () => {
    renderFsStatus();
    loadCompanySettings();   // reload form fields after Firestore data arrives
    loadAutoBackup();        // reload auto-backup toggle
    loadAutoRestorePoint();  // reload auto restore point toggles
    loadStats();             // reload invoice/payment counts
  });

  // ── Admin settings broadcast: re-render form when Firestore pushes a remote change ──
  window.addEventListener('sync:updated', (e) => {
    if (e.detail?.key !== 'wt_settings') return;
    loadCompanySettings();
    loadAutoBackup();
    loadAutoRestorePoint();
    Utils.showAlert('<i class="bi bi-person-check me-1"></i>ผู้ดูแลระบบอัปเดตการตั้งค่าระบบแล้ว', 'info');
  });
  ['companyName','address','phone'].forEach(id =>
    document.getElementById(id).addEventListener('input', updatePreview)
  );
  document.getElementById('showHeader').addEventListener('change', updatePreview);
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

/* ─── Local Folder Sync ─────────────────────────────────────────────────── */

function renderLocalFolderCard() {
  const card = document.getElementById('localFolderSyncCard');
  if (!card) return;

  // If LocalFolderSync isn't loaded yet, wait for it then retry
  if (!window.LocalFolderSync) {
    window.addEventListener('localfolder:connected',  renderLocalFolderCard, { once: true });
    window.addEventListener('localfolder:disconnected', renderLocalFolderCard, { once: true });
    setTimeout(renderLocalFolderCard, 1500); // fallback retry
    return;
  }

  const st = LocalFolderSync.getStatus();

  // No API support
  if (!st.supported) {
    document.getElementById('lfsNoApiAlert').classList.remove('d-none');
    document.getElementById('lfsBody').style.opacity = '0.4';
    document.getElementById('lfsBody').style.pointerEvents = 'none';
    document.getElementById('lfsBadge').textContent  = 'ไม่รองรับ';
    document.getElementById('lfsBadge').className    = 'badge bg-secondary';
    return;
  }

  const nameEl        = document.getElementById('lfsFolderName');
  const badgeEl       = document.getElementById('lfsBadge');
  const statusEl      = document.getElementById('lfsStatus');
  const btnReconnect  = document.getElementById('btnLfsReconnect');
  const btnWriteAll   = document.getElementById('btnLfsWriteAll');
  const btnRestore    = document.getElementById('btnLfsRestore');
  const btnDisconnect = document.getElementById('btnLfsDisconnect');

  nameEl.value = st.folderName || '';

  if (st.connected) {
    badgeEl.textContent = '✓ เชื่อมต่อแล้ว';
    badgeEl.className   = 'badge bg-success text-white';
    statusEl.textContent = `กำลังซิงค์ไปยัง: ${st.folderName}`;
    btnReconnect.classList.add('d-none');
    btnWriteAll.classList.remove('d-none');
    btnRestore.classList.remove('d-none');
    btnDisconnect.classList.remove('d-none');
  } else if (st.needsPermission) {
    badgeEl.textContent = '⚠ ต้องการสิทธิ์';
    badgeEl.className   = 'badge bg-warning text-dark';
    statusEl.innerHTML  = `โฟลเดอร์ <strong>${st.folderName}</strong> ต้องการสิทธิ์ใหม่ — กด <em>เชื่อมต่อใหม่</em>`;
    btnReconnect.classList.remove('d-none');
    btnWriteAll.classList.add('d-none');
    btnRestore.classList.remove('d-none');
    btnDisconnect.classList.remove('d-none');
  } else {
    badgeEl.textContent = 'ไม่ได้เชื่อมต่อ';
    badgeEl.className   = 'badge bg-secondary text-white';
    statusEl.textContent = 'เลือกโฟลเดอร์เพื่อเริ่มซิงค์อัตโนมัติ';
    btnReconnect.classList.add('d-none');
    btnWriteAll.classList.add('d-none');
    btnRestore.classList.add('d-none');
    btnDisconnect.classList.add('d-none');
  }

  // Re-render on connection changes
  window.addEventListener('localfolder:connected',    renderLocalFolderCard, { once: true });
  window.addEventListener('localfolder:disconnected', renderLocalFolderCard, { once: true });
  window.addEventListener('localfolder:permissionlost', renderLocalFolderCard, { once: true });
}

async function lfsSelectFolder() {
  if (!window.LocalFolderSync) return;
  try {
    const name = await LocalFolderSync.selectFolder();
    Utils.showAlert(`<i class="bi bi-check-circle me-1"></i>เชื่อมต่อโฟลเดอร์ <strong>${name}</strong> สำเร็จ — กำลังบันทึกข้อมูล…`);
    renderLocalFolderCard();
  } catch (e) {
    if (e.name !== 'AbortError') Utils.showAlert('เลือกโฟลเดอร์ล้มเหลว: ' + e.message, 'danger');
  }
}

async function lfsReconnect() {
  if (!window.LocalFolderSync) return;
  try {
    const ok = await LocalFolderSync.reconnect();
    if (ok) Utils.showAlert('<i class="bi bi-check-circle me-1"></i>เชื่อมต่อโฟลเดอร์ใหม่สำเร็จ — กำลังบันทึกข้อมูล…');
    else    Utils.showAlert('ไม่ได้รับสิทธิ์ — กรุณาลองเลือกโฟลเดอร์ใหม่', 'warning');
    renderLocalFolderCard();
  } catch (e) {
    Utils.showAlert('Reconnect ล้มเหลว: ' + e.message, 'danger');
  }
}

async function lfsWriteAll() {
  if (!window.LocalFolderSync) return;
  const btn = document.getElementById('btnLfsWriteAll');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';
  try {
    await LocalFolderSync.writeAll();
    Utils.showAlert('<i class="bi bi-check-circle me-1"></i>บันทึกข้อมูลทุก Key ลงโฟลเดอร์สำเร็จ');
  } catch (e) {
    Utils.showAlert('บันทึกล้มเหลว: ' + e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function lfsRestore() {
  if (!window.LocalFolderSync) return;
  const confirmed = confirm(
    'Restore จากโฟลเดอร์?\n\n' +
    'ข้อมูลทุกอย่างในระบบจะถูกแทนที่ด้วยไฟล์จากโฟลเดอร์ที่เลือก\n' +
    'แนะนำให้ Export Backup ก่อน!\n\n' +
    'กด OK เพื่อดำเนินการต่อ'
  );
  if (!confirmed) return;

  const btn = document.getElementById('btnLfsRestore');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Restore…';

  try {
    const data = await LocalFolderSync.restore();
    const keys = Object.keys(data);
    if (keys.length === 0) { Utils.showAlert('ไม่พบไฟล์ .json ในโฟลเดอร์', 'warning'); return; }

    let restored = 0;
    for (const key of keys) {
      // Only restore keys that belong to the DB (ignore unknown keys)
      if (!Object.values(DB.K).includes(key)) continue;
      DB._set(key, data[key]);
      restored++;
    }
    Utils.showAlert(
      `<i class="bi bi-check-circle me-1"></i>Restore สำเร็จ — นำเข้า ${restored} keys จากโฟลเดอร์ กรุณา Reload หน้าเพื่อดูข้อมูลล่าสุด`,
      'success'
    );
    DB.logActivity(session.userId, session.username, 'Restore จาก Local Folder', { keys: restored });
  } catch (e) {
    Utils.showAlert('Restore ล้มเหลว: ' + e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function lfsDisconnect() {
  if (!window.LocalFolderSync) return;
  if (!confirm('ยกเลิกการเชื่อมต่อโฟลเดอร์?\n\nข้อมูลในโฟลเดอร์จะไม่ถูกลบ แค่หยุดซิงค์เท่านั้น')) return;
  await LocalFolderSync.disconnect();
  Utils.showAlert('ยกเลิกการเชื่อมต่อโฟลเดอร์แล้ว', 'info');
  renderLocalFolderCard();
}

/* ─── Company Settings ──────────────────────────────────────────────────── */
function loadCompanySettings() {
  const cfg = DB.getSettings();
  document.getElementById('companyName').value  = cfg.companyName || '';
  document.getElementById('address').value      = cfg.address     || '';
  document.getElementById('phone').value        = cfg.phone       || '';
  document.getElementById('taxId').value        = cfg.taxId       || '';
  document.getElementById('showHeader').checked = cfg.showHeader !== false; // default true
  updatePreview();
}

function updatePreview() {
  const phone      = document.getElementById('phone').value;
  const showHeader = document.getElementById('showHeader').checked;
  const headerRow  = document.getElementById('prev_header_row');
  document.getElementById('prev_name').textContent    = document.getElementById('companyName').value;
  document.getElementById('prev_address').textContent = document.getElementById('address').value;
  document.getElementById('prev_phone').textContent   = phone ? 'โทร. ' + phone : '';
  if (headerRow) headerRow.style.display = showHeader ? '' : 'none';
}

function saveCompanySettings() {
  const cfg = DB.getSettings();
  const upd = {
    ...cfg,
    companyName: document.getElementById('companyName').value.trim(),
    address:     document.getElementById('address').value.trim(),
    phone:       document.getElementById('phone').value.trim(),
    taxId:       document.getElementById('taxId').value.trim(),
    showHeader:  document.getElementById('showHeader').checked,
  };
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

function loadAutoRestorePoint() {
  const arp = (DB.getSettings() || {}).autoRestorePoint || {};
  document.getElementById('arpOnLogout').checked = arp.onLogout !== false;
  document.getElementById('arpOnClose').checked  = arp.onClose  !== false;
}

function saveAutoRestorePointConfig() {
  const cfg = DB.getSettings();
  cfg.autoRestorePoint = {
    onLogout: document.getElementById('arpOnLogout').checked,
    onClose:  document.getElementById('arpOnClose').checked,
  };
  DB.saveSettings(cfg);
  Utils.showAlert('บันทึกการตั้งค่า Auto Restore Point สำเร็จ');
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

/* ─── Storage Cleanup ────────────────────────────────────────────────────── */
function _lsKeyBytes(key) {
  return (localStorage.getItem(key) || '').length * 2; // UTF-16 bytes
}

function renderStorageCleanup() {
  const el = document.getElementById('storageCleanupBody');
  if (!el) return;

  const LOG_KEYS   = [DB.K.ACTIVITY, DB.K.LOGINS, DB.K.ERRORS];
  const PRICE_KEY  = DB.K.PRICE_HISTORY;

  let logBytes = 0, priceBytes = 0, businessBytes = 0;
  for (const k in localStorage) {
    if (!k.startsWith('wt_')) continue;
    const b = _lsKeyBytes(k);
    if (LOG_KEYS.includes(k))  logBytes      += b;
    else if (k === PRICE_KEY)  priceBytes    += b;
    else                       businessBytes += b;
  }
  const totalBytes = logBytes + priceBytes + businessBytes;
  const limit      = 5 * 1024 * 1024;
  const pct        = Math.min(100, (totalBytes / limit) * 100);
  const barColor   = pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-success';

  const fsReady    = !!(window.Sync && Sync.ready && Sync._db);
  const priceCount = DB.getPriceHistory().length;
  const logCount   = DB.getActivity().length + DB.getLogins().length + DB.getErrors().length;

  el.innerHTML = `
    <div class="d-flex justify-content-between text-muted small mb-1">
      <span><i class="bi bi-hdd me-1"></i>พื้นที่ใช้ทั้งหมด</span>
      <span>${fmtBytes(totalBytes)} / ~5 MB (${pct.toFixed(1)}%)</span>
    </div>
    <div class="progress mb-3" style="height:8px">
      <div class="progress-bar ${barColor}" style="width:${pct.toFixed(1)}%"></div>
    </div>
    <div class="row g-2 mb-3">
      <div class="col-4">
        <div class="border rounded p-2 text-center">
          <div class="small text-muted mb-1">ข้อมูลธุรกิจ</div>
          <div class="fw-semibold small">${fmtBytes(businessBytes)}</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2 text-center">
          <div class="small text-muted mb-1">ประวัติราคา</div>
          <div class="fw-semibold small">${fmtBytes(priceBytes)}</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2 text-center">
          <div class="small text-muted mb-1">ล็อกกิจกรรม</div>
          <div class="fw-semibold small ${logBytes > 512 * 1024 ? 'text-danger' : ''}">${fmtBytes(logBytes)}</div>
        </div>
      </div>
    </div>

    <div class="border rounded mb-3 overflow-hidden">
      <div class="d-flex align-items-start gap-3 p-3 border-bottom">
        <input type="checkbox" id="scLogs" class="form-check-input flex-shrink-0" style="margin-top:3px"
          ${logCount > 0 ? 'checked' : ''} ${logCount === 0 ? 'disabled' : ''} onchange="updateCleanupPreview()">
        <div>
          <label for="scLogs" class="fw-semibold small mb-1 d-block" style="cursor:pointer">
            ล็อกกิจกรรม
            <span class="badge bg-danger bg-opacity-10 text-danger ms-1 fw-normal">ปลอดภัยล้างได้</span>
          </label>
          <div class="text-muted" style="font-size:12px">
            wt_activity · wt_logins · wt_errors — ไม่ซิงก์กับ Firestore ·
            ${logCount.toLocaleString('th-TH')} รายการ · ${fmtBytes(logBytes)}
          </div>
        </div>
      </div>
      <div class="d-flex align-items-start gap-3 p-3 border-bottom">
        <input type="checkbox" id="scPrice" class="form-check-input flex-shrink-0" style="margin-top:3px"
          ${priceCount > 500 ? 'checked' : ''} ${priceCount === 0 ? 'disabled' : ''} onchange="updateCleanupPreview()">
        <div>
          <label for="scPrice" class="fw-semibold small mb-1 d-block" style="cursor:pointer">
            ประวัติราคา — เก็บล่าสุด
            <input type="number" id="scPriceKeep" value="500" min="50" max="9999"
              class="form-control form-control-sm d-inline-block mx-1"
              style="width:68px;padding:1px 6px;font-size:12px"
              oninput="updateCleanupPreview()">
            รายการ
            <span class="badge bg-success bg-opacity-10 text-success ms-1 fw-normal">ตัดทิ้งบางส่วน</span>
          </label>
          <div class="text-muted" style="font-size:12px">
            wt_price_history · ${priceCount.toLocaleString('th-TH')} รายการ · ${fmtBytes(priceBytes)}
          </div>
        </div>
      </div>
      <div class="d-flex align-items-start gap-3 p-3 ${!fsReady ? 'opacity-50' : ''}">
        <input type="checkbox" class="form-check-input flex-shrink-0" style="margin-top:3px" disabled>
        <div>
          <label class="fw-semibold small mb-1 d-block">
            ข้อมูลธุรกิจ (ใบกำกับ, ลูกค้า, สินค้า …)
            <span class="badge bg-secondary bg-opacity-25 text-secondary ms-1 fw-normal">
              ${fsReady ? 'ยังไม่รองรับ' : 'ต้องการ Firestore'}
            </span>
          </label>
          <div class="text-muted" style="font-size:12px">
            ${fsReady
              ? 'Firestore พร้อมแล้ว — ฟีเจอร์นี้ยังไม่รองรับในเวอร์ชันนี้'
              : 'เปิด Firestore Sync ก่อนจึงจะล้างข้อมูลธุรกิจได้'}
          </div>
        </div>
      </div>
    </div>

    <div id="scPreviewAlert" class="d-none mb-3"></div>
    <div class="d-flex gap-2 justify-content-end">
      <button class="btn btn-outline-secondary btn-sm" onclick="renderStorageCleanup()">
        <i class="bi bi-arrow-clockwise me-1"></i>รีเฟรช
      </button>
      <button class="btn btn-warning btn-sm" id="btnRunCleanup" onclick="runStorageCleanup()" disabled>
        <i class="bi bi-trash me-1"></i>ล้างข้อมูลที่เลือก
      </button>
    </div>
  `;

  updateCleanupPreview();
}

function updateCleanupPreview() {
  const logsChecked  = document.getElementById('scLogs')?.checked  ?? false;
  const priceChecked = document.getElementById('scPrice')?.checked ?? false;
  const keepN        = parseInt(document.getElementById('scPriceKeep')?.value || '500', 10);

  let willFree = 0;
  if (logsChecked) {
    [DB.K.ACTIVITY, DB.K.LOGINS, DB.K.ERRORS].forEach(k => willFree += _lsKeyBytes(k));
  }
  if (priceChecked) {
    const priceCount = DB.getPriceHistory().length;
    if (priceCount > keepN) {
      const cur = _lsKeyBytes(DB.K.PRICE_HISTORY);
      willFree += Math.round(cur * (priceCount - keepN) / priceCount);
    }
  }

  const alertEl = document.getElementById('scPreviewAlert');
  const btnEl   = document.getElementById('btnRunCleanup');
  if (!alertEl) return;

  if (willFree === 0) {
    alertEl.className = 'alert alert-secondary small py-2 mb-3';
    alertEl.classList.remove('d-none');
    alertEl.innerHTML = '<i class="bi bi-info-circle me-1"></i>ไม่มีรายการที่เลือก หรือข้อมูลว่างอยู่แล้ว';
    if (btnEl) btnEl.disabled = true;
  } else {
    let totalBytes = 0;
    for (const k in localStorage) {
      if (k.startsWith('wt_')) totalBytes += _lsKeyBytes(k);
    }
    const afterPct = Math.min(100, ((totalBytes - willFree) / (5 * 1024 * 1024)) * 100);
    alertEl.className = 'alert alert-warning small py-2 mb-3';
    alertEl.classList.remove('d-none');
    alertEl.innerHTML = `<i class="bi bi-trash me-1"></i>จะล้างประมาณ <strong>${fmtBytes(willFree)}</strong>
      — คาดว่า localStorage จะเหลือ ~${afterPct.toFixed(0)}% หลังล้าง`;
    if (btnEl) btnEl.disabled = false;
  }
}

function runStorageCleanup() {
  const logsChecked  = document.getElementById('scLogs')?.checked  ?? false;
  const priceChecked = document.getElementById('scPrice')?.checked ?? false;
  if (!logsChecked && !priceChecked) {
    Utils.showAlert('ไม่มีรายการที่เลือก', 'warning'); return;
  }

  const lines = [];
  if (logsChecked)  lines.push('• ล็อกกิจกรรมทั้งหมด (activity, logins, errors)');
  if (priceChecked) {
    const keepN = parseInt(document.getElementById('scPriceKeep')?.value || '500', 10);
    lines.push(`• ประวัติราคา (เก็บล่าสุด ${keepN.toLocaleString('th-TH')} รายการ)`);
  }
  if (!confirm(`จะล้างข้อมูลต่อไปนี้:\n\n${lines.join('\n')}\n\nยืนยันหรือไม่?`)) return;

  let freed = 0;

  if (logsChecked) {
    const before = _lsKeyBytes(DB.K.ACTIVITY) + _lsKeyBytes(DB.K.LOGINS) + _lsKeyBytes(DB.K.ERRORS);
    DB._set(DB.K.ACTIVITY, []);
    DB._set(DB.K.LOGINS,   []);
    DB.clearErrors();
    freed += before;
  }

  if (priceChecked) {
    const keepN   = parseInt(document.getElementById('scPriceKeep')?.value || '500', 10);
    const before  = _lsKeyBytes(DB.K.PRICE_HISTORY);
    const history = DB.getPriceHistory();
    if (history.length > keepN) {
      DB.savePriceHistory(history.slice(0, keepN)); // newest first (unshift order)
      freed += Math.max(0, before - _lsKeyBytes(DB.K.PRICE_HISTORY));
    }
  }

  DB.logActivity(session.userId, session.username, 'ล้าง localStorage', { freed: fmtBytes(freed) });

  Utils.showAlert(
    `<i class="bi bi-check-circle me-1"></i>ล้างสำเร็จ — เพิ่มพื้นที่ว่าง ~${fmtBytes(freed)}`,
    'success'
  );
  renderStorageBar();
  renderLogCounts();
  renderStorageCleanup();
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
async function importData(input, mode) {
  const file = input.files[0];
  if (!file) return;
  const modeLabel = mode === 'overwrite' ? 'เขียนทับข้อมูลทั้งหมด ⚠️' : 'เพิ่มข้อมูลใหม่ (Merge)';
  if (!confirm(`Import ไฟล์: "${file.name}"\nโหมด: ${modeLabel}\n\nดำเนินการต่อหรือไม่?`)) {
    input.value = ''; return;
  }
  if (mode === 'overwrite' && !confirm('⚠️ ยืนยันอีกครั้ง — ข้อมูลเดิมทั้งหมดจะถูกแทนที่!')) {
    input.value = ''; return;
  }

  // Disable buttons to prevent double-trigger during processing
  const btns = document.querySelectorAll('#jsonImportSection button');
  btns.forEach(b => { b.disabled = true; });

  try {
    // ── Read & parse JSON ────────────────────────────────────────────────────
    Utils.showProgress('อ่านไฟล์...', 5);
    await new Promise(r => setTimeout(r, 0));

    let data;
    try { data = JSON.parse(await file.text()); } catch(pe) {
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

    // ── Snapshot counts BEFORE import ────────────────────────────────────────
    const before = {
      customers: DB.getCustomers().length,
      products:  DB.getProducts().length,
      invoices:  DB.getInvoices().length,
      payments:  DB.getPayments().length,
    };

    // ── Settings & config ────────────────────────────────────────────────────
    Utils.showProgress('นำเข้าการตั้งค่า...', 10);
    await new Promise(r => setTimeout(r, 0));
    if (data.settings)   DB.saveSettings({ ...DB.getSettings(), ...data.settings });
    if (data.payMethods) DB.savePayMethods(data.payMethods);
    if (data.pricing)    DB.savePricing(data.pricing);

    // ── Bulk-merge helper — O(n) not O(n²) ───────────────────────────────────
    // Reads existing array once, filters new IDs in one pass, writes once.
    // The old approach called addOne() per item: N reads + N LZString compresses + N writes.
    // This approach: 1 read + 1 compress + 1 write regardless of how many items.
    const importCol = async (arr, getAll, saveAll, labelTH, pct) => {
      if (!arr || arr.length === 0) return 0;
      Utils.showProgress(`นำเข้า ${labelTH}... (${arr.length} รายการ)`, pct);
      await new Promise(r => setTimeout(r, 0)); // yield so the progress bar renders
      if (mode === 'overwrite') { saveAll(arr); return arr.length; }
      const existing = getAll();
      const ids = new Set(existing.filter(x => x.id).map(x => x.id));
      const newItems = arr.filter(item => item.id && !ids.has(item.id));
      if (newItems.length > 0) saveAll([...existing, ...newItems]); // 1 write
      return newItems.length;
    };

    const c = {
      customers: await importCol(data.customers, () => DB.getCustomers(), DB.saveCustomers.bind(DB), 'ลูกค้า',    20),
      products:  await importCol(data.products,  () => DB.getProducts(),  DB.saveProducts.bind(DB),  'สินค้า',    35),
      invoices:  await importCol(data.invoices,  () => DB.getInvoices(),  DB.saveInvoices.bind(DB),  'ใบกำกับ',  55),
      payments:  await importCol(data.payments,  () => DB.getPayments(),  DB.savePayments.bind(DB),  'การชำระ',  75),
      versions:  await importCol(data.versions,  () => DB.getVersions(),  DB.saveVersions.bind(DB),  'เวอร์ชัน', 90),
    };

    // ── Integrity check ──────────────────────────────────────────────────────
    Utils.showProgress('ตรวจสอบข้อมูล...', 97);
    await new Promise(r => setTimeout(r, 0));
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

    Utils.hideProgress();
    DB.logActivity(session.userId, session.username, 'Import ข้อมูล', { file: file.name, mode, before, after });
    const modeText = mode === 'overwrite' ? 'Overwrite' : 'Merge';
    Utils.showAlert(
      `<i class="bi bi-check-circle me-1"></i>Import สำเร็จ [${modeText}] — ` +
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
    Utils.hideProgress();
    Utils.showAlert('<i class="bi bi-x-circle me-1"></i>ไม่สามารถ Import ได้: ' + err.message, 'danger');
  } finally {
    btns.forEach(b => { b.disabled = false; });
    input.value = '';
  }
}

/* ─── Backup / Import Card Visibility ───────────────────────────────────── */
async function initZipSections() {
  const isAdmin       = Auth.isAdmin();
  const canExpBackup  = isAdmin || Auth.can('export_backup');
  const canImpBackup  = isAdmin || Auth.can('import_backup');
  const canExpZip     = Auth.can('export_zip');
  const canImpZip     = Auth.can('import_zip');

  // Hide admin-only elements for non-admin users
  if (!isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  }

  // ── Unified Backup card ──────────────────────────────────────────────────
  if (canExpBackup || canExpZip) {
    document.getElementById('backupCard').style.display = '';
    if (isAdmin) {
      document.getElementById('adminExportTiles').style.display = '';
    } else if (canExpBackup) {
      document.getElementById('simpleExportSection').style.display = '';
    }
    if (canExpZip) {
      document.getElementById('zipExportSection').style.display = '';
      const h  = await IDB.get('pdf_dir');
      const el = document.getElementById('zipPdfFolderInfo');
      el.innerHTML = h
        ? `<i class="bi bi-folder2-open me-1 text-warning"></i>PDF Folder: <strong>${h.name}</strong>`
        : '<i class="bi bi-exclamation-triangle me-1 text-danger"></i>ยังไม่ได้ตั้ง PDF Folder — จะ Export เฉพาะข้อมูล ไม่รวม PDF';
    }
  }

  // ── Unified Import card ──────────────────────────────────────────────────
  if (canImpBackup || canImpZip) {
    document.getElementById('importCard').style.display = '';
    if (canImpBackup) {
      document.getElementById('jsonImportSection').style.display = '';
    }
    if (canImpZip) {
      document.getElementById('zipImportSection').style.display = '';
      // Hide the HR divider when no JSON section sits above the ZIP section
      if (!canImpBackup) {
        document.getElementById('zipImportHr').style.display = 'none';
      }
    }
  }

  // Google Drive card — show for admin always
  if (isAdmin) {
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

/* ─── Firestore Sync ─────────────────────────────────────────────────────── */
function renderFsStatus() {
  const icon = document.getElementById('fsStatusIcon');
  const text = document.getElementById('fsStatusText');
  const msg  = document.getElementById('fsSyncMsg');
  if (!icon || !text) return;

  // ── No config ────────────────────────────────────────────────────────────
  // firebase-config.js is loaded asynchronously by nav.js; FIREBASE_CONFIG may
  // not be defined yet at DOMContentLoaded. Retry until it appears (max ~5 s).
  const hasConfig = typeof FIREBASE_CONFIG !== 'undefined' &&
                    FIREBASE_CONFIG.apiKey &&
                    !FIREBASE_CONFIG.apiKey.startsWith('AIzaSy...');
  if (!hasConfig) {
    if (typeof FIREBASE_CONFIG === 'undefined') {
      // Still loading — wait 400 ms and try again
      setTimeout(renderFsStatus, 400);
      return;
    }
    // Config IS defined but has placeholder key → genuinely not configured
    icon.textContent = '❌';
    text.textContent = 'ไม่ได้ตั้งค่า Firebase';
    if (msg) {
      msg.className = 'alert alert-danger small py-2 mb-3';
      msg.classList.remove('d-none');
      msg.innerHTML = `<strong>Firebase ไม่ได้ตั้งค่า</strong><br>
        ตั้ง environment variables ใน GitHub Secrets แล้ว redeploy:<br>
        <code>FIREBASE_TEAM_PASSWORD, GOOGLE_CLIENT_ID</code>`;
    }
    return;
  }

  // ── Check for stored error ────────────────────────────────────────────────
  const errRaw = localStorage.getItem('wt_sync_last_error');
  let lastErr = null;
  try { lastErr = errRaw ? JSON.parse(errRaw) : null; } catch {}

  // Network/offline errors are not config bugs — clear them and show offline status
  const isNetworkErr = lastErr && (
    (lastErr.msg || '').toLowerCase().includes('network') ||
    (lastErr.msg || '').toLowerCase().includes('timeout') ||
    (lastErr.msg || '').includes('auth/network-request-failed')
  );
  if (isNetworkErr) {
    localStorage.removeItem('wt_sync_last_error');
    lastErr = null;
  }

  if (!window.Sync?.ready && lastErr) {
    icon.textContent = '❌';
    text.textContent = 'เชื่อมต่อล้มเหลว';
    if (msg) {
      msg.className = 'alert alert-danger small py-2 mb-3';
      msg.classList.remove('d-none');
      msg.innerHTML = `<strong>Firebase error:</strong> <code>${lastErr.msg}</code><br><br>
        <strong>สาเหตุที่พบบ่อย:</strong><br>
        • <code>auth/user-not-found</code> หรือ <code>auth/wrong-password</code> →
          ยังไม่ได้สร้าง user ใน Firebase Authentication Console<br>
        • <code>auth/operation-not-allowed</code> →
          Email/Password auth ยังไม่ได้เปิดใน Firebase Console<br>
        • <code>permission-denied</code> →
          Firestore Security Rules ไม่อนุญาต<br>
        • <code>auth/invalid-credential</code> →
          password ใน Netlify env var ไม่ตรงกับที่สร้างใน Firebase Auth<br><br>
        <button class="btn btn-sm btn-outline-danger" onclick="fsRetry()">
          <i class="bi bi-arrow-clockwise me-1"></i>ลองเชื่อมต่อใหม่
        </button>`;
    }
    // Keep polling — sync may still connect and we need to update the card
    setTimeout(renderFsStatus, 3000);
    return;
  }

  if (!window.Sync?.ready) {
    icon.textContent = '⏳';
    text.textContent = 'กำลังเชื่อมต่อ Firestore...';
    setTimeout(renderFsStatus, 2000);
    return;
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  localStorage.removeItem('wt_sync_last_error'); // clear old errors on success
  const last = localStorage.getItem('wt_sync_lastAt');
  const lastStr = last ? new Date(last).toLocaleString('th-TH') : 'ยังไม่เคย';
  const snapCount = parseInt(localStorage.getItem('wt_sync_snap_count') || '0');
  icon.textContent = '✅';
  text.textContent = `เชื่อมต่อแล้ว (org: ${FIREBASE_CONFIG.orgId}) · ซิงค์ล่าสุด: ${lastStr} · อัปเดตสด: ${snapCount} ครั้ง`;
  if (msg) { msg.className = 'alert d-none small py-2 mb-3'; }
}

async function fsRetry() {
  localStorage.removeItem('wt_sync_last_error');
  renderFsStatus();
  if (window.Sync) {
    Sync.ready = false;
    try { await Sync.init(); } catch {}
  }
  renderFsStatus();
}

function _fsProgressHtml(done, total, current, pushed, failed) {
  const pct  = total ? Math.round((done / total) * 100) : 0;
  const name = current ? current.replace('wt_', '') : '';
  return `
    <div class="mb-1 fw-semibold"><i class="bi bi-cloud-upload me-1"></i>กำลัง Push ไป Firestore...</div>
    <div class="progress mb-1" style="height:14px">
      <div class="progress-bar progress-bar-striped progress-bar-animated bg-warning"
           style="width:${pct}%;color:#333;font-size:11px;line-height:14px">${pct}%</div>
    </div>
    <div class="d-flex justify-content-between small text-muted">
      <span>${done} / ${total} รายการ${name ? ` · กำลัง: <code>${name}</code>` : ''}</span>
      <span>✓ ${pushed}${failed ? ` · ✗ ${failed}` : ''}</span>
    </div>`;
}

async function fsPushAll() {
  const btn = document.getElementById('btnFsPush');
  const el  = document.getElementById('fsSyncMsg');
  if (!window.Sync?.ready) {
    el.className = 'alert alert-warning small py-2 mb-3';
    el.classList.remove('d-none');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Firestore ยังไม่ได้เชื่อมต่อ';
    return;
  }
  if (!confirm('อัปโหลดข้อมูลทั้งหมดจากเครื่องนี้ไป Firestore?\nจะเขียนทับข้อมูลบน Firestore ด้วยข้อมูลจากเครื่องนี้')) return;
  const btnSync = document.getElementById('btnFsSync');
  btn.disabled = true; if (btnSync) btnSync.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Push...';
  el.className = 'alert alert-info small py-2 mb-3';
  el.classList.remove('d-none');
  el.innerHTML = _fsProgressHtml(0, 1, null, 0, 0);
  try {
    const result = await Sync.pushAll(({ done, total, current, pushed, failed }) => {
      el.innerHTML = _fsProgressHtml(done, total, current, pushed, failed);
    });
    el.className = 'alert alert-success small py-2 mb-3';
    el.innerHTML = `<i class="bi bi-check-circle me-1"></i>Push สำเร็จ — อัปโหลด <strong>${result.pushed} key</strong> ไป Firestore` +
      (result.failed ? ` <span class="text-danger">(ล้มเหลว ${result.failed})</span>` : '') +
      '<br><small class="text-muted">อุปกรณ์อื่นจะซิงค์โดยอัตโนมัติภายใน 1-2 วินาที</small>';
    renderFsStatus();
  } catch (e) {
    el.className = 'alert alert-danger small py-2 mb-3';
    el.innerHTML = '<i class="bi bi-x-circle me-1"></i>Push ล้มเหลว: ' + esc(e.message);
  }
  btn.disabled = false; if (btnSync) btnSync.disabled = false;
  btn.innerHTML = '<i class="bi bi-cloud-upload me-1"></i>Push All → Firestore';
}

async function fsSyncNow() {
  const btn = document.getElementById('btnFsSync');
  const el  = document.getElementById('fsSyncMsg');
  if (!window.Sync?.ready) {
    el.className = 'alert alert-warning small py-2 mb-3';
    el.classList.remove('d-none');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Firestore ยังไม่ได้เชื่อมต่อ';
    return;
  }
  const btnPush = document.getElementById('btnFsPush');
  btn.disabled = true; if (btnPush) btnPush.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Sync...';
  el.className = 'alert alert-info small py-2 mb-3';
  el.classList.remove('d-none');
  el.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>กำลังดึงข้อมูลจาก Firestore...';
  try {
    await Sync._pullAll();
    el.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>ดึงข้อมูลแล้ว — กำลัง Push ข้อมูลขึ้น...';
    const result = await Sync.pushAll(({ done, total, current, pushed, failed }) => {
      el.innerHTML = _fsProgressHtml(done, total, current, pushed, failed);
    });
    el.className = 'alert alert-success small py-2 mb-3';
    el.innerHTML = `<i class="bi bi-check-circle me-1"></i>Sync สำเร็จ — Push ${result.pushed} key` +
      (result.failed ? ` <span class="text-danger">(ล้มเหลว ${result.failed})</span>` : '') +
      '<br><small class="text-muted">ข้อมูลตรงกันกับ Firestore แล้ว</small>';
    renderFsStatus();
  } catch (e) {
    el.className = 'alert alert-danger small py-2 mb-3';
    el.innerHTML = '<i class="bi bi-x-circle me-1"></i>Sync ล้มเหลว: ' + esc(e.message);
  }
  btn.disabled = false; if (btnPush) btnPush.disabled = false;
  btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Sync Now';
}

async function drivePushAll() {
  const btn = document.getElementById('btnDrivePush');
  const el  = document.getElementById('driveSyncStatus');
  if (!window.DriveStore?.ready || !window.DriveDbSync?._ready) {
    el.className = 'alert alert-warning small py-2 mb-2';
    el.classList.remove('d-none');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>กรุณาเชื่อมต่อ Google Drive ก่อน';
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Push...';
  el.className = 'alert alert-info small py-2 mb-2';
  el.classList.remove('d-none');
  el.innerHTML = 'กำลังอัปโหลดข้อมูลทั้งหมดไป Drive...';
  try {
    await DriveDbSync.pushAll();
    el.className = 'alert alert-success small py-2 mb-2';
    el.innerHTML = '<i class="bi bi-check-circle me-1"></i>Push สำเร็จ — ข้อมูลทั้งหมดอัปโหลดไป Drive แล้ว';
    await refreshDriveStats();
  } catch (e) {
    el.className = 'alert alert-danger small py-2 mb-2';
    el.innerHTML = '<i class="bi bi-x-circle me-1"></i>Push ล้มเหลว: ' + esc(e.message);
  }
  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-cloud-upload me-1"></i>Push All → Drive';
}

async function drivePullAll() {
  const btn = document.getElementById('btnDrivePull');
  const el  = document.getElementById('driveSyncStatus');
  if (!window.DriveStore?.ready) {
    el.className = 'alert alert-warning small py-2 mb-2';
    el.classList.remove('d-none');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>กรุณาเชื่อมต่อ Google Drive ก่อน';
    return;
  }
  if (!confirm('Pull All จะดึงข้อมูลจาก Drive มาเขียนทับ localStorage ในเครื่องนี้\nยืนยันหรือไม่?')) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Pull...';
  el.className = 'alert alert-info small py-2 mb-2';
  el.classList.remove('d-none');
  el.innerHTML = 'กำลังสแกน Drive folder และดาวน์โหลดข้อมูล...';
  try {
    // pullAllScan works even when local meta is empty (new computer)
    const result = await DriveDbSync.pullAllScan();
    el.className = 'alert alert-success small py-2 mb-2';
    el.innerHTML = `<i class="bi bi-check-circle me-1"></i>Pull สำเร็จ — ดึงข้อมูล <strong>${result.restored} key</strong> จาก Drive` +
      (result.failed ? ` (ล้มเหลว ${result.failed})` : '') +
      ' — <strong>กรุณารีโหลดหน้าเพื่อให้ข้อมูลมีผล</strong>';
    renderStorageBar();
  } catch (e) {
    el.className = 'alert alert-danger small py-2 mb-2';
    el.innerHTML = '<i class="bi bi-x-circle me-1"></i>Pull ล้มเหลว: ' + esc(e.message);
  }
  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-cloud-download me-1"></i>Pull All ← Drive';
}

async function driveSignIn() {
  // Google OAuth rejects tauri:// origins — Drive is a web-only feature
  if (window.IS_TAURI) {
    Utils.showAlert('Google Drive ไม่รองรับในแอปเดสก์ท็อป (ใช้เว็บเบราว์เซอร์แทน)', 'info');
    return;
  }
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
  if (window.IS_TAURI) return;
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

/* ─── Archive Old Invoices ──────────────────────────────────────────────── */
function previewArchive() {
  const months = 3;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffIso = cutoff.toISOString();

  const all = DB.getInvoices();
  let count = 0;
  for (const inv of all) {
    const dateStr = inv.createdAt || inv.date || '';
    if (!dateStr || dateStr >= cutoffIso) continue;
    const paid  = DB.getInvoicePaidAmount(inv.invoiceNumber);
    const total = parseFloat(inv.totalAmount || inv.total || 0);
    if (total > 0 && paid >= total) count++;
  }

  const el = document.getElementById('archivePreview');
  const btn = document.getElementById('btnRunArchive');
  el.classList.remove('d-none', 'alert-info', 'alert-warning');

  if (count === 0) {
    el.classList.add('alert-info');
    el.innerHTML = '<i class="bi bi-check-circle me-1 text-success"></i>ไม่มีใบกำกับที่ตรงเงื่อนไข (ยังไม่มีอะไรต้อง Archive)';
    btn.disabled = true;
  } else {
    const driveReady = window.DriveStore?.ready;
    el.classList.add('alert-warning');
    el.innerHTML = `<i class="bi bi-exclamation-triangle me-1"></i>พบ <strong>${count} ใบ</strong> ที่ชำระครบและอายุเกิน ${months} เดือน` +
      (driveReady ? ` — จะอัปโหลดไป Google Drive ก่อนลบ` : ` — ⚠️ Google Drive ไม่ได้เชื่อมต่อ ข้อมูลจะถูกลบโดยไม่มีสำเนาบน Drive`);
    btn.disabled = false;
  }
}

async function migratePaymentImages() {
  const btn = document.getElementById('btnMigrateImgs');
  const el  = document.getElementById('imgMigrateStatus');

  if (!window.DriveStore?.ready) {
    el.className = 'alert alert-warning small py-2 mb-3';
    el.classList.remove('d-none');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>กรุณาเชื่อมต่อ Google Drive ก่อน';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังย้ายรูปภาพ...';
  el.className = 'alert alert-info small py-2 mb-3';
  el.classList.remove('d-none');
  el.innerHTML = 'กำลังสแกนรายการชำระเงิน...';

  const IMAGE_FIELDS = ['transferImage', 'chequeImage', 'signedImage'];
  const payments = DB.getPayments();
  let uploadCount = 0, errorCount = 0, processed = 0;

  function b64ToBlob(b64) {
    const [header, data] = b64.split(',');
    const mime = (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin  = atob(data);
    const arr  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function uploadOne(b64, filename) {
    const blob   = b64ToBlob(b64);
    const result = await DriveStore.upload(blob, filename, {});
    return `drv|${result.driveId}|${result.uploadedAt}`;
  }

  for (const p of payments) {
    let changed = false;
    for (const field of IMAGE_FIELDS) {
      const val = p[field];
      if (typeof val === 'string' && val.startsWith('data:')) {
        try {
          const ext = val.startsWith('data:image/png') ? 'png' : 'jpg';
          p[field] = await uploadOne(val, `pay_${p.id}_${field}.${ext}`);
          uploadCount++; changed = true;
        } catch { errorCount++; }
      }
    }
    // imageHistory array
    if (Array.isArray(p.imageHistory)) {
      for (let i = 0; i < p.imageHistory.length; i++) {
        const h = p.imageHistory[i];
        if (h && typeof h.src === 'string' && h.src.startsWith('data:')) {
          try {
            const ext = h.src.startsWith('data:image/png') ? 'png' : 'jpg';
            p.imageHistory[i] = { ...h, src: await uploadOne(h.src, `pay_${p.id}_hist_${i}.${ext}`) };
            uploadCount++; changed = true;
          } catch { errorCount++; }
        }
      }
    }
    if (changed) processed++;
    // Update status message periodically
    if (processed % 5 === 0) {
      el.innerHTML = `สแกนแล้ว ${payments.indexOf(p) + 1}/${payments.length} รายการ — อัปโหลดแล้ว ${uploadCount} รูป`;
    }
  }

  if (uploadCount > 0) DB.savePayments(payments);

  el.className = `alert ${uploadCount > 0 ? 'alert-success' : 'alert-info'} small py-2 mb-3`;
  el.innerHTML = uploadCount > 0
    ? `<i class="bi bi-check-circle me-1"></i>ย้ายสำเร็จ <strong>${uploadCount} รูป</strong> จาก <strong>${processed} รายการ</strong>${errorCount ? ` (ล้มเหลว ${errorCount} รูป)` : ''}`
    : `<i class="bi bi-info-circle me-1"></i>ไม่พบรูปภาพ base64 เก่า — ทุกรูปอยู่บน Drive แล้ว`;

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-cloud-upload me-1"></i>ย้ายรูปภาพไป Drive';
  renderStorageBar();
  if (uploadCount > 0) Utils.showAlert(`ย้ายรูปภาพสำเร็จ ${uploadCount} รูป`, 'success');
}

async function runArchive() {
  const btn = document.getElementById('btnRunArchive');
  const el  = document.getElementById('archivePreview');
  if (!confirm('ยืนยันการ Archive ใบกำกับ?\nใบกำกับที่ชำระครบและอายุเกิน 3 เดือนจะถูกลบออกจากเครื่อง')) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลัง Archive...';

  try {
    const result = await DB.archiveOldInvoices(3);
    el.classList.remove('alert-warning', 'alert-info', 'd-none');
    el.classList.add('alert-success');
    el.innerHTML = `<i class="bi bi-check-circle me-1"></i>Archive สำเร็จ — ย้ายแล้ว <strong>${result.archived} ใบ</strong>, เหลือใน localStorage <strong>${result.remaining} ใบ</strong>` +
      (result.driveId ? ` · <small class="text-muted">Drive: ${result.driveId}</small>` : '');
    Utils.showAlert(`Archive สำเร็จ ${result.archived} ใบ`, 'success');
    renderStorageBar();
    loadStats();
  } catch (e) {
    el.classList.remove('d-none', 'alert-warning');
    el.classList.add('alert-danger');
    el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>เกิดข้อผิดพลาด: ' + esc(e.message);
    Utils.showAlert('Archive ล้มเหลว: ' + e.message, 'danger');
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-archive me-1"></i>Archive ตอนนี้';
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
        // Count PDFs first so we can show progress
        const pdfEntries = [];
        for await (const [name, handle] of dirHandle.entries()) {
          if (handle.kind === 'file' && name.toLowerCase().endsWith('.pdf')) pdfEntries.push([name, handle]);
        }
        const pdfFolder = zip.folder('pdfs');
        for (let i = 0; i < pdfEntries.length; i++) {
          const [name, handle] = pdfEntries[i];
          Utils.showProgress(`เก็บ PDF (${i + 1}/${pdfEntries.length})`, ((i + 1) / pdfEntries.length) * 50);
          const file = await handle.getFile();
          pdfFolder.file(name, await file.arrayBuffer());
          pdfCount++;
        }
      }
    } catch(e) { console.warn('exportZip PDF:', e); }
  }

  Utils.showProgress('สร้างไฟล์ ZIP…', pdfCount > 0 ? 50 : 0);
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => Utils.showProgress('สร้างไฟล์ ZIP…', pdfCount > 0 ? 50 + meta.percent * 0.5 : meta.percent)
  );
  Utils.hideProgress();
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
    Utils.showProgress('อ่านไฟล์ ZIP…', 5);
    const zip = await JSZip.loadAsync(await file.arrayBuffer(), {
      onUpdate: (meta) => Utils.showProgress('อ่านไฟล์ ZIP…', 5 + meta.percent * 0.3),
    });

    // ── Import JSON data ──
    const jsonEntry = zip.file('backup.json');
    if (!jsonEntry) throw new Error('ไม่พบไฟล์ backup.json ใน ZIP');
    const data = JSON.parse(await jsonEntry.async('string'));

    if (data.settings)   DB.saveSettings({ ...DB.getSettings(), ...data.settings });
    if (data.payMethods) DB.savePayMethods(data.payMethods);
    if (data.pricing)    DB.savePricing(data.pricing);

    // Bulk-merge: read once, filter, write once (same O(n) approach as importData)
    const importCol = (arr, getAll, saveAll, labelTH) => {
      if (!arr || arr.length === 0) return 0;
      if (mode === 'overwrite') { saveAll(arr); return arr.length; }
      const existing = getAll();
      const ids = new Set(existing.filter(x => x.id).map(x => x.id));
      const newItems = arr.filter(item => item.id && !ids.has(item.id));
      if (newItems.length > 0) saveAll([...existing, ...newItems]);
      return newItems.length;
    };
    Utils.showProgress('นำเข้าข้อมูล...', 35);
    const c = {
      customers: importCol(data.customers, () => DB.getCustomers(), DB.saveCustomers.bind(DB), 'ลูกค้า'),
      products:  importCol(data.products,  () => DB.getProducts(),  DB.saveProducts.bind(DB),  'สินค้า'),
      invoices:  importCol(data.invoices,  () => DB.getInvoices(),  DB.saveInvoices.bind(DB),  'ใบกำกับ'),
      payments:  importCol(data.payments,  () => DB.getPayments(),  DB.savePayments.bind(DB),  'การชำระ'),
      versions:  importCol(data.versions,  () => DB.getVersions(),  DB.saveVersions.bind(DB),  'เวอร์ชัน'),
    };

    // ── Import PDF files ──
    let pdfCount = 0, pdfSkipped = 0;
    const dirHandle = await IDB.get('pdf_dir');
    const pdfFolder = zip.folder('pdfs');
    if (pdfFolder && dirHandle) {
      try {
        const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          // Collect PDF entries first for progress tracking
          const pdfEntries = [];
          pdfFolder.forEach((relPath, entry) => {
            if (!entry.dir && relPath.toLowerCase().endsWith('.pdf')) pdfEntries.push([relPath, entry]);
          });
          const pdfTotal = pdfEntries.length;
          for (let i = 0; i < pdfTotal; i++) {
            const [relPath, entry] = pdfEntries[i];
            Utils.showProgress(`นำเข้า PDF (${i + 1}/${pdfTotal})`, 35 + ((i + 1) / pdfTotal) * 60);
            try {
              const ab = await entry.async('arraybuffer');
              const fh = await dirHandle.getFileHandle(relPath, { create: true });
              const w  = await fh.createWritable();
              await w.write(ab); await w.close();
              pdfCount++;
            } catch { pdfSkipped++; }
          }
        }
      } catch(e) { console.warn('importZip PDF:', e); }
    } else if (pdfFolder && !dirHandle) {
      pdfFolder.forEach((p, e) => { if (!e.dir) pdfSkipped++; });
    }
    Utils.hideProgress();

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
async function clearAllData() {
  if (!confirm('⚠️ ล้างข้อมูลทั้งหมด?\nการกระทำนี้ไม่สามารถกู้คืนได้!')) return;
  if (!confirm('ยืนยันอีกครั้ง — ลบข้อมูลทุกอย่างจริงหรือไม่?')) return;

  // Disable button to prevent double-click or navigation during async ops
  const btn = document.querySelector('[onclick="clearAllData()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังล้าง...'; }

  const cfg = DB.getSettings();
  const dataKeys = Object.values(DB.K).filter(k => k !== DB.K.SETTINGS && k !== DB.K.COUNTER);

  // Cancel any queued Drive uploads so old data isn't re-uploaded after clear
  if (window.DriveDbSync && DriveDbSync._queue) {
    Object.keys(DriveDbSync._queue).forEach(k => clearTimeout(DriveDbSync._queue[k]));
    DriveDbSync._queue = {};
  }

  // Stop all Firestore real-time listeners — prevents them from pushing data back
  // after we clear Firestore (listeners would otherwise fire and "undo" the clear)
  if (window.Sync && Array.isArray(Sync._unsubscribers)) {
    Sync._unsubscribers.forEach(fn => { try { fn(); } catch {} });
    Sync._unsubscribers = [];
  }

  // Clear Firestore data BEFORE clearing localStorage.
  // This is critical: Sync._pullAll() runs on every page load and would re-download
  // everything from Firestore if we only cleared localStorage.
  if (window.Sync && Sync.ready && Sync._db) {
    try {
      Utils.showAlert('กำลังล้างข้อมูลใน Firestore... โปรดรอ', 'info');
      const base = Sync._orgRef();

      // Clear document keys (customers, products, versions, etc.) → set to empty array
      const docClears = Object.entries(Sync.DOCUMENTS)
        .filter(([lsKey]) => dataKeys.includes(lsKey))
        .map(([, docName]) =>
          base.collection('data').doc(docName)
            .set({ d: [], ts: firebase.firestore.FieldValue.serverTimestamp(), by: 'clear' })
            .catch(() => {})
        );

      // Delete every record in collection keys (invoices, payments)
      const colClears = Object.entries(Sync.COLLECTIONS)
        .map(async ([, colName]) => {
          const snap = await base.collection(colName).get({ source: 'server' }).catch(() => null);
          if (!snap || snap.empty) return;
          let batch = Sync._db.batch(), ops = 0;
          for (const d of snap.docs) {
            batch.delete(d.ref);
            if (++ops >= 490) { await batch.commit(); batch = Sync._db.batch(); ops = 0; }
          }
          if (ops > 0) await batch.commit();
        });

      await Promise.all([...docClears, ...colClears]);
    } catch (e) {
      console.warn('[clearAllData] Firestore clear error:', e);
    }

    // Clear the offline sync queue so stale writes don't replay on next load
    localStorage.removeItem(Sync._pendingLsKey);
  }

  // Clear all data keys from localStorage
  Object.values(DB.K).forEach(k => localStorage.removeItem(k));

  // Clear Drive DB sync meta — prevents _restoreStaleKeys() from re-downloading deleted data
  localStorage.removeItem('wt_drive_db_meta');

  DB.saveSettings(cfg);
  DB.init();

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-trash me-1"></i>ล้างทั้งหมด'; }
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

  // วันที่อัปเดต — show time too when the timestamp carries one (ISO with 'T')
  const d = new Date(APP_VERSION.date);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  let dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
  if (String(APP_VERSION.date).includes('T')) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    dateStr += ` ${hh}:${mm} น.`;
  }
  document.getElementById('versionDate').textContent = dateStr;

  // เครื่องนี้ — real PC name in the desktop app, browser host on the web
  const devEl = document.getElementById('versionDevice');
  if (window.IS_TAURI) {
    // Tauri 1.x os API has no hostname() — show platform label instead
    const osApi = window.__TAURI__?.os;
    if (osApi?.platform) {
      osApi.platform().then(p => {
        const label = p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p || 'Desktop';
        devEl.textContent = 'เครื่องเดสก์ท็อป (' + label + ')';
      }).catch(() => { devEl.textContent = 'เครื่องเดสก์ท็อป'; });
    } else {
      devEl.textContent = 'เครื่องเดสก์ท็อป';
    }
  } else {
    devEl.textContent = window.location.hostname || 'localhost';
  }

  // Check-for-update button — desktop app only (web auto-updates on reload)
  if (window.IS_TAURI) {
    document.getElementById('updateRow').classList.remove('d-none');
    document.getElementById('btnCheckUpdate')?.classList.remove('d-none');
  }
}

// ── Sync diagnostic ─────────────────────────────────────────────────────────
// Reveals the identity each device syncs under + a live server round-trip.
// Run on BOTH devices and compare:
//   • If "deviceId" is IDENTICAL on both → that's the bug: the echo guard
//     (by === deviceId) makes each device ignore the other's writes.
//   • "Server read-back → last write by" shows which device last touched the
//     test doc; run on A then B — B should see A's deviceId (cross-device read OK).
let _diagUnsub = [];
let _diagEvents = [];
async function runSyncDiagnostic() {
  const out = document.getElementById('syncDiagOut');
  out.classList.remove('d-none');
  const head = [];
  const log = (k, v) => head.push(String(k).padEnd(28) + ': ' + v);
  const paint = () => { out.textContent = head.join('\n') + '\n\n── LIVE (keep open; act on OTHER device) ──\n' + _diagEvents.slice(-14).join('\n'); };
  _diagEvents = [];
  out.textContent = 'กำลังตรวจสอบ…';
  (_diagUnsub || []).forEach(u => { try { u(); } catch {} });
  _diagUnsub = [];

  try {
    log('IS_TAURI', !!window.IS_TAURI);
    if (typeof Sync === 'undefined') { out.textContent = '❌ sync.js not loaded'; return; }
    log('Sync.ready', Sync.ready === true);
    log('Sync._online', Sync._online);
    log('deviceId', Sync._deviceId || '(none)');
    log('app listeners attached', (Sync._unsubscribers ? Sync._unsubscribers.length : 0) + '  (expect ≥ 4)');
    const fb = (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) ? firebase : null;
    const user = fb ? fb.auth().currentUser : null;
    log('auth email', user ? (user.email || '(anon)') : '(none)');
    if (!fb || !Sync._db) { paint(); return; }

    const base = Sync._orgRef();

    // ── LOCAL vs SERVER counts — the decisive comparison ─────────────────────
    // Run on A right after you add/delete, then on B. Compares what's on this
    // device vs what's actually on the Firestore server.
    //   • A: local and server should MATCH (your change reached the server).
    //   • B: server should match A; if B's LOCAL differs from server → B isn't
    //     applying remote changes (apply/listener bug). If SERVER on B differs
    //     from A → A's write never reached the server (push bug).
    async function countDoc(docName, lsKey) {
      let localN = '?';
      try { const a = JSON.parse((Sync._localRead ? Sync._localRead(lsKey) : null) || '[]'); localN = Array.isArray(a) ? a.length : 'obj'; } catch {}
      let serverN = '?';
      try {
        const s = await base.collection('data').doc(docName).get({ source: 'server' });
        const d = s.exists ? s.data().d : null;
        serverN = Array.isArray(d) ? d.length : (d ? 'obj' : 'missing');
      } catch (e) { serverN = 'ERR ' + (e.code || e.message); }
      log(docName + ' count', 'local=' + localN + '  server=' + serverN +
          (localN === serverN ? '  ✓match' : '  ✗DIFFER'));
    }
    log('', '');
    await countDoc('customers', 'wt_customers');
    await countDoc('users_cfg', 'wt_users');
    await countDoc('products',  'wt_products');

    // ── LIVE listener on the REAL customers + users docs ─────────────────────
    // Keep this open on device B; add/delete a customer or user on device A.
    // A line should appear here within seconds if B's listener gets the change.
    [['customers','wt_customers'], ['users_cfg','wt_users']].forEach(([docName]) => {
      const u = base.collection('data').doc(docName).onSnapshot({ includeMetadataChanges: true }, (snap) => {
        const d = snap.exists ? snap.data().d : null;
        const n = Array.isArray(d) ? d.length : (d ? 'obj' : '-');
        const by = d && snap.data().by ? snap.data().by : '?';
        const mine = by === Sync._deviceId;
        _diagEvents.push(`${new Date().toLocaleTimeString()}  ${docName}  n=${n}  cache=${snap.metadata.fromCache}  by=${by}` + (mine ? ' (self)' : ' ◀REMOTE'));
        paint();
      }, (err) => { _diagEvents.push(docName + ' listener ERR: ' + err.code); paint(); });
      _diagUnsub.push(u);
    });
    log('', '');
    log('live monitor', 'attached to customers + users_cfg');
    paint();
  } catch (e) {
    out.textContent = head.join('\n') + '\n\n❌ ' + (e.message || e);
  }
}

// Firestore collection delete round-trip test. Directly verifies that a doc in
// the customers_v2 collection can be written AND deleted server-side (rules +
// connectivity). Run on the device where deletes "don't stick".
async function runFsDeleteTest() {
  const out = document.getElementById('syncDiagOut');
  out.classList.remove('d-none');
  const L = [];
  const paint = () => { out.textContent = L.join('\n'); };
  L.push('=== Firestore delete round-trip (customers_v2) ==='); paint();
  try {
    if (typeof Sync === 'undefined' || !Sync._db) { L.push('❌ Sync/Firestore not ready'); paint(); return; }
    const col = Sync._orgRef().collection('customers_v2');
    const id  = '_deltest_' + Date.now();
    L.push('1) writing temp doc ' + id + ' …'); paint();
    await col.doc(id).set({ id, name: 'DELETE TEST', _by: Sync._deviceId, _ts: Date.now() });
    let s = await col.doc(id).get({ source: 'server' });
    L.push('   after write, exists on server: ' + s.exists + (s.exists ? ' ✅' : ' ❌')); paint();
    L.push('2) deleting temp doc …'); paint();
    await col.doc(id).delete();
    s = await col.doc(id).get({ source: 'server' });
    L.push('   after delete, exists on server: ' + s.exists + (s.exists ? '  ❌ DELETE BLOCKED' : '  ✅ gone')); paint();
    // Live collection count (server)
    const all = await col.get({ source: 'server' });
    L.push('3) customers_v2 docs on server: ' + all.size);
    L.push('');
    L.push(s.exists
      ? '⚠️ Delete did NOT persist → Firestore rules/permission block deletes.'
      : '✅ Firestore delete works. If app deletes still return, the issue is in the app delete path, not Firestore.');
    paint();
  } catch (e) {
    L.push('❌ ' + (e.code || '') + ' ' + (e.message || e)); paint();
  }
}

// Device label — shown to other devices in sync-activity toasts. Stored in the
// HDD-backed DB store (not synced; each device keeps its own name).
function loadDeviceLabel() {
  const el = document.getElementById('deviceLabel');
  if (!el) return;
  let v = '';
  try { v = DB._getObj('wt_device_label', '') || ''; } catch {}
  el.value = v;
}
function saveDeviceLabel() {
  const el = document.getElementById('deviceLabel');
  if (!el) return;
  const v = (el.value || '').trim().slice(0, 40);
  try { DB._set('wt_device_label', v); } catch {}
  Utils.showAlert('<i class="bi bi-check-circle me-1"></i>บันทึกชื่อเครื่องแล้ว: <strong>' + (v || '(ค่าเริ่มต้น)') + '</strong>', 'success');
}
window.addEventListener('DOMContentLoaded', () => { try { DB.ready.then(loadDeviceLabel); } catch {} });

// Clear all deletion tombstones (local + the shared Firestore _deletions doc).
// Recovery tool: earlier versions auto-tombstoned bulk reductions, poisoning the
// shared _deletions doc and wiping real records on every device. Running this
// once clears that poison so the UNION merge can restore data; afterwards only
// small, intentional deletions are tombstoned.
async function clearSyncDeletions() {
  if (!confirm('ซ่อมการซิงค์ / รีเซ็ต?\n\n' +
               '• ล้างคิวค้าง + รายการลบ + สถานะซิงค์ในเครื่องนี้\n' +
               '• ดึงข้อมูลใหม่ทั้งหมดจากเซิร์ฟเวอร์ แล้วรวม (union)\n\n' +
               'แนะนำ: กดที่ "เครื่องที่ข้อมูลครบ" ก่อน จากนั้นเปิดแอปใหม่ทุกเครื่อง')) return;
  // Clear ALL stuck local sync state — a leftover pending-write queue (e.g. from
  // an earlier delete-all) can make a device keep pushing an empty array and
  // fighting the device that has the real data. Forcing a fresh full pull lets
  // the UNION merge pull everything back.
  const keys = ['wt_sync_pending', 'wt_sync_tombstones', 'wt_sync_known_doc_ids',
                'wt_sync_doc_ts', 'wt_sync_sids', 'wt_sync_pull_ids', 'wt_sync_lastPulledAt'];
  keys.forEach(k => { try { localStorage.removeItem(k); } catch {} ; try { sessionStorage.removeItem(k); } catch {} });
  try { sessionStorage.removeItem('wt_sync_session_pulled'); } catch {}  // force a fresh _pullAll
  try {
    if (typeof Sync !== 'undefined' && Sync._db && Sync._fsDeletionsRef) {
      await Sync._fsDeletionsRef().set({
        d: {}, ts: firebase.firestore.FieldValue.serverTimestamp(), by: Sync._deviceId
      });
    }
  } catch (e) { console.warn('reset _deletions:', e); }
  Utils.showAlert('<i class="bi bi-check-circle me-1"></i>ล้างสถานะซิงค์แล้ว — กำลังโหลดใหม่…', 'success');
  setTimeout(() => location.reload(), 1200);
}

// ── Update-progress helpers ────────────────────────────────────────────────
let _updManifest = null;   // stored from checkUpdate() so installUpdate() can use it

function _updShow(id) {
  ['Checking','UpToDate','Available','Downloading','Installing','Done','Error']
    .forEach(s => {
      const el = document.getElementById('upd' + s);
      if (el) el.style.display = (s === id) ? '' : 'none';
    });
  const panel = document.getElementById('updPanel');
  const btn   = document.getElementById('btnCheckUpdate');
  if (panel) panel.style.display = id ? '' : 'none';
  // Hide the header check button while a state panel is active; show it when idle
  if (btn) btn.style.display = id ? 'none' : '';
}

function updReset() {
  _updManifest = null;
  _updShow(null);
}

async function checkForUpdate() {
  if (!window.IS_TAURI || !window.__TAURI__?.updater) return;
  _updShow('Checking');
  try {
    const { shouldUpdate, manifest } = await window.__TAURI__.updater.checkUpdate();
    _updManifest = manifest;
    if (shouldUpdate) {
      const verEl = document.getElementById('updNewVer');
      if (verEl) verEl.textContent = 'v' + (manifest?.version || '');
      _updShow('Available');
    } else {
      _updShow('UpToDate');
    }
  } catch (e) {
    const msg = document.getElementById('updErrMsg');
    if (msg) msg.textContent = e?.message || String(e);
    _updShow('Error');
  }
}

async function doInstallUpdate() {
  if (!window.IS_TAURI || !window.__TAURI__?.updater) return;
  const btn = document.getElementById('btnDoUpdate');
  if (btn) btn.disabled = true;

  // ── Fake download progress (Tauri 1.x has no download-chunk events) ───────
  // installUpdate() takes ~5-25 s depending on file size and connection.
  // We animate a progress bar that fills ~80% over 20 s, then jumps to 100%
  // when installUpdate() resolves.
  _updShow('Downloading');
  let pct = 0;
  const dlBar  = document.getElementById('updDlBar');
  const dlPct  = document.getElementById('updDlPct');
  const dlNote = document.getElementById('updDlNote');
  const FILL_DURATION_MS = 20000;   // assume ~20 s to download; bar stops at 80%
  const TICK_MS = 300;
  const MAX_AUTO_PCT = 80;
  let dlTimer = setInterval(() => {
    // Ease-out: fast at start, slows near 80%
    const remaining = MAX_AUTO_PCT - pct;
    pct = Math.min(pct + remaining * (TICK_MS / FILL_DURATION_MS) * 2.5, MAX_AUTO_PCT);
    if (dlBar) dlBar.style.width = pct.toFixed(1) + '%';
    if (dlPct) dlPct.textContent = Math.round(pct) + '%';
    if (dlNote) dlNote.textContent = pct < 30 ? 'กำลังเชื่อมต่อ…' : pct < 65 ? 'กำลังดาวน์โหลด…' : 'กำลังตรวจสอบไฟล์…';
  }, TICK_MS);

  try {
    await window.__TAURI__.updater.installUpdate();

    // Download + verify done — jump bar to 100% then show installing
    clearInterval(dlTimer);
    if (dlBar) dlBar.style.width = '100%';
    if (dlPct) dlPct.textContent = '100%';
    await new Promise(r => setTimeout(r, 400));

    _updShow('Installing');
    // Brief pause so the user sees the installing state before Tauri restarts the app
    await new Promise(r => setTimeout(r, 1500));
    _updShow('Done');

    // Tauri with dialog:true shows its own restart prompt after installUpdate().
    // If the process allowlist is available, we can also trigger relaunch directly.
    try {
      if (window.__TAURI__?.process?.relaunch) await window.__TAURI__.process.relaunch();
    } catch {}

  } catch (e) {
    clearInterval(dlTimer);
    const msg = document.getElementById('updErrMsg');
    if (msg) msg.textContent = e?.message || String(e);
    _updShow('Error');
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

// Re-render stat cards only if page loaded with no local data (fresh browser)
// Avoids overwriting displayed data when Firestore is out of sync with localStorage
let _hadDataAtLoad = false;
window.addEventListener('DOMContentLoaded', () => { _hadDataAtLoad = DB.getInvoices().length > 0; }, { once: true });
window.addEventListener('sync:ready', () => {
  if (!_hadDataAtLoad) { loadStats(); renderStorageBar(); renderLogCounts(); }
});
