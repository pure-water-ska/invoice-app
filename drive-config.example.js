// drive-config.example.js — Template สำหรับ Google Drive integration
// ─────────────────────────────────────────────────────────────────────────────
// วิธีใช้:
//   1. คัดลอกไฟล์นี้เป็น drive-config.js
//   2. ใส่ค่า Client ID จาก Google Cloud Console
//   3. อย่า commit drive-config.js (อยู่ใน .gitignore แล้ว)
//
// วิธีขอ Client ID (ทำครั้งเดียว):
//   1. ไปที่ https://console.cloud.google.com/
//   2. สร้าง Project ใหม่ (หรือใช้ที่มีอยู่)
//   3. APIs & Services → Enable APIs → ค้นหา "Google Drive API" → Enable
//   4. APIs & Services → Credentials → Create Credentials → OAuth client ID
//   5. Application type: Web application
//   6. Authorized JavaScript origins:
//        http://localhost          (สำหรับทดสอบ local)
//        https://ชื่อ.github.io   (สำหรับ production)
//        หรือ https://ชื่อ.netlify.app
//   7. Copy Client ID มาใส่ด้านล่าง
//   8. APIs & Services → OAuth consent screen:
//        - User type: Internal (ถ้าใช้ Google Workspace) หรือ External
//        - App name: ระบบใบกำกับสินค้า
//        - Scopes: เพิ่ม ../auth/drive.file
//        - Test users: ใส่ email ของผู้ใช้ทั้ง 3 คน (ถ้าเป็น External)
// ─────────────────────────────────────────────────────────────────────────────

// Assigned on window (not `const`) so the file is safe to load more than once.
window.GOOGLE_CLIENT_ID = '123456789-abcdefghijklmnop.apps.googleusercontent.com';
