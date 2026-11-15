@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
where python >nul 2>nul || (echo Python not found. Install Python 3.11+ with "Add to PATH". & pause & exit /b)
if not exist .venv python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if not exist config.yaml copy config.example.yaml config.yaml
if not exist .env copy .env.example .env
if not exist members.txt copy members.example.txt members.txt
echo.
echo Done. Edit .env (RIOT_API_KEY) and members.txt, then run doctor.bat
pause
