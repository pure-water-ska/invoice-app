// utils.js - Shared utilities

// Global error capture — ต้องอยู่บนสุดก่อน script อื่น
window.addEventListener('error', e => {
  if (typeof DB !== 'undefined') {
    DB.logError('JS Error', e.message, {
      file: e.filename ? e.filename.split('/').pop() : '',
      line: e.lineno,
      col:  e.colno,
      stack: e.error ? String(e.error.stack || '').slice(0, 300) : ''
    });
  }
});
window.addEventListener('unhandledrejection', e => {
  if (typeof DB !== 'undefined') {
    DB.logError('Unhandled Promise', String(e.reason || '').slice(0, 300), {});
  }
});

const APP_VERSION = {
  version: '1.0.0',
  date: '2026-05-06',
  label: 'v1.0.0 (6 พ.ค. 2569)',
};

// Changelog — add new entry here when releasing a new version.
// Each entry: { version, date, label, highlights[], changes:[{category, items[]}] }
const APP_CHANGELOG = [
  {
    version: '1.0.0',
    date: '2026-05-06',
    label: 'v1.0.0 (6 พ.ค. 2569)',
    highlights: [
      'ระบบใบกำกับสินค้าครบวงจร',
      'จัดการลูกค้า / สินค้า / ราคา',
      'ระบบชำระเงิน & รายการค้างชำระ',
      'สต๊อกฝาขวด + ฉลากขวด',
      'คืนสินค้า (หลายรายการต่อใบ)',
      'Snapshots & Rollback (Admin)',
      'วินิจฉัยระบบ (Admin)',
    ],
    changes: [
      { category: 'ใบกำกับสินค้า', items: [
        'สร้าง / แก้ไข / ลบใบกำกับ รองรับหลายหน้าต่อใบ',
        'แนบรายการคืนสินค้าเป็นรายการหักในใบกำกับได้ทันที',
        'ค้นหา กรองตามสถานะ / ลูกค้า / วันที่',
        'แบ่งหน้า 30 รายการ / หน้า',
      ]},
      { category: 'ชำระเงิน', items: [
        'บันทึกการชำระหลายรูปแบบ (เงินสด / โอน / เช็ค)',
        'ดูรายการค้างชำระของลูกค้า พร้อมบันทึกภาพ / คัดลอก',
        'ยกเลิกรายการชำระ',
      ]},
      { category: 'ลูกค้า', items: [
        'จัดการข้อมูล ที่อยู่ เบอร์โทร แผนที่ Google Maps',
        'บันทึกยี่ห้อสินค้าของลูกค้า (หลายยี่ห้อ)',
        'กำหนดเงื่อนไขการชำระ (จำนวนบิล / วัน)',
        'แจ้งเตือนเมื่อลูกค้าค้างเกินกำหนด (popup รายวัน)',
        'โหมดเลือกหลายราย / ลบพร้อมกัน',
        'แบ่งหน้า 24 รายการ / หน้า',
      ]},
      { category: 'สินค้า / ราคา', items: [
        'จัดการสินค้าและขนาดแพ็ค',
        'ตั้งราคาเฉพาะลูกค้า / ประเภทการจัดส่ง',
        'ประวัติการเปลี่ยนราคา',
      ]},
      { category: 'คืนสินค้า', items: [
        'บันทึกการคืน รองรับหลายรายการสินค้าต่อใบ',
        'ค้นหาจากชื่อลูกค้าหรือเลขใบกำกับต้นทาง (auto-fill)',
        'เชื่อมโยงกับใบกำกับที่หักออก',
      ]},
      { category: 'สต๊อกฝาขวด / ฉลากขวด', items: [
        'บันทึกรับเข้า / จ่ายออกฝาขวดตามสี',
        'หักออกอัตโนมัติเมื่อออกใบกำกับ',
        'ออกแบบและพิมพ์ฉลากขวด',
      ]},
      { category: 'รายงาน', items: [
        'สรุปยอดขายรายเดือน / ปี',
        'รายงานตามลูกค้า / สินค้า',
        'Export รายงาน',
      ]},
      { category: 'ระบบ / ผู้ดูแล (Admin)', items: [
        'จัดการผู้ใช้และสิทธิ์ละเอียด',
        'Auto Backup รายวัน (ดาวน์โหลด JSON อัตโนมัติ)',
        'นำเข้าข้อมูลจาก PDF / Excel / JSON',
        'Archive log อัตโนมัติเมื่อเก่ากว่า 2 ปี',
        'แจ้งเตือนเมื่อ Storage เกิน 80%',
        'Snapshots & Rollback — บันทึกสถานะข้อมูลและย้อนกลับได้',
        'วินิจฉัยระบบ (Troubleshooter) — ตรวจสอบข้อมูลและแก้ไขปัญหาอัตโนมัติ',
        'Fallback แจ้งเตือนเมื่อ CDN โหลดไม่ได้',
      ]},
    ],
  },
];

const Utils = {
  uuid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  },

  hashPassword(password) {
    let hash = 5381;
    const str = password + 'goldstar_wt_2024_salt';
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & 0x7fffffff;
    }
    return 'h' + hash.toString(16).padStart(8, '0');
  },

  // Thai Buddhist Era date formatting
  toBEYear(ceYear) { return ceYear + 543; },

  formatDateTH(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d)) return '-';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear() + 543;
    return `${dd}/${mm}/${yy}`;
  },

  formatDateTimeTH(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d)) return '-';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear() + 543;
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${hh}:${mi}`;
  },

  THAI_MONTHS_SHORT: ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'],
  THAI_MONTHS_LONG: ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'],

  formatDateLongTH(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d)) return '-';
    return `${d.getDate()} ${this.THAI_MONTHS_LONG[d.getMonth()]} ${d.getFullYear() + 543}`;
  },

  formatNumber(n) {
    if (n === null || n === undefined || n === '') return '0.00';
    return parseFloat(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatNumberInt(n) {
    if (n === null || n === undefined || n === '') return '0';
    return parseInt(n).toLocaleString('th-TH');
  },

  // Map product name → unit label
  productUnit(name) {
    if (!name) return '';
    const n = name.trim();
    if (n.startsWith('ฝาขวด PET'))  return 'ฝา/ลัง';
    if (n.startsWith('ขวด'))         return 'ขวด/ห่อ';
    if (n.startsWith('PVC'))         return 'กก./กระสอบ';
    if (n.startsWith('ถุง'))          return 'กก./กระสอบ';
    if (n.startsWith('ฝาถัง 20'))    return 'ฝา';
    if (n.startsWith('ฝาถังใส'))     return 'ฝา';
    if (n.startsWith('ถังน้ำ 20'))   return 'ถัง';
    if (n.startsWith('ฟิล์มม้วน'))  return 'กก.';
    if (n.startsWith('บล๊อก'))       return 'ชิ้น';
    if (n.startsWith('สีสกรีน'))     return 'หน่วย';
    if (n.startsWith('ค่าจัดส่ง'))   return 'หน่วย';
    if (n.startsWith('หักคืน'))      return 'หน่วย';
    return '';
  },

  // Convert number to Thai words (baht)
  numberToThaiWords(amount) {
    if (!amount || amount === 0) return 'ศูนย์บาทถ้วน';
    const ones = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    const pos = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];

    function toWords(n) {
      if (n === 0) return '';
      if (n < 0) return 'ลบ' + toWords(-n);
      let result = '';
      const digits = String(Math.floor(n)).split('').map(Number);
      const len = digits.length;
      for (let i = 0; i < len; i++) {
        const d = digits[i];
        const p = len - i - 1;
        if (d === 0) continue;
        if (p === 1 && d === 1) result += pos[p];
        else if (p === 1 && d === 2) result += 'ยี่' + pos[p];
        else result += ones[d] + pos[p];
      }
      return result;
    }

    const baht = Math.floor(amount);
    const satang = Math.round((amount - baht) * 100);
    let result = toWords(baht) + 'บาท';
    if (satang > 0) result += toWords(satang) + 'สตางค์';
    else result += 'ถ้วน';
    return result;
  },

  BANKS: [
    { code: 'KBANK', name: 'กสิกรไทย (KBANK)', color: '#138f2d' },
    { code: 'SCB',   name: 'ไทยพาณิชย์ (SCB)',  color: '#4e2d8c' },
    { code: 'KTB',   name: 'กรุงไทย (KTB)',     color: '#1ba5e1' },
    { code: 'BBL',   name: 'กรุงเทพ (BBL)',      color: '#1e4598' },
    { code: 'BAY',   name: 'กรุงศรีอยุธยา (BAY)', color: '#fec43b' },
    { code: 'TTB',   name: 'ทหารไทยธนชาต (TTB)', color: '#fc4f1f' },
    { code: 'CIMB',  name: 'ซีไอเอ็มบีไทย (CIMB)', color: '#b40000' },
    { code: 'UOB',   name: 'ยูโอบี (UOB)',       color: '#0f3d8c' },
    { code: 'TISCO', name: 'ทิสโก้ (TISCO)',     color: '#12549c' },
    { code: 'KKP',   name: 'เกียรตินาคินภัทร (KKP)', color: '#199b4b' },
    { code: 'LH',    name: 'แลนด์แอนด์เฮ้าส์ (LH)', color: '#0a4e96' },
    { code: 'GHB',   name: 'อาคารสงเคราะห์ (GHB)', color: '#f57b20' },
    { code: 'GSB',   name: 'ออมสิน (GSB)',       color: '#eb198d' },
    { code: 'BAAC',  name: 'เพื่อการเกษตร (BAAC)', color: '#4bac00' },
    { code: 'TMB',   name: 'ทหารไทย (TMB)',      color: '#fc4f1f' },
    { code: 'ICBC',  name: 'ไอซีบีซี (ICBC)',    color: '#c10000' },
    { code: 'SC',    name: 'สแตนดาร์ดชาร์เตอร์ด (SC)', color: '#0e7bc0' },
    { code: 'OTHER', name: 'อื่นๆ',             color: '#666666' }
  ],

  bankOptions(selected) {
    return this.BANKS.map(b =>
      `<option value="${b.code}" ${selected === b.code ? 'selected' : ''}>${b.name}</option>`
    ).join('');
  },

  bankDatalistOptions() {
    return this.BANKS.map(b => `<option value="${b.name}">`).join('');
  },

  getBankName(val) {
    if (!val) return '-';
    const byCode = this.BANKS.find(x => x.code === val);
    if (byCode) return byCode.name;
    const byName = this.BANKS.find(x => x.name === val);
    if (byName) return byName.name;
    return val;
  },

  // Returns a debounced version of fn — only fires after `delay` ms of silence.
  // Use on search/filter inputs to avoid re-rendering on every keystroke.
  debounce(fn, delay = 200) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  },

  showAlert(msg, type = 'success', containerId = 'alertBox') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="alert alert-${type} alert-dismissible fade show mb-0" role="alert">
      ${msg}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`;
    if (type === 'success') setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // ── Progress toast (fixed bottom-right, shows label + % bar) ───────────────
  showProgress(label, pct) {
    let el = document.getElementById('_progressToast');
    if (!el) {
      el = document.createElement('div');
      el.id = '_progressToast';
      el.style.cssText = [
        'position:fixed', 'bottom:80px', 'right:16px', 'z-index:9999',
        'min-width:260px', 'max-width:320px',
        'background:#1e2329', 'color:#f0f2f5',
        'border-radius:12px', 'padding:12px 16px',
        'box-shadow:0 4px 20px rgba(0,0,0,.45)',
        'font-size:13px', 'font-family:inherit',
      ].join(';');
      document.body.appendChild(el);
    }
    const p = Math.round(Math.min(100, Math.max(0, pct || 0)));
    const color = p < 100 ? '#0d6efd' : '#198754';
    el.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">` +
        `<span style="opacity:.9">${label}</span>` +
        `<strong style="color:${color};font-size:14px;margin-left:10px">${p}%</strong>` +
      `</div>` +
      `<div style="height:7px;background:#3a3f47;border-radius:4px;overflow:hidden">` +
        `<div style="height:100%;width:${p}%;background:${color};border-radius:4px;` +
             `transition:width .25s ease,background .3s"></div>` +
      `</div>`;
    el.style.display = '';
  },

  hideProgress() {
    const el = document.getElementById('_progressToast');
    if (el) {
      // Flash green at 100%, then fade out
      this.showProgress(el.querySelector('span')?.textContent || 'เสร็จแล้ว', 100);
      setTimeout(() => { if (el) el.style.display = 'none'; }, 600);
    }
  },