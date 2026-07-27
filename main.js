const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { fork, spawn } = require("child_process");
const settings = require("./settings");
const { writeVdmForDemo } = require("./vdm");

app.setName("CSGO Demo Highlights"); // share cache/ratings/settings between dev run and installed build

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 940, minHeight: 600,
    backgroundColor: "#0f1216",
    title: "CS:GO Demo Highlights",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  settings.init(app.getPath("userData"));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // check GitHub Releases for a newer version and install it on next quit (packaged app only)
  if (app.isPackaged) {
    try { const { autoUpdater } = require("electron-updater"); autoUpdater.autoDownload = true; autoUpdater.checkForUpdatesAndNotify(); } catch {}
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// ---- IPC ----
ipcMain.handle("settings:get", () => settings.load());
ipcMain.handle("settings:set", (e, obj) => settings.save(obj));

ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("dialog:pickFile", async (e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: filters || [] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("dialog:pickDemos", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "CS:GO demos", extensions: ["dem", "bz2"] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// One entry per demo: an extracted .dem (file or folder) wins over its .bz2.
// Recurses into subfolders (up to a depth) so demos organized in subdirs are found.
ipcMain.handle("demos:list", (e, dir) => {
  const byKey = new Map(); // basename(no .bz2) -> {name, path, compressed, rank}
  function consider(f, full, isDir) {
    let key, rank, compressed = false;
    if (isDir && /\.dem$/i.test(f)) { key = f; rank = 2; }              // extracted folder
    else if (!isDir && /\.dem$/i.test(f)) { key = f; rank = 3; }         // extracted file (best)
    else if (!isDir && /\.dem\.bz2$/i.test(f)) { key = f.slice(0, -4); rank = 1; compressed = true; }
    else return false;
    const prev = byKey.get(key);
    if (!prev || rank > prev.rank) byKey.set(key, { name: key, path: full, compressed, rank });
    return true;
  }
  function walk(d, depth) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      let isDir; try { isDir = ent.isDirectory(); } catch { continue; }
      const isDemo = consider(ent.name, full, isDir);
      // recurse into normal subfolders, but not into a *.dem folder (that IS a demo)
      if (isDir && !isDemo && depth > 0) walk(full, depth - 1);
    }
  }
  walk(dir, 4);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, path: p, compressed }) => ({ name, path: p, compressed }));
});

function cacheDir() { const d = path.join(app.getPath("userData"), "cache"); fs.mkdirSync(d, { recursive: true }); return d; }
// RAW cache key — parser version only, NOT thresholds/weights (those apply at
// classify time, so tuning them never re-decodes). v8 = split decode/classify.
function rawKey(demoPath) {
  const base = path.basename(demoPath).replace(/\.dem(\.bz2)?$/i, "").replace(/[^\w.-]/g, "_");
  return `${base}_raw_v8.json.gz`;
}

// decode-once (cached raw) + classify with current settings, in a forked worker
ipcMain.handle("demo:parse", (e, demoPath, opts) => new Promise((resolve, reject) => {
  const rawFile = path.join(cacheDir(), rawKey(demoPath));
  const child = fork(path.join(__dirname, "parse-worker.js"), [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const timer = setTimeout(() => { child.kill(); reject(new Error("Parse timed out")); }, 3 * 60 * 1000);
  child.on("message", (m) => {
    if (m.type === "progress") { if (win && !win.isDestroyed()) win.webContents.send("parse:progress", { demoPath, frac: m.frac }); return; }
    clearTimeout(timer); child.kill(); m.ok ? resolve(m.result) : reject(new Error(m.error));
  });
  child.on("error", (err) => { clearTimeout(timer); reject(err); });
  const cssffDir = app.isPackaged ? path.join(process.resourcesPath, "cssff") : path.join(__dirname, "vendor", "cssff");
  const csgofast = app.isPackaged ? path.join(process.resourcesPath, "csgofast", "csgofast.exe") : path.join(__dirname, "native", "csgofast", "csgofast.exe");
  child.send({ path: demoPath, opts, rawFile, cssffDir, csgofast });
}));

// fast preview: slice just the frames for one highlight straight from the cached raw
// (no full re-classify). This is what makes the preview open quickly.
ipcMain.handle("demo:frames", (e, demPath, watchTick, endTick, maxPreviewSec) => {
  try {
    const rawFile = path.join(cacheDir(), rawKey(demPath));
    if (!fs.existsSync(rawFile)) return null;
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile)));
    const tickrate = raw.tickrate || 64;
    const end = Math.min(endTick, watchTick + Math.round(tickrate * (maxPreviewSec || 25)));
    const frames = [];
    for (const f of raw.timeline) {
      if (f.t < watchTick || f.t > end) continue;
      frames.push({ tick: f.t, players: f.p.map((q) => ({ uid: q[0], x: q[1], y: q[2], yaw: q[3], team: q[4], z: q[5] == null ? null : q[5], name: (raw.roster[q[0]] || {}).name || "" })) });
    }
    const utils = (raw.utils || []).filter((u) => u.endTick >= watchTick && u.tick <= end);
    return { tickrate, watchTick, endTick: end, frames, utils };
  } catch { return null; }
});

// write a .vdm next to the demo covering all cool kills
ipcMain.handle("vdm:write", (e, demPath, coolKills, opts) => {
  const p = writeVdmForDemo(demPath, coolKills, opts);
  return p;
});

ipcMain.handle("shell:showItem", (e, p) => { shell.showItemInFolder(p); });
ipcMain.handle("weights:defaults", () => require("./parser").TAGW);

// thumbs up/down ratings (to learn scoring weights from the user's taste)
function ratingsFile() { return path.join(app.getPath("userData"), "ratings.json"); }
ipcMain.handle("ratings:get", () => { try { return JSON.parse(fs.readFileSync(ratingsFile(), "utf8")); } catch { return {}; } });
ipcMain.handle("ratings:set", (e, key, patch) => {
  let all = {}; try { all = JSON.parse(fs.readFileSync(ratingsFile(), "utf8")); } catch {}
  const next = { ...(all[key] || {}), ...patch };
  const hasNote = next.note && String(next.note).trim();
  if (!next.r && !hasNote) delete all[key]; else all[key] = next;
  try { fs.writeFileSync(ratingsFile(), JSON.stringify(all)); } catch {}
  return all;
});
// write a readable feedback file to the Desktop (to share) and reveal it
ipcMain.handle("feedback:export", (e, text) => {
  const p = path.join(app.getPath("desktop"), "demo-highlights-feedback.md");
  try { fs.writeFileSync(p, text); shell.showItemInFolder(p); return p; } catch (err) { return null; }
});

// persistent "best of folder" store — save all extracted highlights so the folder
// scan is a ONE-TIME cost; reopening/filtering never re-reads demo caches.
const zlib = require("zlib");
function aggFile() { return path.join(app.getPath("userData"), "aggregate_v2.json.gz"); }
ipcMain.handle("aggregate:load", () => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(aggFile()))); } catch { return null; } });
ipcMain.handle("aggregate:save", (e, data) => { try { fs.writeFileSync(aggFile(), zlib.gzipSync(JSON.stringify(data))); return true; } catch (err) { return false; } });
ipcMain.handle("aggregate:clear", () => { try { fs.unlinkSync(aggFile()); } catch {} return true; });

// favorites (for building a demopack)
function favFile() { return path.join(app.getPath("userData"), "favorites.json"); }
ipcMain.handle("favorites:get", () => { try { return JSON.parse(fs.readFileSync(favFile(), "utf8")); } catch { return {}; } });
ipcMain.handle("favorites:set", (e, key, entry) => {
  let all = {}; try { all = JSON.parse(fs.readFileSync(favFile(), "utf8")); } catch {}
  if (entry == null) delete all[key]; else all[key] = entry;
  try { fs.writeFileSync(favFile(), JSON.stringify(all)); } catch {}
  return all;
});
// export favorites into a folder: copy each demo once, renamed player_type_tick.dem,
// with a .vdm beside it that jumps through every favorited clip in that demo.
ipcMain.handle("demopack:export", async (e, favs) => {
  favs = (favs || []).filter((f) => f && f.demoPath);
  if (!favs.length) return { ok: false, error: "No favorites yet — star some clips first." };
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Choose a folder for the demopack" });
  if (r.canceled) return { ok: false, error: "cancelled" };
  const outDir = r.filePaths[0];
  const sani = (s) => String(s || "").replace(/[^\w.-]/g, "_").replace(/_+/g, "_").slice(0, 40) || "clip";
  const byDemo = new Map();
  for (const f of favs) { if (!byDemo.has(f.demoPath)) byDemo.set(f.demoPath, []); byDemo.get(f.demoPath).push(f); }
  let copied = 0, failed = 0, clips = 0;
  for (const [demoPath, list] of byDemo) {
    try {
      let src = demoPath;
      if (fs.existsSync(src) && fs.statSync(src).isDirectory()) { const inner = fs.readdirSync(src).find((f) => /\.dem$/i.test(f)); if (inner) src = path.join(src, inner); }
      if (!fs.existsSync(src)) { failed++; continue; }
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = list[0];
      const base = list.length === 1 ? `${sani(top.player)}_${sani(top.type)}_${top.tick}` : `${sani(top.player)}_${list.length}clips_${top.tick}`;
      let dest = path.join(outDir, base + ".dem"), i = 2;
      while (fs.existsSync(dest)) dest = path.join(outDir, `${base}_${i++}.dem`);
      fs.copyFileSync(src, dest);
      try { writeVdmForDemo(dest, list.map((c) => ({ watchTick: c.tick, killTick: c.killTick, endTick: c.endTick, attacker: { name: c.player }, tags: c.tags || [] })), {}); } catch {}
      copied++; clips += list.length;
    } catch { failed++; }
  }
  try { shell.openPath(outDir); } catch {}
  return { ok: true, copied, failed, clips, dir: outDir };
});

// weapon + modifier SVG icons (read once)
let iconCache = null;
ipcMain.handle("icons:get", () => {
  if (iconCache) return iconCache;
  const read = (sub) => {
    const dir = path.join(__dirname, "assets", sub); const out = {};
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".svg")) out[f.replace(/\.svg$/, "")] = fs.readFileSync(path.join(dir, f), "utf8"); } catch {}
    return out;
  };
  iconCache = { weapons: read("weapons"), modifiers: read("modifiers") };
  return iconCache;
});

// radar image (as data URL) + calibration for a map, or null if we don't have it
let mapsCal = null;
ipcMain.handle("maps:radar", (e, map) => {
  try {
    const calFile = path.join(__dirname, "maps", "maps.json");
    if (!mapsCal) mapsCal = JSON.parse(fs.readFileSync(calFile, "utf8"));
    if (!mapsCal[map]) { try { mapsCal = JSON.parse(fs.readFileSync(calFile, "utf8")); } catch {} } // maps.json may have grown
    const cal = mapsCal[map];
    if (!cal) return null;
    const png = fs.readFileSync(path.join(__dirname, "maps", map + ".png"));
    return { cal, dataUrl: "data:image/png;base64," + png.toString("base64") };
  } catch { return null; }
});

// Try to hand the demo to an ALREADY-RUNNING game over its netconsole (requires the
// game to have been launched with -netconport <port>). Resolves true on success.
const net = require("net");
function sendNetcon(port, cmds) {
  return new Promise((resolve) => {
    let done = false; const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.write(cmds.join("\n") + "\n"); setTimeout(() => { try { sock.end(); } catch {} fin(true); }, 200); });
    sock.setTimeout(700, () => { try { sock.destroy(); } catch {} fin(false); });
    sock.on("error", () => fin(false));
  });
}
// launch the game to play the demo (VDM auto-loads if same basename next to it).
// If a netcon port is set and the game is up, jump in the running instance instead.
async function launchGame(exe, demPath, port) {
  if (port) { const ok = await sendNetcon(+port, [`playdemo "${demPath}"`]); if (ok) return { ok: true, running: true }; }
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: "Set the game exe path in Settings (or launch the game with -netconport)." };
  try { const child = spawn(exe, ["-novid", "-insecure", ...(port ? ["-netconport", String(port)] : []), "+playdemo", demPath], { detached: true, stdio: "ignore", cwd: path.dirname(exe) }); child.unref(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}
ipcMain.handle("csgo:launch", (e, demPath) => { const s = settings.load(); return launchGame(s.csgoExe, demPath, s.csgoNetconPort); });
ipcMain.handle("css:launch", (e, demPath) => { const s = settings.load(); return launchGame(s.cssExe, demPath, s.cssNetconPort); });
