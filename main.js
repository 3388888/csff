const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { fork, spawn } = require("child_process");
const settings = require("./settings");
const { writeVdmForDemo } = require("./vdm");

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
  child.send({ path: demoPath, opts, rawFile });
}));

// write a .vdm next to the demo covering all cool kills
ipcMain.handle("vdm:write", (e, demPath, coolKills, opts) => {
  const p = writeVdmForDemo(demPath, coolKills, opts);
  return p;
});

ipcMain.handle("shell:showItem", (e, p) => { shell.showItemInFolder(p); });
ipcMain.handle("weights:defaults", () => require("./parser").TAGW);

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

// launch CS:GO to play the demo (VDM auto-loads if same basename next to it)
ipcMain.handle("csgo:launch", (e, demPath) => {
  const s = settings.load();
  if (!s.csgoExe || !fs.existsSync(s.csgoExe)) return { ok: false, error: "Set csgo.exe path in Settings first." };
  // copy demo into csgo/replays if launching by name is needed; simplest: pass absolute path
  const args = ["-novid", "-insecure", "+playdemo", demPath];
  try {
    const child = spawn(s.csgoExe, args, { detached: true, stdio: "ignore", cwd: path.dirname(s.csgoExe) });
    child.unref();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
