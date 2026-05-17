// firebase-config.js — Firebase project: invoice-app-3033a
// ─────────────────────────────────────────────────────────────────────────────
// ✅ ไฟล์นี้ commit ได้ — ไม่มี password (ดู firebase-credentials.js สำหรับ local dev)
//    GitHub Actions inject teamPassword ผ่าน secret FIREBASE_TEAM_PASSWORD อัตโนมัติ
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCCO8jHI84C00A_fXLhOJvdEB8MY_6d32o",
  authDomain:        "invoice-app-3033a.firebaseapp.com",
  projectId:         "invoice-app-3033a",
  storageBucket:     "invoice-app-3033a.firebasestorage.app",
  messagingSenderId: "1057822150566",
  appId:             "1:1057822150566:web:33f43cea74219eac914967",

  orgId:        "main",
  teamEmail:    "pure.water.ska@gmail.com",
  teamPassword: "", // ← injected by CI (FIREBASE_TEAM_PASSWORD secret) or firebase-credentials.js
};
