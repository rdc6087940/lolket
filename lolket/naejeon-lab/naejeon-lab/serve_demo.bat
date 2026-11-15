@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup.bat first & pause & exit /b)
set PY=.venv\Scripts\python.exe
start "" http://127.0.0.1:8787
%PY% -m lab --config config.demo.yaml serve
