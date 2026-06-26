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

// ───────────────────────── server ─────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") return json(res, 204, {});

  try {
    // ═══════════ API PLUGIN (client) ═══════════

    // login del cliente dal plugin
    if (path === "/api/login" && method === "POST") {
      const { email, password } = await readBody(req);
      const user = DB.checkLogin(email || "", password || "");
      if (!user) return json(res, 401, { ok: false, error: "Credenziali non valide" });
      const active = DB.isProductActive(user.id, "fastbet");
      const token = DB.createSession(user.id);
      DB.logUsage(user.id, "fastbet", "login", { active });
      return json(res, 200, { ok: true, token, email: user.email, active });
    }

    // il plugin verifica periodicamente se è ancora attivo
    if (path === "/api/check" && method === "POST") {
      const { token } = await readBody(req);
      const sess = DB.getSession(token || "");
      if (!sess) return json(res, 401, { ok: false, error: "Sessione non valida" });
      const active = DB.isProductActive(sess.user_id, "fastbet");
      DB.logUsage(sess.user_id, "fastbet", "check", { active });
      return json(res, 200, { ok: true, active });
    }

    // il plugin invia un evento di telemetria (es. una giocata)
    if (path === "/api/event" && method === "POST") {
      const { token, event, detail } = await readBody(req);
      const sess = DB.getSession(token || "");
      if (!sess) return json(res, 401, { ok: false, error: "Sessione non valida" });
      DB.logUsage(sess.user_id, "fastbet", event || "event", detail || null);
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

      // attiva/disattiva fastbet per un utente
      if (path === "/api/admin/activate" && method === "POST") {
        const { userId, active, expiresAt } = await readBody(req);
        DB.setActivation(userId, "fastbet", !!active, expiresAt || null);
        return json(res, 200, { ok: true });
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

      if (path === "/api/admin/stats" && method === "GET") {
        return json(res, 200, { ok: true, stats: DB.getStats() });
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

server.listen(PORT, "0.0.0.0", () => {
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  console.log(`\n  🔑 License backend attivo`);
  console.log(`  ├─ Dashboard admin: ${base}/`);
  console.log(`  ├─ API plugin:      ${base}/api/`);
  console.log(`  └─ DB: ${process.env.DB_PATH || "locale"}\n`);
});
