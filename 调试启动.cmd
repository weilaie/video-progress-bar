@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"

echo ==========================================
echo   Video Progress Bar Tool - debug console
echo ==========================================
echo.

rem Prefer the runtime bundled in this package, so it runs without Node.js installed.
set "NODE_EXE="
if exist "%ROOT%bin\node.exe" set "NODE_EXE=%ROOT%bin\node.exe"
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE goto nonode

echo   node: %NODE_EXE%
echo   starting server, log shows up below...
echo.

"%NODE_EXE%" "%ROOT%app\server.js"

echo.
echo   Server stopped. Press any key to close.
pause >nul
exit /b 0

:nonode
chcp 65001 >nul
type "%~dp0docs\node-missing.txt"
set "OPEN="
set /p "OPEN=> "
if defined OPEN start "" "https://nodejs.org/zh-cn/download"
exit /b 1
