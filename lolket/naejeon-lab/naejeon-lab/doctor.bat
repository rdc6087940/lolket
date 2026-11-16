@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup.bat first & pause & exit /b)
set PY=.venv\Scripts\python.exe
set /p RID=Name#Tag or deeplol puuid: 
%PY% -m lab doctor "%RID%"
pause
