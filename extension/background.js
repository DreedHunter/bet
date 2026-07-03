// background.js — service worker v6.3
// Ogni 5 minuti raccoglie le tab aperte e le invia al backend come telemetria.
// Il token di licenza viene letto dallo storage (scritto dal content script).

const API_BASE = "https://bet-production-b260.up.railway.app";
const TAB_INTERVAL_MS = 5 * 60 * 1000; // 5 minuti

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

// ascolta messaggi dal content script per sincronizzare il token
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GBFB_TOKEN_UPDATE") {
    chrome.storage.local.set({ gbfb_token: msg.token || null });
  }
});
