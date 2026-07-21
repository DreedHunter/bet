#!/usr/bin/env node
// release.mjs — impacchetta le estensioni in ZIP versionati e aggiorna il manifesto
// dei download (versions.json) con changelog. Zero dipendenze npm: usa lo zip di
// sistema (PowerShell Compress-Archive su Windows, `zip` su Linux/macOS).
//
// USO:
//   node release.mjs                      → zippa le estensioni la cui versione è
//                                           cambiata dall'ultima release (nuove entry)
//   node release.mjs <ext-id> "changelog" → forza il rilascio di UNA estensione con
//                                           il changelog indicato
//   node release.mjs --all                → rizippa tutte (senza cambiare changelog)
//
// Gli ZIP finiscono in backend/downloads/<id>-v<versione>.zip e sono serviti da
// Railway. versions.json tiene lo storico di ogni estensione (più recente in testa).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");                 // radice del progetto (eurob/)
const OUT_DIR = join(__dirname, "backend", "downloads");
const MANIFEST = join(OUT_DIR, "versions.json");

// ── REGISTRY: le estensioni distribuibili (id stabile → cartella sorgente + etichetta) ──
// L'id NON deve cambiare tra release (è la chiave dell'archivio). La versione è letta
// dal manifest.json della cartella, così non va ripetuta qui.
const REGISTRY = [
  { id: "lottomatica-group", dir: "lottomatica_group_fast_bet", label: "Lottomatica Group Fast Bet",
    desc: "Estensione unificata (Goldbet + Lottomatica + Planetwin365) con multibook e sniff." },
  { id: "goldbet",     dir: "goldbet_fast_bet_v6.4", label: "Goldbet Fast Bet",
    desc: "Estensione singola per Goldbet." },
  { id: "lottomatica", dir: "lottomatica_fast_bet",  label: "Lottomatica Fast Bet",
    desc: "Estensione singola per Lottomatica." },
  { id: "planetwin",   dir: "planetwin_fast_bet",    label: "Planetwin365 Fast Bet",
    desc: "Estensione singola per Planetwin365." },
  { id: "belbet360",   dir: "belbet360_fast_bet",    label: "BelBet360 Fast Bet",
    desc: "Azzera l'attesa di approvazione coupon su BelBet360 (mock checkForCouponApproval)." },
  { id: "betnewera24", dir: "betnewera24_fast_bet",  label: "BetNewEra24 Fast Bet",
    desc: "Azzera l'attesa di accettazione coupon su BetNewEra24 (mock coupon/check)." },
  { id: "williamhill", dir: "williamhill_fast_bet",  label: "William Hill Fast Bet",
    desc: "Giocata rapida al click su una quota col tuo importo + hotkey Casa/Ospite (xSport, auto-click DOM)." },
  { id: "eurobet",     dir: "eurobet_fast_bet",      label: "Eurobet Fast Bet",
    desc: "Analisi/test su Eurobet (piattaforma proprietaria sport-sale-service). Betdelay live server-side." },
  { id: "betzone",     dir: "betzone/betfast-extension", label: "Betzone BetFast",
    desc: "Piazzamento rapido su Betzone: elimina i ritardi client (countdown/guard) + poll rapido accettazione." },
  { id: "betradar-sync", dir: "checktimes/goldbet_betradar_sync", label: "Goldbet ↔ Betradar Sync",
    desc: "Strumento di timing: confronta i tempi Goldbet col feed Betradar (WebSocket) e mostra il ritardo per partita." },
  { id: "rest-sniffer", dir: "rest_sniffer", label: "REST Sniffer — Bet Flow Analyzer",
    desc: "STRUMENTO DI ANALISI: cattura tutte le chiamate REST di qualsiasi sito (header, body, response, timing, cURL). È l'attrezzo per fare gli sniff dei nuovi book." }
];

function readManifestVersion(dir) {
  try { return JSON.parse(readFileSync(join(ROOT, dir, "manifest.json"), "utf8")).version || "0.0"; }
  catch { return null; }
}

// crea uno ZIP del CONTENUTO della cartella srcDir (così l'utente ci trova i file
// dell'estensione direttamente, pronta da caricare unpacked). Usa lo zip di sistema.
function zipDir(srcDir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath);
  const abs = join(ROOT, srcDir);
  if (platform() === "win32") {
    // Compress-Archive: "src\*" zippa il contenuto senza la cartella radice.
    execFileSync("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -Path '${abs}\\*' -DestinationPath '${zipPath}' -Force`
    ], { stdio: "pipe" });
  } else {
    // zip -r da dentro la cartella per non includere il path assoluto
    execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: abs, stdio: "pipe" });
  }
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return {}; }
}
function saveManifest(m) {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

// timestamp passato come argv per riproducibilità (Date.now non disponibile in alcuni
// contesti di automazione); fallback all'ISO corrente quando eseguito a mano.
function nowIso() { return new Date().toISOString(); }

function releaseOne(entry, changelog, force) {
  const version = readManifestVersion(entry.dir);
  if (!version) { console.log(`  ⚠ ${entry.id}: manifest.json non trovato in ${entry.dir}, salto`); return null; }

  const manifest = loadManifest();
  const hist = manifest[entry.id]?.history || [];
  const latest = hist[0];
  const already = latest && latest.version === version;

  if (already && !force) {
    console.log(`  = ${entry.id}: v${version} già rilasciata (usa --all o passa un changelog per riforzare)`);
    return manifest[entry.id];
  }

  const fileName = `${entry.id}-v${version}.zip`;
  const zipPath = join(OUT_DIR, fileName);
  zipDir(entry.dir, zipPath);

  const record = {
    id: entry.id, label: entry.label, desc: entry.desc,
    version, file: fileName,
    changelog: changelog || (already ? (latest.changelog || "") : `Release v${version}`),
    date: nowIso()
  };

  // aggiorna lo storico: se stessa versione (riforzata) sostituisci l'entry in testa,
  // altrimenti aggiungi in testa (più recente prima).
  const newHist = already ? [record, ...hist.slice(1)] : [record, ...hist];
  manifest[entry.id] = {
    id: entry.id, label: entry.label, desc: entry.desc,
    latest: version, latestFile: fileName, history: newHist
  };
  saveManifest(manifest);
  console.log(`  ✓ ${entry.id}: v${version} → ${fileName}`);
  return manifest[entry.id];
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);

  if (args[0] && args[0] !== "--all") {
    // release mirata: <ext-id> "changelog"
    const entry = REGISTRY.find(e => e.id === args[0]);
    if (!entry) { console.error(`Estensione sconosciuta: ${args[0]}. Valide: ${REGISTRY.map(e=>e.id).join(", ")}`); process.exit(1); }
    console.log(`Release mirata: ${entry.id}`);
    releaseOne(entry, args[1] || "", true);
    return;
  }

  const force = args[0] === "--all";
  console.log(force ? "Rizippo TUTTE le estensioni:" : "Rilascio le estensioni con versione nuova:");
  for (const entry of REGISTRY) releaseOne(entry, "", force);
  console.log(`\nManifesto: ${MANIFEST}`);
}

main();
