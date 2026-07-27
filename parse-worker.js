// Forked worker. Decodes the demo ONCE into a raw cache (kills + telemetry +
// timeline), then classifies raw -> highlights with the current settings.
// A settings/weight change re-runs classify from the cached raw — no re-decode.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawn } = require("child_process");
const seekBzip = require("seek-bzip");
const { parseRaw, classify } = require("./parser");

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

// CS:S demos (protocol 3 / cstrike) aren't supported by our parser — run the
// bundled cssff.exe (native, works on v34) and parse its frag list instead.
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
  try {
    const opts = msg.opts || {};
    let raw = null;
    if (msg.rawFile && fs.existsSync(msg.rawFile)) {
      try { raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawFile))); } catch { raw = null; }
    }
    if (!raw) {
      const onProgress = (frac) => process.send({ type: "progress", frac });
      let usedNative = false;
      // FAST PATH: hand the file (even .bz2) straight to csgofast — it unzips natively and
      // decodes in one pass, skipping the slow pure-JS bzip2 + the extra .dem on disk.
      const isFile = fs.existsSync(msg.path) && fs.statSync(msg.path).isFile() && /\.(dem|bz2)$/i.test(msg.path);
      if (msg.csgofast && fs.existsSync(msg.csgofast) && msg.rawFile && isFile) {
        try {
          await runCsgofast(msg.path, msg.csgofast, msg.rawFile, onProgress);
          raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawFile)));
          raw.demPath = msg.path;
          usedNative = true;
        } catch (nativeErr) { raw = null; } // not CS:GO (e.g. CS:S) or error -> classic path below
      }
      if (!usedNative) {
        const p = resolveDem(msg.path, opts.deleteBz2); // JS unzip / folder resolve
        if (!fs.existsSync(p)) throw new Error("File not found: " + p);
        if (demoKind(p) === "css") { const result = runCssff(p, msg.cssffDir); process.send({ ok: true, result }); return; }
        if (msg.csgofast && fs.existsSync(msg.csgofast) && msg.rawFile) {
          try { await runCsgofast(p, msg.csgofast, msg.rawFile, onProgress); raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(msg.rawFile))); raw.demPath = p; usedNative = true; } catch { raw = null; }
        }
        if (!usedNative) {
          raw = await parseRaw(p, { onProgress });
          raw.demPath = p;
          if (msg.rawFile) { try { fs.writeFileSync(msg.rawFile, zlib.gzipSync(JSON.stringify(raw))); } catch {} }
        }
      }
    }
    const result = classify(raw, opts);
    result.demPath = raw.demPath || msg.path;
    process.send({ ok: true, result });
  } catch (e) {
    process.send({ ok: false, error: e.message });
  }
});
