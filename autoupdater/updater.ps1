# updater.ps1 — auto-updater estensione Goldbet Fast Bet (Approccio A: git pull + reload Chrome)
# Gira in loop: controlla il repo, quando c'è un nuovo commit che tocca extension/
# aggiorna la cartella locale e (se serve) ricarica Chrome.
#
# Config via config.json nella stessa cartella (creato da install.ps1).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root "config.json"

if (-not (Test-Path $cfgPath)) {
  Write-Host "config.json mancante — esegui prima install.ps1" -ForegroundColor Red
  exit 1
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json

$RepoDir     = $cfg.repoDir                       # es. C:\GBFB\bet
$ExtSubdir   = $cfg.extSubdir                     # es. license_system\extension
$Branch      = $cfg.branch                        # es. main
$IntervalSec = [int]$cfg.intervalSeconds          # es. 300
$ChromeExe   = $cfg.chromeExe
$AutoRestart = [bool]$cfg.autoRestartChrome        # se true riavvia Chrome quando l'estensione cambia
$LogFile     = Join-Path $root "updater.log"

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

# git robusto: non tratta lo stderr informativo di git come errore terminante
function RunGit {
  param([string[]]$GitArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & git @GitArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw ("git " + ($GitArgs -join " ") + " (exit $code): " + ($out -join " ")) }
  return $out
}

function Restart-Chrome {
  Log "Riavvio Chrome per applicare l'aggiornamento estensione..."
  $procs = Get-Process chrome -ErrorAction SilentlyContinue
  if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
  # riapre Chrome caricando l'estensione unpacked dalla cartella aggiornata
  $extPath = Join-Path $RepoDir $ExtSubdir
  Start-Process $ChromeExe -ArgumentList "--load-extension=`"$extPath`""
  Log "Chrome riavviato con estensione da: $extPath"
}

Log "===== Auto-updater avviato (branch=$Branch, ogni ${IntervalSec}s, autoRestart=$AutoRestart) ====="

while ($true) {
  try {
    Set-Location $RepoDir

    # versione locale prima del pull
    $before = (RunGit @("rev-parse","HEAD")).Trim()

    # scarica gli aggiornamenti remoti
    RunGit @("fetch","origin",$Branch) | Out-Null
    $remote = (RunGit @("rev-parse","origin/$Branch")).Trim()

    if ($before -ne $remote) {
      Log "Nuovo commit rilevato: $($before.Substring(0,7)) -> $($remote.Substring(0,7))"

      # cosa cambia in extension/ tra locale e remoto?
      $changed = RunGit @("diff","--name-only","HEAD","origin/$Branch","--",$ExtSubdir)
      RunGit @("pull","origin",$Branch) | Out-Null
      $after = (RunGit @("rev-parse","HEAD")).Trim()
      Log "Pull completato -> $($after.Substring(0,7))"

      if ($changed) {
        Log ("Estensione aggiornata. File cambiati: " + ($changed -join ", "))
        if ($AutoRestart) {
          Restart-Chrome
        } else {
          Log "autoRestartChrome=false: riavvia Chrome manualmente per applicare."
        }
      } else {
        Log "Commit non tocca l'estensione (solo backend/dashboard). Nessun reload."
      }
    }
  }
  catch {
    Log ("ERRORE: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $IntervalSec
}
