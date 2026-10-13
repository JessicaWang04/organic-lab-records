@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Host none -InstallDependencies %*
set "LAB_SETUP_EXIT=%ERRORLEVEL%"
if not "%LAB_SETUP_EXIT%"=="0" echo Setup failed. Review the message above.
pause
exit /b %LAB_SETUP_EXIT%
