# Goldbet Fast Bet — Estensione (backup versionato)

Copia dell'estensione Chrome tenuta sotto git per **backup e storico versioni**.
La cartella "viva" caricata in Chrome è `../../goldbet_fast_bet_v6.4/`.

> ⚠️ Le estensioni **unpacked non si aggiornano da sole**. Questo backup serve a:
> 1. tracciare ogni versione (ripristinabile con `git checkout <tag>`)
> 2. distribuire il file ZIP ai clienti quando esce una nuova versione

## Sistema di avviso aggiornamento

L'estensione manda la propria `APP_VERSION` (in `fastbet.js`) a `/api/check` ogni 60s.
Se il backend ha pubblicato una versione più recente, risponde con `update` e
l'estensione mostra un **banner giallo** al cliente con il link di download.

## Procedura di release (checklist)

1. Modifica il codice in `../../goldbet_fast_bet_v6.4/`
2. **Bump della versione in DUE punti** (devono combaciare):
   - `manifest.json` → `"version"`
   - `fastbet.js` → `const APP_VERSION`
3. Copia i file aggiornati qui in `extension/` e committa con un tag:
   ```
   git add extension/ && git commit -m "ext: v6.5 — <cosa cambia>"
   git tag ext-v6.5 && git push --tags
   ```
4. Crea lo ZIP della cartella e caricalo dove i clienti lo scaricano
   (Drive, sito, ecc.) — copia quell'URL.
5. Nella **dashboard admin** → pannello "Versione estensione":
   inserisci numero, URL download, changelog → **Pubblica versione**.
6. I clienti vedranno il banner entro ~1 minuto e potranno scaricare + ricaricare.

Se spunti **Obbligatorio**, Fast Bet si blocca sui client con versione vecchia
finché non aggiornano.

## File

- `manifest.json` — MV3, permessi `tabs` + host goldbet/backend
- `background.js` — service worker: snapshot tab ogni 5 min
- `fastbet.js` — content script MAIN world: mock pendingBet, licenza, comandi, banner update

## Vincolo account Goldbet (v6.5)

Il plugin legge lo username Goldbet dall'header della pagina (`<div class="utente">…<div>NOME</div></div>`)
e lo manda al backend a ogni login/check. Il backend risponde `gb_allowed` in base
alla lista di account legati alla licenza (dashboard → "Account GB"). Il plugin si apre
SOLO se: utente loggato su Goldbet **+** account nella lista **+** licenza attiva.
Confronto case-insensitive. Se lo username cambia (login/logout sul sito) il gate
viene rivalutato entro ~2 secondi.

(Il file `rest` da ~6.7 MB nella cartella viva NON è incluso: non è referenziato dal manifest.)
