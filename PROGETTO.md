# PROGETTO Fast Bet — memoria generale per copilot

> Questo file è la "memoria condivisa" del progetto. Se sei un copilot che apre questo repo
> su un altro PC, **leggi tutto questo prima di lavorare**: contiene lo stato, le scoperte,
> cosa è stato provato e cosa NON funziona (per non rifare strade morte). Aggiornalo quando
> scopri cose nuove. L'utente è **Sergio**; parla italiano; è pratico, diretto, vuole risultati
> concreti e onestà sui limiti (niente promesse gonfiate).

---

## 1. Cos'è il progetto

Suite di **estensioni Chrome (Manifest V3)** per bookmaker italiani AAMS/ADM, il cui scopo è
**velocizzare il piazzamento delle scommesse live** e **analizzare/confrontare i tempi dei book**.
Più un **backend Node.js + dashboard admin** (sistema licenze + download + statistiche) deployato
su **Railway** (repo git in `license_system/`, push su `main` → deploy automatico).

Obiettivo attuale (2026): raccogliere dati sui **tempi reali di piazzamento** dei vari book per
capire **chi è più veloce su quali partite**, e costruire estensioni dove è tecnicamente possibile.

## 2. LA REGOLA CHIAVE scoperta (fondamentale)

Il ritardo di piazzamento live (betdelay) **NON viene dalla registrazione ADM/Sogei** (il
totalizzatore nazionale valida in tempo reale). Viene dal **trading layer / risk-management**:

- **Piattaforme con trading proprietario integrato** (GAD/Lottomatica, Kambi, bet365) → conferma
  in ~1-2s, il polling è cosmetico → **MOCKABILE / veloce**.
- **Piattaforme che passano da MTS Sportradar o managed-trading** (Altenar, xSport, Eurobet) →
  betdelay server-side 10-22s imposto → **NON aggirabile dal client**.

**Test di screening**: se la conferma live torna in ~1-2s con polling cosmetico → buono. Se resta
"pending" 10-22s con attesa server (ticket non ancora esistente) → da scartare.

Su xSport il ticket (`ticketSogei`) **non esiste** finché ADM non finisce → mockare l'attesa
sarebbe mentire (credi di aver giocato ma non è vero). Su GAD invece il `couponCode` arriva SUBITO
con l'insertBet → il pendingBet è mockabile.

## 3. Stato dei bookmaker analizzati

| Book | Piattaforma | Velocità live | Stato | Note |
|---|---|---|---|---|
| **Goldbet/Lottomatica/Planetwin** | GAD/Lottomatica (Angular) | ~2,4s | ✅ FUNZIONANTE | insertBet+pendingBet, mock del pendingBet OK. Multibook (ID condivisi). |
| **William Hill** | xSport (ADM/Sogei) | live 12s / interv. 8,5s / prematch 0,4s | ✅ auto-click DOM | betdelay non azzerabile. Estensione velocizza l'INVIO. |
| **Bwin** | Entain proprietaria (cds-api) | ~4s | vicolo cieco ma veloce | place (torna solo requestId) -> ~4s -> querystatus. Pending fino al querystatus = risk Entain, NON mockabile. Ma 2o piu veloce dopo Goldbet. Payload leggibile -> estensione che velocizza l invio fattibile. |
| **Betzone** | PHP/jQuery (JWT, Pusher) | ~13s | ✅ parziale (client) | elimina ritardi client, riserva server non comprimibile. |
| **BelBet360** | PHP/jQuery (ajax.php) | ~10s | ⏳ in analisi | mock checkForCouponApproval, non confermato (serviva credito). |
| **BetNewEra24** | React (api.xcodetec.com) | ~14s | ⏳ in analisi | mock /coupon/check, non confermato. |
| **Fastbet** | Altenar (biahosted) | 22s (prematch 0,5s) | ❌ vicolo cieco | placeWidget sincrono, status 17. 9 varianti testate, rifiutate. |
| **NetBet** | xSport | ~14s | ❌ vicolo cieco | ticketSogei null fino alla fine, non mockabile. |
| **Vincitù** | xSport | ~6-10s | ❌ vicolo cieco | delay dichiarato dal server, attesa reale. |
| **Eurobet** | proprietaria (sport-sale-service) | ~12s | ❌ vicolo cieco | 1 chiamata bloccante, no polling da tagliare. Leva: multipla azzera il delay. |
| **Sportium** | Playtech | ? | ⬜ non iniziato | solo pagina salvata, da sniffare. |

**Vicoli ciechi confermati** (NON riprovare senza motivo): Fastbet, NetBet, Vincitù, Eurobet.
Eurobet/Vincitu erano già segnati morti prima.

## 4. Esperimenti fatti e ESITI (per non ripeterli)

- **"Live come prematch"** (forzare `isLive:false` nel payload) — testato su:
  - **Fastbet**: RIFIUTATA. Il server controlla lo stato reale dell'evento (id), non il flag.
  - **William Hill**: RIFIUTATA con **code -5105** (script `william/test_live_as_prematch.js`).
  - **Betzone**: FALLITO ("evento_LIVE_chiuso").
  → **Su tutte le piattaforme il server verifica lo stato reale. Strada chiusa ovunque.**
- **Mock del delay** (riscrivere `delay:10 → delay:1` nella risposta xSport): INUTILE. Il delay è
  descrittivo, non prescrittivo — il ticket arriva quando ADM finisce, non quando lo dici tu.
- **API diretta su William Hill** (costruire la purchase a mano): RIFIUTATA **code -2007**
  (validazione payload). Soluzione: auto-click DOM (fa costruire il payload al sito).
- **Betdelay variabile scoperto** (William Hill): live 10s, **intervallo 7s** (~8,5s reali),
  prematch 0s. Il server abbassa il delay quando la partita è ferma (meno rischio). → Leva:
  **tempismo** (giocare nei momenti calmi).
- **Multibook Goldbet-group**: i 3 book condividono `evtId/selId/markId/aamsId`, solo `oddsId`
  differisce → replica di gruppo SENZA traduzione. La replica usa l'importo REALE giocato su
  Goldbet (payload.totalStake), non il campo dell'estensione.
- **Storni Goldbet** (75€ e 52€): la giocata viene accettata in riserva (addebito), poi stornata
  in ~15s se la selezione era sospesa (`ms:0` nel feed) o la quota era vecchia (UI mostra 20, server
  ha 7.5). NON è un bug: è betdelay server che rifiuta selezioni non più bancabili. Da qui la
  "guardia anti-storno" (non bloccante) nell'estensione Lottomatica.

## 5. Ricerca book veloci (10 agenti, luglio 2026 — cartella `agenti/`)

Candidati promettenti MAI ancora sniffati (potrebbero essere veloci/mockabili):
- **Snai** (Playtech): doc API mostra `PENDING_ACCEPTANCE` + polling = pattern come Goldbet. ALTA priorità.
- **Better / Totosì**: STESSO motore GAD di Goldbet → probabilmente già coperti dall'estensione esistente (basta aggiungere il dominio). ALTA.
- **Bet365**: piattaforma Erlang proprietaria, la più veloce. Betfair/Betflag **Exchange**: istantanei (matching peer-to-peer).
- **888sport / LeoVegas** (Kambi): dynamic bet delay ~1s, no MTS.
- **Betitaly/Domusbet/Elabet** (Microgame): piattaforma italiana mai vista, 3 book insieme.

Vedi `agenti/RISULTATI_RICERCA.md`, `agenti/ELENCO_ADM_ufficiale_2025.md`, `agenti/book_trovati/*.json`.

## 6. Struttura del repo (root `eurob/`)

### Estensioni (cartella = estensione unpacked; ognuna ha `manifest.json` + `fastbet.js`/`content.js` + `DOC.md`)
- `lottomatica_group_fast_bet/` — **la principale (v9.9)**: Goldbet+Lottomatica+Planetwin unificata,
  multibook, hotkey, mock pendingBet, guardia anti-storno, misura latenza, re-login automatico
  (sessione sempre attiva), raccolta tempi al backend. GAD/Angular.
- `williamhill_fast_bet/` — **(v4.5)** auto-click DOM, hotkey Casa/Ospite + Gol 1°T, palette nero/oro.
- `goldbet_fast_bet_v6.4/`, `lottomatica_fast_bet/`, `planetwin_fast_bet/` — versioni SINGOLE (vecchie, GAD).
- `belbet360_fast_bet/`, `betnewera24_fast_bet/` — mock costruiti, non confermati.
- `eurobet_fast_bet/` — test/analisi (vicolo cieco).
- `betzone/betfast-extension/` — BetFast (funzionante lato client).
- `checktimes/goldbet_betradar_sync/` — strumento timing Goldbet↔Betradar (NON un fast bet).
- `rest_sniffer/` — **STRUMENTO DI ANALISI (v1.1)**: cattura tutto il traffico REST di qualsiasi
  sito, con filtro anti-rumore, evidenzia i piazzamenti lenti, estrae il delay server, riconosce la
  piattaforma. È l'attrezzo con cui si fanno TUTTI gli sniff. Installalo per analizzare un book nuovo.

### Backend + dashboard
- `license_system/` — **repo git** (push → Railway). `backend/server.js` (node:http a mano),
  `backend/db.js` (node:sqlite). Dashboard admin in `dashboard/`. `release.mjs` zippa le estensioni
  (REGISTRY con id stabili) in `backend/downloads/` + `versions.json`. Password admin di default
  in server.js (`ADMIN_PASSWORD`, cambiabile via env).
  - Tabelle nuove: `book_stats` (velocità per book, editabile da dashboard), `bet_timings`
    (raccolta automatica dei tempi reali dalle estensioni via `POST /api/timing`).
  - Dashboard: sezione **"Velocità book"** (classifica + tabella editabile + medie reali) +
    placeholder **"Partite giocate"** (futuro).

### Sniff e analisi (materiale grezzo, NON estensioni)
- `william/`, `fastbet/`, `NETBET/` — pagine salvate + file di sniff dei rispettivi book.
- `agenti/` — risultati della ricerca book veloci (10 agenti).
- `_archivio/`, `_analisi_bookmaker/`, `_documenti/`, `_sorgenti_lottomatica_group/` — materiale storico.

## 7. Convenzioni operative

- **Ogni release**: bump versione in 3 punti dell'estensione (manifest.json `version`,
  `APP_VERSION` nel js, banner GUI `vX.Y`), poi `node release.mjs <id> "changelog"` da `license_system/`,
  poi `git add` degli zip+versions.json, commit, `git push origin main` (deploy Railway).
- Git: SOLO in `license_system/`. Il sorgente delle estensioni sta FUORI dal git (in `eurob/`),
  finisce solo dentro gli zip di release.
- Le estensioni girano in **MAIN world** (intercettano XHR/fetch) + a volte ISOLATED (bridge) +
  background (service worker). Login bookmaker DEVE essere same-origin (Akamai blocca il background).
- Chrome only (Manifest V3). Su Mac serve Chrome, NON Safari (richiederebbe conversione Xcode).
- Auto-update codice: Chrome NON lo permette per estensioni unpacked. Idea in sospeso: config
  remota + avviso-download. Vedi memory `idea-auto-update-estensione`.

## 8. Come continuare (per il copilot)

1. Per analizzare un **book nuovo**: installa `rest_sniffer`, fai una giocata reale, esporta lo
   sniff, studia il flusso di piazzamento. Cerca: la chiamata di piazzamento, se il ticket/conferma
   arriva SUBITO (mockabile) o dopo polling con delay (server-side).
2. Applica la **regola sez. 2** per capire se è aggirabile.
3. Se GAD/Lottomatica → probabilmente basta aggiungere il dominio all'estensione esistente.
4. Se veloce/nuova piattaforma → vale una nuova estensione. Se xSport/Altenar/Eurobet → vicolo cieco.
5. **Non promettere di azzerare i secondi del server** se è xSport/Altenar: è disonesto e non funziona.
   Puoi solo velocizzare l'invio dell'utente e sfruttare il tempismo.
6. Aggiorna questo file e i memory quando scopri cose nuove.

_Ultimo aggiornamento: luglio 2026._
