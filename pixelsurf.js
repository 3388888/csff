// Confirming pixelsurfs against the map's collision brushes.
//
// The decoder (native/csgofast) flags a "pixelsurf candidate" whenever a player is
// AIRBORNE with no horizontal speed and no vertical movement for half a second — perched
// on a sliver of geometry too small for the engine to call it ground. That test is
// airtight physically, with exactly two lookalikes:
//
//   * standing still on a LADDER  — very common (nuke, vertigo, vents)
//   * treading WATER              — rare in comp maps, common in community ones
//
// Both are brush volumes in the .bsp, so the map itself tells us which is which. No map
// on disk means no confirmation, and an unconfirmed candidate is dropped: on de_nuke_2023
// five of six candidates were ladders, so keeping them unverified would be mostly noise.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const bspgeo = require("./bspgeo");
const { findBsp } = require("./mapfiles");

// A player's hull is 32x32, so his origin can hang up to ~16u off the brush he's holding.
const PAD_XY = 24;   // horizontal slack around a ladder/water volume
const PAD_Z = 32;    // vertical slack (feet vs the volume's own top/bottom)

function metaFile(dir, mapName) { return path.join(dir, mapName + ".meta.json.gz"); }

// Reads the cached brush volumes for a map, extracting them from the .bsp on first use.
// Cheap: only the plane/brush/entity lumps, no faces — milliseconds, a few KB cached.
function loadMeta(mapName, { cacheDir, dirs } = {}) {
  const name = String(mapName || "").toLowerCase().replace(/[^\w.-]/g, "");
  if (!name || !cacheDir) return null;
  const cached = metaFile(cacheDir, name);
  try {
    if (fs.existsSync(cached)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(cached)).toString("utf8"));
  } catch {}
  const bsp = findBsp(name, dirs);
  if (!bsp) return null;
  let meta;
  try { meta = bspgeo.extractMeta(bsp); } catch { return null; }
  meta.forMap = name;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = cached + ".tmp";
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(meta), "utf8")));
    fs.renameSync(tmp, cached);
  } catch {}
  return meta;
}

function insideAny(boxes, x, y, z) {
  for (const b of boxes || []) {
    if (x >= b.minX - PAD_XY && x <= b.maxX + PAD_XY &&
        y >= b.minY - PAD_XY && y <= b.maxY + PAD_XY &&
        z >= b.minZ - PAD_Z && z <= b.maxZ + PAD_Z) return true;
  }
  return false;
}

// Drops every pixelsurf candidate that turns out to be a ladder or water. Returns a small
// report so the caller can log/see what happened. `raw.tricks` is filtered in place.
function confirm(raw, meta) {
  const tricks = (raw && raw.tricks) || [];
  const cands = tricks.filter((t) => t.kind === "pixelsurf");
  if (!cands.length) return { candidates: 0, kept: 0, ladder: 0, water: 0, unverified: 0 };
  if (!meta) {
    raw.tricks = tricks.filter((t) => t.kind !== "pixelsurf");
    return { candidates: cands.length, kept: 0, ladder: 0, water: 0, unverified: cands.length };
  }
  let ladder = 0, water = 0;
  const keep = new Set();
  for (const t of cands) {
    if (insideAny(meta.ladders, t.x, t.y, t.z)) { ladder++; continue; }
    if (insideAny(meta.water, t.x, t.y, t.z)) { water++; continue; }
    keep.add(t);
  }
  raw.tricks = tricks.filter((t) => t.kind !== "pixelsurf" || keep.has(t));
  return { candidates: cands.length, kept: keep.size, ladder, water, unverified: 0 };
}

module.exports = { loadMeta, confirm };
