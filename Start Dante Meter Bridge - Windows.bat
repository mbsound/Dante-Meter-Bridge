@echo off
cd /d "%~dp0"
title Dante Audio Meter Bridge
set "PATH=%PATH%;%ProgramFiles%\nodejs"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ========================================================
    echo   [ERROR] Node.js is not installed on this computer.
    echo ========================================================
    echo.
    echo Please double-click "First Time Running - Click Here - Windows.bat" first.
    echo.
    pause
    exit /b 1
)

node server.js --open
pause
