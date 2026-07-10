# Fast Bet — Sistema Licenze (prototipo locale)

Backend + dashboard per gestire utenti, attivare/disattivare il prodotto **Fast Bet**
per ciascun cliente, e vedere il loro utilizzo. Tutto in locale, zero dipendenze esterne
(usa SQLite e crypto nativi di Node 22).

## Struttura

```
license_system/
├── backend/
│   ├── server.js     API REST (http nativo, porta 4000)
│   ├── db.js         database SQLite + funzioni
│   ├── package.json
│   └── licenses.db   (creato al primo avvio)
└── dashboard/
    ├── index.html    pannello admin (giallo/blu)
    └── app.js
```

## Avvio

Requisito: **Node 22+** (per SQLite nativo).

```bash
cd license_system/backend
node --experimental-sqlite server.js
```

Poi apri **http://localhost:4000/** nel browser → dashboard admin.

Password admin iniziale: **`admin123`** (cambiala in `server.js`, variabile `ADMIN_PASSWORD`).

## Come si usa (flusso)

1. **Accedi** alla dashboard con la password admin
2. **Crea un utente**: email + password + account Goldbet + nota → diventa un cliente
3. L'utente parte **disattivato**. Clicca **Attiva** per abilitargli Fast Bet
4. **Lega gli account Goldbet** (pulsante "Account GB"): il plugin si apre SOLO se
   l'utente loggato su Goldbet è in questa lista. Lista vuota = plugin bloccato.
5. Dai al cliente le sue **credenziali** (email + password)
6. Il cliente le inserisce nel plugin → il plugin legge lo username Goldbet dalla
   pagina e chiede al backend se è attivo **e** autorizzato per quell'account
7. Puoi **Disattivare** in qualsiasi momento → il plugin si blocca al successivo check
8. **Log**: vedi gli eventi di ogni cliente (login, check, giocate) con l'account GB usato

## API (per collegare il plugin)

| Endpoint | Metodo | Cosa fa |
|----------|--------|---------|
| `/api/health` | GET | Healthcheck (usato da Railway) |
| `/api/login` | POST `{email,password,gbUser}` | Login cliente → `{token, active, gb_allowed, license_active}`. `active` è true solo se licenza attiva **e** `gbUser` è tra gli account Goldbet legati (rate-limit 10/min per IP) |
| `/api/check` | POST `{token,version,gbUser}` | Verifica se ancora attivo/autorizzato → `{active, gb_allowed}` + aggiorna "ultimo visto" |
| `/api/tabs` | POST `{token,tabs}` | Snapshot tab aperte (ogni 5 min dal background worker) |
| `/api/event` | POST `{token,event,detail}` | Invia telemetria (es. una giocata) |
| `/api/logout` | POST `{token}` | Chiude la sessione |

### API admin (dashboard)

| Endpoint | Cosa fa |
|----------|---------|
| `/api/admin/live` | **Chi è online adesso**: ultima tab attiva + stato online per utente |
| `/api/admin/tabs` | Storico snapshot tab (filtrabile per `?userId=`) |
| `/api/admin/stats` | Statistiche + n° utenti online |
| `/api/admin/goldbet-accounts` | GET `?userId=` lista account Goldbet legati · POST `{userId, accounts:[…]}` sostituisce la lista (normalizzati lowercase) |

## Persistenza su Railway (IMPORTANTE)

Il DB SQLite ora vive in `/data/licenses.db` (variabile `DB_PATH` nel Dockerfile).
Perché **sopravviva ai deploy** devi creare un **Volume** su Railway montato su `/data`:

1. Apri il progetto su Railway → tab **Settings** del servizio → sezione **Volumes**
2. **+ New Volume** → Mount path: `/data` → Salva
3. Redeploy. Da ora utenti, licenze e snapshot restano anche dopo ogni push.

> ⚠️ Senza il volume, ogni deploy azzera il database (utenti e licenze inclusi).

## Retention automatica

- Snapshot tab più vecchi di **14 giorni** vengono eliminati (`SNAPSHOT_RETENTION_DAYS`)
- Sessioni inattive da **30 giorni** vengono eliminate (`SESSION_RETENTION_DAYS`)
- La pulizia gira all'avvio e ogni 6 ore.

Il plugin: fa `login`, salva il `token`, e funziona solo se `active:true`. Ogni tanto
richiama `check`. Su ogni giocata può mandare `event` per la telemetria.

## ⚠️ Note importanti (prototipo → produzione)

Questo è un **prototipo locale** per capire il sistema. Prima di vendere davvero serve:

1. **Mettere il backend online** (VPS o servizio cloud) — ora gira solo sul tuo PC,
   quindi i clienti non possono raggiungerlo. La porta `localhost:4000` va sostituita
   con un dominio HTTPS pubblico.
2. **HTTPS obbligatorio** — le password viaggiano in chiaro su HTTP. Serve un certificato.
3. **Token admin più robusto** — ora è banale (`admin-<password>`). In produzione usa JWT
   o sessioni firmate.
4. **GDPR** — se raccogli dati d'uso dei clienti (telemetria), servono informativa e
   base giuridica. Consulta le regole sul trattamento dati prima di andare live.

## Sicurezza già presente

- Password salvate con **scrypt + salt** (mai in chiaro nel DB)
- Confronto password **timing-safe**
- Endpoint admin protetti da token
- Sessioni separate per ogni login
