// Forked worker. Decodes the demo ONCE into a raw cache (kills + telemetry +
// timeline), then classifies raw -> highlights with the current settings.
// A settings/weight change re-runs classify from the cached raw — no re-decode.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawn } = require("child_process");
const seekBzip = require("seek-bzip");
const { parseRaw, classify } = require("./parser");
const pixelsurf = require("./pixelsurf");

// Airborne + no speed + not falling = perched on a pixel... or standing on a ladder / in
// water. The map's collision brushes settle it (see pixelsurf.js). Never let this fail a
// parse: worst case we just drop the candidates.
function confirmPixelsurfs(raw, msg) {
  try {
    if (!raw || !raw.tricks || !raw.tricks.some((t) => t.kind === "pixelsurf")) return;
    const meta = pixelsurf.loadMeta(raw.mapName, { cacheDir: msg.geoDir, dirs: msg.mapDirs });
    const rep = pixelsurf.confirm(raw, meta);
    if (rep.candidates) {
      process.send({ type: "log", text: `pixelsurf: ${rep.kept}/${rep.candidates} confirmed` +
        (rep.ladder ? `, ${rep.ladder} on ladders` : "") + (rep.water ? `, ${rep.water} in water` : "") +
        (rep.unverified ? `, ${rep.unverified} unverified (no .bsp for ${raw.mapName})` : "") });
    }
  } catch {}
}

// native Go decoder (csgofast) — same raw JSON, ~3x faster than the Node decode.
// Writes the gzipped raw straight to the cache file; falls back to Node if absent.
function runCsgofast(demPath, exe, outGz, onProgress) {
  return new Promise((resolve, reject) => {
    const ch = spawn(exe, [demPath, outGz], { windowsHide: true });
    let err = "";
    ch.stderr.on("data", (d) => {
      const s = d.toString(); err += s;
      for (const m of s.matchAll(/P\s+([0-9.]+)/g)) { const f = parseFloat(m[1]); if (onProgress && f >= 0 && f <= 1) onProgress(f); }
    });
    ch.on("error", reject);
    ch.on("close", (code) => code === 0 ? resolve() : reject(new Error("csgofast failed: " + err.split("\n").filter(Boolean).pop())));
  });
}

// CS:S demos: our own native parser (cssfast) handles every network protocol we've
// seen — 7 (v34), 14/15 (v77 era) and 24+ (v93/v94). cssff.exe stays as a fallback.
function runCssfast(demPath, exe, cacheFile) {
  // cached result? (same cache folder as the CS:GO raws, keyed on the demo name)
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)).toString("utf8"));
      if (j && j.frags && j.frags.length) return cssResult(j, demPath);
    } catch {}
  }
  const tmp = (cacheFile || demPath) + ".tmp.json";
  try {
    execFileSync(exe, [demPath, tmp], { timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    // exit 3 = parsed but found no kills -> let the caller fall back to cssff
    if (!fs.existsSync(tmp)) throw new Error("cssfast failed: " + ((e.stderr || "").toString().trim().split("\n").pop() || e.message));
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(tmp, "utf8")); } finally { try { fs.unlinkSync(tmp); } catch {} }
  if (!j || !j.frags || !j.frags.length) throw new Error("cssfast found no frags");
  if (cacheFile) { try { fs.writeFileSync(cacheFile, zlib.gzipSync(JSON.stringify(j))); } catch {} }
  return cssResult(j, demPath);
}

function cssResult(j, demPath) {
  // The position timeline stays in the cache file (it runs to megabytes); the renderer
  // asks for slices through demo:frames, exactly like it does for CS:GO raws.
  return {
    css: true, mapName: j.mapName, tickrate: j.tickrate || 66, demPath,
    hasPositions: !!(j.timeline && j.timeline.length),
    netProtocol: j.netProtocol, players: j.players || [],
    header: { serverName: j.serverName || "" },
    frags: j.frags.map((f) => ({ tick: f.tick, endTick: f.endTick, player: f.player, team: f.team, desc: f.desc,
      kills: f.kills, headshots: f.headshots, weapon: f.weapon, round: f.round, spanSec: f.spanSec })),
  };
}

// Older fallback: the bundled cssff.exe (v34 only), parsed out of its console output.
function demoKind(p) {
  const fd = fs.openSync(p, "r"); const b = Buffer.alloc(1072); fs.readSync(fd, b, 0, 1072, 0); fs.closeSync(fd);
  if (b.toString("latin1", 0, 7) !== "HL2DEMO") return "unknown";
  const proto = b.readInt32LE(8), gd = b.toString("latin1", 796, Math.max(796, b.indexOf(0, 796)));
  if (proto === 4 && /csgo/i.test(gd)) return "csgo";
  if (proto === 3 || /cstrike/i.test(gd)) return "css";
  return "other";
}
function runCssff(demPath, cssffDir) {
  const exe = path.join(cssffDir, "cssff.exe");
  if (!fs.existsSync(exe)) throw new Error("cssff.exe not found (CS:S support). Expected at " + exe);
  let out = "";
  try { out = execFileSync(exe, [demPath], { cwd: cssffDir, timeout: 180000, windowsHide: true, input: "\n\n", maxBuffer: 32 * 1024 * 1024 }).toString(); }
  catch (e) { out = (e.stdout || "").toString(); if (!out) throw new Error("cssff failed: " + e.message); }
  const map = (out.match(/Map name:\s*(\S+)/) || [])[1] || "";
  const tr = +(out.match(/Tickrate:\s*(\d+)/) || [])[1] || 66;
  const frags = [];
  const re = /Tick:\s*(\d+)\s+Player:\s*(.+?)\s*\((CT|TERRORIST|T|SPEC|Unassigned)\)[\r\n]+\s*Frag:\s*(.+)/g;
  let m; while ((m = re.exec(out))) frags.push({ tick: +m[1], player: m[2].trim(), team: /CT/.test(m[3]) ? 3 : 2, desc: m[4].trim() });
  return { css: true, mapName: map, tickrate: tr, frags, demPath, header: { serverName: (out.match(/Server name:\s*(.+)/) || [])[1] || "" } };
}

function resolveDem(p, deleteBz2) {
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const inner = fs.readdirSync(p).find((f) => /\.dem$/i.test(f) && fs.statSync(path.join(p, f)).isFile());
    if (!inner) throw new Error("No .dem file inside folder: " + p);
    return path.join(p, inner);
  }
  if (p.toLowerCase().endsWith(".bz2")) {
    const out = p.slice(0, -4);
    if (!fs.existsSync(out)) {
      try { fs.writeFileSync(out, seekBzip.decode(fs.readFileSync(p))); } // pure-JS bzip2 (no external tool)
      catch (e) { throw new Error("Could not extract .bz2: " + e.message); }
    }
    if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error("Extraction failed: " + out);
    if (deleteBz2) { try { fs.unlinkSync(p); } catch {} }
    return resolveDem(out, false);
  }
  return p;
}

process.on("message", async (msg) => {
  // quick job: extract a .bz2 -> .dem off the main process (bzip2 decode is CPU-heavy and
  // was freezing the UI when done inline). Handled here and returned immediately.
  if (msg && msg.extract) {
    try { fs.writeFileSync(msg.out, seekBzip.decode(fs.readFileSync(msg.in))); process.send({ ok: true }); }
    catch (e) { process.send({ ok: false, error: e.message }); }
    return;
  }
  try {
    const opts = msg.opts || {};
    let raw = null;
    // read the newest existing cache (rawRead); decode only when there is none. writes go
    // to rawWrite (current format), so a re-decode upgrades an old cache in place.
    if (msg.rawRead && fs.existsSync(msg.rawRead)) {
      try { raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawRead))); } catch { raw = null; }
      // older caches were written without it, and classify needs the filename (tick hints)
      if (raw && !raw.demPath) raw.demPath = msg.path;
    }
    if (!raw) {
      const onProgress = (frac) => process.send({ type: "progress", frac });
      let usedNative = false;
      // FAST PATH: hand the file (even .bz2) straight to csgofast — it unzips natively and
      // decodes in one pass, skipping the slow pure-JS bzip2 + the extra .dem on disk.
      const isFile = fs.existsSync(msg.path) && fs.statSync(msg.path).isFile() && /\.(dem|bz2)$/i.test(msg.path);
      if (msg.csgofast && fs.existsSync(msg.csgofast) && msg.rawWrite && isFile) {
        try {
          await runCsgofast(msg.path, msg.csgofast, msg.rawWrite, onProgress);
          raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawWrite)));
          raw.demPath = msg.path;
          usedNative = true;
        } catch (nativeErr) { raw = null; } // not CS:GO (e.g. CS:S) or error -> classic path below
      }
      if (!usedNative) {
        const p = resolveDem(msg.path, opts.deleteBz2); // JS unzip / folder resolve
        if (!fs.existsSync(p)) throw new Error("File not found: " + p);
        if (demoKind(p) === "css") {
          let result = null, err1 = null;
          if (msg.cssfast && fs.existsSync(msg.cssfast)) {
            try { result = runCssfast(p, msg.cssfast, msg.cssFile); } catch (e) { err1 = e; }
          }
          if (!result) {
            try { result = runCssff(p, msg.cssffDir); }
            catch (e) { throw new Error(err1 ? `${err1.message}; cssff: ${e.message}` : e.message); }
          }
          process.send({ ok: true, result });
          return;
        }
        if (msg.csgofast && fs.existsSync(msg.csgofast) && msg.rawWrite) {
          try { await runCsgofast(p, msg.csgofast, msg.rawWrite, onProgress); raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawWrite))); raw.demPath = p; usedNative = true; } catch { raw = null; }
        }
        if (!usedNative) {
          raw = await parseRaw(p, { onProgress });
          raw.demPath = p;
          if (msg.rawWrite) { try { fs.writeFileSync(msg.rawWrite, zlib.gzipSync(JSON.stringify(raw))); } catch {} }
        }
      }
    }
    // vet pixelsurf candidates against the map's ladder/water brushes before classify
    confirmPixelsurfs(raw, msg);
    const result = classify(raw, opts);
    result.demPath = raw.demPath || msg.path;
    process.send({ ok: true, result });
  } catch (e) {
    process.send({ ok: false, error: e.message });
  }
});
