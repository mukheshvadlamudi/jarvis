@echo off
rem Double-click to start Jarvis on Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Jarvis needs Node.js 24 or newer.
  echo   Install it from https://nodejs.org  ^(or run: winget install OpenJS.NodeJS.LTS^), then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts\jarvis.mjs %*
if errorlevel 1 pause
