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
2. **Crea un utente**: email + password + nota → diventa un cliente
3. L'utente parte **disattivato**. Clicca **Attiva** per abilitargli Fast Bet
4. Dai al cliente le sue **credenziali** (email + password)
5. Il cliente le inserisce nel plugin → il plugin chiede al backend se è attivo
6. Puoi **Disattivare** in qualsiasi momento → il plugin si blocca al successivo check
7. **Log**: vedi gli eventi di ogni cliente (login, check, giocate)

## API (per collegare il plugin)

| Endpoint | Metodo | Cosa fa |
|----------|--------|---------|
| `/api/login` | POST `{email,password}` | Login cliente → ritorna `{token, active}` |
| `/api/check` | POST `{token}` | Verifica se ancora attivo → `{active}` |
| `/api/event` | POST `{token,event,detail}` | Invia telemetria (es. una giocata) |
| `/api/logout` | POST `{token}` | Chiude la sessione |

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
