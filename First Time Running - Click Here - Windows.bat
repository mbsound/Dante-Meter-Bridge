@echo off
setlocal
cd /d "%~dp0"
title Dante Audio Meter Bridge - First Time Setup

echo ========================================================
echo   DANTE AUDIO METER BRIDGE - FIRST TIME SETUP (Windows)
echo ========================================================
echo.

call :node_ok
if %errorlevel% equ 0 goto start

echo [!] Node.js 18 or newer was not found. Installing the current LTS release...
echo.

where winget >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Installing with Windows Package Manager ^(winget^)...
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    call :refresh_path
    call :node_ok
    if not errorlevel 1 goto installed
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1"
call :refresh_path
call :node_ok
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js could not be installed automatically.
    echo Please install the LTS version from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

:installed
echo.
echo [SUCCESS] Node.js is installed.

:start
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
echo.
echo Starting Dante Meter Bridge... (close this window to stop)
echo.
node server.js --open
pause
exit /b 0

:node_ok
where node >nul 2>nul || exit /b 1
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
exit /b %errorlevel%

:refresh_path
set "PATH=%PATH%;%ProgramFiles%\nodejs"
exit /b 0
