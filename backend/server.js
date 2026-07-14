// server.js — API REST per sistema licenze (prototipo locale, zero dipendenze)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import * as DB from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

// Password admin per la dashboard — impostala come env var ADMIN_PASSWORD in produzione.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_TOKEN = "admin-" + ADMIN_PASSWORD;

// in produzione (Docker) il cwd è /app, in locale è backend/
const DASHBOARD_DIR = process.env.DASHBOARD_DIR || join(__dirname, "..", "dashboard");
// archivio ZIP delle estensioni + manifesto versioni (generato da release.mjs)
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(__dirname, "downloads");

// ───────────────────────── helpers ─────────────────────────
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

function isAdmin(req) {
  const auth = req.headers["authorization"] || "";
  return auth === "Bearer " + ADMIN_TOKEN;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Il vincolo account Goldbet vale solo dalla v6.5 in su. Le versioni precedenti
// devono funzionare come prima: solo licenza attiva, nessun controllo sull'account.
//
// Come riconosciamo un client >=6.5:
//  - manda "version" >= 6.5, OPPURE
//  - manda il campo "gbUser" nel body (concetto introdotto solo dalla 6.5: i
//    client vecchi non lo inviano affatto). Serve perché il login della 6.5-6.8
//    manda gbUser ma non ancora la version.
// I client <6.5 non inviano né version né gbUser → esenti.
const GB_ENFORCE_FROM = "6.5";
function gbEnforced(body) {
  const version = body && body.version;
  if (version) return DB.compareVersions(version, GB_ENFORCE_FROM) >= 0;
  return body && Object.prototype.hasOwnProperty.call(body, "gbUser");
}

// ───────── rate limiter in-memory (per IP) per gli endpoint sensibili ─────────
const rateBuckets = new Map();
function rateLimit(key, max = 10, windowMs = 60_000) {
  const nowT = Date.now();
  const b = rateBuckets.get(key);
  if (!b || nowT > b.reset) {
    rateBuckets.set(key, { count: 1, reset: nowT + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}
// pulizia periodica dei bucket scaduti
setInterval(() => {
  const nowT = Date.now();
  for (const [k, v] of rateBuckets) if (nowT > v.reset) rateBuckets.delete(k);
}, 60_000).unref?.();

// ───────────────────────── server ─────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") return json(res, 204, {});

  try {
    // healthcheck per Railway / uptime monitor
    if (path === "/api/health" && method === "GET") {
      return json(res, 200, { ok: true, status: "up", ts: new Date().toISOString() });
    }

    // versione più recente pubblicata (l'estensione la confronta con la propria)
    if (path === "/api/version" && method === "GET") {
      const v = DB.getAppVersion();
      const current = url.searchParams.get("current");
      const outdated = current ? DB.compareVersions(v.version, current) > 0 : false;
      return json(res, 200, {
        ok: true,
        latest: v.version,
        changelog: v.changelog,
        download_url: v.download_url,
        mandatory: !!v.mandatory,
        outdated
      });
    }

    // ═══════════ API PLUGIN (client) ═══════════

    // login del cliente dal plugin — gbUser = username Goldbet letto dalla pagina.
    // "active" è true SOLO se la licenza è attiva E l'account Goldbet è autorizzato.
    if (path === "/api/login" && method === "POST") {
      if (!rateLimit("login:" + clientIp(req), 10, 60_000))
        return json(res, 429, { ok: false, error: "Troppi tentativi, riprova tra un minuto" });
      const body = await readBody(req);
      const { email, password, gbUser, version, bookmaker } = body;
      const bk = (bookmaker || "goldbet").toLowerCase();
      const user = DB.checkLogin(email || "", password || "");
      if (!user) {
        // se l'email esiste, registra il tentativo fallito (password sbagliata)
        const existing = DB.getUserByEmail(email || "");
        if (existing) DB.logUsage(existing.id, "fastbet", "login_fallito",
          { motivo: "password errata", gbUser: gbUser || null });
        return json(res, 401, { ok: false, error: "Credenziali non valide" });
      }
      const licenseActive = DB.isProductActive(user.id, "fastbet");
      const enforce = gbEnforced(body);
      // client <6.5: vincolo non applicato → gb_allowed = true (comportamento legacy)
      const gbAllowed = enforce ? DB.isGoldbetAccountAllowed(user.id, gbUser, bk) : true;
      const active = licenseActive && gbAllowed;
      const token = DB.createSession(user.id);
      DB.logUsage(user.id, "fastbet", "login",
        { active, gbUser: gbUser || null, gbAllowed, bookmaker: bk, version: version || null, gbEnforced: enforce });
      return json(res, 200, {
        ok: true, token, email: user.email,
        active, license_active: licenseActive, gb_allowed: gbAllowed
      });
    }

    // il plugin verifica periodicamente se è ancora attivo (e ritira i comandi remoti)
    if (path === "/api/check" && method === "POST") {
      const body = await readBody(req);
      const { token, version, gbUser, bookmaker } = body;
      const bk = (bookmaker || "goldbet").toLowerCase();
      const sess = DB.getSession(token || "");
      if (!sess) return json(res, 401, { ok: false, error: "Sessione non valida" });
      DB.touchSession(token);
      const licenseActive = DB.isProductActive(sess.user_id, "fastbet");
      const enforce = gbEnforced(body);
      // client <6.5: vincolo non applicato → gb_allowed = true (comportamento legacy)
      const gbAllowed = enforce ? DB.isGoldbetAccountAllowed(sess.user_id, gbUser, bk) : true;
      const active = licenseActive && gbAllowed;
      const commands = DB.popCommands(sess.user_id);
      DB.logUsage(sess.user_id, "fastbet", "check",
        { active, gbUser: gbUser || null, gbAllowed, bookmaker: bk, version: version || null, gbEnforced: enforce });
      // info aggiornamento se il client ha mandato la sua versione
      let update = null;
      if (version) {
        const v = DB.getAppVersion();
        if (DB.compareVersions(v.version, version) > 0) {
          update = { latest: v.version, changelog: v.changelog, download_url: v.download_url, mandatory: !!v.mandatory };
        }
      }
      // account extra (multi-account) importati per questo utente: l'estensione li
      // ritira e fa i login lei (Akamai lato browser). Solo se ce ne sono.
      const extraAccounts = DB.getExtraAccounts(sess.user_id);
      return json(res, 200, {
        ok: true, active, license_active: licenseActive, gb_allowed: gbAllowed, commands, update,
        extra_accounts: extraAccounts
      });
    }

    // il plugin invia un evento di telemetria (es. una giocata)
    if (path === "/api/event" && method === "POST") {
      const { token, event, detail } = await readBody(req);
      const sess = DB.getSession(token || "");
      if (!sess) return json(res, 401, { ok: false, error: "Sessione non valida" });
      DB.logUsage(sess.user_id, "fastbet", event || "event", detail || null);
      return json(res, 200, { ok: true });
    }

    // il background worker invia uno snapshot delle tab aperte ogni 5 min
    if (path === "/api/tabs" && method === "POST") {
      const { token, tabs } = await readBody(req);
      const sess = DB.getSession(token || "");
      if (!sess) return json(res, 401, { ok: false, error: "Sessione non valida" });
      DB.touchSession(token);
      DB.saveTabSnapshot(sess.user_id, tabs || []);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/logout" && method === "POST") {
      const { token } = await readBody(req);
      if (token) DB.deleteSession(token);
      return json(res, 200, { ok: true });
    }

    // ═══════════ API ADMIN (dashboard) ═══════════

    if (path === "/api/admin/login" && method === "POST") {
      const { password } = await readBody(req);
      if (password === ADMIN_PASSWORD) return json(res, 200, { ok: true, token: ADMIN_TOKEN });
      return json(res, 401, { ok: false, error: "Password admin errata" });
    }

    // da qui in poi serve essere admin
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return json(res, 403, { ok: false, error: "Non autorizzato" });

      if (path === "/api/admin/users" && method === "GET") {
        return json(res, 200, { ok: true, users: DB.listUsers() });
      }

      if (path === "/api/admin/users" && method === "POST") {
        const { email, password, note } = await readBody(req);
        if (!email || !password) return json(res, 400, { ok: false, error: "Email e password richieste" });
        if (DB.getUserByEmail(email)) return json(res, 409, { ok: false, error: "Email già esistente" });
        const u = DB.createUser(email, password, note || "");
        return json(res, 200, { ok: true, user: { id: u.id, email: u.email } });
      }

      // ── account bookmaker legati a una licenza (multi-bookmaker) ──
      // GET ?userId=&bookmaker=  → lista account di quel bookmaker (default goldbet).
      // Senza bookmaker → tutti gli account raggruppati per bookmaker + lista bookmaker supportati.
      if (path === "/api/admin/goldbet-accounts" && method === "GET") {
        const uid = url.searchParams.get("userId");
        if (!uid) return json(res, 400, { ok: false, error: "userId richiesto" });
        const bk = url.searchParams.get("bookmaker");
        if (bk) return json(res, 200, { ok: true, bookmaker: bk, accounts: DB.getGoldbetAccounts(+uid, bk) });
        return json(res, 200, {
          ok: true,
          byBookmaker: DB.getBookmakerAccounts(+uid),
          bookmakers: DB.BOOKMAKERS,
          accounts: DB.getGoldbetAccounts(+uid, "goldbet")   // compat: lista goldbet
        });
      }

      // sostituisce la lista di UN bookmaker: { userId, accounts:[...], bookmaker:"lottomatica" }
      // bookmaker assente → "goldbet" (retrocompatibile con la dashboard vecchia).
      if (path === "/api/admin/goldbet-accounts" && method === "POST") {
        const { userId, accounts, bookmaker } = await readBody(req);
        if (!userId) return json(res, 400, { ok: false, error: "userId richiesto" });
        const list = DB.setGoldbetAccounts(userId, accounts || [], bookmaker || "goldbet");
        return json(res, 200, { ok: true, bookmaker: (bookmaker || "goldbet"), accounts: list });
      }

      // attiva/disattiva fastbet per un utente
      if (path === "/api/admin/activate" && method === "POST") {
        const { userId, active, expiresAt } = await readBody(req);
        DB.setActivation(userId, "fastbet", !!active, expiresAt || null);
        return json(res, 200, { ok: true });
      }

      // abilita/disabilita il multibook (replica di gruppo) per un utente
      if (path === "/api/admin/multibook" && method === "POST") {
        const { userId, enabled } = await readBody(req);
        if (!userId) return json(res, 400, { ok: false, error: "userId richiesto" });
        const state = DB.setMultibookEnabled(userId, !!enabled);
        return json(res, 200, { ok: true, multibook_enabled: state });
      }

      // ── account extra (multi-account): import da TXT, lista, elimina ──
      // import: body { userId, txt } con righe "user:psw:G/L/P". Ritorna importati + errori.
      if (path === "/api/admin/extra-accounts/import" && method === "POST") {
        const { userId, txt } = await readBody(req);
        if (!userId || !txt) return json(res, 400, { ok: false, error: "userId e txt richiesti" });
        const { accounts, errors } = DB.parseAccountsTxt(txt);
        const imported = DB.importExtraAccounts(userId, accounts);
        return json(res, 200, { ok: true, imported, parsed: accounts.length, errors });
      }
      if (path === "/api/admin/extra-accounts" && method === "GET") {
        const uid = url.searchParams.get("userId");
        if (!uid) return json(res, 400, { ok: false, error: "userId richiesto" });
        return json(res, 200, { ok: true, accounts: DB.getExtraAccounts(+uid) });
      }
      if (path === "/api/admin/extra-accounts/delete" && method === "POST") {
        const { userId, bookmaker, username } = await readBody(req);
        if (!userId || !bookmaker || !username) return json(res, 400, { ok: false, error: "userId, bookmaker, username richiesti" });
        const removed = DB.deleteExtraAccount(userId, bookmaker, username);
        return json(res, 200, { ok: true, removed });
      }

      if (path === "/api/admin/delete-user" && method === "POST") {
        const { userId } = await readBody(req);
        DB.deleteUser(userId);
        return json(res, 200, { ok: true });
      }

      if (path === "/api/admin/set-password" && method === "POST") {
        const { userId, password } = await readBody(req);
        if (!password) return json(res, 400, { ok: false, error: "Password richiesta" });
        DB.setPassword(userId, password);
        return json(res, 200, { ok: true });
      }

      if (path === "/api/admin/usage" && method === "GET") {
        const uid = url.searchParams.get("userId");
        return json(res, 200, { ok: true, usage: DB.getUsage(uid ? +uid : null) });
      }

      // storico giocate piazzate + totali (puntate e vincite potenziali)
      if (path === "/api/admin/bets" && method === "GET") {
        const uid = url.searchParams.get("userId");
        const days = url.searchParams.get("days");
        const r = DB.getPlacedBets(uid ? +uid : null, days ? +days : null);
        return json(res, 200, { ok: true, bets: r.bets, totali: r.totali });
      }

      if (path === "/api/admin/stats" && method === "GET") {
        return json(res, 200, { ok: true, stats: DB.getStats() });
      }

      // catture sniff multi-bookmaker (per account); ?userId=&days=&aamsId=
      if (path === "/api/admin/sniff" && method === "GET") {
        const uid = url.searchParams.get("userId");
        const days = url.searchParams.get("days");
        const aamsId = url.searchParams.get("aamsId");
        return json(res, 200, {
          ok: true,
          sniff: DB.getSniffEvents(uid ? +uid : null, days ? +days : null, aamsId || null)
        });
      }

      // snapshot tab per utente (storico)
      if (path === "/api/admin/tabs" && method === "GET") {
        const uid = url.searchParams.get("userId");
        return json(res, 200, { ok: true, tabs: DB.getTabSnapshots(uid ? +uid : null) });
      }

      // vista LIVE: ultima tab attiva per utente + stato online
      if (path === "/api/admin/live" && method === "GET") {
        return json(res, 200, { ok: true, live: DB.getLiveTabs() });
      }

      // ── controllo remoto ──
      // accoda un comando generico per un utente
      if (path === "/api/admin/command" && method === "POST") {
        const { userId, type, payload } = await readBody(req);
        if (!userId || !type) return json(res, 400, { ok: false, error: "userId e type richiesti" });
        const id = DB.queueCommand(userId, type, payload || null);
        return json(res, 200, { ok: true, id });
      }

      // kill/logout remoto immediato: invalida le sessioni + accoda logout
      if (path === "/api/admin/kill" && method === "POST") {
        const { userId } = await readBody(req);
        if (!userId) return json(res, 400, { ok: false, error: "userId richiesto" });
        DB.queueCommand(userId, "logout", null);
        const killed = DB.deleteUserSessions(userId);
        return json(res, 200, { ok: true, killed });
      }

      if (path === "/api/admin/commands" && method === "GET") {
        const uid = url.searchParams.get("userId");
        return json(res, 200, { ok: true, commands: DB.getRecentCommands(uid ? +uid : null) });
      }

      // ── analitiche ──
      if (path === "/api/admin/analytics/domains" && method === "GET") {
        const uid = url.searchParams.get("userId");
        const days = +(url.searchParams.get("days") || 7);
        return json(res, 200, { ok: true, domains: DB.getDomainStats(uid ? +uid : null, days) });
      }

      if (path === "/api/admin/analytics/activity" && method === "GET") {
        const days = +(url.searchParams.get("days") || 30);
        return json(res, 200, { ok: true, daily: DB.getDailyActivity(days), hourly: DB.getHourlyActivity(days) });
      }

      if (path === "/api/admin/timeline" && method === "GET") {
        const uid = url.searchParams.get("userId");
        if (!uid) return json(res, 400, { ok: false, error: "userId richiesto" });
        return json(res, 200, { ok: true, timeline: DB.getUserTimeline(+uid) });
      }

      if (path === "/api/admin/expiring" && method === "GET") {
        const days = +(url.searchParams.get("days") || 14);
        return json(res, 200, { ok: true, expiring: DB.getExpiringLicenses(days) });
      }

      // export CSV
      if (path === "/api/admin/export" && method === "GET") {
        const type = url.searchParams.get("type") || "users";
        const uid = url.searchParams.get("userId");
        const days = url.searchParams.get("days");
        let csv;
        if (type === "events") csv = DB.exportEventsCsv();
        else if (type === "bets") csv = DB.exportPlacedBetsCsv(uid ? +uid : null, days ? +days : null);
        else csv = DB.exportUsersCsv();
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${type}.csv"`,
          "Access-Control-Allow-Origin": "*"
        });
        return res.end(csv);
      }

      // ── versione estensione ──
      if (path === "/api/admin/version" && method === "GET") {
        return json(res, 200, { ok: true, version: DB.getAppVersion() });
      }
      if (path === "/api/admin/version" && method === "POST") {
        const { version, changelog, downloadUrl, mandatory } = await readBody(req);
        if (!version) return json(res, 400, { ok: false, error: "version richiesta" });
        const v = DB.setAppVersion(version, changelog || "", downloadUrl || "", !!mandatory);
        return json(res, 200, { ok: true, version: v });
      }
    }

    // ═══════════ download estensioni (pubblici, per la dashboard e i link) ═══════════
    // elenco versioni + changelog dal manifesto generato da release.mjs
    if (path === "/api/downloads" && method === "GET") {
      try {
        const raw = await readFile(join(DOWNLOADS_DIR, "versions.json"), "utf8");
        return json(res, 200, { ok: true, extensions: JSON.parse(raw) });
      } catch {
        return json(res, 200, { ok: true, extensions: {} });  // nessun rilascio ancora
      }
    }
    // scarica un singolo ZIP: /api/download/<file>.zip (solo file .zip, no path traversal)
    if (path.startsWith("/api/download/") && method === "GET") {
      const file = decodeURIComponent(path.slice("/api/download/".length));
      if (!/^[A-Za-z0-9._-]+\.zip$/.test(file)) return json(res, 400, { ok: false, error: "Nome file non valido" });
      try {
        const content = await readFile(join(DOWNLOADS_DIR, file));
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${file}"`,
          "Access-Control-Allow-Origin": "*"
        });
        return res.end(content);
      } catch {
        return json(res, 404, { ok: false, error: "File non trovato" });
      }
    }

    // ═══════════ serve la dashboard statica ═══════════
    if (method === "GET" && !path.startsWith("/api/")) {
      let file = path === "/" ? "/index.html" : path;
      const full = join(DASHBOARD_DIR, file);
      try {
        const content = await readFile(full);
        const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(full)] || "text/plain";
        res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
        return res.end(content);
      } catch {
        res.writeHead(404); return res.end("Not found");
      }
    }

    json(res, 404, { ok: false, error: "Endpoint non trovato" });
  } catch (err) {
    console.error("Errore:", err);
    json(res, 500, { ok: false, error: "Errore interno" });
  }
});

// ───────── retention: pulizia periodica di snapshot e sessioni vecchie ─────────
const SNAPSHOT_RETENTION_DAYS = +(process.env.SNAPSHOT_RETENTION_DAYS || 14);
const SESSION_RETENTION_DAYS  = +(process.env.SESSION_RETENTION_DAYS  || 30);
function runRetention() {
  try {
    const s = DB.pruneTabSnapshots(SNAPSHOT_RETENTION_DAYS);
    const q = DB.pruneSessions(SESSION_RETENTION_DAYS);
    if (s || q) console.log(`  🧹 Retention: ${s} snapshot e ${q} sessioni rimossi`);
  } catch (e) { console.error("Retention error:", e); }
}
runRetention();                                    // all'avvio
setInterval(runRetention, 6 * 60 * 60 * 1000).unref?.();  // ogni 6 ore

server.listen(PORT, "0.0.0.0", () => {
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  console.log(`\n  🔑 License backend attivo`);
  console.log(`  ├─ Dashboard admin: ${base}/`);
  console.log(`  ├─ API plugin:      ${base}/api/`);
  console.log(`  ├─ Health:          ${base}/api/health`);
  console.log(`  └─ DB: ${process.env.DB_PATH || "locale"}\n`);
});
