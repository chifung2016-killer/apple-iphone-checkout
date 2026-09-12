@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 未偵測到 Node.js。
  echo 請先去 https://nodejs.org 下載並安裝 LTS 版，然後重開呢個視窗再試。
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 第一次使用：正在安裝依賴（含 Chromium）…
  call npm install
  if errorlevel 1 (
    echo 安裝失敗。請檢查網絡後再試。
    pause
    exit /b 1
  )
)

echo.
echo Checkout Dashboard 啟動中…
echo 請用瀏覽器開： http://127.0.0.1:8787
echo 關閉呢個視窗 = 停止 Dashboard
echo.
call npm run dashboard
pause
