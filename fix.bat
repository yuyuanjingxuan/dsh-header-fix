@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=apply"

echo ============================================
echo  DeepSeek Harness startup fix
echo  desktop welcome: Web authentication failed
echo ============================================
echo.

rem Locate the install directory. The uninstall registry key is the reliable
rem source; the default path is only a fallback.
set "HOME="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" /d 2^>nul ^| findstr /i "InstallLocation"') do (
    if not defined HOME set "HOME=%%B"
)
if defined HOME (
    set "HOME=!HOME:REG_SZ=!"
    for /f "tokens=* delims= " %%C in ("!HOME!") do set "HOME=%%C"
)
if not defined HOME (
    if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar" (
        set "HOME=%LOCALAPPDATA%\Programs\DeepSeek Harness"
    )
)
if not defined HOME (
    echo [error] Could not find the DeepSeek Harness install directory.
    echo         Pass it explicitly: fix.bat %ACTION% "C:\path\to\DeepSeek Harness"
    goto :end
)
if not "%~2"=="" set "HOME=%~2"

if not exist "%HOME%\resources\app.asar" (
    echo [error] No resources\app.asar under %HOME%
    goto :end
)

rem Use the Node runtime that ships with the app, so nothing has to be installed.
set "NODE=%HOME%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
    echo [error] Bundled Node runtime not found:
    echo         %NODE%
    goto :end
)

echo Install dir: %HOME%
echo Action     : %ACTION%
echo.

"%NODE%" "%SCRIPT_DIR%patch.mjs" %ACTION% "%HOME%"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo Failed with exit code %RC%
pause >nul

:end
endlocal
