# install.ps1 — setup una tantum dell'auto-updater (Approccio A)
# - clona/aggiorna il repo in una cartella locale
# - scrive config.json
# - registra un Scheduled Task che avvia updater.ps1 al logon (sempre attivo)
# - (opzionale) apre Chrome con l'estensione caricata
#
# Uso:  powershell -ExecutionPolicy Bypass -File install.ps1
#       parametri opzionali per personalizzare (vedi sotto)

param(
  [string]$RepoUrl     = "https://github.com/DreedHunter/bet.git",
  [string]$RepoDir     = "C:\GBFB\bet",
  [string]$ExtSubdir   = "extension",          # path dell'estensione dentro il repo
  [string]$Branch      = "main",
  [int]   $IntervalSeconds = 300,              # controlla ogni 5 min
  [bool]  $AutoRestartChrome = $false,         # false = non ti chiude Chrome mentre giochi
  [string]$ChromeExe   = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [switch]$LaunchNow                            # apri subito Chrome con l'estensione
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m, $c = "Cyan") { Write-Host $m -ForegroundColor $c }

# 1) git presente?
$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) { Say "git non trovato nel PATH. Installa Git for Windows." Red; exit 1 }

# 2) chrome presente?
if (-not (Test-Path $ChromeExe)) {
  $alt = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  if (Test-Path $alt) { $ChromeExe = $alt }
  else { Say "chrome.exe non trovato. Passa -ChromeExe col percorso giusto." Red; exit 1 }
}

# 3) clona o aggiorna il repo
if (Test-Path (Join-Path $RepoDir ".git")) {
  Say "Repo gia presente in $RepoDir — aggiorno..."
  Set-Location $RepoDir
  & git fetch origin $Branch --quiet
  & git checkout $Branch --quiet
  & git pull origin $Branch --quiet
} else {
  Say "Clono $RepoUrl in $RepoDir ..."
  $parent = Split-Path -Parent $RepoDir
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  & git clone --branch $Branch $RepoUrl $RepoDir
}

$extPath = Join-Path $RepoDir $ExtSubdir
if (-not (Test-Path (Join-Path $extPath "manifest.json"))) {
  Say "ATTENZIONE: manifest.json non trovato in $extPath — controlla ExtSubdir." Yellow
}

# 4) scrivi config.json (letto da updater.ps1)
$cfg = [ordered]@{
  repoDir            = $RepoDir
  extSubdir          = $ExtSubdir
  branch             = $Branch
  intervalSeconds    = $IntervalSeconds
  chromeExe          = $ChromeExe
  autoRestartChrome  = $AutoRestartChrome
}
$cfgJson = $cfg | ConvertTo-Json
Set-Content -Path (Join-Path $scriptDir "config.json") -Value $cfgJson -Encoding utf8
Say "config.json scritto."

# 5) registra lo Scheduled Task (avvio al logon, sempre attivo)
$taskName  = "GBFB-AutoUpdater"
$updater   = Join-Path $scriptDir "updater.ps1"
$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
              -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$updater`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Auto-updater estensione Goldbet Fast Bet" -Force | Out-Null
Say "Scheduled Task '$taskName' registrato (parte a ogni login)." Green

# 6) avvia subito l'updater in background
Start-ScheduledTask -TaskName $taskName
Say "Updater avviato." Green

# 7) opzionale: apri Chrome con l'estensione caricata
if ($LaunchNow) {
  Say "Apro Chrome con l'estensione..."
  Start-Process $ChromeExe -ArgumentList "--load-extension=`"$extPath`""
}

Say ""
Say "===== INSTALLAZIONE COMPLETATA =====" Green
Say "Estensione (sorgente live): $extPath"
Say "Log updater:                $(Join-Path $scriptDir 'updater.log')"
Say ""
Say "IMPORTANTE (prima volta): carica l'estensione in Chrome una volta manualmente:" Yellow
Say "  1) chrome://extensions  ->  attiva 'Modalita sviluppatore'"
Say "  2) 'Carica estensione non pacchettizzata'  ->  seleziona:  $extPath"
Say "Da li in poi l'updater tiene la cartella aggiornata; per applicare un update"
Say "chiude/riapre Chrome (se autoRestartChrome=true) oppure ricarichi tu l'estensione."
