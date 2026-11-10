@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0src\setup-entry.mjs" %*
set "result=%errorlevel%"
pause
exit /b %result%
