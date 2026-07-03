@echo off
REM ============================================================
REM  GBFB Auto-Updater — installer one-click (si auto-eleva ad admin)
REM  Doppio click: chiede l'elevazione UAC, scarica install.ps1 e fa tutto.
REM ============================================================
setlocal

REM --- 1) auto-elevazione ad amministratore ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Richiedo i privilegi di amministratore...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ==========================================================
echo   GBFB Auto-Updater - Installazione (admin OK)
echo ==========================================================
echo.

REM --- 2) scarica l'ultima install.ps1 da GitHub ---
if not exist "C:\GBFB" mkdir "C:\GBFB"

echo Scarico install.ps1 dal repo...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/DreedHunter/bet/main/autoupdater/install.ps1' -OutFile 'C:\GBFB\install.ps1'"

if not exist "C:\GBFB\install.ps1" (
  echo ERRORE: download di install.ps1 fallito. Controlla la connessione.
  pause
  exit /b 1
)

REM --- 3) esegui l'installer ---
echo Eseguo l'installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GBFB\install.ps1"

echo.
echo ==========================================================
echo   Fatto. Ora carica l'estensione in Chrome UNA volta:
echo     1) chrome://extensions  -^>  Modalita sviluppatore ON
echo     2) Carica estensione non pacchettizzata
echo     3) seleziona:  C:\GBFB\bet\extension
echo ==========================================================
echo.
pause
