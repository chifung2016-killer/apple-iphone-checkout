@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  Apple Checkout — 第一次安裝
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 未偵測到 Node.js。
  echo.
  echo 請先下載安裝：
  echo   https://nodejs.org  （揀 LTS）
  echo.
  echo 裝完後重開呢個視窗，再雙擊 setup.bat。
  pause
  exit /b 1
)

echo Node 版本：
node -v
npm -v
echo.
echo 正在 npm install（會自動下載 Playwright Chromium）…
call npm install
if errorlevel 1 (
  echo.
  echo npm install 失敗。可再試：
  echo   npx playwright install chromium
  pause
  exit /b 1
)

echo.
echo 確保 Chromium 已安裝…
call npx playwright install chromium
echo.
echo ========================================
echo  安裝完成！
echo  之後日常請雙擊 start-dashboard.bat
echo  然後開 http://127.0.0.1:8787
echo ========================================
pause
