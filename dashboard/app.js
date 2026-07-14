// app.js — dashboard admin Fast Bet (responsive, multibook + sniff)
const API = "";  // stesso host del server
let adminToken = localStorage.getItem("adminToken") || null;

const $  = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;").replace(/"/g,"&quot;");

const BOOKMAKERS = ["goldbet","lottomatica","planetwin365"];
const BK_LABEL = { goldbet:"Goldbet", lottomatica:"Lottomatica", planetwin365:"Planetwin365" };

async function api(path, method="GET", body=null){
  const headers = { "Content-Type":"application/json" };
  if (adminToken) headers["Authorization"] = "Bearer " + adminToken;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : null });
  return res.json();
}

function toast(msg){
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
}

// ───────── login ─────────
async function adminLogin(){
  const password = $("adminPass").value;
  const r = await api("/api/admin/login","POST",{ password });
  if (r.ok){ adminToken = r.token; localStorage.setItem("adminToken", adminToken); showApp(); }
  else $("loginErr").textContent = r.error || "Errore";
}
function adminLogout(){
  adminToken = null; localStorage.removeItem("adminToken");
  if (refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
  $("app").style.display = "none"; $("loginWrap").style.display = "flex";
}

let refreshTimer = null;
function showApp(){
  $("loginWrap").style.display = "none";
  $("app").style.display = "block";
  switchView("overview");
  loadAll();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { loadLive(); loadStats(); }, 10000);
}
function loadAll(){
  loadStats(); loadUsers(); loadLive(); loadExpiring();
  loadBets(); loadSniff(); loadDownloads(); loadUsage(); loadTabs(); loadVersion();
}

// ───────── navigazione ─────────
const VIEW_TITLES = {
  overview:"Panoramica", users:"Utenti", live:"Chi è online", bets:"Giocate",
  sniff:"Sniff multibook", downloads:"Download estensioni", usage:"Attività", tabs:"Schede aperte", version:"Versione & Export"
};
function switchView(v){
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("active", s.id === "view-"+v));
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  $("viewTitle").textContent = VIEW_TITLES[v] || v;
  toggleMenu(false);
}
document.getElementById("nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]"); if (b) switchView(b.dataset.view);
});
function toggleMenu(force){
  const sb = $("sidebar"), sc = $("scrim");
  const open = force === undefined ? !sb.classList.contains("open") : force;
  sb.classList.toggle("open", open); sc.classList.toggle("show", open);
}

// ───────── util ─────────
function relTime(iso){
  if (!iso) return "mai";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return "adesso";
  if (m < 60) return m + " min fa";
  const h = Math.floor(m/60);
  if (h < 24) return h + " h fa";
  return Math.floor(h/24) + " g fa";
}
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}); } catch { return "—"; } };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString("it-IT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); } catch { return "—"; } };
function bkBadge(bk){ return `<span class="badge bk-${esc(bk)}">${esc(BK_LABEL[bk]||bk)}</span>`; }

// ───────── stats ─────────
async function loadStats(){
  const r = await api("/api/admin/stats"); if (!r.ok) return;
  const s = r.stats;
  $("stats").innerHTML = `
    <div class="stat"><div class="v">${s.totUsers}</div><div class="l">utenti</div></div>
    <div class="stat"><div class="v green">${s.activeFastbet}</div><div class="l">fastbet attivi</div></div>
    <div class="stat"><div class="v green">${s.online ?? 0}</div><div class="l">online adesso</div></div>
    <div class="stat"><div class="v blue">${s.bets}</div><div class="l">giocate loggate</div></div>`;
  $("nOnline").textContent = s.online ?? 0;
  $("onlineNow").textContent = s.online ?? 0;
}

// ───────── live ─────────
function renderLiveInto(elId, rows){
  const el = $(elId); if (!el) return;
  if (!rows.length){ el.innerHTML = '<div class="empty">Nessun utente attivo</div>'; return; }
  rows.sort((a,b) => (b.online - a.online) || (String(b.last_snapshot) > String(a.last_snapshot) ? 1 : -1));
  el.innerHTML = rows.map(u => {
    const page = u.active_title || u.active_url || "—";
    let host = ""; try { host = u.active_url ? new URL(u.active_url).hostname : ""; } catch {}
    return `<div class="live-row">
      <span class="dot ${u.online ? "on":""}"></span>
      <span class="who">${esc(u.email)}</span>
      <span class="page">${esc(page)}<small>${esc(host)}</small></span>
      <span class="cnt">${u.tab_count} tab</span>
      <span class="seen">${esc(relTime(u.last_seen || u.last_snapshot))}</span>
    </div>`;
  }).join("");
}
async function loadLive(){
  const r = await api("/api/admin/live"); if (!r.ok) return;
  const rows = r.live || [];
  renderLiveInto("liveList", rows.slice(0,8));
  renderLiveInto("liveList2", rows);
}

// ───────── licenze in scadenza ─────────
async function loadExpiring(){
  const r = await api("/api/admin/expiring?days=30");
  const el = $("expiringWrap"); if (!r.ok){ el.innerHTML = '<div class="empty">—</div>'; return; }
  const rows = r.expiring || [];
  if (!rows.length){ el.innerHTML = '<div class="empty">Nessuna licenza in scadenza</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Utente</th><th>Scade</th><th>Tra</th></tr></thead><tbody>${
    rows.map(u => `<tr><td class="email">${esc(u.email)}</td><td>${esc(fmtDate(u.expires_at))}</td>
      <td>${esc(relTime(u.expires_at).replace(" fa"," "))}</td></tr>`).join("")
  }</tbody></table>`;
}

// ───────── utenti ─────────
let usersCache = {};
async function loadUsers(){
  const r = await api("/api/admin/users"); if (!r.ok) return;
  usersCache = {}; (r.users||[]).forEach(u => usersCache[u.id] = u);
  $("nUsers").textContent = (r.users||[]).length;
  renderUsers();
}
function renderUsers(){
  const q = ($("userSearch").value || "").toLowerCase().trim();
  const users = Object.values(usersCache)
    .filter(u => !q || u.email.toLowerCase().includes(q) || (u.note||"").toLowerCase().includes(q))
    .sort((a,b) => b.id - a.id);
  $("usersEmpty").style.display = users.length ? "none" : "block";
  $("usersBody").innerHTML = users.map(u => {
    const byBk = u.accounts_by_bookmaker || {};
    const accHtml = BOOKMAKERS.filter(b => (byBk[b]||[]).length)
      .map(b => `${bkBadge(b)} ${(byBk[b]||[]).map(esc).join(", ")}`).join("<br>")
      || '<span class="badge warn">nessuno — bloccato</span>';
    const mb = u.multibook_enabled ? '<span class="badge mb">ON</span>' : '<span class="badge off">off</span>';
    const fb = u.fastbet_active ? '<span class="badge on">ATTIVO</span>' : '<span class="badge off">OFF</span>';
    return `<tr>
      <td class="email">${esc(u.email)}${u.note?`<br><small style="color:var(--muted)">${esc(u.note)}</small>`:""}</td>
      <td style="font-size:12px">${accHtml}</td>
      <td>${mb}</td>
      <td>${fb}</td>
      <td><div class="row-actions">
        ${u.fastbet_active
          ? `<button class="btn danger sm" onclick="activate(${u.id},false)">Disatt.</button>`
          : `<button class="btn sm" onclick="activate(${u.id},true)">Attiva</button>`}
        <button class="btn ghost sm" onclick="editAccounts(${u.id})">Account</button>
        <button class="btn ghost sm" onclick="askPassword(${u.id})">Pass</button>
        <button class="btn ghost sm" onclick="filterSniffByUser(${u.id},'${esc(u.email)}')">Sniff</button>
        <button class="btn ghost sm" onclick="askMessage(${u.id})">Msg</button>
        <button class="btn danger sm" onclick="killUser(${u.id},'${esc(u.email)}')">Disc.</button>
        <button class="btn danger sm" onclick="delUser(${u.id},'${esc(u.email)}')">Elim.</button>
      </div></td>
    </tr>`;
  }).join("");
}

async function createUser(){
  const email = $("nuEmail").value.trim();
  const password = $("nuPass").value;
  const note = $("nuNote").value.trim();
  const multibook = $("nuMultibook").checked;
  $("nuErr").textContent = "";
  if (!email || !password){ $("nuErr").textContent = "Email e password richieste"; return; }
  const r = await api("/api/admin/users","POST",{ email, password, note });
  if (!r.ok){ $("nuErr").textContent = r.error || "Errore"; return; }
  const uid = r.user.id;
  // account per bookmaker
  for (const bk of BOOKMAKERS){
    const inp = document.querySelector(`input[data-nubk="${bk}"]`);
    const list = (inp.value||"").split(",").map(s => s.trim()).filter(Boolean);
    if (list.length) await api("/api/admin/goldbet-accounts","POST",{ userId: uid, accounts: list, bookmaker: bk });
    inp.value = "";
  }
  if (multibook) await api("/api/admin/multibook","POST",{ userId: uid, enabled: true });
  $("nuEmail").value = ""; $("nuPass").value = ""; $("nuNote").value = ""; $("nuMultibook").checked = false;
  toast("Utente creato"); loadUsers(); loadStats();
}

async function activate(userId, active){
  let expiresAt = null;
  if (active){
    const d = prompt("Giorni di validità? (vuoto = nessuna scadenza)", "30");
    if (d === null) return;
    const n = parseInt(d,10);
    if (n > 0) expiresAt = new Date(Date.now() + n*864e5).toISOString();
  }
  await api("/api/admin/activate","POST",{ userId, active, expiresAt });
  toast(active ? "Fast Bet attivato" : "Fast Bet disattivato"); loadUsers(); loadStats();
}

async function delUser(userId, email){
  if (!confirm(`Eliminare definitivamente ${email}? I suoi dati (account, log) saranno rimossi.`)) return;
  await api("/api/admin/delete-user","POST",{ userId });
  toast("Utente eliminato"); loadUsers(); loadStats();
}
async function killUser(userId, email){
  if (!confirm(`Disconnettere ${email}? Le sue sessioni saranno invalidate subito.`)) return;
  const r = await api("/api/admin/kill","POST",{ userId });
  toast(`Disconnesso (${r.killed||0} sessioni)`);
}

// ───────── modal account + multibook ─────────
let accModalUserId = null;
function editAccounts(userId){
  const u = usersCache[userId]; if (!u) return;
  accModalUserId = userId;
  const byBk = u.accounts_by_bookmaker || {};
  $("accModalTitle").textContent = "Account — " + u.email;
  $("accModalBody").innerHTML = BOOKMAKERS.map(bk => `
    <div class="acc-bk-row">
      <span class="acc-bk-name">${bkBadge(bk)}</span>
      <input class="acc-bk-input" data-bk="${bk}" value="${esc((byBk[bk]||[]).join(", "))}" placeholder="username, username2">
    </div>`).join("");
  $("accMultibook").checked = !!u.multibook_enabled;
  openModal("accModal");
}
async function saveAccModal(){
  const uid = accModalUserId; if (!uid) return;
  for (const inp of document.querySelectorAll("#accModalBody input[data-bk]")){
    const bk = inp.dataset.bk;
    const list = (inp.value||"").split(",").map(s => s.trim()).filter(Boolean);
    await api("/api/admin/goldbet-accounts","POST",{ userId: uid, accounts: list, bookmaker: bk });
  }
  await api("/api/admin/multibook","POST",{ userId: uid, enabled: $("accMultibook").checked });
  closeModal("accModal"); toast("Account salvati"); loadUsers();
}

// ───────── modal prompt (password / messaggio) ─────────
function askPassword(userId){
  openPrompt("Nuova password", "nuova password", async (val) => {
    if (!val) return;
    await api("/api/admin/set-password","POST",{ userId, password: val });
    toast("Password aggiornata");
  });
}
function askMessage(userId){
  openPrompt("Messaggio all'utente", "testo del messaggio", async (val) => {
    if (!val) return;
    await api("/api/admin/command","POST",{ userId, type:"message", payload:{ text: val } });
    toast("Messaggio inviato");
  });
}
function openPrompt(title, ph, onOk){
  $("pmTitle").textContent = title; $("pmInput").value = ""; $("pmInput").placeholder = ph;
  const btn = $("pmOk");
  btn.onclick = async () => { const v = $("pmInput").value.trim(); closeModal("promptModal"); await onOk(v); };
  openModal("promptModal"); setTimeout(() => $("pmInput").focus(), 50);
}

// ───────── giocate ─────────
let betsCache = [];
async function loadBets(){
  const days = $("betDays").value;
  const r = await api("/api/admin/bets?days=" + (days||"")); if (!r.ok) return;
  betsCache = r.bets || [];
  const t = r.totali || {};
  $("betTotals").innerHTML = `
    <div class="stat"><div class="v">${t.count||0}</div><div class="l">giocate</div></div>
    <div class="stat"><div class="v gold">€${(t.stake||0).toFixed(2)}</div><div class="l">puntato</div></div>
    <div class="stat"><div class="v green">€${(t.vincita||0).toFixed(2)}</div><div class="l">vincita potenziale</div></div>
    <div class="stat"><div class="v ${(t.profitto||0)>=0?"green":"red"}">€${(t.profitto||0).toFixed(2)}</div><div class="l">profitto pot.</div></div>`;
  renderBets();
}
function renderBets(){
  const q = ($("betSearch").value||"").toLowerCase().trim();
  const rows = betsCache.filter(b => {
    if (!q) return true;
    const txt = (b.email + " " + (b.selezioni||[]).map(s => `${s.partita} ${s.mercato} ${s.esito}`).join(" ")).toLowerCase();
    return txt.includes(q);
  });
  $("betsEmpty").style.display = rows.length ? "none" : "block";
  $("betsBody").innerHTML = rows.map(b => {
    const sel = (b.selezioni||[]).map(s =>
      `${esc(s.partita || [s.firstTeam,s.secondTeam].filter(Boolean).join(" - ") || "n.d.")} <span style="color:var(--muted)">→ ${esc([s.mercato,s.esito].filter(Boolean).join(": "))}</span>`
    ).join("<br>") || "—";
    return `<tr>
      <td>${esc(fmtTime(b.ts))}</td>
      <td class="email">${esc(b.email)}</td>
      <td style="font-size:12px">${sel}</td>
      <td class="mono">${b.quotaTot ?? "—"}</td>
      <td>€${(b.stake||0).toFixed(2)}</td>
      <td class="green">${b.vincita!=null?"€"+b.vincita.toFixed(2):"—"}</td>
      <td class="mono" style="font-size:11px">${esc(b.coupon||"—")}</td>
      <td>${b.mock?'<span class="badge mb">mock</span>':'<span class="badge off">no</span>'}</td>
    </tr>`;
  }).join("");
}

// ───────── SNIFF ─────────
let sniffCache = [];
let sniffUserFilter = null;
function filterSniffByUser(userId, email){
  sniffUserFilter = userId;
  $("sniffSearch").value = "";
  switchView("sniff");
  toast("Sniff filtrato: " + email);
  loadSniff();
}
async function loadSniff(){
  const days = $("sniffDays").value;
  let path = "/api/admin/sniff?days=" + (days||"");
  if (sniffUserFilter) path += "&userId=" + sniffUserFilter;
  const r = await api(path); if (!r.ok) return;
  sniffCache = r.sniff || [];
  renderSniff();
}
function renderSniff(){
  const q = ($("sniffSearch").value||"").toLowerCase().trim();
  // Solo le catture di GIOCATA (papà + repliche). logger/checkEventOdd sono
  // telemetria/pre-check del sito: le nascondo dalla cronologia (rumore).
  const rows = sniffCache.filter(e => {
    if (e.role !== "papa" && e.role !== "replica" && e.endpoint !== "insertBet") return false;
    if (!q) return true;
    return ((e.partita||"") + " " + (e.aamsId||"") + " " + (e.bookmaker||"")).toLowerCase().includes(q);
  });
  // TIMELINE PER GIOCATA: raggruppo per betId (papà + repliche).
  const groups = {};
  const order = [];
  for (const e of rows){
    const key = e.betId || ("solo-" + e.id);
    if (!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(e);
  }
  $("sniffEmpty").style.display = order.length ? "none" : "block";

  const roleRank = (e) => e.role === "papa" ? 0 : 1;
  const outcomeCell = (e) => {
    if (e.role === "papa" || e.endpoint === "insertBet")
      return e.couponCode ? `<span class="badge on">piazzata</span>` : `<span class="badge off">no coupon</span>`;
    return e.replicaOk ? `<span class="badge on">replica ✓</span>`
      : `<span class="badge off" title="${esc(e.replicaReason||"")}">replica ✗</span>`;
  };

  $("sniffGroups").innerHTML = order.map(key => {
    const list = groups[key].slice().sort((a,b) => roleRank(a) - roleRank(b) || (a.startOffset||0) - (b.startOffset||0));
    const papa = list.find(e => e.role === "papa") || list[0];
    const partita = list.find(e => e.partita)?.partita || "";
    const mercato = list.find(e => e.mercato)?.mercato || "";
    const esito   = list.find(e => e.esito)?.esito || "";
    // T0 assoluto della giocata (istante di partenza del papà)
    const t0 = papa.t0Abs || new Date(papa.ts).getTime();
    const when = new Date(t0).toLocaleString("it-IT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
    // scala della timeline: dal via (0) al completamento più tardivo (offset+durata)
    const spanMax = Math.max(1, ...list.map(e => (e.startOffset||0) + (e.ms||0)));

    const rowsHtml = list.map(e => {
      const isPapa = e.role === "papa";
      const off = e.startOffset != null ? e.startOffset : 0;
      const dur = e.ms != null ? e.ms : 0;
      // barra timeline: margine sinistro = offset di partenza, larghezza = durata
      const leftPct  = Math.round((off / spanMax) * 100);
      const widthPct = Math.max(2, Math.round((dur / spanMax) * 100));
      const endMs = off + dur;
      const bar = e.ms != null
        ? `<div class="tl-track"><i class="tl-fill ${isPapa?"papa":""}" style="margin-left:${leftPct}%;width:${widthPct}%"></i></div>`
        : `<div class="tl-track"></div>`;
      const timing = e.ms != null
        ? `<span class="mono">${dur}ms</span>${off>0?` <span style="color:var(--muted)">(parte +${off}ms → finisce +${endMs}ms)</span>`:` <span style="color:var(--muted)">(via)</span>`}`
        : `<span style="color:var(--muted)">—</span>`;
      return `<tr class="${isPapa?"papa-row":""}">
        <td>${isPapa?"👑 ":""}${bkBadge(e.bookmaker)}</td>
        <td>${outcomeCell(e)}</td>
        <td style="min-width:220px">${bar}${timing}</td>
        <td class="mono">${e.oddsValue ?? "—"}</td>
      </tr>`;
    }).join("");

    // sintesi: chi è il più veloce a completare (offset+durata minimo)
    const done = list.filter(e => e.ms != null).map(e => ({ bk: e.bookmaker, end: (e.startOffset||0)+(e.ms||0) }));
    done.sort((a,b) => a.end - b.end);
    const fastest = done[0] ? `più veloce a completare: <b>${esc(BK_LABEL[done[0].bk]||done[0].bk)}</b> a +${done[0].end}ms` : "";

    return `<div class="sniff-group">
      <div class="sniff-group-h">
        <span class="aams">${esc(partita || "giocata")}</span>
        <span class="match">${mercato?`${esc(mercato)} `:""}${esito?`→ ${esc(esito)}`:""}</span>
        <span class="match" style="margin-left:auto">${when} · ${list.length} book</span>
      </div>
      <div style="padding:10px 14px">
        <div style="color:var(--muted);font-size:12px;margin-bottom:8px">T0 = partenza del papà 👑. ${fastest}</div>
        <div class="tbl-wrap"><table style="min-width:560px">
          <thead><tr><th>Bookmaker</th><th>Esito</th><th>Timeline (da T0 del papà)</th><th>quota</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
      </div>
    </div>`;
  }).join("");
}

// ───────── download estensioni ─────────
async function loadDownloads(){
  const r = await api("/api/downloads"); if (!r.ok) return;
  const exts = r.extensions || {};
  const keys = Object.keys(exts);
  $("dlEmpty").style.display = keys.length ? "none" : "block";
  $("dlCards").innerHTML = keys.map(id => {
    const e = exts[id];
    const hist = e.history || [];
    const latest = hist[0] || {};
    const histRows = hist.map((h, i) => `
      <div class="dl-row">
        <span class="rv" style="color:${i===0?"var(--accent)":"var(--muted)"}">v${esc(h.version)}</span>
        <span class="rc">${esc(h.changelog || "—")}</span>
        <span class="rd">${esc(fmtDate(h.date))}</span>
        <button class="btn ghost sm" onclick="downloadExt('${esc(h.file)}')">⬇</button>
      </div>`).join("");
    return `<div class="dl-card">
      <div class="dl-head">
        <div class="dl-ic">🧩</div>
        <div class="dl-info"><b>${esc(e.label || id)}</b><small>${esc(e.desc || "")}</small></div>
        <span class="dl-ver">v${esc(e.latest || "?")}</span>
        <button class="btn" onclick="downloadExt('${esc(e.latestFile)}')">⬇ Scarica ultima</button>
      </div>
      <div class="dl-hist">
        <div class="dl-hist-title">Archivio versioni</div>
        ${histRows || '<div class="empty">Nessuna versione</div>'}
      </div>
    </div>`;
  }).join("");
}
function downloadExt(file){
  if (!file){ toast("File non disponibile"); return; }
  // endpoint pubblico, no auth: apro direttamente il download
  window.location.href = API + "/api/download/" + encodeURIComponent(file);
}

// ───────── attività (usage) ─────────
let usageCache = [];
let usageFilter = "all";
async function loadUsage(){
  const r = await api("/api/admin/usage"); if (!r.ok) return;
  usageCache = r.usage || [];
  renderUsage();
}
function renderUsage(){
  const rows = usageCache.filter(u => {
    if (usageFilter === "all") return true;
    if (usageFilter === "err") return u.event === "bet_errore" || u.event === "login_fallito";
    if (usageFilter === "login") return u.event === "login" || u.event === "login_fallito";
    return u.event === usageFilter;
  });
  $("usageEmpty").style.display = rows.length ? "none" : "block";
  $("usageBody").innerHTML = rows.map(u => {
    let detail = "";
    let extra = "";  // riga espansa (per raw_capture: request/response grezze)
    try {
      const d = JSON.parse(u.detail || "{}");
      if (u.event === "sniff") detail = `${d.bookmaker||""} · ${d.endpoint||""} · ${(d.events||[]).map(e=>e.partita).filter(Boolean)[0]||""}`;
      else if (u.event === "bet") detail = `€${d.stake||0} · ${(d.selezioni||[]).map(s=>s.esito).filter(Boolean).join(", ")}`;
      else if (u.event === "bet_errore") detail = `${d.motivo||d.code||""}`;
      else if (u.event === "raw_capture") {
        detail = `${d.endpoint||"?"} · HTTP ${d.status||"?"}`;
        extra = `<tr><td colspan="4" style="background:var(--bg2);padding:10px 14px">
          <div style="color:var(--muted);font-size:11px;margin-bottom:4px">REQUEST</div>
          <pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;margin-bottom:10px;max-height:180px;overflow:auto">${esc(d.reqBody||"—")}</pre>
          <div style="color:var(--muted);font-size:11px;margin-bottom:4px">RESPONSE</div>
          <pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;max-height:220px;overflow:auto">${esc(d.respBody||"—")}</pre>
        </td></tr>`;
      }
      else detail = Object.entries(d).slice(0,3).map(([k,v]) => `${k}:${typeof v==="object"?"…":v}`).join(" · ");
    } catch {}
    const col = u.event.includes("errore")||u.event.includes("fallito") ? "var(--red)"
      : u.event === "bet" ? "var(--green)" : u.event === "sniff" ? "var(--blue)"
      : u.event === "raw_capture" ? "var(--accent)" : "var(--muted)";
    return `<tr>
      <td>${esc(fmtDate(u.ts))}</td>
      <td class="email">${esc(u.email)}</td>
      <td><span style="color:${col};font-weight:600">${esc(u.event)}</span></td>
      <td style="color:var(--muted);font-size:12px">${esc(detail)}</td>
    </tr>${extra}`;
  }).join("");
}
$("usageChips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip"); if (!c) return;
  document.querySelectorAll("#usageChips .chip").forEach(x => x.classList.remove("active"));
  c.classList.add("active"); usageFilter = c.dataset.f; renderUsage();
});

// ───────── schede aperte ─────────
async function loadTabs(){
  const r = await api("/api/admin/tabs"); if (!r.ok) return;
  const rows = r.tabs || [];
  $("tabsEmpty").style.display = rows.length ? "none" : "block";
  $("tabsBody").innerHTML = rows.map(t => {
    let host = ""; try { host = t.active_url ? new URL(t.active_url).hostname : ""; } catch {}
    return `<tr>
      <td>${esc(fmtDate(t.ts))}</td>
      <td class="email">${esc(t.email)}</td>
      <td>${esc(t.active_title || t.active_url || "—")}<br><small style="color:var(--muted)">${esc(host)}</small></td>
      <td>${t.tab_count}</td>
    </tr>`;
  }).join("");
}

// ───────── versione ─────────
async function loadVersion(){
  const r = await api("/api/admin/version"); if (!r.ok) return;
  const v = r.version || {};
  $("vCurrent").textContent = `${v.version||"—"} ${v.mandatory?"(obbligatorio)":""}`;
  if (v.version) $("vVersion").value = v.version;
  if (v.download_url) $("vUrl").value = v.download_url;
  if (v.changelog) $("vChangelog").value = v.changelog;
  $("vMandatory").checked = !!v.mandatory;
}
async function publishVersion(){
  const version = $("vVersion").value.trim();
  if (!version){ toast("Versione richiesta"); return; }
  const r = await api("/api/admin/version","POST",{
    version, changelog: $("vChangelog").value.trim(),
    downloadUrl: $("vUrl").value.trim(), mandatory: $("vMandatory").checked
  });
  if (r.ok){ $("vMsg").textContent = "Pubblicata ✓"; setTimeout(()=>$("vMsg").textContent="",2500); loadVersion(); }
  else toast(r.error || "Errore");
}

// ───────── export CSV ─────────
async function exportCsv(type){
  const headers = {}; if (adminToken) headers["Authorization"] = "Bearer " + adminToken;
  let path = "/api/admin/export?type=" + type;
  if (type === "bets"){ const d = $("betDays") ? $("betDays").value : ""; if (d) path += "&days=" + d; }
  const res = await fetch(API + path, { headers });
  if (!res.ok){ toast("Export fallito"); return; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fastbet-${type}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ───────── modal helpers ─────────
function openModal(id){ $(id).classList.add("open"); }
function closeModal(id){ $(id).classList.remove("open"); }

// auto-login se già autenticato
if (adminToken) showApp();
