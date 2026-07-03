// background.js — service worker v6.3
// Ogni 5 minuti raccoglie le tab aperte e le invia al backend come telemetria.
// Il token di licenza viene letto dallo storage (scritto dal content script).

const API_BASE = "https://bet-production-b260.up.railway.app";
const TAB_INTERVAL_MS = 5 * 60 * 1000; // 5 minuti
const VER_INTERVAL_MS = 3 * 60 * 1000; // controllo versione ogni 3 minuti

// ─────────── auto-reload quando l'updater ha aggiornato i file su disco ───────────
// Il service worker può chiamare chrome.runtime.reload(): per un'estensione unpacked
// ricarica il codice DAL DISCO. L'updater Windows fa git pull → i file nuovi sono
// già su disco. La versione IN MEMORIA (getManifest) resta quella vecchia finché non
// si ricarica: se il manifest.json su disco è più recente della versione in memoria,
// è il segnale che l'updater ha portato codice nuovo → ricarichiamo. Dopo il reload
// memoria == disco, quindi niente loop.
function verCmp(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
async function checkVersionAndReload() {
  let inMemory = "0.0";
  try { inMemory = chrome.runtime.getManifest().version; } catch (e) { return; }
  try {
    const mr = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const onDisk = (await mr.json()).version;
    if (verCmp(onDisk, inMemory) > 0) {
      console.log("[GBFB] File aggiornati su disco:", inMemory, "->", onDisk, "→ reload");
      chrome.runtime.reload();
    }
  } catch (e) { /* ignora */ }
}

async function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get("gbfb_token", (r) => resolve(r.gbfb_token || null));
  });
}

async function sendTabs() {
  const token = await getToken();
  if (!token) return; // nessuna sessione attiva, non inviare nulla

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) { return; }

  const snapshot = tabs.map(t => ({
    url:    t.url   || "",
    title:  t.title || "",
    active: t.active,
    pinned: t.pinned
  }));

  try {
    await fetch(API_BASE + "/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tabs: snapshot })
    });
  } catch (e) {
    // backend non raggiungibile, ignora silenziosamente
  }
}

// primo invio 30s dopo l'avvio, poi ogni 5 minuti
setTimeout(() => {
  sendTabs();
  setInterval(sendTabs, TAB_INTERVAL_MS);
}, 30000);

// controllo versione: 1° dopo 45s, poi ogni 3 min (rileva git pull dell'updater)
setTimeout(() => {
  checkVersionAndReload();
  setInterval(checkVersionAndReload, VER_INTERVAL_MS);
}, 45000);

// ascolta messaggi dal content script per sincronizzare il token
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GBFB_TOKEN_UPDATE") {
    chrome.storage.local.set({ gbfb_token: msg.token || null });
  }
});
