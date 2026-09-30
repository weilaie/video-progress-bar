@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
set "PORT=8790"

rem ---- 1. already running? just bring the window up ----
netstat -an | findstr /c:":%PORT%" | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

rem ---- 2. locate node.exe ----
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "E:\nodejs\node.exe" set "NODE_EXE=E:\nodejs\node.exe"

if not defined NODE_EXE goto nonode
if not exist "%NODE_EXE%" goto nonode

rem ---- 3. start server ----
if not exist "%ROOT%config" mkdir "%ROOT%config"
start "VideoBar Server" /min "%NODE_EXE%" "%ROOT%app\server.js"
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Please install it from https://nodejs.org and run this file again.
echo.
pause
exit /b 1
