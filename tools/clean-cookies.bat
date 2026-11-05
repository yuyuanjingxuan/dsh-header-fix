@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
set "HOME="
set "ARGS="

rem --dry-run goes to the script, anything else is treated as the install dir.
for %%A in (%*) do (
    if /i "%%~A"=="--dry-run" (
        set "ARGS=--dry-run"
    ) else (
        set "HOME=%%~A"
    )
)

if not defined HOME (
    for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" /d 2^>nul ^| findstr /i "InstallLocation"') do (
        if not defined HOME set "HOME=%%B"
    )
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
    echo         Pass it explicitly: clean-cookies.bat "C:\path\to\DeepSeek Harness"
    goto :end
)

set "NODE=%HOME%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
    echo [error] Bundled Node runtime not found:
    echo         %NODE%
    goto :end
)

echo ============================================
echo  DeepSeek Harness cookie cleanup
echo ============================================
echo.

"%NODE%" "%SCRIPT_DIR%clean-cookies.mjs" %ARGS%
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo Failed with exit code %RC%
pause >nul

:end
endlocal
