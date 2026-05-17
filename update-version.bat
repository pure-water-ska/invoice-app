@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo   อัปเดตเวอร์ชันโปรแกรม - Web App
echo ============================================
echo.

:: แสดงเวอร์ชันปัจจุบัน
for /f "tokens=*" %%a in ('powershell -command "(Get-Content 'utils.js') | Select-String \"version:\" | Select-Object -First 1"') do (
  echo เวอร์ชันปัจจุบัน: %%a
)
echo.

:: รับเวอร์ชันใหม่
set /p NEW_VER=ใส่เวอร์ชันใหม่ (เช่น 1.0.1):
if "%NEW_VER%"=="" (
  echo ยกเลิก — ไม่ได้ใส่เวอร์ชัน
  pause & exit /b
)

:: คำนวณวันที่ปัจจุบัน (พ.ศ.)
for /f "tokens=*" %%d in ('powershell -command "$d = Get-Date; $day = $d.Day; $monthsTH = @('ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'); $m = $monthsTH[$d.Month - 1]; $y = $d.Year + 543; \"$day $m $y\""') do set THAI_DATE=%%d

for /f "tokens=*" %%d in ('powershell -command "Get-Date -Format 'yyyy-MM-dd'"') do set ISO_DATE=%%d

echo.
echo เวอร์ชันใหม่ : %NEW_VER%
echo วันที่       : %ISO_DATE% (%THAI_DATE%)
echo label        : v%NEW_VER% (%THAI_DATE%)
echo.
set /p CONFIRM=ยืนยันอัปเดต? (y/n):
if /i not "%CONFIRM%"=="y" (
  echo ยกเลิก
  pause & exit /b
)

:: สำรอง utils.js ก่อนแก้
copy "utils.js" "utils.js.bak" >nul
echo สำรอง utils.js เป็น utils.js.bak แล้ว

:: อัปเดต utils.js ด้วย PowerShell
powershell -command ^
  "$content = Get-Content 'utils.js' -Raw -Encoding UTF8;" ^
  "$content = $content -replace \"version: '[^']*'\", \"version: '%NEW_VER%'\";" ^
  "$content = $content -replace \"date: '[^']*'\", \"date: '%ISO_DATE%'\";" ^
  "$content = $content -replace \"label: '[^']*'\", \"label: 'v%NEW_VER% (%THAI_DATE%)'\";" ^
  "[System.IO.File]::WriteAllText((Resolve-Path 'utils.js'), $content, [System.Text.UTF8Encoding]::new($false));"

echo.
echo ============================================
echo   อัปเดตสำเร็จ!
echo ============================================
for /f "tokens=*" %%a in ('powershell -command "(Get-Content 'utils.js') | Select-String \"version:\" | Select-Object -First 1"') do (
  echo %%a
)
for /f "tokens=*" %%a in ('powershell -command "(Get-Content 'utils.js') | Select-String \"label:\" | Select-Object -First 1"') do (
  echo %%a
)
echo.
echo หมายเหตุ: ไฟล์สำรองอยู่ที่ utils.js.bak
echo          ลบทิ้งได้หากไม่ต้องการ
echo ============================================
pause
