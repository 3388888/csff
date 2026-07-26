// Forked worker. Decodes the demo ONCE into a raw cache (kills + telemetry +
// timeline), then classifies raw -> highlights with the current settings.
// A settings/weight change re-runs classify from the cached raw — no re-decode.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const seekBzip = require("seek-bzip");
const { parseRaw, classify } = require("./parser");

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
      const p = resolveDem(msg.path, opts.deleteBz2);
      if (!fs.existsSync(p)) throw new Error("File not found: " + p);
      if (demoKind(p) === "css") { const result = runCssff(p, msg.cssffDir); process.send({ ok: true, result }); return; } // CS:S via cssff.exe
      raw = await parseRaw(p, { onProgress: (frac) => process.send({ type: "progress", frac }) });
      raw.demPath = p;
      if (msg.rawFile) { try { fs.writeFileSync(msg.rawFile, zlib.gzipSync(JSON.stringify(raw))); } catch {} }
    }
    const result = classify(raw, opts);
    result.demPath = raw.demPath || msg.path;
    process.send({ ok: true, result });
  } catch (e) {
    process.send({ ok: false, error: e.message });
  }
});
