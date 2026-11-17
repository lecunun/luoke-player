@echo off
setlocal
cd /d "%~dp0"

rem Prefer the bundled runtime\node.exe, then fall back to node on PATH.
set "NODEEXE=%~dp0runtime\node.exe"
if exist "%NODEEXE%" goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODEEXE=node"

:run
echo Starting player server...
"%NODEEXE%" proxy\server.mjs --open
if errorlevel 1 pause
exit /b 0

:nonode
echo.
echo Node.js not found.
echo Put node.exe into the "runtime" folder, or install Node.js 18+ from https://nodejs.org/
echo.
pause
exit /b 1
