#!/usr/bin/env node
// Pre-strip 3D geometry out of maps so the preview never has to do it at runtime.
//
//   node tools/build-geo.js "C:/Users/w/Desktop/ClassicCounter/csgo/maps" "C:/Users/w/Downloads/custom maps"
//   node tools/build-geo.js de_dust2.bsp --out maps3d --stats
//
// Writes <out>/<map>.geo.gz (default out = maps3d/). The app reads the same files,
// so anything built here ships with the installer; anything missing is stripped on
// demand from the user's own maps folder and cached in %APPDATA%.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const bspgeo = require("../bspgeo");

const ROOT = path.dirname(__dirname);

function collect(inputs) {
  const files = [];
  for (const inp of inputs) {
    let st; try { st = fs.statSync(inp); } catch { console.error("missing:", inp); continue; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(inp)) if (/\.bsp(\.bz2)?$/i.test(f)) files.push(path.join(inp, f));
    } else files.push(inp);
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const stats = args.includes("--stats");
  const force = args.includes("--force");
  const oi = args.indexOf("--out");
  const out = oi >= 0 ? path.resolve(args[oi + 1]) : path.join(ROOT, "maps3d");
  const inputs = args.filter((a, i) => !a.startsWith("--") && i !== oi + 1);
  if (!inputs.length) { console.error("usage: node tools/build-geo.js <map.bsp|dir> [more…] [--out dir] [--force] [--stats]"); process.exit(1); }

  fs.mkdirSync(out, { recursive: true });
  const files = collect(inputs);
  console.log(`${files.length} map file(s) -> ${out}\n`);
  let ok = 0, skip = 0, fail = 0, bytes = 0;
  for (const f of files.sort()) {
    const name = path.basename(f).replace(/\.bsp(\.bz2)?$/i, "").toLowerCase();
    const dest = path.join(out, name + ".geo.gz");
    if (!force && fs.existsSync(dest)) { skip++; continue; }
    const t0 = Date.now();
    try {
      const geo = bspgeo.extract(f);
      const gz = zlib.gzipSync(bspgeo.serialize(geo), { level: 9 });
      fs.writeFileSync(dest, gz);
      bytes += gz.length;
      ok++;
      const s = geo.stats;
      console.log(`  [ok  ] ${name.padEnd(28)} ${String(geo.triCount).padStart(7)} tris  ${String(Math.round(gz.length / 1024)).padStart(5)} KB  ${Date.now() - t0}ms` +
        (stats ? `   faces ${s.faces} · skipped ${s.skipped} · disp ${s.displacements} · skycull ${s.skyCulled}` : ""));
    } catch (e) {
      fail++;
      console.log(`  [fail] ${name.padEnd(28)} ${e.message}`);
    }
  }
  console.log(`\n${ok} built, ${skip} already present, ${fail} failed · ${(bytes / 1048576).toFixed(1)} MB written`);
}

main();
