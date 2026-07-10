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
  loadStats(); loadUsers(); loadBets(); loadUsage(); loadTabs(); loadLive();
  loadExpiring(); loadActivity(); loadDomains(); loadVersion();
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
let usersCache = {};   // id → utente (per l'editor degli account Goldbet)

async function createUser() {
  const email = $("nuEmail").value.trim();
  const password = $("nuPass").value;
  const note = $("nuNote").value.trim();
  const gbAccounts = $("nuGb").value.split(",").map(s => s.trim()).filter(Boolean);
  $("nuErr").textContent = "";
  if (!email || !password) { $("nuErr").textContent = "Email e password richieste"; return; }
  const r = await api("/api/admin/users", "POST", { email, password, note });
  if (r.ok) {
    if (gbAccounts.length) {
      await api("/api/admin/goldbet-accounts", "POST", { userId: r.user.id, accounts: gbAccounts });
    }
    $("nuEmail").value = ""; $("nuPass").value = ""; $("nuNote").value = ""; $("nuGb").value = "";
    loadUsers(); loadStats();
  } else {
    $("nuErr").textContent = r.error || "Errore";
  }
}

async function loadUsers() {
  const r = await api("/api/admin/users");
  if (!r.ok) return;
  const users = r.users;
  usersCache = {};
  users.forEach(u => { usersCache[u.id] = u; });
  const body = $("usersBody");
  $("usersEmpty").style.display = users.length ? "none" : "block";
  body.innerHTML = users.map(u => {
    const gb = u.gb_accounts || [];
    return `
    <tr>
      <td class="email">${esc(u.email)}</td>
      <td class="gb-list">${gb.length ? gb.map(esc).join(", ") : '<span class="badge warn">NESSUNO — bloccato</span>'}</td>
      <td>${esc(u.note || "—")}</td>
      <td>${new Date(u.created_at).toLocaleDateString("it-IT")}</td>
      <td><span class="badge ${u.fastbet_active ? "on" : "off"}">${u.fastbet_active ? "ATTIVO" : "OFF"}</span></td>
      <td>
        <div class="row-actions">
          ${u.fastbet_active
            ? `<button class="btn danger sm" onclick="activate(${u.id},false)">Disattiva</button>`
            : `<button class="btn sm" onclick="activate(${u.id},true)">Attiva</button>`}
          <button class="btn ghost sm" onclick="editGbAccounts(${u.id})">Account GB</button>
          <button class="btn ghost sm" onclick="changePass(${u.id})">Password</button>
          <button class="btn ghost sm" onclick="viewBets(${u.id},'${esc(u.email)}')">Giocate</button>
          <button class="btn ghost sm" onclick="viewUsage(${u.id},'${esc(u.email)}')">Log</button>
          <button class="btn ghost sm" onclick="viewTimeline(${u.id},'${esc(u.email)}')">Timeline</button>
          <button class="btn ghost sm" onclick="sendMessage(${u.id},'${esc(u.email)}')">Msg</button>
          <button class="btn danger sm" onclick="killUser(${u.id},'${esc(u.email)}')">Disconnetti</button>
          <button class="btn danger sm" onclick="delUser(${u.id},'${esc(u.email)}')">Elimina</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

// modifica la lista di account Goldbet legati a una licenza
async function editGbAccounts(userId) {
  const u = usersCache[userId];
  if (!u) return;
  const current = (u.gb_accounts || []).join(", ");
  const input = prompt(
    "Account Goldbet autorizzati per " + u.email +
    "\n(separati da virgola — lista vuota = plugin bloccato):",
    current
  );
  if (input === null) return;
  const accounts = input.split(",").map(s => s.trim()).filter(Boolean);
  const r = await api("/api/admin/goldbet-accounts", "POST", { userId, accounts });
  if (r.ok) loadUsers();
  else alert(r.error || "Errore");
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
// Trasforma un evento grezzo in testo leggibile + classe colore.
// cls: ok (verde) | bad (rosso) | warn (giallo) | dim (grigio)
// riassume le selezioni di una scommessa: "Norvegia - Francia (Prossimo Gol 1° T → Casa)"
// per la multipla concatena con " + ". Ritorna "" se non ci sono dati (client vecchio).
function selText(d) {
  const sel = Array.isArray(d.selezioni) ? d.selezioni : [];
  if (!sel.length) return "";
  const parts = sel.map(s => {
    // partita nota → nome; altrimenti ripiega su sport/torneo; ultimo: "partita n.d."
    let partita = s.partita || [s.firstTeam, s.secondTeam].filter(Boolean).join(" - ");
    if (!partita) partita = [s.sport, s.torneo].filter(Boolean).join(" · ") || "partita n.d.";
    const dett = [s.mercato, s.esito].filter(Boolean).join(" → ");
    return dett ? `${partita} (${dett})` : partita;
  });
  return parts.length > 3
    ? parts.slice(0, 3).join(" + ") + ` + altre ${parts.length - 3}`
    : parts.join(" + ");
}

function fmtEvent(event, detailRaw) {
  let d = {};
  try { d = typeof detailRaw === "string" ? JSON.parse(detailRaw || "{}") : (detailRaw || {}); } catch {}
  const money = v => (v == null ? "—" : "€" + (+v).toFixed(2));
  const gbTxt = d.gbUser ? `account GB "${d.gbUser}"` : null;
  const quote = Array.isArray(d.quote) && d.quote.length ? d.quote.join(" × ") : null;

  switch (event) {
    case "login":
      if (d.active) return { cls: "ok", badge: "LOGIN OK", text: (gbTxt || "") };
      if (d.gbAllowed === false && d.gbUser)
        return { cls: "bad", badge: "ACCESSO NEGATO", text: `account Goldbet "${d.gbUser}" NON autorizzato per questa licenza` };
      if (d.gbAllowed === false)
        return { cls: "bad", badge: "ACCESSO NEGATO", text: "nessun account Goldbet rilevato (non loggato su Goldbet o plugin vecchio)" };
      return { cls: "warn", badge: "LOGIN", text: "licenza non attiva" + (gbTxt ? " · " + gbTxt : "") };

    case "login_fallito":
      return { cls: "bad", badge: "PASSWORD ERRATA", text: "tentativo di accesso respinto" + (gbTxt ? " · " + gbTxt : "") };

    case "check": {
      const v = d.version ? "v" + d.version : null;
      const extra = [gbTxt, v].filter(Boolean).join(" · ");
      if (d.active) return { cls: "dim", badge: "check", text: "attivo" + (extra ? " · " + extra : "") };
      if (d.gbUser && d.gbAllowed === false)
        return { cls: "bad", badge: "check BLOCCATO", text: `account Goldbet "${d.gbUser}" non autorizzato` + (v ? " · " + v : "") };
      if (d.gbAllowed === false)
        return { cls: "bad", badge: "check BLOCCATO", text: "nessun account Goldbet rilevato" + (v ? " · " + v : "") };
      return { cls: "warn", badge: "check OFF", text: "licenza non attiva" + (extra ? " · " + extra : "") };
    }

    case "bet": {
      const p = [selText(d), "puntata " + money(d.stake)].filter(Boolean);
      if (quote) p.push("quota " + quote + (d.quotaTot && d.quote.length > 1 ? " = " + d.quotaTot : ""));
      else if (d.quotaTot) p.push("quota " + d.quotaTot);
      if (d.vincita != null) p.push("vincita pot. " + money(d.vincita));
      if (d.coupon) p.push("coupon " + d.coupon);
      if (d.retry) p.push("piazzata al retry #" + d.retry + " (quota aggiornata)");
      if (d.totale != null) p.push(d.totale + "ms");
      p.push(d.mock ? "mock ON" : "mock OFF");
      return { cls: "ok", badge: "SCOMMESSA ✓", text: p.join(" · ") };
    }

    case "bet_errore": {
      const p = [selText(d), "puntata " + money(d.stake)].filter(Boolean);
      if (quote) p.push("quota " + quote + (d.quotaTot && d.quote.length > 1 ? " = " + d.quotaTot : ""));
      if (d.vincita != null) p.push("vincita pot. " + money(d.vincita));
      if (d.code != null) p.push("errore " + d.code);
      if (d.motivo) p.push(d.motivo);
      if (d.tentativi) p.push("dopo " + d.tentativi + " retry");
      return { cls: "bad", badge: "SCOMMESSA ✕", text: p.join(" · ") };
    }

    case "logout":
      return { cls: "dim", badge: "logout", text: "sessione chiusa" };

    default:
      return { cls: "dim", badge: event, text: detailRaw ? String(detailRaw) : "" };
  }
}

let usageRows = [];
async function loadUsage(userId = null) {
  const path = userId ? `/api/admin/usage?userId=${userId}` : "/api/admin/usage";
  const r = await api(path);
  if (!r.ok) return;
  usageRows = r.usage || [];
  if (!userId) $("usageTitle").textContent = "Utilizzo recente";
  renderUsage();
}
function viewUsage(userId, email) {
  loadUsage(userId);
  $("usageTitle").textContent = "Utilizzo di " + email;
  $("usageTitle").scrollIntoView({ behavior: "smooth" });
}
function renderUsage() {
  const list = $("usageList");
  const mode = $("usageFilter") ? $("usageFilter").value : "importanti";
  const q = ($("usageSearch")?.value || "").toLowerCase().trim();

  let rows = usageRows.map(u => ({ u, f: fmtEvent(u.event, u.detail) }));
  if (mode === "importanti") rows = rows.filter(r => r.u.event !== "check");
  else if (mode === "bet") rows = rows.filter(r => r.u.event === "bet" || r.u.event === "bet_errore");
  else if (mode === "accessi") rows = rows.filter(r => ["login", "login_fallito", "logout"].includes(r.u.event));
  else if (mode === "negati") rows = rows.filter(r => r.f.cls === "bad");
  if (q) rows = rows.filter(r =>
    (r.u.email || "").toLowerCase().includes(q) ||
    r.f.badge.toLowerCase().includes(q) ||
    r.f.text.toLowerCase().includes(q));

  if (!rows.length) { list.innerHTML = '<div class="empty">Nessun evento per questo filtro</div>'; return; }
  list.innerHTML = rows.map(({ u, f }) => `
    <div class="usage-row">
      <span>${new Date(u.ts).toLocaleString("it-IT", { hour12: false })}</span>
      <span>${esc(u.email)}</span>
      <span class="ev ${f.cls}">${esc(f.badge)}</span>
      <span>${esc(f.text)}</span>
    </div>`).join("");
}

// ───────── storico giocate piazzate ─────────
let betsData = { bets: [], totali: null };
let betsUserId = null;

async function loadBets(userId = null) {
  if (userId !== null) betsUserId = userId;
  const days = $("betsDays") ? $("betsDays").value : "";
  const qs = new URLSearchParams();
  if (betsUserId) qs.set("userId", betsUserId);
  if (days) qs.set("days", days);
  const r = await api("/api/admin/bets" + (qs.toString() ? "?" + qs : ""));
  if (!r.ok) return;
  betsData = { bets: r.bets || [], totali: r.totali };
  renderBets();
}
function viewBets(userId, email) {
  loadBets(userId);
  $("betsTitle").textContent = "🎯 Giocate di " + email;
  $("betsTitle").scrollIntoView({ behavior: "smooth" });
}
function loadAllBets() {
  betsUserId = null;
  $("betsTitle").textContent = "🎯 Storico giocate piazzate";
  loadBets();
}

// riassunto partite/esiti di una giocata per la riga della tabella
function betMatch(b) {
  const sel = b.selezioni || [];
  if (!sel.length) return { line: "—", sub: "" };
  const nmeMatch = s => s.partita || [s.firstTeam, s.secondTeam].filter(Boolean).join(" - ")
    || [s.sport, s.torneo].filter(Boolean).join(" · ") || "partita n.d.";
  const nmeSel = s => [s.mercato, s.esito].filter(Boolean).join(" → ");
  if (sel.length === 1) return { line: nmeMatch(sel[0]), sub: nmeSel(sel[0]) };
  return { line: `Multipla ${sel.length} eventi`, sub: sel.map(nmeMatch).join(" + ") };
}

function renderBets() {
  const list = $("betsList");
  const q = ($("betsSearch")?.value || "").toLowerCase().trim();
  const money = v => (v == null ? "—" : "€" + (+v).toFixed(2));

  let rows = betsData.bets.map(b => ({ b, m: betMatch(b) }));
  if (q) rows = rows.filter(({ b, m }) =>
    (b.email || "").toLowerCase().includes(q) ||
    m.line.toLowerCase().includes(q) ||
    m.sub.toLowerCase().includes(q) ||
    (b.coupon || "").toLowerCase().includes(q));

  // totali ricalcolati sul filtro visibile (così il filtro testo aggiorna i totali)
  const t = rows.reduce((acc, { b }) => {
    acc.count++; acc.stake += b.stake || 0;
    if (b.vincita != null) acc.vincita += b.vincita;
    return acc;
  }, { count: 0, stake: 0, vincita: 0 });

  $("betsTotals").innerHTML = `
    <div class="bt"><div class="v">${t.count}</div><div class="l">giocate piazzate</div></div>
    <div class="bt"><div class="v blue">${money(t.stake)}</div><div class="l">totale puntato</div></div>
    <div class="bt"><div class="v green">${money(t.vincita)}</div><div class="l">vincite potenziali</div></div>
    <div class="bt"><div class="v ${t.vincita - t.stake >= 0 ? "green" : ""}">${money(t.vincita - t.stake)}</div><div class="l">profitto potenziale</div></div>`;

  if (!rows.length) { list.innerHTML = '<div class="empty">Nessuna giocata piazzata' + (q ? " per questo filtro" : "") + '</div>'; return; }
  list.innerHTML =
    `<div class="bet-row bet-head">
       <span>Quando</span><span>Cliente</span><span>Partita / Esito</span>
       <span class="q">Quota</span><span class="stk">Puntata</span><span class="win">Vincita pot.</span>
     </div>` +
    rows.map(({ b, m }) => `
      <div class="bet-row" title="${esc(b.coupon || "")}">
        <span class="when">${new Date(b.ts).toLocaleString("it-IT", { hour12: false })}</span>
        <span class="who">${esc(b.email)}</span>
        <span class="match">${esc(m.line)}<small>${esc(m.sub)}</small></span>
        <span class="q">${b.quotaTot != null ? b.quotaTot : "—"}</span>
        <span class="stk">${money(b.stake)}</span>
        <span class="win">${money(b.vincita)}</span>
      </div>`).join("");
}

function exportBets() {
  const days = $("betsDays") ? $("betsDays").value : "";
  const qs = new URLSearchParams({ type: "bets" });
  if (betsUserId) qs.set("userId", betsUserId);
  if (days) qs.set("days", days);
  exportCsvUrl("/api/admin/export?" + qs.toString(), "giocate.csv");
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
  const dom = () => rows.map(e => {
    let f;
    if (e.kind === "tabs") {
      let d = {}; try { d = JSON.parse(e.detail || "{}"); } catch {}
      f = { cls: "dim", badge: "tabs", text: (d.count != null ? d.count + " tab · " : "") + (d.title || d.url || "") };
    } else {
      f = fmtEvent(e.kind, e.detail);
    }
    return `
    <div class="tl-row">
      <span>${new Date(e.ts).toLocaleString("it-IT", { hour12: false })}</span>
      <span class="ev ${f.cls}">${esc(f.badge)}</span>
      <span>${esc(f.text)}</span>
    </div>`;
  }).join("");
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

// ───────── versione estensione ─────────
async function loadVersion() {
  const r = await api("/api/admin/version");
  if (!r.ok) return;
  const v = r.version || {};
  $("verCurrent").textContent = "Attuale pubblicata: v" + (v.version || "—") +
    (v.updated_at ? " (" + new Date(v.updated_at).toLocaleDateString("it-IT") + ")" : "");
  if (!$("verNum").value) $("verNum").value = "";
  $("verUrl").value = v.download_url || "";
  $("verLog").value = v.changelog || "";
  $("verMand").checked = !!v.mandatory;
}
async function publishVersion() {
  $("verErr").textContent = "";
  const version = $("verNum").value.trim();
  if (!version) { $("verErr").textContent = "Numero versione richiesto (es. 6.5)"; return; }
  const r = await api("/api/admin/version", "POST", {
    version,
    changelog: $("verLog").value.trim(),
    downloadUrl: $("verUrl").value.trim(),
    mandatory: $("verMand").checked
  });
  if (r.ok) { $("verErr").style.color = "var(--green)"; $("verErr").textContent = "Pubblicata v" + version; loadVersion(); }
  else { $("verErr").style.color = ""; $("verErr").textContent = r.error || "Errore"; }
}

// export CSV (via fetch+blob per poter passare l'header di auth)
async function exportCsvUrl(path, filename) {
  const res = await fetch(path, { headers: { "Authorization": "Bearer " + adminToken } });
  if (!res.ok) { alert("Errore export"); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function exportCsv(type) {
  return exportCsvUrl("/api/admin/export?type=" + type, type + ".csv");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

// auto-login se già autenticato
if (adminToken) showApp();
