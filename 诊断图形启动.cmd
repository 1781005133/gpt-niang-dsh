@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
set NODE_OPTIONS=
set ELECTRON_RUN_AS_NODE=1
if not exist "%~dp0audit" mkdir "%~dp0audit"
set "log=%~dp0audit\manual-gui-console.log"
start "" /wait /b "%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0tools\diagnose-gui.mjs" >"%log%" 2>&1
set "result=%errorlevel%"
chcp 65001 >nul
if exist "%log%" type "%log%"
echo.
if "%result%"=="0" (
  echo GUI RESULT: PASS
) else (
  echo GUI RESULT: FAILED
  echo Exit code: %result%
)
echo.
echo This test creates a HIDDEN window. No installation or security changes.
echo Please copy the GUI RESULT line above.
pause
exit /b %result%
