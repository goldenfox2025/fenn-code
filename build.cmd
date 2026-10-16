@echo off
rem One-step local build for Windows: double-click, or run "build.cmd -Installer" / "build.cmd -Run".
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set code=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %code%
