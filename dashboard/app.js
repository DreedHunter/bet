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
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  $("app").style.display = "none";
  $("loginWrap").style.display = "flex";
}
let liveTimer = null;
function showApp() {
  $("loginWrap").style.display = "none";
  $("app").style.display = "block";
  loadStats(); loadUsers(); loadUsage(); loadTabs(); loadLive();
  loadExpiring(); loadActivity(); loadDomains();
  // auto-refresh della vista live + stats ogni 30s
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => { loadLive(); loadStats(); }, 30000);
}

// ───────── stats ─────────
async function loadStats() {
  const r = await api("/api/admin/stats");
  if (!r.ok) return;
  const s = r.stats;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${s.totUsers}</div><div class="l">utenti</div></div>
    <div class="stat"><div class="v green">${s.activeFastbet}</div><div class="l">fastbet attivi</div></div>
    <div class="stat"><div class="v green">${s.online ?? 0}</div><div class="l">online adesso</div></div>
    <div class="stat"><div class="v blue">${s.bets}</div><div class="l">giocate loggate</div></div>`;
}

// ───────── vista live ─────────
function relTime(iso) {
  if (!iso) return "mai";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "adesso";
  if (m < 60) return m + " min fa";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " h fa";
  return Math.floor(h / 24) + " g fa";
}
async function loadLive() {
  const r = await api("/api/admin/live");
  if (!r.ok) return;
  const el = $("liveList");
  const rows = r.live || [];
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessun utente attivo</div>'; return; }
  // online prima, poi per ultimo snapshot
  rows.sort((a, b) => (b.online - a.online) || (b.last_snapshot > a.last_snapshot ? 1 : -1));
  el.innerHTML = rows.map(u => {
    const page = u.active_title || u.active_url || "—";
    let host = "";
    try { host = u.active_url ? new URL(u.active_url).hostname : ""; } catch {}
    return `
      <div class="live-row">
        <span class="dot ${u.online ? "on" : ""}" title="${u.online ? "online" : "offline"}"></span>
        <span class="who">${esc(u.email)}</span>
        <span class="page">${esc(page)}<small>${esc(host)}</small></span>
        <span class="cnt">${u.tab_count} tab</span>
        <span class="seen">${esc(relTime(u.last_seen || u.last_snapshot))}</span>
      </div>`;
  }).join("");
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
          <button class="btn ghost sm" onclick="viewTimeline(${u.id},'${esc(u.email)}')">Timeline</button>
          <button class="btn ghost sm" onclick="sendMessage(${u.id},'${esc(u.email)}')">Msg</button>
          <button class="btn danger sm" onclick="killUser(${u.id},'${esc(u.email)}')">Disconnetti</button>
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

// ───────── tab tracking (storico) ─────────
let tabRows = [];
async function loadTabs(userId = null) {
  const path = userId ? `/api/admin/tabs?userId=${userId}` : "/api/admin/tabs";
  const r = await api(path);
  if (!r.ok) return;
  tabRows = r.tabs || [];
  renderTabs();
}
function clearTabFilter() {
  $("tabSearch").value = "";
  loadTabs();
}
function renderTabs() {
  const el = $("tabsList");
  const q = ($("tabSearch")?.value || "").toLowerCase().trim();
  let rows = tabRows;
  if (q) {
    rows = tabRows.filter(row => {
      if ((row.email || "").toLowerCase().includes(q)) return true;
      return (row.detail || "").toLowerCase().includes(q);
    });
  }
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessuno snapshot' + (q ? " per questo filtro" : " ricevuto ancora") + '</div>'; return; }
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

// ───────── controllo remoto ─────────
async function killUser(userId, email) {
  if (!confirm("Disconnettere subito " + email + "? La sua sessione verrà invalidata.")) return;
  const r = await api("/api/admin/kill", "POST", { userId });
  if (r.ok) { alert("Disconnesso (" + (r.killed || 0) + " sessioni chiuse)"); loadLive(); loadStats(); }
  else alert(r.error || "Errore");
}
async function sendMessage(userId, email) {
  const text = prompt("Messaggio da mostrare a " + email + ":");
  if (!text) return;
  const r = await api("/api/admin/command", "POST", { userId, type: "message", payload: { text } });
  alert(r.ok ? "Messaggio accodato — arriverà al prossimo check (entro ~1 min)" : (r.error || "Errore"));
}

// ───────── timeline utente ─────────
async function viewTimeline(userId, email) {
  const r = await api(`/api/admin/timeline?userId=${userId}`);
  if (!r.ok) return;
  const rows = r.timeline || [];
  const dom = () => rows.map(e => `
    <div class="tl-row">
      <span>${new Date(e.ts).toLocaleString("it-IT", { hour12: false })}</span>
      <span class="ev">${esc(e.kind)}</span>
      <span>${esc(e.detail || "")}</span>
    </div>`).join("");
  $("timelineTitle").textContent = "Timeline di " + email;
  $("timelineList").innerHTML = rows.length ? dom() : '<div class="empty">Nessun evento</div>';
  $("timelinePanel").style.display = "block";
  $("timelinePanel").scrollIntoView({ behavior: "smooth" });
}

// ───────── analitiche ─────────
async function loadExpiring() {
  const r = await api("/api/admin/expiring?days=30");
  if (!r.ok) return;
  const rows = r.expiring || [];
  const el = $("expiringList");
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessuna licenza con scadenza nei prossimi 30 giorni</div>'; return; }
  el.innerHTML = rows.map(u => {
    const cls = u.expired ? "off" : (u.days_left <= 3 ? "warn" : "on");
    const label = u.expired ? "SCADUTA" : (u.days_left + "g");
    return `<div class="exp-row">
      <span class="who">${esc(u.email)}</span>
      <span>${new Date(u.expires_at).toLocaleDateString("it-IT")}</span>
      <span class="badge ${cls}">${label}</span>
      ${!u.active ? '<span class="badge off">OFF</span>' : ''}
    </div>`;
  }).join("");
}

async function loadActivity() {
  const r = await api("/api/admin/analytics/activity?days=30");
  if (!r.ok) return;
  // DAU
  const daily = r.daily || [];
  const maxU = Math.max(1, ...daily.map(d => d.users));
  $("dauChart").innerHTML = daily.length ? daily.map(d => `
    <div class="bar" title="${d.day}: ${d.users} utenti, ${d.events} eventi">
      <div class="bar-fill" style="height:${Math.round(d.users / maxU * 100)}%"></div>
      <div class="bar-lbl">${d.day.slice(5)}</div>
    </div>`).join("") : '<div class="empty">Nessun dato</div>';
  // heatmap oraria
  const hourly = r.hourly || [];
  const maxH = Math.max(1, ...hourly.map(h => h.events));
  $("hourChart").innerHTML = hourly.map(h => {
    const intensity = h.events / maxH;
    const bg = intensity === 0 ? "#16264f" : `rgba(255,204,0,${0.15 + intensity * 0.85})`;
    return `<div class="cell" style="background:${bg}" title="${h.hour}:00 — ${h.events} eventi">${h.hour}</div>`;
  }).join("");
}

async function loadDomains() {
  const r = await api("/api/admin/analytics/domains?days=7");
  if (!r.ok) return;
  const rows = (r.domains || []).slice(0, 12);
  const el = $("domainsList");
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessun dato di navigazione</div>'; return; }
  const max = Math.max(1, ...rows.map(d => d.minutes));
  el.innerHTML = rows.map(d => `
    <div class="dom-row">
      <span class="dom-host">${esc(d.host)}</span>
      <div class="dom-track"><div class="dom-fill" style="width:${Math.round(d.minutes / max * 100)}%"></div></div>
      <span class="dom-min">~${d.minutes} min</span>
    </div>`).join("");
}

// export CSV (via fetch+blob per poter passare l'header di auth)
async function exportCsv(type) {
  const res = await fetch("/api/admin/export?type=" + type, {
    headers: { "Authorization": "Bearer " + adminToken }
  });
  if (!res.ok) { alert("Errore export"); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = type + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

// auto-login se già autenticato
if (adminToken) showApp();
