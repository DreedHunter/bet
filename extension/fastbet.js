(function () {
  "use strict";

  // Goldbet Fast Bet v6.5 — MAIN world, GUI a overlay (Shadow DOM)
  // Intercetta insertBet/pendingBet e mocka la conferma pendingBet.
  // Gate di licenza: funziona solo se l'utente è loggato e attivo sul backend.
  // Novità v6.3: telemetria tab ogni 5 min via background service worker.
  // Novità v6.4: retry automatico su error 41 (quota scaduta) — recupera la
  //              quota fresca da getDetailsEventLive e ripiazza la scommessa.
  // Novità v6.5: vincolo account Goldbet — il plugin si apre SOLO se lo username
  //              loggato su Goldbet è nella lista autorizzata della licenza.
  // Novità v6.6: telemetria scommesse dettagliata — importo, quote, vincita
  //              potenziale, coupon, esito (piazzata / errore 41 con motivo).
  // Novità v6.7: log arricchito con partita, squadre, mercato ed esito di ogni
  //              selezione (letti dal payload insertBet).
  // Novità v6.8: fallback nome partita dallo slug URL + sport/torneo quando il
  //              payload non contiene i nomi (evita il "?" nel log).

  // ───────────────────────── licenza ─────────────────────────
  const API_BASE   = "https://bet-production-b260.up.railway.app";
  const APP_VERSION = "6.8";  // ⚠️ bumpare INSIEME al manifest.json a ogni release
  const LS_TOKEN   = "gbfb_token";
  const LS_EMAIL   = "gbfb_email";
  let licToken     = null;
  let licEmail     = null;
  let licActive    = false;
  try {
    licToken = localStorage.getItem(LS_TOKEN);
    licEmail = localStorage.getItem(LS_EMAIL);
  } catch (e) {}

  // ───────────────── account Goldbet (username dal DOM) ─────────────────
  // L'header Goldbet mostra il nome utente in <div class="utente">…<div>NOME</div></div>.
  // Se l'elemento non c'è, l'utente non ha fatto il login su Goldbet.
  let gbUser = null;
  function readGbUser() {
    try {
      const box = document.querySelector(".utente");
      if (!box) return null;
      for (const d of box.querySelectorAll(":scope > div")) {
        if (d.querySelector("a, i, button, input")) continue;
        const t = (d.textContent || "").trim();
        if (t) return t;
      }
    } catch (e) {}
    return null;
  }

  // notifica il background service worker quando il token cambia
  function syncTokenToBackground(token) {
    try {
      chrome.runtime.sendMessage({ type: "GBFB_TOKEN_UPDATE", token: token || null });
    } catch (e) {}
  }

  async function apiLogin(email, password) {
    const r = await fetch(API_BASE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, gbUser })
    });
    return r.json();
  }
  async function apiCheck(token) {
    try {
      const r = await fetch(API_BASE + "/api/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, version: APP_VERSION, gbUser })
      });
      return r.json();
    } catch (e) { return { ok: false, offline: true }; }
  }
  function apiEvent(event, detail) {
    if (!licToken) return;
    fetch(API_BASE + "/api/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: licToken, event, detail })
    }).catch(() => {});
  }
  function saveLicense() {
    try {
      if (licToken) localStorage.setItem(LS_TOKEN, licToken); else localStorage.removeItem(LS_TOKEN);
      if (licEmail) localStorage.setItem(LS_EMAIL, licEmail); else localStorage.removeItem(LS_EMAIL);
    } catch (e) {}
    syncTokenToBackground(licToken);
  }
  function doLogout() {
    if (licToken) fetch(API_BASE + "/api/logout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: licToken })
    }).catch(() => {});
    licToken = null; licEmail = null; licActive = false;
    saveLicense();
  }

  // esegue i comandi remoti ricevuti dal backend
  function handleCommands(cmds) {
    for (const c of cmds) {
      try {
        if (c.type === "logout") {
          doLogout();
          if (ui && ui.showLogin) ui.showLogin("Disconnesso dall'amministratore", "warn");
        } else if (c.type === "message") {
          const txt = c.payload && c.payload.text ? c.payload.text : "Messaggio dall'amministratore";
          alert(txt);
        }
        // altri tipi (config, ecc.) verranno gestiti in futuro
      } catch (e) {}
    }
  }

  // mostra un banner di aggiornamento (una sola volta per sessione di pagina)
  let updateBannerShown = false;
  function showUpdateBanner(update) {
    if (updateBannerShown) return;
    updateBannerShown = true;
    try {
      if (update.mandatory) licActive = false;  // blocca l'uso finché non aggiorna
      const bar = document.createElement("div");
      bar.id = "gbfb-update-bar";
      bar.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
        "background:rgb(255,204,0)", "color:#0A1B4E", "font:700 13px -apple-system,Segoe UI,sans-serif",
        "padding:10px 16px", "display:flex", "align-items:center", "gap:12px",
        "box-shadow:0 2px 12px rgba(0,0,0,.3)"
      ].join(";");
      const msg = update.mandatory
        ? `⚠️ Aggiornamento OBBLIGATORIO alla v${update.version || update.latest} — Fast Bet è bloccato finché non aggiorni.`
        : `⬆️ Disponibile Fast Bet v${update.version || update.latest}.`;
      const changelog = update.changelog ? ` — ${update.changelog}` : "";
      bar.innerHTML =
        `<span style="flex:1">${msg}${changelog}</span>` +
        (update.download_url ? `<a href="${update.download_url}" target="_blank" style="background:#0A1B4E;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none">Scarica</a>` : "") +
        (update.mandatory ? "" : `<span id="gbfb-update-x" style="cursor:pointer;font-size:18px;padding:0 4px">×</span>`);
      document.documentElement.appendChild(bar);
      const x = bar.querySelector("#gbfb-update-x");
      if (x) x.addEventListener("click", () => bar.remove());
    } catch (e) {}
  }

  // ───────────────────────────── stato ─────────────────────────────
  let mockEnabled = false;
  let couponCode  = null;
  let stake       = 1.0;
  let t0 = 0, t1 = 0;
  let pendingXhr  = null;
  const aamsTicketID = "df07ea0613304e9e910b";

  // contesto dell'ultima scommessa (per la telemetria dettagliata)
  let betCtx = null;
  let lastRetryAttempt = 0;

  // Goldbet a volte manda le quote come interi x100 (185 = 1.85)
  function normOdd(v) {
    const n = parseFloat(String(v).replace(",", "."));
    if (!isFinite(n) || n <= 0) return null;
    return n >= 101 ? +(n / 100).toFixed(2) : n;
  }

  // ricostruisce il nome partita dallo slug dell'URL Goldbet quando il payload
  // non lo contiene. Es. ".../calcio/mondiali/norvegia-francia" → "Norvegia-Francia".
  function partitaDaUrl() {
    try {
      const seg = location.pathname.split("/").filter(Boolean).pop() || "";
      const slug = seg.split("?")[0];
      if (!slug || !slug.includes("-")) return null;
      return slug.split("-")
        .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
        .join(" ")
        .replace(/\bVs\b/i, "-");
    } catch (e) { return null; }
  }

  const nz = (v) => { const s = (v == null ? "" : String(v)).trim(); return s || null; };

  // estrae dal payload insertBet: importo, quote, quota totale, vincita potenziale,
  // e per ogni selezione partita/squadre/mercato/esito.
  // Struttura reale: { Payload: { totalStake, events: [{ oddsValue, selName,
  //   markName, evtName / masterAamsEventName, firstTeam, secondTeam, sportName, tName }] } }
  function parseBetCtx(body) {
    try {
      const p = JSON.parse(body);
      const payload = p?.Payload || p?.request?.Payload || {};
      const events = payload.events || [];
      const urlPartita = partitaDaUrl();
      const quote = [];
      const selezioni = events.map(e => {
        const q = normOdd(e.oddsValue);
        if (q) quote.push(q);
        const first = nz(e.firstTeam), second = nz(e.secondTeam);
        const partita = nz(e.masterAamsEventName) || nz(e.evtName) ||
          ([first, second].filter(Boolean).join(" - ") || null) ||
          (events.length === 1 ? urlPartita : null);  // fallback URL solo per la singola
        return {
          partita,
          firstTeam: first,
          secondTeam: second,
          mercato: nz(e.markName),   // es. "Prossimo Gol 1° Tempo"
          esito: nz(e.selName),      // es. "Casa" / "Over 2.5"
          quota: q,
          sport: nz(e.sportName),
          torneo: nz(e.tName)
        };
      });
      const quotaTot = quote.length ? +quote.reduce((a, q) => a * q, 1).toFixed(2) : null;
      const stk = payload.totalStake || 0;
      return {
        stake: stk,
        quote,
        quotaTot,
        vincita: quotaTot ? +(quotaTot * stk).toFixed(2) : null,
        nSel: events.length,
        selezioni
      };
    } catch (e) { return null; }
  }

  // telemetria: scommessa rifiutata (errore server / quota scaduta non recuperata)
  function logBetError(code, motivo, tentativi = 0) {
    apiEvent("bet_errore", {
      esito: "rifiutata", code, motivo, tentativi,
      stake,
      quote: (betCtx && betCtx.quote) || [],
      quotaTot: betCtx ? betCtx.quotaTot : null,
      vincita: betCtx ? betCtx.vincita : null,
      selezioni: (betCtx && betCtx.selezioni) || []
    });
  }

  // auth headers catturati dalla prima XHR autenticata — usati dal monitor SMK
  let globalAuthHeaders = {};

  // marketIdLong dell'ultima selezione aggiunta al coupon — es. "3826;21669;44806;0;0"
  // se null, monitora tutti i mercati dell'evento
  let watchedMarketIdLong = null;

  // ───────────────────── monitor SMK (sospensione mercati) ─────────────────────
  // Legge il DOM della pagina ogni 1s — nessuna chiamata di rete.
  // ATTENZIONE: le classi .red / .green sulle quote indicano solo la DIREZIONE
  // del movimento quota (scesa/salita), NON la sospensione. Una quota può essere
  // rossa ed essere perfettamente giocabile.
  //
  // La quota NON giocabile (quella che causa l'errore 41) ha la classe "lucchetto"
  // (o "disabled") sul div .item — Goldbet ci mette l'icona del lucchetto.
  // Selettore reale: .item.lucchetto  oppure  .item.disabled

  let smkTimer = null;

  // ─── tracking durata sospensioni (rosso→verde) ───
  let smkState     = "gray";   // stato corrente: gray | green | red
  let smkRedStart  = 0;        // performance.now() di inizio sospensione
  let smkRedNames  = [];       // selezioni che erano bloccate in questa sospensione
  let smkEvtId     = null;     // eid dell'evento monitorato
  // storico delle sospensioni concluse: { orario, durata(ms), sel, eid }
  let smkLog = [];
  const LS_SMKLOG = "gbfb_smklog";
  try { smkLog = JSON.parse(localStorage.getItem(LS_SMKLOG) || "[]"); } catch (e) {}
  function saveSmkLog() {
    try { localStorage.setItem(LS_SMKLOG, JSON.stringify(smkLog)); } catch (e) {}
  }

  function isItemLocked(el) {
    return el.classList.contains("lucchetto") || el.classList.contains("disabled");
  }

  function currentEvtId() {
    const m = window.location.search.match(/[?&]eid=(\d+)/);
    return m ? m[1] : null;
  }

  // registra una transizione di stato e misura la durata del rosso
  function onSmkTransition(newState, lockedNames) {
    const now = performance.now();
    if (newState === "red" && smkState !== "red") {
      // inizio sospensione
      smkRedStart = now;
      smkRedNames = lockedNames.slice();
      smkEvtId    = currentEvtId();
    } else if (newState === "green" && smkState === "red") {
      // fine sospensione → calcola durata
      const durata = Math.round(now - smkRedStart);
      smkLog.unshift({
        orario: new Date().toTimeString().slice(0, 8),
        durata,
        sel: (smkRedNames.length ? smkRedNames.join(", ") : "—"),
        eid: smkEvtId || currentEvtId()
      });
      if (smkLog.length > 50) smkLog.pop();
      saveSmkLog();
      if (ui) ui.onSmkClosed(smkLog[0]);
    }
    smkState = newState;
  }

  function pollSmk() {
    try {
      // trova il mercato Prossimo Gol nel DOM (aggiorna ad ogni poll — può cambiare)
      const mktId = findProssimoGolMarket();
      if (!mktId) {
        if (smkState === "red") onSmkTransition("green", []); // chiudi eventuale sospensione aperta
        smkState = "gray";
        if (ui) ui.setSmk("gray", []);
        return;
      }
      watchedMarketIdLong = mktId;
      const scope = `[data-marketidlong='${mktId}']`;

      const items = document.querySelectorAll(scope + " .item.item-hover");
      if (!items.length) {
        if (smkState === "red") onSmkTransition("green", []);
        smkState = "gray";
        if (ui) ui.setSmk("gray", []);
        return;
      }

      // nomi delle selezioni BLOCCATE (lucchetto) — sono quelle che danno errore 41
      const locked = [...items]
        .filter(isItemLocked)
        .map(el => el.querySelector(".item--mercato")?.textContent?.trim() || "?");

      const newState = locked.length > 0 ? "red" : "green";
      onSmkTransition(newState, locked);
      if (ui) ui.setSmk(newState, locked);
    } catch (e) {
      if (ui) ui.setSmk("gray", []);
    }
  }

  function startSmkMonitor() {
    if (smkTimer) return;
    // aspetta che Angular abbia renderizzato almeno una quota prima di partire
    const kick = () => {
      if (document.querySelector(".item.item-hover")) {
        smkTimer = setInterval(pollSmk, 100); // 100ms per misure precise
        pollSmk();
      } else {
        setTimeout(kick, 300);
      }
    };
    kick();
  }

  let log = [];
  let cronoTimer = null;
  let ui = null;

  const LS_MOCK = "gbfb_mock";
  const LS_LOG  = "gbfb_log";
  try {
    mockEnabled = localStorage.getItem(LS_MOCK) === "1";
    log = JSON.parse(localStorage.getItem(LS_LOG) || "[]");
  } catch (e) {}

  function saveState() {
    try {
      localStorage.setItem(LS_MOCK, mockEnabled ? "1" : "0");
      localStorage.setItem(LS_LOG, JSON.stringify(log));
    } catch (e) {}
  }

  // ───────────────────── intercettore XHR (mock) ───────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    this._method = method;
    this._headers = {};
    return _open.apply(this, [method, url, ...rest]);
  };

  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this._headers) this._headers[k] = v;
    // salva gli auth headers Goldbet globalmente per il monitor SMK
    if (k && k.startsWith("X-Auth") && v) globalAuthHeaders[k] = v;
    return _setRequestHeader.apply(this, [k, v]);
  };

  // ─── cache dell'ultimo getDetailsEventLive (per non rifare la fetch ad ogni selezione) ───
  let _detailsCache = { evtId: null, ts: 0, data: null };

  async function getEventDetails(evtId, authHeaders) {
    const now = performance.now();
    // riusa la cache se è dello stesso evento e fresca (< 800ms)
    if (_detailsCache.evtId === evtId && _detailsCache.data && (now - _detailsCache.ts) < 800) {
      return _detailsCache.data;
    }
    try {
      const r = await fetch(
        `https://www.goldbet.it/api/sport/live/getDetailsEventLive/1/${evtId}`,
        { method: "GET", headers: authHeaders }
      );
      const data = await r.json();
      _detailsCache = { evtId, ts: now, data };
      return data;
    } catch (e) { return null; }
  }

  // Recupera lo stato aggiornato di una selezione da getDetailsEventLive.
  // Chiavi abbreviate: si=selId, oi=oddsId, ov=oddsValue, ms=stato(1=attiva), mi=markId, smk=mercato sospeso.
  // Ritorna:
  //   { status: "ok",       oddsId, oddsValue, markId }  → quota viva, si può ritentare
  //   { status: "retired" }                              → quota azzerata/ritirata (oi:0 o ov:0) → 41 NON bypassabile
  //   { status: "suspended" }                            → mercato col lucchetto (smk:true)
  //   { status: "notfound" }                             → selezione non presente nei dati
  async function probeSelection(evtId, selId, authHeaders) {
    const data = await getEventDetails(evtId, authHeaders);
    if (!data) return { status: "notfound" };
    const mktWbD = data.mktWbD || {};
    for (const mktKey of Object.keys(mktWbD)) {
      const mkt = mktWbD[mktKey];
      const msGroups = mkt.ms || {};
      for (const grpKey of Object.keys(msGroups)) {
        const asl = msGroups[grpKey]?.asl || [];
        for (const sel of asl) {
          if (sel.si !== selId) continue;
          // trovata la selezione
          if (mkt.smk) return { status: "suspended" };
          if (!sel.oi || !sel.ov || sel.ms !== 1) return { status: "retired" };
          return { status: "ok", oddsId: sel.oi, oddsValue: String(sel.ov), markId: sel.mi };
        }
      }
    }
    return { status: "notfound" };
  }

  // Esegue un insertBet con un payload aggiornato. onDone(success, data, logged):
  // logged=true se fireMockPending ha già registrato la giocata nel log.
  function doInsert(payload, headers, onDone) {
    const xhr = new XMLHttpRequest();
    _open.call(xhr, "POST", "https://www.goldbet.it/api/sport/book/insertBet", true);
    for (const [k, v] of Object.entries(headers)) {
      try { xhr.setRequestHeader(k, v); } catch (e) {}
    }
    xhr.addEventListener("load", function () {
      try {
        const data = JSON.parse(this.responseText);
        if (data?.data?.couponCode && data?.success !== false) {
          couponCode = data.data.couponCode;
          t1 = performance.now();
          let logged = false;
          if (mockEnabled && pendingXhr) logged = !!fireMockPending();
          onDone(true, data, logged);
        } else {
          onDone(false, data, false);
        }
      } catch (e) { onDone(false, null, false); }
    });
    xhr.addEventListener("error", () => onDone(false, null, false));
    _send.call(xhr, JSON.stringify(payload));
  }

  // Retry intelligente: aggiorna le quote scadute SOLO se ancora vive, altrimenti si ferma
  // subito distinguendo il motivo (ritirata pre-gol vs mercato sospeso).
  // maxAttempts evita loop infiniti se il server continua a invalidare la quota.
  function retryInsertBet(originalBody, expiredSelections, headers, attempt = 1) {
    let payload;
    try { payload = JSON.parse(originalBody); } catch (e) { return; }
    const events = payload?.Payload?.events || [];
    if (!events.length) {
      logBetError(41, "errore interno nel coupon", attempt - 1);
      if (ui) ui.onRetryFailed("payload");
      return;
    }

    const MAX_ATTEMPTS = 3;

    // sonda in parallelo lo stato attuale di ogni selezione scaduta
    const probes = expiredSelections.map(async (exp) => {
      const evt = events.find(e => e.selId === exp.selectionId || e.oddsId === exp.oddId);
      if (!evt) return { evt: null, probe: { status: "notfound" } };
      const probe = await probeSelection(evt.evtId, evt.selId, headers);
      return { evt, probe };
    });

    Promise.all(probes).then(results => {
      // se anche una sola selezione è ritirata o sospesa → inutile insistere
      const retired   = results.find(r => r.probe.status === "retired");
      const suspended = results.find(r => r.probe.status === "suspended");
      if (suspended) {
        logBetError(41, "mercato sospeso (lucchetto)", attempt - 1);
        if (ui) ui.onRetryFailed("suspended");
        return;
      }
      if (retired) {
        logBetError(41, "quota ritirata dal bookmaker", attempt - 1);
        if (ui) ui.onRetryFailed("retired");
        return;
      }

      // tutte vive → aggiorna oddsId/oddsValue/markId
      let updated = false;
      for (const { evt, probe } of results) {
        if (!evt || probe.status !== "ok") continue;
        evt.oddsId    = probe.oddsId;
        evt.oddsValue = probe.oddsValue;
        if (probe.markId) evt.markId = probe.markId;
        updated = true;
      }
      if (!updated) {
        logBetError(41, "selezione non più presente nei mercati live", attempt - 1);
        if (ui) ui.onRetryFailed("notfound");
        return;
      }

      if (ui) ui.onRetrying(attempt);

      lastRetryAttempt = attempt;
      doInsert(payload, headers, (ok, data, logged) => {
        if (ok) {
          if (ui) ui.onRetryOk();
          if (!logged) {
            // senza mock non arriverà nessun pendingBet per il retry: logga qui l'esito
            const t2 = performance.now();
            addLog(Math.round(t1 - t0), 0, Math.round(t2 - t0), false);
          }
          return;
        }
        // fallito di nuovo: se è ancora 41 e abbiamo tentativi, riprova con quota più fresca
        if (data?.error?.error === 41 && data?.error?.expiredSelections?.length && attempt < MAX_ATTEMPTS) {
          _detailsCache.ts = 0; // invalida cache per forzare fetch fresca
          retryInsertBet(JSON.stringify(payload), data.error.expiredSelections, headers, attempt + 1);
        } else {
          logBetError(data?.error?.error ?? 41, "quota non più disponibile dopo i retry", attempt);
          if (ui) ui.onRetryFailed("server");
        }
      });
    });
  }

  XMLHttpRequest.prototype.send = function (body) {

    if (this._url && this._url.includes("/api/sport/book/insertBet")) {
      t0 = performance.now(); t1 = 0;
      couponCode = null; pendingXhr = null;
      betCtx = parseBetCtx(body);
      stake = (betCtx && betCtx.stake) || 1.0;
      lastRetryAttempt = 0;
      if (ui) ui.startCrono(Date.now());

      const capturedHeaders = this._headers || {};
      const _body = body;

      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          if (data?.data?.couponCode && data?.success !== false) {
            // successo normale
            couponCode = data.data.couponCode;
            t1 = performance.now();
            if (mockEnabled && pendingXhr) fireMockPending();
          } else if (data?.error?.error === 41 && data?.error?.expiredSelections?.length) {
            // quota scaduta → retry intelligente (distingue recuperabile vs ritirata)
            retryInsertBet(_body, data.error.expiredSelections, capturedHeaders);
          } else if (data?.success === false) {
            // altro errore → logga e mostra il codice
            logBetError(data?.error?.error ?? null, "rifiutata dal server", 0);
            if (ui) ui.onRetryFailed("err" + (data?.error?.error ?? "?"));
          }
        } catch (e) {}
      });
      return _send.apply(this, [body]);
    }

    if (this._url && this._url.includes("/api/sport/book/pendingBet")) {
      if (mockEnabled && licActive) {
        pendingXhr = this;
        if (couponCode && t1 > 0) fireMockPending();
        return;
      }
      this.addEventListener("load", function () {
        try {
          const t2 = performance.now();
          const totale = t0 ? Math.round(t2 - t0) : 0;
          const insert = t1 ? Math.round(t1 - t0) : 0;
          const pend   = t1 ? Math.round(t2 - t1) : 0;
          addLog(insert, pend, totale, false);
        } catch (e) {}
      });
      return _send.apply(this, [body]);
    }

    return _send.apply(this, [body]);
  };

  function fireMockPending() {
    if (!pendingXhr || !couponCode || !t1) return false;
    const mockBody = JSON.stringify({
      couponCode, aamsTicketID,
      couponDate: new Date().toISOString(),
      stake, confirmedStake: stake,
      statusCode: "P", isPending: false,
      couponTypeEnum: 0, potentialWin: 0.0, idCouponStatus: 0
    });
    Object.defineProperty(pendingXhr, "status",       { get: () => 200 });
    Object.defineProperty(pendingXhr, "readyState",   { get: () => 4 });
    Object.defineProperty(pendingXhr, "responseText", { get: () => mockBody });
    Object.defineProperty(pendingXhr, "response",     { get: () => mockBody });

    const t2 = performance.now();
    pendingXhr.dispatchEvent(new Event("readystatechange"));
    pendingXhr.dispatchEvent(new Event("load"));

    const totale = Math.round(t2 - t0);
    const insert = Math.round(t1 - t0);
    const pend   = Math.round(t2 - t1);
    addLog(insert, pend, totale, true);

    pendingXhr = null;
    couponCode = null;
    return true;
  }

  function addLog(insert, pend, totale, isMock) {
    log.unshift({
      orario: new Date().toTimeString().slice(0, 8),
      stake, insert, pend, totale, mock: isMock
    });
    if (log.length > 10) log.pop();
    saveState();
    if (ui) ui.onNewBet(log[0]);
    apiEvent("bet", {
      esito: "piazzata",
      stake,
      quote: (betCtx && betCtx.quote) || [],
      quotaTot: betCtx ? betCtx.quotaTot : null,
      vincita: betCtx ? betCtx.vincita : null,
      selezioni: (betCtx && betCtx.selezioni) || [],
      coupon: couponCode || null,
      retry: lastRetryAttempt || 0,
      insert, pend, totale, mock: isMock
    });
  }

  // trova il data-marketidlong del mercato "Prossimo Gol" cercando per nome nel DOM
  function findProssimoGolMarket() {
    const headers = document.querySelectorAll(".market-name, .market__name, .mn, [class*='market-title'], [class*='marketName']");
    for (const el of headers) {
      if (el.textContent.trim().toLowerCase().includes("prossimo gol")) {
        const mktEl = el.closest("[data-marketidlong]");
        if (mktEl) return mktEl.dataset.marketidlong;
      }
    }
    // fallback: cerca negli elementi che contengono Casa/Nessun Gol/Ospite come gruppo
    const allMkts = document.querySelectorAll("[data-marketidlong]");
    for (const mkt of allMkts) {
      const texts = [...mkt.querySelectorAll(".item--mercato")].map(e => e.textContent.trim().toLowerCase());
      if (texts.includes("casa") && texts.includes("ospite") && texts.includes("nessun gol")) {
        return mkt.dataset.marketidlong;
      }
    }
    return null;
  }

  // connection prewarming
  function prewarm() {
    fetch("https://www.goldbet.it/", { method: "HEAD", mode: "no-cors", cache: "no-store" }).catch(() => {});
  }
  prewarm();
  setInterval(prewarm, 25000);

  // ───────────────────────────── GUI overlay ───────────────────────
  function buildUI() {
    const host = document.createElement("div");
    host.id = "gbfb-host";
    host.style.cssText = "position:fixed!important;top:0!important;right:0!important;" +
      "z-index:2147483647!important;width:0;height:0;pointer-events:none;";
    (document.body || document.documentElement).appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0;
            font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
        .wrap { position: fixed; top: 14px; right: 14px; width: 300px;
          z-index: 2147483647; pointer-events: auto;
          background: #0A1B4E; color: #e8ecf7;
          border: 1px solid #1c3270; border-radius: 14px;
          box-shadow: 0 14px 44px rgba(0,0,0,.6); overflow: hidden; transition: all .2s; }
        .wrap.min { height: 50px; }
        .wrap.min .body { display: none; }

        .head { display: flex; align-items: center; gap: 10px; padding: 13px 14px; cursor: move;
          background: linear-gradient(135deg, #0A1B4E, #122356);
          border-bottom: 1px solid #1c3270; user-select: none; }
        .logo { width: 30px; height: 30px; border-radius: 8px; background: rgb(255,204,0);
          color: #0A1B4E; display: flex; align-items: center; justify-content: center;
          font-size: 17px; font-weight: 900; flex-shrink: 0;
          box-shadow: 0 3px 12px rgba(255,204,0,.35); }
        .title { font-size: 14px; font-weight: 800; color: #fff; flex: 1; line-height: 1.05; }
        .title small { display: block; font-size: 9px; color: rgb(255,204,0); font-weight: 700; letter-spacing: .5px; }
        .hbtn { width: 24px; height: 24px; border-radius: 6px; border: 1px solid #1c3270;
          background: #0e2050; color: #6c7aa8; cursor: pointer; font-size: 12px;
          display: flex; align-items: center; justify-content: center; }
        .hbtn:hover { color: rgb(255,204,0); border-color: rgb(255,204,0); }
        .hbtn.stop { color: #e85d5d; border-color: #5a2230; background: #2a1418; font-size: 11px; font-weight: 800; }
        .hbtn.stop:hover { color: #fff; background: #e85d5d; border-color: #e85d5d; }

        .smk-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
        .smk-dot { width: 10px; height: 10px; border-radius: 50%;
          background: #3a3a5c; transition: background .4s, box-shadow .4s; }
        .smk-dot.green { background: #6fd36f; box-shadow: 0 0 6px #6fd36f; }
        .smk-dot.red   { background: #e85d5d; box-shadow: 0 0 8px #e85d5d;
          animation: pulse-red .8s ease-in-out infinite; }
        @keyframes pulse-red {
          0%,100% { box-shadow: 0 0 4px #e85d5d; }
          50%      { box-shadow: 0 0 14px #e85d5d; }
        }
        .smk-label { font-size: 7px; font-weight: 800; color: #e85d5d; text-align: center;
          letter-spacing: .3px; max-width: 54px; line-height: 1.2; display: none; }
        .smk-label.visible { display: block; }

        .body { padding: 14px; }

        .switch-row { display: flex; align-items: center; justify-content: space-between;
          background: #0e2050; border: 1px solid #1c3270; border-radius: 11px; padding: 12px 14px; }
        .switch-label { font-size: 13px; font-weight: 700; color: #fff; }
        .switch { position: relative; width: 46px; height: 25px; flex-shrink: 0; }
        .switch input { display: none; }
        .slider { position: absolute; inset: 0; background: #1c3270; border: 1px solid #1c3270;
          border-radius: 25px; cursor: pointer; transition: all .3s; }
        .slider::before { content: ""; position: absolute; width: 17px; height: 17px; left: 4px; top: 3px;
          background: #6c7aa8; border-radius: 50%; transition: all .3s; }
        input:checked + .slider { background: rgb(255,204,0); border-color: rgb(255,204,0); }
        input:checked + .slider::before { transform: translateX(21px); background: #0A1B4E; }

        .status { text-align: center; font-size: 10px; font-weight: 700; padding: 7px; border-radius: 8px;
          margin: 9px 0 13px; letter-spacing: .3px; }
        .status.on  { background: rgba(255,204,0,.13); color: rgb(255,204,0); }
        .status.off { background: #0e2050; color: #6c7aa8; }

        .crono-box { background: #0e2050; border: 1px solid #1c3270; border-radius: 12px;
          padding: 18px; text-align: center; position: relative; overflow: hidden; }
        .crono-box::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px;
          background: linear-gradient(90deg, transparent, rgb(255,204,0), transparent); }
        .crono-label { font-size: 9px; color: #6c7aa8; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .crono-val { font-size: 48px; font-weight: 800; font-variant-numeric: tabular-nums;
          color: rgb(255,204,0); line-height: 1; }
        .crono-val .u { font-size: 16px; font-weight: 500; color: #6c7aa8; margin-left: 5px; }
        .crono-val.run { color: #6fd36f; }
        .crono-detail { font-size: 10px; color: #6c7aa8; margin-top: 9px; }

        .mini { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        .mini .box { background: #0e2050; border: 1px solid #1c3270; border-radius: 9px; padding: 10px; text-align: center; }
        .mini .v { font-size: 20px; font-weight: 800; color: rgb(255,204,0); }
        .mini .v.green { color: #6fd36f; }
        .mini .l { font-size: 8px; color: #6c7aa8; text-transform: uppercase; letter-spacing: 1px; margin-top: 2px; }

        .tabs { display: flex; gap: 4px; margin: 12px 0 0; }
        .tab { flex: 1; text-align: center; padding: 7px 0; font-size: 10px; font-weight: 700;
          color: #6c7aa8; cursor: pointer; border-radius: 7px; background: #0e2050; border: 1px solid #1c3270;
          text-transform: uppercase; letter-spacing: .5px; }
        .tab.active { color: rgb(255,204,0); border-color: rgb(255,204,0); }

        .pane { display: none; margin-top: 10px; }
        .pane.active { display: block; }

        .loghead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; }
        .loghead span { font-size: 9px; color: #6c7aa8; text-transform: uppercase; letter-spacing: 1px; }
        .loghead button { font-size: 9px; background: #0e2050; color: #6c7aa8; border: 1px solid #1c3270;
          padding: 3px 9px; border-radius: 5px; cursor: pointer; font-weight: 700; }
        .loghead button:hover { color: rgb(255,204,0); border-color: rgb(255,204,0); }
        .log-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
        .log-list::-webkit-scrollbar { width: 6px; }
        .log-list::-webkit-scrollbar-thumb { background: #1c3270; border-radius: 3px; }
        .li { background: #0e2050; border: 1px solid #1c3270; border-radius: 7px; padding: 8px 10px;
          display: grid; grid-template-columns: 52px 1fr 1fr 38px; align-items: center; font-size: 11px; gap: 4px; }
        .li .o { color: #6c7aa8; font-size: 10px; }
        .li .i { color: rgb(255,204,0); text-align: center; font-weight: 600; }
        .li .t { color: #fff; text-align: center; font-weight: 800; }
        .li .b { font-size: 8px; font-weight: 800; padding: 2px 4px; border-radius: 3px; text-align: center; }
        .li .b.on { background: rgba(255,204,0,.13); color: rgb(255,204,0); }
        .li .b.off { background: #16264f; color: #6c7aa8; }
        .empty { text-align: center; color: #16264f; font-size: 11px; padding: 18px 0; }

        .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .sbox { background: #0e2050; border: 1px solid #1c3270; border-radius: 9px; padding: 12px; text-align: center; }
        .sbox .v { font-size: 22px; font-weight: 800; color: rgb(255,204,0); }
        .sbox .v.green { color: #6fd36f; } .sbox .v.white { color: #fff; }
        .sbox .l { font-size: 8px; color: #6c7aa8; text-transform: uppercase; letter-spacing: 1px; margin-top: 3px; }
        .swide { background: #0e2050; border: 1px solid #1c3270; border-radius: 9px; padding: 9px 12px;
          margin-top: 8px; display: flex; justify-content: space-between; align-items: center; }
        .swide .l { font-size: 10px; color: #6c7aa8; } .swide .v { font-size: 13px; font-weight: 800; color: rgb(255,204,0); }

        /* login */
        .login { text-align: center; padding: 6px 2px; }
        .login .ico { font-size: 32px; margin-bottom: 8px; }
        .login h3 { font-size: 14px; color: #fff; margin-bottom: 2px; }
        .login p { font-size: 11px; color: #6c7aa8; margin-bottom: 16px; }
        .login input { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #1c3270;
          background: #0A1B4E; color: #e8ecf7; font-size: 13px; margin-bottom: 9px; }
        .login input::placeholder { color: #6c7aa8; }
        .login .gobtn { width: 100%; padding: 11px; border-radius: 9px; border: none;
          background: rgb(255,204,0); color: #0A1B4E; font-weight: 800; font-size: 14px; cursor: pointer; }
        .login .gobtn:hover { filter: brightness(1.08); }
        .login .gobtn:disabled { opacity: .6; cursor: default; }
        .login .msg { font-size: 11px; min-height: 16px; margin-top: 10px; }
        .login .msg.err { color: #e85d5d; }
        .login .msg.warn { color: rgb(255,204,0); }
        .userbar { display: flex; align-items: center; gap: 6px; font-size: 10px; color: #6c7aa8;
          margin-bottom: 10px; padding: 7px 10px; background: #0e2050; border: 1px solid #1c3270; border-radius: 8px; }
        .userbar b { color: #6fd36f; }
        .userbar .out { margin-left: auto; cursor: pointer; color: #6c7aa8; font-weight: 700; }
        .userbar .out:hover { color: #e85d5d; }
      </style>

      <div class="wrap" id="wrap">
        <div class="head" id="head">
          <div class="logo">⚡</div>
          <div class="title">GOLDBET FAST BET<small>v6.8 · LICENSED</small></div>
          <div class="smk-wrap">
            <div class="smk-dot" id="smkDot"></div>
            <div class="smk-label" id="smkLabel"></div>
          </div>
          <div class="hbtn stop" id="stop" title="Reset / ferma cronometro" style="display:none">⏹</div>
          <div class="hbtn" id="min">—</div>
        </div>

        <!-- VISTA LOGIN -->
        <div class="body" id="loginView">
          <div class="login">
            <div class="ico">🔒</div>
            <h3>Accesso richiesto</h3>
            <p>Inserisci le credenziali della tua licenza</p>
            <input type="email" id="liEmail" placeholder="email" autocomplete="off">
            <input type="password" id="liPass" placeholder="password" autocomplete="off">
            <button class="gobtn" id="liBtn">Accedi</button>
            <div class="msg" id="liMsg"></div>
          </div>
        </div>

        <!-- VISTA BLOCCO (account Goldbet mancante o non autorizzato) -->
        <div class="body" id="blockView" style="display:none">
          <div class="login">
            <div class="ico" id="blkIco">⛔</div>
            <h3 id="blkTitle">Accesso bloccato</h3>
            <p id="blkMsg" style="margin-bottom:0">—</p>
          </div>
        </div>

        <!-- VISTA PRINCIPALE -->
        <div class="body" id="mainView" style="display:none">
          <div class="userbar">
            <span>licenza: <b id="ubEmail">—</b></span>
            <span>GB: <b id="ubGb">—</b></span>
            <span class="out" id="ubOut">esci</span>
          </div>
          <div class="switch-row">
            <span class="switch-label">Mock pendingBet</span>
            <label class="switch"><input type="checkbox" id="tg"><span class="slider"></span></label>
          </div>
          <div class="status off" id="st">OFF — timing reale (~7 sec)</div>

          <div class="tabs">
            <div class="tab active" data-p="dash">Dashboard</div>
            <div class="tab" data-p="log">Log</div>
            <div class="tab" data-p="smk">SMK</div>
            <div class="tab" data-p="stats">Stats</div>
          </div>

          <div class="pane active" id="pane-dash">
            <div class="crono-box">
              <div class="crono-label">ultima puntata</div>
              <div class="crono-val" id="crono">--</div>
              <div class="crono-detail" id="cdet">in attesa di una giocata…</div>
            </div>
            <div class="mini">
              <div class="box"><div class="v" id="d-med">--</div><div class="l">media ms</div></div>
              <div class="box"><div class="v green" id="d-rec">--</div><div class="l">record ms</div></div>
            </div>
          </div>

          <div class="pane" id="pane-log">
            <div class="loghead"><span>ultime 10 giocate</span><button id="clr">Pulisci</button></div>
            <div class="log-list" id="loglist"><div class="empty">Nessuna giocata</div></div>
          </div>

          <div class="pane" id="pane-smk">
            <div class="loghead">
              <span>durata sospensioni (rosso→verde)</span>
              <button id="clrSmk">Pulisci</button>
            </div>
            <div class="mini" style="margin-bottom:8px">
              <div class="box"><div class="v" id="smk-cnt">0</div><div class="l">sospensioni</div></div>
              <div class="box"><div class="v green" id="smk-avg">--</div><div class="l">durata media ms</div></div>
            </div>
            <div class="log-list" id="smklist"><div class="empty">Nessuna sospensione registrata</div></div>
          </div>

          <div class="pane" id="pane-stats">
            <div class="stat-grid">
              <div class="sbox"><div class="v white" id="s-tot">0</div><div class="l">puntate</div></div>
              <div class="sbox"><div class="v green" id="s-rec">--</div><div class="l">record ms</div></div>
              <div class="sbox"><div class="v" id="s-med">--</div><div class="l">media ms</div></div>
              <div class="sbox"><div class="v white" id="s-stk">€0</div><div class="l">stake tot</div></div>
            </div>
            <div class="swide"><span class="l">Peggiore</span><span class="v" id="s-wor" style="color:#e85d5d">--</span></div>
            <div class="swide"><span class="l">Mock ON / OFF</span><span class="v" id="s-mon">-- / --</span></div>
            <div class="swide"><span class="l">Risparmio medio</span><span class="v" id="s-sav" style="color:#6fa8ff">--</span></div>
          </div>
        </div>
      </div>
    `;

    const $ = (s) => root.querySelector(s);
    const wrap = $("#wrap"), crono = $("#crono"), cdet = $("#cdet");
    const tg = $("#tg"), st = $("#st"), loglist = $("#loglist");

    function showLogin(msg, cls) {
      $("#loginView").style.display = "block";
      $("#blockView").style.display = "none";
      $("#mainView").style.display = "none";
      $("#stop").style.display = "none";
      if (msg) { $("#liMsg").textContent = msg; $("#liMsg").className = "msg " + (cls || ""); }
    }
    function showBlocked(ico, title, msg) {
      $("#loginView").style.display = "none";
      $("#blockView").style.display = "block";
      $("#mainView").style.display = "none";
      $("#stop").style.display = "none";
      $("#blkIco").textContent = ico;
      $("#blkTitle").textContent = title;
      $("#blkMsg").textContent = msg;
    }
    function showMain() {
      $("#loginView").style.display = "none";
      $("#blockView").style.display = "none";
      $("#mainView").style.display = "block";
      $("#stop").style.display = "flex";
      $("#ubEmail").textContent = licEmail || "—";
      $("#ubGb").textContent = gbUser || "—";
      startSmkMonitor();
    }

    function showGbMissing() {
      showBlocked("🔗", "Login Goldbet richiesto",
        "Nessun account Goldbet rilevato: accedi al tuo conto Goldbet. " +
        "Fast Bet si apre solo con un account autorizzato dalla licenza.");
    }
    function showGbDenied() {
      showBlocked("⛔", "Account Goldbet non autorizzato",
        `L'account "${gbUser}" non è associato a questa licenza. ` +
        "Contatta il fornitore per farlo aggiungere.");
    }

    // ── gate centrale: decide la vista in base a account Goldbet + licenza ──
    async function refreshGate() {
      if (!gbUser) { licActive = false; showGbMissing(); return; }
      if (!licToken) { showLogin("", ""); return; }
      const r = await apiCheck(licToken);
      if (r.offline) {
        // backend momentaneamente irraggiungibile: mantieni lo stato corrente
        if (!licActive) showLogin("Backend offline — riprova", "err");
        return;
      }
      if (!r.ok) {
        if (r.error === "Sessione non valida") {
          licToken = null; licEmail = null; licActive = false; saveLicense();
          showLogin("Sessione terminata dall'amministratore", "warn");
        } else {
          licActive = false;
          showLogin(r.error || "Errore backend", "err");
        }
        return;
      }
      if (Array.isArray(r.commands)) handleCommands(r.commands);
      if (r.update) showUpdateBanner(r.update);
      if (!r.gb_allowed) { licActive = false; showGbDenied(); return; }
      if (!r.active) {
        licActive = false;
        showLogin("Licenza non attiva. Contatta il fornitore.", "warn");
        return;
      }
      if (!licToken) return; // un comando remoto (logout) ha appena chiuso la sessione
      licActive = true;
      showMain();
    }

    async function doLogin() {
      const email = $("#liEmail").value.trim();
      const password = $("#liPass").value;
      const btn = $("#liBtn");
      if (!gbUser) { showGbMissing(); return; }
      if (!email || !password) { $("#liMsg").textContent = "Inserisci email e password"; $("#liMsg").className = "msg err"; return; }
      btn.disabled = true; btn.textContent = "Accesso…";
      try {
        const r = await apiLogin(email, password);
        if (!r.ok) { showLogin(r.error || "Credenziali non valide", "err"); }
        else if (!r.gb_allowed) {
          licToken = r.token; licEmail = r.email; licActive = false; saveLicense();
          showGbDenied();
        }
        else if (!r.active) {
          licToken = r.token; licEmail = r.email; licActive = false; saveLicense();
          showLogin("Licenza non attiva. Contatta il fornitore.", "warn");
        } else {
          licToken = r.token; licEmail = r.email; licActive = true; saveLicense();
          showMain();
        }
      } catch (e) {
        showLogin("Backend non raggiungibile", "err");
      }
      btn.disabled = false; btn.textContent = "Accedi";
    }

    $("#liBtn").addEventListener("click", doLogin);
    $("#liPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    $("#ubOut").addEventListener("click", () => {
      doLogout();
      if (smkTimer) { clearInterval(smkTimer); smkTimer = null; }
      if (ui) ui.setSmk("gray");
      showLogin("", ""); $("#liEmail").value=""; $("#liPass").value="";
    });

    (async function initLicense() {
      showBlocked("⏳", "Rilevamento account Goldbet…",
        "Attendi qualche secondo: sto leggendo il nome utente dalla pagina.");
      // poll rapido all'avvio: Angular renderizza l'header dopo qualche secondo
      for (let i = 0; i < 24 && !gbUser; i++) {
        gbUser = readGbUser();
        if (gbUser) break;
        await new Promise(res => setTimeout(res, 500));
      }
      refreshGate();
    })();

    // se l'account Goldbet cambia (login/logout sul sito) → rivaluta il gate
    setInterval(() => {
      const u = readGbUser();
      if (u !== gbUser) { gbUser = u; refreshGate(); }
    }, 2000);

    // ricontrolla la licenza ogni 60s (disattivazione, account GB, comandi remoti, update)
    setInterval(() => { if (licToken) refreshGate(); }, 60000);

    root.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        root.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        root.querySelectorAll(".pane").forEach(p => p.classList.remove("active"));
        tab.classList.add("active");
        $("#pane-" + tab.dataset.p).classList.add("active");
      });
    });

    $("#min").addEventListener("click", () => {
      wrap.classList.toggle("min");
      $("#min").textContent = wrap.classList.contains("min") ? "▢" : "—";
    });

    $("#stop").addEventListener("click", () => {
      if (cronoTimer) { clearInterval(cronoTimer); cronoTimer = null; }
      t0 = 0; t1 = 0; couponCode = null; pendingXhr = null;
      if (log.length) showResult(log[0]); else resultIdle();
      const b = $("#stop"); const old = b.textContent; b.textContent = "✓";
      setTimeout(() => { b.textContent = old; }, 800);
    });

    (function () {
      const head = $("#head");
      let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
      head.addEventListener("mousedown", (e) => {
        if (e.target.id === "min") return;
        drag = true;
        const r = wrap.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        wrap.style.right = "auto"; wrap.style.left = ox + "px"; wrap.style.top = oy + "px";
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        wrap.style.left = (ox + e.clientX - sx) + "px";
        wrap.style.top = Math.max(0, oy + e.clientY - sy) + "px";
      });
      window.addEventListener("mouseup", () => { drag = false; });
    })();

    function setSwitch(on) {
      tg.checked = on;
      st.textContent = on ? "ON — pendingBet istantaneo" : "OFF — timing reale (~7 sec)";
      st.className = "status " + (on ? "on" : "off");
    }
    tg.addEventListener("change", () => {
      mockEnabled = tg.checked; saveState(); setSwitch(mockEnabled);
    });
    setSwitch(mockEnabled);

    $("#clr").addEventListener("click", () => { log = []; saveState(); renderLog(); renderStats(); resultIdle(); });
    $("#clrSmk").addEventListener("click", () => { smkLog = []; saveSmkLog(); renderSmk(); });

    function startCrono(betStart) {
      if (cronoTimer) clearInterval(cronoTimer);
      crono.className = "crono-val run";
      cronoTimer = setInterval(() => {
        crono.innerHTML = (Date.now() - betStart) + '<span class="u">ms</span>';
        cdet.textContent = "bet in corso…";
      }, 50);
    }
    function showResult(e) {
      if (cronoTimer) { clearInterval(cronoTimer); cronoTimer = null; }
      if (!e) return;
      crono.innerHTML = e.totale + '<span class="u">ms</span>';
      crono.className = "crono-val " + (e.mock ? "run" : "");
      cdet.textContent = `totale ${e.totale}ms · insert ${e.insert}ms · pending ${e.pend}ms`;
    }
    function resultIdle() {
      crono.innerHTML = "--"; crono.className = "crono-val"; cdet.textContent = "in attesa di una giocata…";
    }

    function renderLog() {
      if (!log.length) { loglist.innerHTML = '<div class="empty">Nessuna giocata</div>'; return; }
      loglist.innerHTML = log.map(e => `
        <div class="li">
          <span class="o">${e.orario}</span>
          <span class="i">${e.insert}ms</span>
          <span class="t">${e.totale}ms</span>
          <span class="b ${e.mock ? "on" : "off"}">${e.mock ? "ON" : "OFF"}</span>
        </div>`).join("");
    }

    function renderSmk() {
      const smklist = $("#smklist");
      const setT = (id, v) => { const el = $("#" + id); if (el) el.textContent = v; };
      setT("smk-cnt", smkLog.length);
      if (!smkLog.length) {
        smklist.innerHTML = '<div class="empty">Nessuna sospensione registrata</div>';
        setT("smk-avg", "--");
        return;
      }
      const avg = Math.round(smkLog.reduce((a, e) => a + e.durata, 0) / smkLog.length);
      setT("smk-avg", avg);
      smklist.innerHTML = smkLog.map(e => `
        <div class="li" style="grid-template-columns:52px 1fr 70px">
          <span class="o">${e.orario}</span>
          <span class="i" style="text-align:left;color:#e85d5d">${e.sel}</span>
          <span class="t">${e.durata}ms</span>
        </div>`).join("");
    }

    function renderStats() {
      const n = log.length;
      const setT = (id, v) => { const el = $("#" + id); if (el) el.textContent = v; };
      if (!n) {
        ["d-med","d-rec","s-rec","s-med","s-wor"].forEach(id => setT(id, "--"));
        setT("s-tot", "0"); setT("s-stk", "€0"); setT("s-mon", "-- / --"); setT("s-sav", "--");
        return;
      }
      const tempi = log.map(e => e.totale);
      const media = Math.round(tempi.reduce((a, b) => a + b, 0) / n);
      const rec = Math.min(...tempi), wor = Math.max(...tempi);
      const stk = log.reduce((a, e) => a + (e.stake || 0), 0).toFixed(2);
      const on = log.filter(e => e.mock).length, off = n - on;
      const mOn = on ? Math.round(log.filter(e => e.mock).reduce((a, e) => a + e.totale, 0) / on) : null;
      const mOff = off ? Math.round(log.filter(e => !e.mock).reduce((a, e) => a + e.totale, 0) / off) : null;
      const sav = (mOn !== null && mOff !== null) ? (mOff - mOn) + "ms" : "--";
      setT("d-med", media); setT("d-rec", rec);
      setT("s-tot", n); setT("s-rec", rec + "ms"); setT("s-med", media + "ms"); setT("s-stk", "€" + stk);
      setT("s-wor", wor + "ms"); setT("s-mon", on + " / " + off); setT("s-sav", sav);
    }

    const smkDot   = $("#smkDot");
    const smkLabel = $("#smkLabel");

    ui = {
      startCrono,
      showLogin,
      showBlocked,
      onNewBet(e) { showResult(e); renderLog(); renderStats(); },
      onRetrying(attempt = 1) {
        crono.className = "crono-val run";
        cdet.textContent = attempt > 1
          ? `quota scaduta — retry #${attempt} con quota fresca…`
          : "quota scaduta — retry con quota fresca…";
      },
      onRetryOk() {
        crono.className = "crono-val";
        cdet.textContent = "✓ retry OK — scommessa piazzata con quota aggiornata";
      },
      onRetryFailed(reason) {
        if (cronoTimer) { clearInterval(cronoTimer); cronoTimer = null; }
        crono.innerHTML = "✕"; crono.className = "crono-val";
        const msg = {
          retired:   "quota RITIRATA dal bookmaker (probabile gol imminente) — non piazzabile",
          suspended: "mercato SOSPESO (lucchetto) — riprova quando riapre",
          server:    "rifiutata dal server dopo i tentativi — quota non più disponibile",
          notfound:  "selezione non più presente nei mercati live",
          payload:   "errore interno nel coupon",
        };
        cdet.textContent = msg[reason] || ("scommessa rifiutata (" + (reason || "?") + ")");
      },
      onSmkClosed() { renderSmk(); },
      setSmk(state, suspended = []) {
        if (!smkDot) return;
        smkDot.className = "smk-dot" + (state !== "gray" ? " " + state : "");
        if (smkLabel) {
          if (state === "red" && suspended.length) {
            smkLabel.textContent = suspended.join(" · ");
            smkLabel.classList.add("visible");
          } else {
            smkLabel.textContent = "";
            smkLabel.classList.remove("visible");
          }
        }
      }
    };

    if (log.length) showResult(log[0]);
    renderLog(); renderStats(); renderSmk();
  }

  let built = false;
  function tryBuild() {
    if (built || !document.body) return built;
    try { buildUI(); built = true; } catch (e) {}
    return built;
  }
  function init() {
    if (tryBuild()) return;
    document.addEventListener("DOMContentLoaded", tryBuild, { once: true });
    try { const o = new MutationObserver(() => { if (tryBuild()) o.disconnect(); });
      o.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    let n = 0; const iv = setInterval(() => { if (tryBuild() || ++n > 40) clearInterval(iv); }, 250);
  }
  init();

})();
