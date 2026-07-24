// Forked worker. Decodes the demo ONCE into a raw cache (kills + telemetry +
// timeline), then classifies raw -> highlights with the current settings.
// A settings/weight change re-runs classify from the cached raw — no re-decode.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const seekBzip = require("seek-bzip");
const { parseRaw, classify } = require("./parser");

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
