@echo off
setlocal EnableExtensions
rem Build the single-file console edition, and UPX-compress it if upx is available.
set "ROOT=%~dp0"
set "OUT=%ROOT%CSGO-Highlights-Console.exe"

echo Building console edition...
pushd "%ROOT%native\cli"
go build -ldflags="-s -w" -trimpath -o "%OUT%" .
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo Go build failed. & pause & exit /b 1 )

rem find upx: next to this script, else on PATH
set "UPX="
if exist "%ROOT%upx.exe" set "UPX=%ROOT%upx.exe"
if not defined UPX where upx >nul 2>nul && set "UPX=upx"

if not defined UPX goto noupx
echo Compressing with UPX...
"%UPX%" --best --lzma "%OUT%"
goto size

:noupx
echo.
echo   UPX not found - exe is the full ~14 MB. To shrink it to ~3.5 MB:
echo     1) download upx.exe:  https://github.com/upx/upx/releases  (win64 zip)
echo     2) drop upx.exe next to this script (or put it on PATH) and re-run build-console.cmd
echo.

:size
for %%F in ("%OUT%") do set /a MB=%%~zF/1048576
echo.
echo Done:  %OUT%  (~%MB% MB)
endlocal
