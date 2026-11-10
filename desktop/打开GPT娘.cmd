@echo off
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0src\setup-entry.mjs" --open
if errorlevel 1 pause
