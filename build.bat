@echo off
setlocal
cd /d "%~dp0"
title Echo Scoreboard - build
echo ============================================
echo   Echo Scoreboard - build EchoScoreboard.exe
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :nonode
where npm >nul 2>&1
if errorlevel 1 goto :nonode

tasklist /fi "imagename eq EchoScoreboard.exe" 2>nul | find /i "EchoScoreboard.exe" >nul
if not errorlevel 1 (
  echo EchoScoreboard.exe is running. Close it ^(tray icon -^> Quit^) and run build.bat again.
  if not defined NOPAUSE pause
  exit /b 1
)

echo [1/2] Installing dependencies ^(first run downloads Electron, ~100 MB^)...
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  echo.
  echo ERROR: installing dependencies failed.
  if not defined NOPAUSE pause
  exit /b 1
)

echo.
echo [2/2] Building the app...
call npm run pack
if errorlevel 1 (
  echo.
  echo ERROR: build failed.
  if not defined NOPAUSE pause
  exit /b 1
)

echo.
echo Build complete:
echo   %~dp0dist\EchoScoreboard-win32-x64\EchoScoreboard.exe
echo.
echo Double-click it to open the scoreboard. The tray icon toggles the in-game overlay.
echo Run it with --tray to start hidden ^(tray + overlay only^).
echo.
if not defined NOPAUSE pause
exit /b 0

:nonode
echo ERROR: Node.js and npm were not found.
echo Install Node.js ^(LTS^) from https://nodejs.org and run build.bat again.
if not defined NOPAUSE pause
exit /b 1
