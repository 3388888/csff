@echo off
setlocal EnableExtensions
title CSGO Demo Highlights - installer
set "APP=CSGO Demo Highlights"
set "DEST=%LOCALAPPDATA%\%APP%"
set "URL=https://github.com/3388888/cc-demo-highlights/releases/latest/download/CSGO-Demo-Highlights-portable.zip"
set "ZIP=%TEMP%\cdh-portable.zip"

echo.
echo   %APP%  -  installer
echo   target: %DEST%
echo.

echo [1/3] Downloading latest release...
curl -L --fail --progress-bar -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo.
  echo   Download failed. A release with CSGO-Demo-Highlights-portable.zip must exist at:
  echo   https://github.com/3388888/cc-demo-highlights/releases
  echo.
  pause & exit /b 1
)

echo [2/3] Unpacking...
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%" 2>nul
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%DEST%' -Force"
if errorlevel 1 ( echo   Unpack failed. & pause & exit /b 1 )
del "%ZIP%" 2>nul

set "EXE=%DEST%\%APP%.exe"
if not exist "%EXE%" for /r "%DEST%" %%F in ("%APP%.exe") do set "EXE=%%F"
if not exist "%EXE%" ( echo   Could not find %APP%.exe after unpacking. & pause & exit /b 1 )

echo [3/3] Creating desktop shortcut...
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\%APP%.lnk'); $s.TargetPath='%EXE%'; $s.WorkingDirectory=Split-Path '%EXE%'; $s.Save()"

echo.
echo   Done. A "%APP%" shortcut is on your desktop. Launching...
start "" "%EXE%"
endlocal
