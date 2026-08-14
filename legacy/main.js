const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fork, spawn, execFile } = require("child_process");
const seekBzip = require("seek-bzip");
const settings = require("./settings");
const { writeVdmForDemo } = require("./vdm");

// CS:GO/CS:S can't playdemo a .bz2 — extract it to the sibling .dem (once) and use THAT for
// both the .vdm and the launch, so compressed demos stop silently failing to launch.
// The bzip2 decode runs in a forked worker (doing it inline froze the UI). Idempotent.
function extractDem(inp, out) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, "parse-worker.js"), [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 180000);
    child.on("message", (m) => { clearTimeout(t); try { child.kill(); } catch {} resolve(!!(m && m.ok)); });
    child.on("error", () => { clearTimeout(t); resolve(false); });
    child.send({ extract: true, in: inp, out });
  });
}
async function playableDem(demPath) {
  if (!/\.bz2$/i.test(demPath || "")) return demPath;
  const out = demPath.replace(/\.bz2$/i, "");
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out; // already extracted
  await extractDem(demPath, out);
  return fs.existsSync(out) ? out : demPath;
}

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
// How busy the CPU is *right now* — so the scanner can size its worker pool to the cores
// actually free (Windows Defender's real-time scan can eat a third of them). Samples the
// per-core idle deltas over a short window and reports how many cores are effectively idle.
ipcMain.handle("cpu:sample", async (e, ms) => {
  const snap = () => os.cpus().map((c) => c.times);
  const a = snap();
  await new Promise((r) => setTimeout(r, Math.max(120, Math.min(1000, ms || 350))));
  const b = snap();
  let idle = 0, total = 0;
  for (let i = 0; i < b.length; i++) {
    const di = b[i].idle - a[i].idle;
    const dt = Object.keys(b[i]).reduce((s, k) => s + (b[i][k] - a[i][k]), 0);
    idle += di; total += dt;
  }
  const cores = b.length;
  const idleFrac = total > 0 ? idle / total : 0.5;
  return { cores, freeCores: Math.max(1, Math.round(cores * idleFrac)), idlePct: Math.round(idleFrac * 100) };
});

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
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, path: p, compressed }) => {
    // file mtime doubles as the match date, so the UI can show/sort highlights by age
    let mtime = 0; try { mtime = Math.round(fs.statSync(p).mtimeMs); } catch {}
    return { name, path: p, compressed, mtime };
  });
});

function cacheDir() { const d = path.join(app.getPath("userData"), "cache"); fs.mkdirSync(d, { recursive: true }); return d; }
// RAW decode cache, newest format first. Reading tries every version in order and uses
// the first that exists; only a demo with NO cache at all is decoded. So a version bump
// (a new decoder signal like pixelsurf) NEVER forces a re-decode of demos already cached
// — they load as-is, missing only the newest signal (which degrades gracefully), and fill
// in as demos are freshly decoded. Classify/scoring/tag/filter changes never touch this
// cache at all; they re-run from it (minutes), which is NOT the 17h decode.
//   v8 = split decode/classify;  v9 = + pixelsurf candidates & trick x/y/z
const RAW_VERSIONS = ["v9", "v8"];
function rawName(demoPath, ver) {
  const base = path.basename(demoPath).replace(/\.dem(\.bz2)?$/i, "").replace(/[^\w.-]/g, "_");
  return `${base}_raw_${ver}.json.gz`;
}
function rawWritePath(demoPath) { return path.join(cacheDir(), rawName(demoPath, RAW_VERSIONS[0])); }
function rawReadPath(demoPath) {
  for (const ver of RAW_VERSIONS) {
    const p = path.join(cacheDir(), rawName(demoPath, ver));
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// CS:S results live in the SAME cache folder as the CS:GO raws (they used to be written
// next to the demo, which littered the demo folder and re-parsed on every open).
function cssKey(demoPath) {
  const base = path.basename(demoPath).replace(/\.dem(\.bz2)?$/i, "").replace(/[^\w.-]/g, "_");
  // v2 = userinfo table decodes (roster names + slot→userID), so the timeline's uids
  // line up with the roster; v1 caches have blank radar labels and must be redone.
  return `${base}_css_v2.json.gz`;
}

// cssff_settings.ini — the rulebook the classifier obeys
const cssffcfg = require("./cssffcfg");
function cssffIniPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "cssff", "cssff_settings.ini")
    : path.join(__dirname, "vendor", "cssff", "cssff_settings.ini");
}
function cssffConfig() { return cssffcfg.load(cssffIniPath()); }
ipcMain.handle("cssff:config", () => {
  const c = cssffConfig();
  return { file: c.file, mtime: c.mtime, ok: c.ok, error: c.error || null, general: c.general, sections: c.sections };
});
ipcMain.handle("cssff:reveal", () => { shell.showItemInFolder(cssffIniPath()); return true; });

// Persistent worker pool. Forking a fresh process per demo (spawn + module load each time)
// was the real cost of "re-classify from cache" — thousands of process startups. Instead we
// keep a handful of workers alive and reuse them, so a cache re-classify is just IPC + read.
const idleWorkers = [];
function newWorker() {
  const child = fork(path.join(__dirname, "parse-worker.js"), [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const w = { child, busy: false };
  child.on("exit", () => { const i = idleWorkers.indexOf(w); if (i >= 0) idleWorkers.splice(i, 1); });
  return w;
}
function acquireWorker() {
  while (idleWorkers.length) { const w = idleWorkers.pop(); if (w.child && !w.child.killed) return w; }
  return newWorker();
}
function releaseWorker(w) { if (w && w.child && !w.child.killed) { w.busy = false; idleWorkers.push(w); } }

// decode-once (cached raw) + classify with current settings, on a pooled worker
ipcMain.handle("demo:parse", (e, demoPath, opts) => new Promise((resolve, reject) => {
  // read the newest cache that exists; write the current format. forceDecode (background
  // pixelsurf backfill) ignores the read cache so an old v8 demo is re-decoded to v9.
  const rawRead = (opts && opts.forceDecode) ? null : rawReadPath(demoPath);
  const rawWrite = rawWritePath(demoPath);
  const w = acquireWorker();
  const child = w.child;
  let settled = false;
  const cleanup = () => { child.off("message", onMsg); child.off("error", onErr); };
  const onMsg = (m) => {
    if (m.type === "progress") { if (win && !win.isDestroyed()) win.webContents.send("parse:progress", { demoPath, frac: m.frac }); return; }
    if (m.type === "log") { console.log("[worker]", m.text); return; } // pixelsurf confirm report, etc.
    if (settled) return; settled = true; clearTimeout(timer); cleanup(); releaseWorker(w);
    m.ok ? resolve(m.result) : reject(new Error(m.error));
  };
  const onErr = (err) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); try { child.kill(); } catch {} reject(err); };
  // a hung decode must not poison the pool: kill (don't reuse) on timeout
  const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); try { child.kill(); } catch {} reject(new Error("Parse timed out")); }, 3 * 60 * 1000);
  child.on("message", onMsg);
  child.on("error", onErr);
  const cssffDir = app.isPackaged ? path.join(process.resourcesPath, "cssff") : path.join(__dirname, "vendor", "cssff");
  const csgofast = app.isPackaged ? path.join(process.resourcesPath, "csgofast", "csgofast.exe") : path.join(__dirname, "native", "csgofast", "csgofast.exe");
  // Rust decoder (native/csgo-rs, built with --features app). Same interface as csgofast;
  // parse-worker prefers it and falls back to csgofast if it's absent/errors.
  const csgors = app.isPackaged ? path.join(process.resourcesPath, "csgo-rs", "csgo-rs.exe") : path.join(__dirname, "native", "csgo-rs", "target", "release", "csgo-rs.exe");
  const cssfast = app.isPackaged ? path.join(process.resourcesPath, "cssfast", "cssfast.exe") : path.join(__dirname, "native", "cssfast", "cssfast.exe");
  // the ini is the rulebook: read it fresh for every parse so editing it takes effect
  // on the next scan without restarting anything
  opts = { ...(opts || {}), cssff: cssffConfig() };
  const cssFile = path.join(cacheDir(), cssKey(demoPath));
  child.send({ path: demoPath, opts, rawRead, rawWrite, cssFile, cssffDir, csgofast, csgors, cssfast,
    mapDirs: mapSearchDirs(), geoDir: geoCacheDir() }); // for pixelsurf ladder/water vetting
}));

// which of these demos still lack the newest decode (v9 = pixelsurf)? the renderer uses
// this to backfill them in the background without re-decoding what's already current.
ipcMain.handle("demos:pixelsurfPending", (e, demoPaths) => {
  const cur = RAW_VERSIONS[0];
  return (demoPaths || []).filter((p) => {
    try { return !fs.existsSync(path.join(cacheDir(), rawName(p, cur))); } catch { return false; }
  });
});

// fast preview: slice just the frames for one highlight straight from the cached raw
// (no full re-classify). This is what makes the preview open quickly.
ipcMain.handle("demo:frames", (e, demPath, watchTick, endTick, maxPreviewSec, round) => {
  try {
    const rawFile = rawReadPath(demPath);
    if (!rawFile) return cssFrames(demPath, watchTick, endTick, maxPreviewSec);
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile)));
    const tickrate = raw.tickrate || 64;
    const end = Math.min(endTick, watchTick + Math.round(tickrate * (maxPreviewSec || 25)));
    // who's already dead during this clip — the timeline keeps sampling corpses
    const deathAt = {};
    for (const k of raw.kills || []) {
      const uid = k.victim && k.victim.uid;
      if (uid == null) continue;
      const inScope = round != null ? k.round === round : (k.killTick <= end && k.killTick >= watchTick - tickrate * 60);
      if (!inScope) continue;
      if (deathAt[uid] == null || k.killTick < deathAt[uid]) deathAt[uid] = k.killTick;
    }
    const frames = [];
    for (const f of raw.timeline) {
      if (f.t < watchTick || f.t > end) continue;
      frames.push({ tick: f.t, players: f.p.filter((q) => q[4] === 2 || q[4] === 3).map((q) => ({ uid: q[0], x: q[1], y: q[2], yaw: q[3], team: q[4], z: q[5] == null ? null : q[5],
        name: (raw.roster[q[0]] || {}).name || "", dead: deathAt[q[0]] != null && f.t >= deathAt[q[0]] ? deathAt[q[0]] : null })) });
    }
    const utils = (raw.utils || []).filter((u) => u.endTick >= watchTick && u.tick <= end);
    return { tickrate, watchTick, endTick: end, frames, utils };
  } catch { return null; }
});

// CS:S previews: same job as above, but the positions live in the cssfast cache. The
// timeline format is identical ([uid, x, y, yaw, team, z] per sampled tick), so the radar
// and the 3D view consume it unchanged.
function cssFrames(demPath, watchTick, endTick, maxPreviewSec) {
  try {
    const f = path.join(cacheDir(), cssKey(demPath));
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
    if (!j.timeline || !j.timeline.length) return null;
    const tickrate = j.tickrate || 66;
    const end = Math.min(endTick, watchTick + Math.round(tickrate * (maxPreviewSec || 25)));
    const roster = j.roster || {};
    const frames = [];
    for (const fr of j.timeline) {
      if (fr.t < watchTick || fr.t > end) continue;
      frames.push({ tick: fr.t, players: fr.p.filter((q) => q[4] === 2 || q[4] === 3).map((q) => ({ uid: q[0], x: q[1], y: q[2], yaw: q[3], team: q[4], z: q[5],
        name: (roster[q[0]] || {}).name || "", dead: null })) });
    }
    if (!frames.length) return null;
    // hand the whole roster over too: a POV demo may not carry the frag's author in
    // this particular window, and the renderer still needs his uid to follow him
    return { tickrate, watchTick, endTick: end, frames, utils: [], roster };
  } catch { return null; }
}

// write a .vdm next to the demo covering all cool kills
ipcMain.handle("vdm:write", async (e, demPath, coolKills, opts) => {
  return writeVdmForDemo(await playableDem(demPath), coolKills, opts); // .vdm sits next to the real .dem
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

// CS:S servers run renamed variants of maps we already have art for (de_cache_v34,
// de_vertigo_sc, de_nuke_old_blue_ep, de_tuscan/de_toscan). When the exact name is
// missing, fall back to the closest base name — most specific first — and tell the UI
// it's an approximation so the user knows the overlay may be slightly off.
function mapAliases(name) {
  const out = [];
  const swaps = [["tuscan", "toscan"], ["toscan", "tuscan"], ["cbble", "cobble"], ["cobble", "cbble"]];
  const push = (n) => { if (n && n !== name && !out.includes(n)) out.push(n); };
  const alts = (n) => { push(n); for (const [a, b] of swaps) if (n.includes(a)) push(n.replace(a, b)); };
  alts(name);
  const parts = name.split("_");
  for (let n = parts.length - 1; n >= 2; n--) alts(parts.slice(0, n).join("_"));
  return out;
}

// radar image (as data URL) + calibration for a map, or null if we don't have it
let mapsCal = null;
ipcMain.handle("maps:radar", (e, map) => {
  const read = (m) => {
    const cal = mapsCal && mapsCal[m];
    if (!cal) return null;
    try { return { cal, dataUrl: "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "maps", m + ".png")).toString("base64") }; }
    catch { return null; }
  };
  try {
    const calFile = path.join(__dirname, "maps", "maps.json");
    if (!mapsCal) mapsCal = JSON.parse(fs.readFileSync(calFile, "utf8"));
    if (!mapsCal[map]) { try { mapsCal = JSON.parse(fs.readFileSync(calFile, "utf8")); } catch {} } // maps.json may have grown
    const exact = read(map);
    if (exact) return exact;
    for (const alt of mapAliases(map)) {
      const r = read(alt);
      if (r) return { ...r, usedMap: alt };
    }
    return null;
  } catch { return null; }
});

// ---- 3D preview geometry (stripped out of the map's .bsp) ----
// Lookup order: prebuilt maps3d/ that ships with the app -> the userData cache ->
// strip it out of a .bsp we can find on disk (then cache it).
const bspgeo = require("./bspgeo");
function geoCacheDir() { const d = path.join(app.getPath("userData"), "geo"); fs.mkdirSync(d, { recursive: true }); return d; }

function mapSearchDirs() {
  const s = settings.load();
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  add(s.mapsDir); add(s.mapsDir2);
  for (const exe of [s.csgoExe, s.cssExe]) {
    if (!exe) continue;
    const base = path.dirname(exe);
    for (const sub of ["csgo", "cstrike", "cc", "hl2"]) add(path.join(base, sub, "maps"));
    add(path.join(base, "maps"));
  }
  try { add(path.join(app.getPath("home"), "Downloads", "custom maps")); } catch {}
  try { add(path.join(app.getPath("desktop"), "ClassicCounter", "csgo", "maps")); } catch {}
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// <dir>/<map>.bsp | <map>.bsp.bz2, plus one level of workshop/<id>/ subfolders
function findBspExact(map) {
  for (const dir of mapSearchDirs()) {
    for (const ext of [".bsp", ".bsp.bz2"]) {
      const p = path.join(dir, map + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    for (const sub of ["workshop", "download"]) {
      let ids = []; try { ids = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
      for (const id of ids.slice(0, 400)) {
        for (const ext of [".bsp", ".bsp.bz2"]) {
          const p = path.join(dir, sub, id, map + ext);
          try { if (fs.statSync(p).isFile()) return p; } catch {}
        }
      }
    }
  }
  return null;
}
// exact file first; only then the renamed-variant fallbacks (see mapAliases)
function findBsp(map) {
  const hit = findBspExact(map);
  if (hit) return hit;
  for (const alt of mapAliases(map)) {
    const p = findBspExact(alt);
    if (p) return p;
  }
  return null;
}

function stripGeo(bsp, out) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, "geo-worker.js"), [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: "geometry strip timed out" }); }, 90 * 1000);
    child.on("message", (m) => { clearTimeout(timer); try { child.kill(); } catch {} resolve(m); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.send({ bsp, out });
  });
}

const geoInflight = new Map();
ipcMain.handle("maps:geo", async (e, map) => {
  const name = String(map || "").toLowerCase().replace(/[^\w.-]/g, "");
  if (!name) return { ok: false, error: "no map name" };
  const prebuilt = path.join(__dirname, "maps3d", name + ".geo.gz");
  const cached = path.join(geoCacheDir(), name + ".geo.gz");
  for (const f of [prebuilt, cached]) {
    try { if (fs.existsSync(f)) return { ok: true, data: zlib.gunzipSync(fs.readFileSync(f)), source: f }; } catch {}
  }
  if (geoInflight.has(name)) return geoInflight.get(name);
  const job = (async () => {
    const bsp = findBsp(name);
    if (!bsp) return { ok: false, error: `no .bsp found for ${name} — point Settings ▸ Maps folder at your maps directory` };
    const used = path.basename(bsp).replace(/\.bsp(\.bz2)?$/i, "").toLowerCase();
    const r = await stripGeo(bsp, cached);
    if (!r.ok) return { ok: false, error: `${path.basename(bsp)}: ${r.error}` };
    try { return { ok: true, data: zlib.gunzipSync(fs.readFileSync(cached)), source: bsp, triCount: r.triCount, stripped: true, usedMap: used !== name ? used : undefined }; }
    catch (err) { return { ok: false, error: err.message }; }
  })().finally(() => geoInflight.delete(name));
  geoInflight.set(name, job);
  return job;
});

// does this map have (or could it get) 3D geometry? cheap check for the UI
ipcMain.handle("maps:geoAvailable", (e, map) => {
  const name = String(map || "").toLowerCase().replace(/[^\w.-]/g, "");
  if (!name) return false;
  if (fs.existsSync(path.join(__dirname, "maps3d", name + ".geo.gz"))) return true;
  if (fs.existsSync(path.join(geoCacheDir(), name + ".geo.gz"))) return true;
  return !!findBsp(name);
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
// is a process with this exe name already running? (so we don't spawn a doomed 2nd copy)
function isRunning(exeBase) {
  return new Promise((resolve) => {
    try { execFile("tasklist", ["/FI", `IMAGENAME eq ${exeBase}`, "/NH"], { windowsHide: true }, (err, out) => resolve(!err && String(out).toLowerCase().includes(exeBase.toLowerCase()))); }
    catch { resolve(false); }
  });
}
// launch the game to play the demo (VDM auto-loads if same basename next to it).
// If a netcon port is set and the game is up, jump in the running instance instead.
async function launchGame(exe, demPath, port) {
  demPath = await playableDem(demPath); // extract .bz2 -> .dem so playdemo can actually read it
  // resume before switching: loading a new demo while the current one is PAUSED is extra
  // crash-prone, and that's exactly the state our own demo_pause leaves it in.
  if (port) { const ok = await sendNetcon(+port, ["demo_resume", `playdemo "${demPath}"`]); if (ok) return { ok: true, running: true }; }
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: "Set the game exe path in Settings (or launch the game with -netconport)." };
  // netcon didn't answer. If the game is ALREADY open (you started it yourself, without
  // console access) a second copy just errors with "only one instance" — so don't. Tell
  // the user how to make jump-in work instead.
  const base = path.basename(exe);
  if (await isRunning(base)) {
    return { ok: false, running: true, error: `${base} is already open but I can't control it — it wasn't started with console access. Close the game, then click again and I'll relaunch it so demos jump straight to the clip. (The .vdm is written next to the demo, so you can also load it manually with playdemo.)` };
  }
  // game not running: launch it WITH -netconport so every later clip jumps into this instance
  try { const child = spawn(exe, ["-novid", "-insecure", ...(port ? ["-netconport", String(port)] : []), "+playdemo", demPath], { detached: true, stdio: "ignore", cwd: path.dirname(exe) }); child.unref(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}
// Nobody should have to go find a port number: if it isn't set we pick one, save it, and
// launch the game with -netconport ourselves. Every launch after that can jump into the
// running game instead of starting it again.
function ensureNetconPort(key, fallback) {
  const s = settings.load();
  const cur = String(s[key] || "").trim();
  if (cur) return cur;
  const port = String(fallback);
  try { settings.save({ [key]: port }); } catch {}
  return port;
}
ipcMain.handle("csgo:launch", (e, demPath) => {
  const s = settings.load();
  return launchGame(s.csgoExe, demPath, ensureNetconPort("csgoNetconPort", 2121));
});
ipcMain.handle("css:launch", (e, demPath) => {
  const s = settings.load();
  return launchGame(s.cssExe, demPath, ensureNetconPort("cssNetconPort", 2122));
});
