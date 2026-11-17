@echo off
rem ---------------------------------------------------------------------------
rem  Luoke Player launcher
rem    1. use runtime\node.exe if present
rem    2. else use node from PATH (must be 18+)
rem    3. else download a portable node.exe (one time, ~30MB) and use it
rem  Everything here is plain ASCII on purpose: cmd.exe reads this file with the
rem  system code page, so non-ASCII characters would break on some machines.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Luoke Player

set "VER=v22.22.2"
set "NODE="

if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE call :frompath
if not defined NODE call :download
if not defined NODE goto failed

echo.
echo Starting player... your browser will open by itself.
echo Keep this window open; closing it stops the server.
echo.
"%NODE%" proxy\server.mjs --open
if errorlevel 1 (
  echo.
  echo The server stopped with an error.
  pause
)
exit /b 0

rem --- use node from PATH, but only if it is 18 or newer -------------------
:frompath
set "MAJ="
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do set "MAJ=%%a"
if not defined MAJ exit /b 0
set "MAJ=!MAJ:v=!"
if !MAJ! GEQ 18 (
  set "NODE=node"
  echo Using Node.js already installed on this computer.
)
exit /b 0

rem --- download a portable node.exe ----------------------------------------
:download
echo.
echo Node.js was not found on this computer.
echo Downloading a portable copy now, about 30 MB, only the first time...
echo.
set "ZIP=%TEMP%\luoke-node.zip"
set "EXDIR=%TEMP%\luoke-node"
if exist "%ZIP%" del /f /q "%ZIP%" >nul 2>nul

call :grab "https://cdn.npmmirror.com/binaries/node/%VER%/node-%VER%-win-x64.zip"
if not exist "%ZIP%" call :grab "https://npmmirror.com/mirrors/node/%VER%/node-%VER%-win-x64.zip"
if not exist "%ZIP%" call :grab "https://nodejs.org/dist/%VER%/node-%VER%-win-x64.zip"

if not exist "%ZIP%" (
  echo.
  echo Direct download failed, trying the Windows PowerShell downloader...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get_runtime.ps1"
  if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
  exit /b 0
)

echo.
echo Unpacking node.exe ...
if exist "%EXDIR%" rd /s /q "%EXDIR%" >nul 2>nul
mkdir "%EXDIR%" >nul 2>nul
tar -xf "%ZIP%" -C "%EXDIR%" >nul 2>nul
if not exist "%~dp0runtime" mkdir "%~dp0runtime" >nul 2>nul
for /r "%EXDIR%" %%f in (node.exe) do (
  if not exist "%~dp0runtime\node.exe" copy /y "%%f" "%~dp0runtime\node.exe" >nul 2>nul
)
del /f /q "%ZIP%" >nul 2>nul
rd /s /q "%EXDIR%" >nul 2>nul
if exist "%~dp0runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
  echo Done. Node.js is now stored in the runtime folder.
)
exit /b 0

rem --- download helper: %1 = url ------------------------------------------
:grab
if exist "%ZIP%" exit /b 0
echo   trying %~1
curl -L --fail --connect-timeout 20 --max-time 1800 -o "%ZIP%" "%~1" >nul 2>nul
if not exist "%ZIP%" exit /b 1
for %%A in ("%ZIP%") do if %%~zA LSS 1000000 del /f /q "%ZIP%" >nul 2>nul
exit /b 0

:failed
echo.
echo Could not get Node.js automatically. What to try:
echo   1. Check the internet connection, then double-click this file again.
echo   2. Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1
