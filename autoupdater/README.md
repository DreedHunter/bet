# GBFB Auto-Updater (Windows)

Agente Windows sempre attivo che tiene aggiornata l'estensione **Goldbet Fast Bet**
sui tuoi PC. Quando fai un push su GitHub che tocca `extension/`, l'agente scarica
il codice nuovo e l'estensione si ricarica **da sola, senza riavviare Chrome**.

> Pensato per i **tuoi PC** (installazione unpacked). Approccio A: `git pull` + reload.

## Come funziona (2 pezzi che collaborano)

1. **`updater.ps1`** (questo agente, gira su Windows): ogni 5 min fa `git fetch`;
   se c'è un commit nuovo che tocca `extension/`, fa `git pull` → i file nuovi
   finiscono su disco in `C:\GBFB\bet\extension`.

2. **`background.js`** (dentro l'estensione): ogni 3 min confronta la versione
   **in memoria** con quella del `manifest.json` **su disco**. Dopo il pull, il disco
   è più recente → il service worker chiama `chrome.runtime.reload()`, che per le
   estensioni unpacked **rilegge il codice dal disco**. Nuova versione live, zero
   riavvii di Chrome.

Il trucco: `chrome.runtime.reload()` da service worker ricarica dal disco. L'updater
mette i file giusti su disco; l'estensione si accorge e si ricarica.

## Installazione (una tantum, sul PC)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Parametri utili (tutti opzionali):

| Param | Default | Cosa |
|-------|---------|------|
| `-RepoDir` | `C:\GBFB\bet` | dove clonare il repo |
| `-IntervalSeconds` | `300` | ogni quanto controlla GitHub |
| `-AutoRestartChrome` | `$false` | se `$true`, riavvia Chrome invece di affidarsi al self-reload |
| `-LaunchNow` | (off) | apre subito Chrome con l'estensione |

L'installer: clona il repo, scrive `config.json`, registra lo Scheduled Task
`GBFB-AutoUpdater` (parte a ogni login) e lo avvia.

**Solo la primissima volta** devi caricare l'estensione a mano in Chrome:
`chrome://extensions` → Modalità sviluppatore → *Carica estensione non pacchettizzata*
→ scegli `C:\GBFB\bet\extension`. Da lì in poi è automatico.

## Workflow di release (dal tuo PC di sviluppo)

1. Modifica il codice dell'estensione
2. **Bump versione** in `extension/manifest.json` (`"version"`) e
   `extension/fastbet.js` (`APP_VERSION`) — devono combaciare
3. `git commit` + `git push`
4. Entro ~5 min ogni PC fa il pull; entro ~3 min l'estensione si autoricarica
5. (opzionale) pubblica la versione nella dashboard per il banner ai clienti manuali

> Il reload scatta perché la versione del manifest **aumenta**. Se pushi codice
> senza bumpare la versione, i file si aggiornano ma l'estensione non si ricarica
> da sola fino al prossimo bump (o riavvio di Chrome).

## Gestione

```powershell
Get-ScheduledTask GBFB-AutoUpdater                 # stato
Start-ScheduledTask GBFB-AutoUpdater               # avvia
Stop-ScheduledTask  GBFB-AutoUpdater               # ferma
Unregister-ScheduledTask GBFB-AutoUpdater -Confirm:$false   # rimuovi
Get-Content .\updater.log -Tail 30                 # log
```

## Limiti onesti

- Solo estensioni **unpacked** su PC che controlli tu (nessuna firma .crx).
- Il self-reload richiede che la **versione del manifest aumenti** a ogni release.
- Se preferisci non affidarti al self-reload, metti `-AutoRestartChrome $true`:
  l'updater chiude e riapre Chrome caricando l'estensione (ti chiude le tab aperte).
- `chrome.runtime.reload()` riavvia il service worker e ricarica i content script
  alla successiva navigazione/refresh della pagina Goldbet.
