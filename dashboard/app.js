// app.js — logica dashboard admin
const API = "";  // stesso host del server
let adminToken = localStorage.getItem("adminToken") || null;

const $ = (id) => document.getElementById(id);

async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers["Authorization"] = "Bearer " + adminToken;
  const res = await fetch(API + path, {
    method, headers, body: body ? JSON.stringify(body) : null
  });
  return res.json();
}

// ───────── login admin ─────────
async function adminLogin() {
  const password = $("adminPass").value;
  const r = await api("/api/admin/login", "POST", { password });
  if (r.ok) {
    adminToken = r.token;
    localStorage.setItem("adminToken", adminToken);
    showApp();
  } else {
    $("loginErr").textContent = r.error || "Errore";
  }
}
function adminLogout() {
  adminToken = null;
  localStorage.removeItem("adminToken");
  $("app").style.display = "none";
  $("loginWrap").style.display = "flex";
}
function showApp() {
  $("loginWrap").style.display = "none";
  $("app").style.display = "block";
  loadStats(); loadUsers(); loadUsage(); loadTabs();
}

// ───────── stats ─────────
async function loadStats() {
  const r = await api("/api/admin/stats");
  if (!r.ok) return;
  const s = r.stats;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${s.totUsers}</div><div class="l">utenti</div></div>
    <div class="stat"><div class="v green">${s.activeFastbet}</div><div class="l">fastbet attivi</div></div>
    <div class="stat"><div class="v blue">${s.bets}</div><div class="l">giocate loggate</div></div>
    <div class="stat"><div class="v">${s.totEvents}</div><div class="l">eventi totali</div></div>`;
}

// ───────── utenti ─────────
async function createUser() {
  const email = $("nuEmail").value.trim();
  const password = $("nuPass").value;
  const note = $("nuNote").value.trim();
  $("nuErr").textContent = "";
  if (!email || !password) { $("nuErr").textContent = "Email e password richieste"; return; }
  const r = await api("/api/admin/users", "POST", { email, password, note });
  if (r.ok) {
    $("nuEmail").value = ""; $("nuPass").value = ""; $("nuNote").value = "";
    loadUsers(); loadStats();
  } else {
    $("nuErr").textContent = r.error || "Errore";
  }
}

async function loadUsers() {
  const r = await api("/api/admin/users");
  if (!r.ok) return;
  const users = r.users;
  const body = $("usersBody");
  $("usersEmpty").style.display = users.length ? "none" : "block";
  body.innerHTML = users.map(u => `
    <tr>
      <td class="email">${esc(u.email)}</td>
      <td>${esc(u.note || "—")}</td>
      <td>${new Date(u.created_at).toLocaleDateString("it-IT")}</td>
      <td><span class="badge ${u.fastbet_active ? "on" : "off"}">${u.fastbet_active ? "ATTIVO" : "OFF"}</span></td>
      <td>
        <div class="row-actions">
          ${u.fastbet_active
            ? `<button class="btn danger sm" onclick="activate(${u.id},false)">Disattiva</button>`
            : `<button class="btn sm" onclick="activate(${u.id},true)">Attiva</button>`}
          <button class="btn ghost sm" onclick="changePass(${u.id})">Password</button>
          <button class="btn ghost sm" onclick="viewUsage(${u.id},'${esc(u.email)}')">Log</button>
          <button class="btn danger sm" onclick="delUser(${u.id},'${esc(u.email)}')">Elimina</button>
        </div>
      </td>
    </tr>`).join("");
}

async function activate(userId, active) {
  await api("/api/admin/activate", "POST", { userId, active });
  loadUsers(); loadStats();
}
async function delUser(userId, email) {
  if (!confirm("Eliminare l'utente " + email + "?")) return;
  await api("/api/admin/delete-user", "POST", { userId });
  loadUsers(); loadStats();
}
async function changePass(userId) {
  const password = prompt("Nuova password per questo utente:");
  if (!password) return;
  await api("/api/admin/set-password", "POST", { userId, password });
  alert("Password aggiornata");
}

// ───────── utilizzo ─────────
async function loadUsage(userId = null) {
  const path = userId ? `/api/admin/usage?userId=${userId}` : "/api/admin/usage";
  const r = await api(path);
  if (!r.ok) return;
  renderUsage(r.usage);
}
function viewUsage(userId, email) {
  loadUsage(userId);
  document.querySelector(".panel:last-child h2").firstChild.textContent = "Utilizzo di " + email + " ";
}
function renderUsage(usage) {
  const list = $("usageList");
  if (!usage.length) { list.innerHTML = '<div class="empty">Nessun evento</div>'; return; }
  list.innerHTML = usage.map(u => `
    <div class="usage-row">
      <span>${new Date(u.ts).toLocaleString("it-IT", { hour12: false })}</span>
      <span>${esc(u.email)}</span>
      <span class="ev">${esc(u.event)}</span>
      <span>${esc(u.detail || "")}</span>
    </div>`).join("");
}

// ───────── tab tracking ─────────
async function loadTabs(userId = null) {
  const path = userId ? `/api/admin/tabs?userId=${userId}` : "/api/admin/tabs";
  const r = await api(path);
  if (!r.ok) return;
  renderTabs(r.tabs);
}
function renderTabs(rows) {
  const el = $("tabsList");
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessuno snapshot ricevuto ancora</div>'; return; }
  el.innerHTML = rows.map((row, i) => {
    let tabs = [];
    try { const d = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail; tabs = d?.tabs || []; } catch (e) {}
    const activeTab = tabs.find(t => t.active);
    const preview = activeTab ? activeTab.title || activeTab.url : (tabs[0]?.url || "—");
    return `
      <div class="tab-snapshot">
        <div class="tab-snapshot-header" onclick="toggleSnapshot(${i})">
          <span class="ts">${new Date(row.ts).toLocaleString("it-IT", { hour12: false })}</span>
          <span class="who">${esc(row.email)}</span>
          <span class="cnt">${tabs.length} tab &nbsp;·&nbsp; ${esc(preview.slice(0, 60))}</span>
        </div>
        <div class="tab-snapshot-body" id="snap-${i}">
          ${tabs.map(t => `
            <div class="tab-row">
              <span class="active-dot">${t.active ? "●" : ""}</span>
              <div>
                <div>${esc(t.title || "(no title)")}</div>
                <div class="url">${esc(t.url)}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
  }).join("");
}
function toggleSnapshot(i) {
  const el = document.getElementById("snap-" + i);
  if (el) el.classList.toggle("open");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

// auto-login se già autenticato
if (adminToken) showApp();
