@echo off
setlocal EnableExtensions
rem Build the portable zip that install.cmd downloads. Run `npm run dist` first.
set "ROOT=%~dp0"
set "SRC=%ROOT%dist\win-unpacked"
set "OUT=%ROOT%dist\CSGO-Demo-Highlights-portable.zip"

if not exist "%SRC%" (
  echo No dist\win-unpacked found. Build it first:
  echo    npm run dist
  pause & exit /b 1
)
if exist "%OUT%" del "%OUT%"

echo Zipping the portable build - this takes a minute for ~400 MB...
powershell -NoProfile -Command "Compress-Archive -Path '%SRC%\*' -DestinationPath '%OUT%' -Force"
if errorlevel 1 ( echo Zip failed. & pause & exit /b 1 )

echo.
echo Done:  %OUT%
echo.
echo Upload it to a GitHub release so install.cmd can fetch it, e.g.:
echo    gh release create v1.0.1 "%OUT%" "%ROOT%dist\CSGO Demo Highlights Setup 1.0.1.exe" -t "v1.0.1" -n "portable + installer"
echo (or drag it into the Releases page in your browser)
endlocal
