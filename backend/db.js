// db.js — database SQLite (nativo Node 22) per il sistema licenze
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "licenses.db");
const db = new DatabaseSync(DB_PATH);

// ───────────────────────── schema ─────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT UNIQUE NOT NULL,
    pass_hash   TEXT NOT NULL,
    pass_salt   TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    code        TEXT PRIMARY KEY,        -- es. "fastbet"
    name        TEXT NOT NULL
  );

  -- attivazione di un prodotto per un utente
  CREATE TABLE IF NOT EXISTS activations (
    user_id      INTEGER NOT NULL,
    product_code TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 0,   -- 0/1
    activated_at TEXT,
    expires_at   TEXT,                          -- opzionale (NULL = nessuna scadenza)
    PRIMARY KEY (user_id, product_code),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- account Goldbet autorizzati per una licenza (username normalizzati lowercase).
  -- Il plugin funziona SOLO se l'utente loggato su Goldbet è in questa lista.
  CREATE TABLE IF NOT EXISTS goldbet_accounts (
    user_id      INTEGER NOT NULL,
    username     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, username),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- log degli utilizzi (telemetria d'uso del plugin)
  CREATE TABLE IF NOT EXISTS usage_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    product_code TEXT NOT NULL,
    event        TEXT NOT NULL,        -- es. "login", "bet", "check"
    detail       TEXT,                 -- JSON con dati extra
    ts           TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- sessioni (token di login del plugin)
  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT,                 -- aggiornato a ogni check/tabs → serve per "chi è online"
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- snapshot delle tab aperte per utente (tabella dedicata, non più in usage_log)
  CREATE TABLE IF NOT EXISTS tab_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    tabs         TEXT NOT NULL,        -- JSON array delle tab
    tab_count    INTEGER NOT NULL DEFAULT 0,
    active_url   TEXT,                 -- url della tab attiva (per la vista live)
    active_title TEXT,
    ts           TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- coda comandi remoti: l'admin accoda, il plugin li ritira al check
  CREATE TABLE IF NOT EXISTS commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    type         TEXT NOT NULL,        -- es. "logout", "message", "config"
    payload      TEXT,                 -- JSON opzionale
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- versione più recente pubblicata dell'estensione (per l'avviso di aggiornamento)
  CREATE TABLE IF NOT EXISTS app_version (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    version     TEXT NOT NULL,
    changelog   TEXT,
    download_url TEXT,
    mandatory   INTEGER NOT NULL DEFAULT 0,   -- 1 = blocca l'uso finché non aggiorna
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_user_ts   ON usage_log(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_event     ON usage_log(event);
  CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_snap_user_ts    ON tab_snapshots(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_snap_ts         ON tab_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_cmd_user_status ON commands(user_id, status);
`);

// migrazione soft: aggiunge last_seen_at se il DB è vecchio
try { db.exec(`ALTER TABLE sessions ADD COLUMN last_seen_at TEXT`); } catch { /* colonna già presente */ }

// prodotto fastbet di default
db.prepare(`INSERT OR IGNORE INTO products (code, name) VALUES (?, ?)`)
  .run("fastbet", "Goldbet Fast Bet");

// versione iniziale dell'estensione (allineata al manifest corrente)
db.prepare(`INSERT OR IGNORE INTO app_version (id, version, changelog, download_url, mandatory, updated_at)
            VALUES (1, ?, ?, ?, 0, ?)`)
  .run("6.8", "Versione iniziale registrata", "", new Date().toISOString());

// ───────────────────────── password helpers ─────────────────────────
function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const now = () => new Date().toISOString();

// ───────────────────────── utenti ─────────────────────────
export function createUser(email, password, note = "") {
  const { hash, salt } = hashPassword(password);
  const stmt = db.prepare(
    `INSERT INTO users (email, pass_hash, pass_salt, note, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(email.toLowerCase().trim(), hash, salt, note, now());
  return getUserById(info.lastInsertRowid);
}

export function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
}
export function getUserById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

export function checkLogin(email, password) {
  const u = getUserByEmail(email);
  if (!u) return null;
  if (!verifyPassword(password, u.pass_salt, u.pass_hash)) return null;
  return u;
}

export function listUsers() {
  const users = db.prepare(`SELECT id, email, note, created_at FROM users ORDER BY id DESC`).all();
  // aggiunge lo stato fastbet di ciascuno
  return users.map(u => {
    const act = getActivation(u.id, "fastbet");
    return { ...u, fastbet_active: act ? !!act.active : false, gb_accounts: getGoldbetAccounts(u.id) };
  });
}

export function deleteUser(id) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

export function setPassword(id, password) {
  const { hash, salt } = hashPassword(password);
  db.prepare(`UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?`).run(hash, salt, id);
}

// ───────────────────────── attivazioni ─────────────────────────
export function getActivation(userId, productCode) {
  return db.prepare(`SELECT * FROM activations WHERE user_id = ? AND product_code = ?`)
    .get(userId, productCode);
}

export function setActivation(userId, productCode, active, expiresAt = null) {
  const existing = getActivation(userId, productCode);
  if (existing) {
    db.prepare(`UPDATE activations SET active = ?, activated_at = ?, expires_at = ? WHERE user_id = ? AND product_code = ?`)
      .run(active ? 1 : 0, active ? now() : existing.activated_at, expiresAt, userId, productCode);
  } else {
    db.prepare(`INSERT INTO activations (user_id, product_code, active, activated_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(userId, productCode, active ? 1 : 0, active ? now() : null, expiresAt);
  }
  return getActivation(userId, productCode);
}

// verifica se un prodotto è attivo e non scaduto
export function isProductActive(userId, productCode) {
  const a = getActivation(userId, productCode);
  if (!a || !a.active) return false;
  if (a.expires_at && new Date(a.expires_at) < new Date()) return false;
  return true;
}

// ───────────────────────── account Goldbet ─────────────────────────
const normGb = (u) => String(u || "").trim().toLowerCase();

export function getGoldbetAccounts(userId) {
  return db.prepare(`SELECT username FROM goldbet_accounts WHERE user_id = ? ORDER BY username`)
    .all(userId).map(r => r.username);
}

// sostituisce l'intera lista di account autorizzati per una licenza
export function setGoldbetAccounts(userId, usernames) {
  const list = [...new Set((Array.isArray(usernames) ? usernames : []).map(normGb).filter(Boolean))];
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM goldbet_accounts WHERE user_id = ?`).run(userId);
    const ins = db.prepare(`INSERT INTO goldbet_accounts (user_id, username, created_at) VALUES (?, ?, ?)`);
    for (const u of list) ins.run(userId, u, now());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return getGoldbetAccounts(userId);
}

// true solo se lo username Goldbet (case-insensitive) è nella lista della licenza.
// Lista vuota o username mancante → false: senza legame il plugin non si apre.
export function isGoldbetAccountAllowed(userId, gbUser) {
  const u = normGb(gbUser);
  if (!u) return false;
  return !!db.prepare(`SELECT 1 FROM goldbet_accounts WHERE user_id = ? AND username = ?`).get(userId, u);
}

// ───────────────────────── sessioni ─────────────────────────
export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const t = now();
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, t, t);
  return token;
}
export function getSession(token) {
  return db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
}
export function touchSession(token) {
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`).run(now(), token);
}
export function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}
// elimina sessioni più vecchie di N giorni (default 30)
export function pruneSessions(days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const info = db.prepare(`DELETE FROM sessions WHERE COALESCE(last_seen_at, created_at) < ?`).run(cutoff);
  return info.changes;
}

// ───────────────────────── telemetria ─────────────────────────
export function logUsage(userId, productCode, event, detail = null) {
  db.prepare(`INSERT INTO usage_log (user_id, product_code, event, detail, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, productCode, event, detail ? JSON.stringify(detail) : null, now());
}

export function getUsage(userId = null, limit = 200) {
  if (userId) {
    return db.prepare(`SELECT u.*, us.email FROM usage_log u JOIN users us ON us.id = u.user_id
                       WHERE u.user_id = ? ORDER BY u.id DESC LIMIT ?`).all(userId, limit);
  }
  return db.prepare(`SELECT u.*, us.email FROM usage_log u JOIN users us ON us.id = u.user_id
                     ORDER BY u.id DESC LIMIT ?`).all(limit);
}

// ───────────────────────── storico giocate piazzate ─────────────────────────
// Estrae dagli eventi "bet" (scommesse piazzate con successo) l'elenco dettagliato
// + i totali (n° giocate, somma puntate, somma vincite potenziali). Filtrabile per
// utente e finestra temporale (giorni). Le vincite sono POTENZIALI (quota×puntata),
// non esiti reali: il plugin non conosce l'esito finale della partita.
export function getPlacedBets(userId = null, days = null, limit = 500) {
  const params = [];
  let where = `u.event = 'bet'`;
  if (userId) { where += ` AND u.user_id = ?`; params.push(userId); }
  if (days)   { where += ` AND u.ts >= ?`; params.push(new Date(Date.now() - days * 864e5).toISOString()); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT u.id, u.ts, u.detail, us.email
    FROM usage_log u JOIN users us ON us.id = u.user_id
    WHERE ${where}
    ORDER BY u.id DESC LIMIT ?
  `).all(...params);

  const bets = rows.map(r => {
    let d = {};
    try { d = JSON.parse(r.detail || "{}"); } catch {}
    const stake = +d.stake || 0;
    const vincita = d.vincita != null ? +d.vincita : null;
    return {
      id: r.id, ts: r.ts, email: r.email,
      stake,
      quotaTot: d.quotaTot != null ? +d.quotaTot : null,
      vincita,
      selezioni: Array.isArray(d.selezioni) ? d.selezioni : [],
      coupon: d.coupon || null,
      mock: !!d.mock,
      retry: d.retry || 0
    };
  });

  const totali = bets.reduce((t, b) => {
    t.count++;
    t.stake += b.stake;
    if (b.vincita != null) { t.vincita += b.vincita; t.vincitaCount++; }
    return t;
  }, { count: 0, stake: 0, vincita: 0, vincitaCount: 0 });
  totali.stake = +totali.stake.toFixed(2);
  totali.vincita = +totali.vincita.toFixed(2);
  // profitto potenziale = vincite potenziali - puntate (solo sulle giocate con vincita nota)
  totali.profitto = +(totali.vincita - bets
    .filter(b => b.vincita != null)
    .reduce((s, b) => s + b.stake, 0)).toFixed(2);

  return { bets, totali };
}

// export CSV delle giocate piazzate
export function exportPlacedBetsCsv(userId = null, days = null) {
  const { bets } = getPlacedBets(userId, days, 100000);
  const rows = bets.map(b => ({
    data: b.ts,
    email: b.email,
    partite: b.selezioni.map(s => s.partita || [s.firstTeam, s.secondTeam].filter(Boolean).join(" - ") || "n.d.").join(" + "),
    esiti: b.selezioni.map(s => [s.mercato, s.esito].filter(Boolean).join(": ")).join(" + "),
    quota_tot: b.quotaTot ?? "",
    puntata: b.stake,
    vincita_potenziale: b.vincita ?? "",
    coupon: b.coupon || "",
    mock: b.mock ? "si" : "no"
  }));
  return toCsv(rows, ["data", "email", "partite", "esiti", "quota_tot", "puntata", "vincita_potenziale", "coupon", "mock"]);
}

// ───────────────────────── tab snapshots ─────────────────────────
export function saveTabSnapshot(userId, tabs = []) {
  const arr = Array.isArray(tabs) ? tabs : [];
  const activeTab = arr.find(t => t && t.active) || arr[0] || null;
  db.prepare(`INSERT INTO tab_snapshots (user_id, tabs, tab_count, active_url, active_title, ts)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      userId,
      JSON.stringify(arr),
      arr.length,
      activeTab ? (activeTab.url || "") : null,
      activeTab ? (activeTab.title || "") : null,
      now()
    );
}

// storico snapshot (formato compatibile con la dashboard: id, email, ts, detail JSON)
export function getTabSnapshots(userId = null, limit = 100) {
  const rows = userId
    ? db.prepare(`SELECT s.*, us.email FROM tab_snapshots s JOIN users us ON us.id = s.user_id
                  WHERE s.user_id = ? ORDER BY s.id DESC LIMIT ?`).all(userId, limit)
    : db.prepare(`SELECT s.*, us.email FROM tab_snapshots s JOIN users us ON us.id = s.user_id
                  ORDER BY s.id DESC LIMIT ?`).all(limit);
  return rows.map(r => ({ id: r.id, email: r.email, ts: r.ts, detail: JSON.stringify({ tabs: JSON.parse(r.tabs || "[]") }) }));
}

// vista LIVE: ultimo snapshot per ogni utente + se è "online" (last_seen recente)
export function getLiveTabs(onlineWindowMin = 12) {
  const cutoff = new Date(Date.now() - onlineWindowMin * 60_000).toISOString();
  return db.prepare(`
    SELECT u.id AS user_id, u.email,
           s.active_url, s.active_title, s.tab_count, s.ts AS last_snapshot,
           sess.last_seen AS last_seen
    FROM users u
    JOIN (
      SELECT t1.* FROM tab_snapshots t1
      JOIN (SELECT user_id, MAX(id) mid FROM tab_snapshots GROUP BY user_id) t2
        ON t1.id = t2.mid
    ) s ON s.user_id = u.id
    LEFT JOIN (
      SELECT user_id, MAX(COALESCE(last_seen_at, created_at)) last_seen
      FROM sessions GROUP BY user_id
    ) sess ON sess.user_id = u.id
    ORDER BY s.ts DESC
  `).all().map(r => ({ ...r, online: !!(r.last_seen && r.last_seen >= cutoff) }));
}

// retention: elimina snapshot più vecchi di N giorni (default 14)
export function pruneTabSnapshots(days = 14) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const info = db.prepare(`DELETE FROM tab_snapshots WHERE ts < ?`).run(cutoff);
  return info.changes;
}

// ───────────────────────── comandi remoti ─────────────────────────
export function queueCommand(userId, type, payload = null) {
  const info = db.prepare(
    `INSERT INTO commands (user_id, type, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)`
  ).run(userId, type, payload ? JSON.stringify(payload) : null, now());
  return info.lastInsertRowid;
}

// ritira i comandi pendenti di un utente e li marca come consegnati
export function popCommands(userId) {
  const rows = db.prepare(
    `SELECT id, type, payload FROM commands WHERE user_id = ? AND status = 'pending' ORDER BY id ASC`
  ).all(userId);
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const t = now();
    const ph = ids.map(() => "?").join(",");
    db.prepare(`UPDATE commands SET status='delivered', delivered_at=? WHERE id IN (${ph})`).run(t, ...ids);
  }
  return rows.map(r => ({ id: r.id, type: r.type, payload: r.payload ? JSON.parse(r.payload) : null }));
}

export function getRecentCommands(userId = null, limit = 50) {
  const rows = userId
    ? db.prepare(`SELECT c.*, u.email FROM commands c JOIN users u ON u.id=c.user_id
                  WHERE c.user_id=? ORDER BY c.id DESC LIMIT ?`).all(userId, limit)
    : db.prepare(`SELECT c.*, u.email FROM commands c JOIN users u ON u.id=c.user_id
                  ORDER BY c.id DESC LIMIT ?`).all(limit);
  return rows;
}

// invalida tutte le sessioni di un utente (kill remoto immediato)
export function deleteUserSessions(userId) {
  const info = db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  return info.changes;
}

// ───────────────────────── analitiche ─────────────────────────
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// tempo stimato per dominio: ogni snapshot ≈ intervallo (5 min) sulla tab attiva
export function getDomainStats(userId = null, days = 7, intervalMin = 5) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const rows = userId
    ? db.prepare(`SELECT active_url FROM tab_snapshots WHERE user_id=? AND ts>=? AND active_url IS NOT NULL`).all(userId, cutoff)
    : db.prepare(`SELECT active_url FROM tab_snapshots WHERE ts>=? AND active_url IS NOT NULL`).all(cutoff);
  const map = new Map();
  for (const r of rows) {
    const h = hostOf(r.active_url);
    if (!h) continue;
    map.set(h, (map.get(h) || 0) + 1);
  }
  return [...map.entries()]
    .map(([host, snaps]) => ({ host, snapshots: snaps, minutes: snaps * intervalMin }))
    .sort((a, b) => b.minutes - a.minutes);
}

// timeline unificata di un utente: eventi + snapshot, in ordine cronologico
export function getUserTimeline(userId, limit = 100) {
  const events = db.prepare(
    `SELECT ts, event AS kind, detail FROM usage_log WHERE user_id=? ORDER BY id DESC LIMIT ?`
  ).all(userId, limit).map(e => ({ ts: e.ts, kind: e.kind, detail: e.detail }));
  const snaps = db.prepare(
    `SELECT ts, active_url, active_title, tab_count FROM tab_snapshots WHERE user_id=? ORDER BY id DESC LIMIT ?`
  ).all(userId, limit).map(s => ({
    ts: s.ts, kind: "tabs",
    detail: JSON.stringify({ url: s.active_url, title: s.active_title, count: s.tab_count })
  }));
  return [...events, ...snaps].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

// attività giornaliera (utenti distinti attivi per giorno)
export function getDailyActivity(days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  return db.prepare(`
    SELECT substr(ts,1,10) AS day,
           COUNT(DISTINCT user_id) AS users,
           COUNT(*) AS events
    FROM usage_log WHERE ts >= ?
    GROUP BY day ORDER BY day ASC
  `).all(cutoff);
}

// heatmap oraria (eventi per ora del giorno, UTC)
export function getHourlyActivity(days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const rows = db.prepare(`
    SELECT CAST(substr(ts,12,2) AS INTEGER) AS hour, COUNT(*) AS events
    FROM usage_log WHERE ts >= ? GROUP BY hour
  `).all(cutoff);
  const out = Array.from({ length: 24 }, (_, h) => ({ hour: h, events: 0 }));
  for (const r of rows) if (r.hour >= 0 && r.hour < 24) out[r.hour].events = r.events;
  return out;
}

// licenze in scadenza entro N giorni (o già scadute)
export function getExpiringLicenses(days = 14) {
  const limit = new Date(Date.now() + days * 864e5).toISOString();
  const nowIso = now();
  return db.prepare(`
    SELECT u.id AS user_id, u.email, a.expires_at, a.active
    FROM activations a JOIN users u ON u.id = a.user_id
    WHERE a.product_code='fastbet' AND a.expires_at IS NOT NULL AND a.expires_at <= ?
    ORDER BY a.expires_at ASC
  `).all(limit).map(r => ({
    ...r,
    active: !!r.active,
    expired: r.expires_at < nowIso,
    days_left: Math.ceil((new Date(r.expires_at) - new Date(nowIso)) / 864e5)
  }));
}

// export CSV
function toCsv(rows, cols) {
  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = cols.join(",");
  const body = rows.map(r => cols.map(c => esc(r[c])).join(",")).join("\n");
  return head + "\n" + body;
}
export function exportUsersCsv() {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.note, u.created_at,
           COALESCE(a.active,0) AS fastbet_active, a.expires_at,
           (SELECT GROUP_CONCAT(username, ' ') FROM goldbet_accounts g WHERE g.user_id = u.id) AS gb_accounts
    FROM users u
    LEFT JOIN activations a ON a.user_id=u.id AND a.product_code='fastbet'
    ORDER BY u.id
  `).all();
  return toCsv(rows, ["id", "email", "note", "created_at", "fastbet_active", "expires_at", "gb_accounts"]);
}
export function exportEventsCsv(limit = 5000) {
  const rows = db.prepare(`
    SELECT u.id, us.email, u.event, u.detail, u.ts
    FROM usage_log u JOIN users us ON us.id=u.user_id
    ORDER BY u.id DESC LIMIT ?
  `).all(limit);
  return toCsv(rows, ["id", "email", "event", "detail", "ts"]);
}

export function getStats(onlineWindowMin = 12) {
  const cutoff = new Date(Date.now() - onlineWindowMin * 60_000).toISOString();
  const totUsers = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const activeFastbet = db.prepare(`SELECT COUNT(*) c FROM activations WHERE product_code='fastbet' AND active=1`).get().c;
  const totEvents = db.prepare(`SELECT COUNT(*) c FROM usage_log`).get().c;
  const bets = db.prepare(`SELECT COUNT(*) c FROM usage_log WHERE event='bet'`).get().c;
  const online = db.prepare(
    `SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE COALESCE(last_seen_at, created_at) >= ?`
  ).get(cutoff).c;
  return { totUsers, activeFastbet, totEvents, bets, online };
}

// ───────────────────────── versione estensione ─────────────────────────
export function getAppVersion() {
  return db.prepare(`SELECT version, changelog, download_url, mandatory, updated_at FROM app_version WHERE id = 1`).get()
    || { version: "0.0", changelog: "", download_url: "", mandatory: 0, updated_at: null };
}

export function setAppVersion(version, changelog = "", downloadUrl = "", mandatory = false) {
  db.prepare(`UPDATE app_version SET version=?, changelog=?, download_url=?, mandatory=?, updated_at=? WHERE id=1`)
    .run(String(version), changelog || "", downloadUrl || "", mandatory ? 1 : 0, now());
  return getAppVersion();
}

// confronta due versioni semver-like ("6.4" < "6.10"): >0 se a>b, <0 se a<b, 0 se uguali
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export default db;
