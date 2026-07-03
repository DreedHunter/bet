# install.ps1 - setup una tantum dell'auto-updater (Approccio A)
# - clona/aggiorna il repo in una cartella locale
# - scrive config.json
# - registra uno Scheduled Task che avvia updater.ps1 al logon (sempre attivo)
# - (opzionale) apre Chrome con l'estensione caricata
#
# Uso:  powershell -ExecutionPolicy Bypass -File install.ps1
# NB: file in puro ASCII (niente trattini lunghi) per compatibilita' parser PS 5.1.

param(
  [string]$RepoUrl     = "https://github.com/DreedHunter/bet.git",
  [string]$RepoDir     = "C:\GBFB\bet",
  [string]$ExtSubdir   = "extension",
  [string]$Branch      = "main",
  [int]   $IntervalSeconds = 300,
  [bool]  $AutoRestartChrome = $false,
  [string]$ChromeExe   = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [switch]$LaunchNow
)

$ErrorActionPreference = "Stop"

function Say($m, $c = "Cyan") { Write-Host $m -ForegroundColor $c }

# Esegue git senza farsi ingannare da PS 5.1 (git scrive su stderr anche i messaggi
# normali). Non lanciamo eccezioni sullo stderr: controlliamo il vero exit code.
function RunGit {
  param([string[]]$GitArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & git @GitArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) {
    throw ("git " + ($GitArgs -join " ") + " ha fallito (exit " + $code + "): " + ($out -join " "))
  }
  return $out
}

# 1) git presente?
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "git non trovato nel PATH. Installa Git for Windows." Red; exit 1
}

# 2) chrome presente?
if (-not (Test-Path $ChromeExe)) {
  $alt = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  if (Test-Path $alt) { $ChromeExe = $alt }
  else { Say "chrome.exe non trovato. Passa -ChromeExe col percorso giusto." Red; exit 1 }
}

# 3) clona o aggiorna il repo
if (Test-Path (Join-Path $RepoDir ".git")) {
  Say ("Repo gia presente in " + $RepoDir + ", aggiorno...")
  Set-Location $RepoDir
  RunGit @("fetch","origin",$Branch) | Out-Null
  RunGit @("checkout",$Branch)       | Out-Null
  RunGit @("pull","origin",$Branch)  | Out-Null
} else {
  Say ("Clono " + $RepoUrl + " in " + $RepoDir + " ...")
  $parent = Split-Path -Parent $RepoDir
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  RunGit @("clone","--branch",$Branch,$RepoUrl,$RepoDir) | Out-Null
}

# verifica che il clone/aggiornamento sia andato davvero a buon fine
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
  Say ("ERRORE: repo non presente in " + $RepoDir + " dopo il clone. Interrompo.") Red
  exit 1
}

$extPath = Join-Path $RepoDir $ExtSubdir
if (-not (Test-Path (Join-Path $extPath "manifest.json"))) {
  Say ("ATTENZIONE: manifest.json non trovato in " + $extPath + " - controlla ExtSubdir.") Yellow
}

# 4) scrivi config.json (letto da updater.ps1) DENTRO il repo clonato
$updaterDir = Join-Path $RepoDir "autoupdater"
if (-not (Test-Path $updaterDir)) { New-Item -ItemType Directory -Path $updaterDir -Force | Out-Null }
$cfg = [ordered]@{
  repoDir            = $RepoDir
  extSubdir          = $ExtSubdir
  branch             = $Branch
  intervalSeconds    = $IntervalSeconds
  chromeExe          = $ChromeExe
  autoRestartChrome  = $AutoRestartChrome
}
($cfg | ConvertTo-Json) | Set-Content -Path (Join-Path $updaterDir "config.json") -Encoding utf8
Say ("config.json scritto in " + $updaterDir + ".")

# 5) registra lo Scheduled Task (avvio al logon, sempre attivo)
$taskName = "GBFB-AutoUpdater"
$updater  = Join-Path $updaterDir "updater.ps1"
if (-not (Test-Path $updater)) { Say ("ATTENZIONE: updater.ps1 non trovato in " + $updaterDir) Yellow }
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
              -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"" + $updater + "`"")
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Auto-updater estensione Goldbet Fast Bet" -Force | Out-Null
Say ("Scheduled Task '" + $taskName + "' registrato (parte a ogni login).") Green

# 6) avvia subito l'updater
Start-ScheduledTask -TaskName $taskName
Say "Updater avviato." Green

# 7) opzionale: apri Chrome con l'estensione caricata
if ($LaunchNow) {
  Say "Apro Chrome con l'estensione..."
  Start-Process $ChromeExe -ArgumentList ("--load-extension=`"" + $extPath + "`"")
}

Say ""
Say "===== INSTALLAZIONE COMPLETATA =====" Green
Say ("Estensione (sorgente live): " + $extPath)
Say ("Log updater:                " + (Join-Path $updaterDir "updater.log"))
Say ""
Say "IMPORTANTE (prima volta): carica l'estensione in Chrome una volta manualmente:" Yellow
Say "  1) chrome://extensions  ->  attiva 'Modalita sviluppatore'"
Say ("  2) 'Carica estensione non pacchettizzata'  ->  seleziona:  " + $extPath)
Say "Da li in poi l'updater tiene la cartella aggiornata e l'estensione si ricarica da sola."
