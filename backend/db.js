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
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

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
  db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`)
    .run(token, userId, now());
  return token;
}
export function getSession(token) {
  return db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
}
export function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
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

export function getTabLogs(userId = null, limit = 100) {
  if (userId) {
    return db.prepare(`SELECT u.*, us.email FROM usage_log u JOIN users us ON us.id = u.user_id
                       WHERE u.user_id = ? AND u.event = 'tabs' ORDER BY u.id DESC LIMIT ?`).all(userId, limit);
  }
  return db.prepare(`SELECT u.*, us.email FROM usage_log u JOIN users us ON us.id = u.user_id
                     WHERE u.event = 'tabs' ORDER BY u.id DESC LIMIT ?`).all(limit);
}

export function getStats() {
  const totUsers = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const activeFastbet = db.prepare(`SELECT COUNT(*) c FROM activations WHERE product_code='fastbet' AND active=1`).get().c;
  const totEvents = db.prepare(`SELECT COUNT(*) c FROM usage_log`).get().c;
  const bets = db.prepare(`SELECT COUNT(*) c FROM usage_log WHERE event='bet'`).get().c;
  return { totUsers, activeFastbet, totEvents, bets };
}

export default db;
