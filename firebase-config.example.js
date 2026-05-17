// firebase-config.example.js
// ─────────────────────────────────────────────────────────────────────────────
// คัดลอกไฟล์นี้เป็น firebase-config.js แล้วกรอกข้อมูลจาก Firebase Console
//
// วิธีหา config:
//  1. ไปที่ https://console.firebase.google.com
//  2. เลือก Project → Project Settings → Your apps
//  3. คลิก </> เพื่อสร้าง Web App (ถ้ายังไม่มี)
//  4. Copy firebaseConfig object มาวางด้านล่าง
//
// ⚠️  ห้าม commit firebase-config.js ขึ้น GitHub (เพิ่มใน .gitignore แล้ว)
//     ใช้ GitHub Secrets + Actions workflow ในการ deploy แทน
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",               // จาก Firebase Console
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",

  // orgId: ใช้แยกข้อมูลถ้าต้องการหลาย org ในอนาคต (ปกติใช้ "main")
  orgId: "main",

  // teamEmail / teamPassword: สร้างใน Firebase Authentication → Email/Password
  // ใช้ 1 account สำหรับทั้ง team (sync layer) — แยกจาก app user (username/password)
  teamEmail:    "team@yourcompany.com",
  teamPassword: "your-team-firebase-password",
};
