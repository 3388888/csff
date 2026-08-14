// Finding a map's .bsp on disk, and the name fallbacks that make old CS:S map versions
// resolve to the closest thing we have. Shared by the main process (3D geometry, radar)
// and the parse worker (pixelsurf confirmation), so the rules can't drift apart.
"use strict";

const fs = require("fs");
const path = require("path");

// CS:S / community servers run renamed variants of maps we already have art or geometry
// for (de_cache_v34 -> de_cache, de_vertigo_sc -> de_vertigo, de_tuscan -> de_toscan).
// Most specific first; only ever used when the exact name is missing.
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

// <dir>/<map>.bsp | <map>.bsp.bz2, plus one level of workshop/<id>/ and download/<id>/
function findBspExact(map, dirs) {
  for (const dir of dirs || []) {
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

// exact file first; only then the renamed-variant fallbacks
function findBsp(map, dirs) {
  const hit = findBspExact(map, dirs);
  if (hit) return hit;
  for (const alt of mapAliases(map)) {
    const p = findBspExact(alt, dirs);
    if (p) return p;
  }
  return null;
}

module.exports = { mapAliases, findBsp, findBspExact };
