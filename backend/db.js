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

  CREATE INDEX IF NOT EXISTS idx_usage_user_ts   ON usage_log(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_event     ON usage_log(event);
  CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_snap_user_ts    ON tab_snapshots(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_snap_ts         ON tab_snapshots(ts);
`);

// migrazione soft: aggiunge last_seen_at se il DB è vecchio
try { db.exec(`ALTER TABLE sessions ADD COLUMN last_seen_at TEXT`); } catch { /* colonna già presente */ }

// prodotto fastbet di default
db.prepare(`INSERT OR IGNORE INTO products (code, name) VALUES (?, ?)`)
  .run("fastbet", "Goldbet Fast Bet");

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
    return { ...u, fastbet_active: act ? !!act.active : false };
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

export default db;
