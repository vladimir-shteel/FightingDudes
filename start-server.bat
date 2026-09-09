@echo off
setlocal
cd /d "%~dp0"

set PORT=8080

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found in PATH. Install Python or add it to PATH, then try again.
  echo.
  pause
  exit /b 1
)

echo Starting local server for FightingDudes at http://localhost:%PORT%/
echo Press Ctrl+C to stop the server.
echo.

python -m http.server %PORT%

echo.
echo Server stopped.
pause
