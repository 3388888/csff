// bspgeo.js — strip renderable geometry out of Source-engine maps (VBSP .bsp / .bsp.bz2)
// so the preview can draw the real map in 3D.
//
// We only read the handful of lumps needed for a triangle soup:
//   VERTEXES + EDGES + SURFEDGES + FACES   -> brush geometry
//   TEXINFO + TEXDATA + string table       -> surface flags (skip sky/nodraw/trigger) + a material class
//   DISPINFO + DISP_VERTS                  -> displacement terrain (ground on most maps)
//   MODELS + ENTITIES                      -> brush-entity offsets, spawn bounds, 3D-skybox cull
//
// Output is a compact binary blob (see serialize()): quantized int16 positions,
// one material byte per triangle. Normals are derived in the shader, so nothing
// else needs to be stored. A 40 MB bsp typically strips down to ~1-3 MB (~300 KB gzipped).
"use strict";

const fs = require("fs");
const path = require("path");

const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7,
  EDGES: 12, SURFEDGES: 13, MODELS: 14, DISPINFO: 26, DISP_VERTS: 33,
  TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44, FACES_HDR: 58,
};

// surface flags (bspflags.h)
const SURF_LIGHT = 0x1, SURF_SKY2D = 0x2, SURF_SKY = 0x4, SURF_WARP = 0x8, SURF_TRANS = 0x10,
  SURF_NOPORTAL = 0x20, SURF_TRIGGER = 0x40, SURF_NODRAW = 0x80, SURF_HINT = 0x100,
  SURF_SKIP = 0x200, SURF_NOLIGHT = 0x400, SURF_HITBOX = 0x8000;
const SKIP_MASK = SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_TRIGGER | SURF_HINT | SURF_SKIP | SURF_HITBOX;

// material classes — index into the palette in renderer/preview3d.js
const MAT = {
  DEFAULT: 0, BRICK: 1, WOOD: 2, METAL: 3, SAND: 4, GRASS: 5, WATER: 6, GLASS: 7,
  ROCK: 8, TILE: 9, PLASTER: 10, FABRIC: 11, SNOW: 12,
};
// first match wins, so order matters (e.g. "sandstone" is rock-ish, not sand)
const MAT_RULES = [
  [MAT.WATER, /water|slime|liquid/],
  [MAT.GLASS, /glass|window|mirror/],
  [MAT.SNOW, /snow|ice(?!land)|frost/],
  [MAT.GRASS, /grass|foliage|hedge|bush|leaf|leaves|moss|jungle/],
  [MAT.SAND, /sand(?!stone)|dust_floor|dirt|mud|gravel|desert|ground_dust|dust\/dust/],
  [MAT.ROCK, /rock|cliff|sandstone|boulder|stone_wall|cobble|limestone/],
  [MAT.WOOD, /wood|plank|crate|plywood|lumber|fence_wood|door_wood/],
  [MAT.METAL, /metal|steel|iron|alum|corrugate|chainlink|grate|pipe|vent|container|train|car_|truck/],
  [MAT.BRICK, /brick|masonry/],
  [MAT.TILE, /tile|marble|checker|floor_tile/],
  [MAT.FABRIC, /carpet|fabric|cloth|canvas|tarp|rug|awning/],
  [MAT.PLASTER, /plaster|stucco|drywall|paint|wall_paper|wallpaper|paper|sheetrock/],
];
function classifyMaterial(name, flags) {
  if (flags & SURF_WARP) return MAT.WATER;
  const n = (name || "").toLowerCase();
  for (const [m, re] of MAT_RULES) if (re.test(n)) return m;
  return MAT.DEFAULT;
}

// ---------------------------------------------------------------- lump access

// Reads only the byte ranges we need. For a plain .bsp that means we never pull the
// (huge) pakfile/lighting lumps off disk at all; for .bsp.bz2 we have to inflate first.
function openBsp(file) {
  const isBz2 = /\.bz2$/i.test(file);
  let fd = null, mem = null;
  if (isBz2) {
    const seekBzip = require("seek-bzip");
    mem = seekBzip.decode(fs.readFileSync(file));
  } else {
    fd = fs.openSync(file, "r");
  }
  const head = Buffer.alloc(1036);
  if (mem) mem.copy(head, 0, 0, Math.min(1036, mem.length));
  else fs.readSync(fd, head, 0, 1036, 0);

  const magic = head.toString("latin1", 0, 4);
  if (magic !== "VBSP") {
    if (fd != null) fs.closeSync(fd);
    throw new Error(magic === "rBSP" || magic === "VBSP".split("").reverse().join("") ? "unsupported bsp variant" : "not a VBSP map");
  }
  const version = head.readInt32LE(4);
  const lumps = [];
  for (let i = 0; i < 64; i++) {
    const o = 8 + i * 16;
    lumps.push({ ofs: head.readInt32LE(o), len: head.readInt32LE(o + 4), ver: head.readInt32LE(o + 8) });
  }
  return {
    version, lumps,
    read(i) {
      const l = lumps[i];
      if (!l || l.len <= 0) return Buffer.alloc(0);
      // always a fresh Buffer.alloc so byteOffset is 0 — typed-array views over the
      // lumps need 4-byte alignment, which subarray()/pooled buffers don't guarantee
      const buf = Buffer.alloc(l.len);
      if (mem) mem.copy(buf, 0, l.ofs, l.ofs + l.len);
      else fs.readSync(fd, buf, 0, l.len, l.ofs);
      // per-lump LZMA compression (some console/workshop maps) — we can't inflate that
      if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "LZMA") throw new Error("lump-compressed (LZMA) bsp not supported");
      return buf;
    },
    close() { if (fd != null) try { fs.closeSync(fd); } catch {} },
  };
}

// ---------------------------------------------------------------- entities

// Minimal keyvalue scan of the entity lump: we only want origins/classnames.
function parseEntities(buf) {
  const txt = buf.toString("latin1");
  const out = [];
  const blockRe = /\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(txt))) {
    const ent = {};
    const kvRe = /"([^"]*)"\s*"([^"]*)"/g;
    let kv;
    while ((kv = kvRe.exec(m[1]))) ent[kv[1].toLowerCase()] = kv[2];
    out.push(ent);
  }
  return out;
}
function vec3(s) {
  if (!s) return null;
  const p = String(s).trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every((n) => Number.isFinite(n)) ? [p[0], p[1], p[2]] : null;
}

// ---------------------------------------------------------------- extraction

const FACE_SIZE = 56, TEXINFO_SIZE = 72, TEXDATA_SIZE = 32, DISPINFO_SIZE = 176, DISPVERT_SIZE = 20, MODEL_SIZE = 48;

/**
 * Strip a triangle soup out of a .bsp / .bsp.bz2.
 * @returns {{name,triCount,pos:Int16Array,mat:Uint8Array,bounds,play,version,stats}}
 */
function extract(file, opts = {}) {
  const maxDispCells = opts.maxDispCells || 8;   // cap displacement tessellation (8x8 quads per face)
  const bsp = openBsp(file);
  try {
    const vertsBuf = bsp.read(LUMP.VERTEXES);
    const edgesBuf = bsp.read(LUMP.EDGES);
    const surfBuf = bsp.read(LUMP.SURFEDGES);
    let facesBuf = bsp.read(LUMP.FACES);
    if (!facesBuf.length) facesBuf = bsp.read(LUMP.FACES_HDR);
    const texinfoBuf = bsp.read(LUMP.TEXINFO);
    const texdataBuf = bsp.read(LUMP.TEXDATA);
    const strTabBuf = bsp.read(LUMP.TEXDATA_STRING_TABLE);
    const strDatBuf = bsp.read(LUMP.TEXDATA_STRING_DATA);
    const dispInfoBuf = bsp.read(LUMP.DISPINFO);
    const dispVertBuf = bsp.read(LUMP.DISP_VERTS);
    const modelsBuf = bsp.read(LUMP.MODELS);
    const ents = parseEntities(bsp.read(LUMP.ENTITIES));

    if (!vertsBuf.length || !facesBuf.length) throw new Error("no geometry lumps");

    const nVerts = (vertsBuf.length / 12) | 0;
    const nEdges = (edgesBuf.length / 4) | 0;
    const nSurf = (surfBuf.length / 4) | 0;
    const nFaces = (facesBuf.length / FACE_SIZE) | 0;
    const nTexinfo = (texinfoBuf.length / TEXINFO_SIZE) | 0;
    const nTexdata = (texdataBuf.length / TEXDATA_SIZE) | 0;
    const nDisp = (dispInfoBuf.length / DISPINFO_SIZE) | 0;

    // texture name per texdata, then material class per texinfo
    const strOfs = new Int32Array(strTabBuf.buffer, strTabBuf.byteOffset, (strTabBuf.length / 4) | 0);
    const texName = new Array(nTexdata);
    for (let i = 0; i < nTexdata; i++) {
      const id = texdataBuf.readInt32LE(i * TEXDATA_SIZE + 12);
      let name = "";
      if (id >= 0 && id < strOfs.length) {
        const s = strOfs[id];
        let e = s;
        while (e < strDatBuf.length && strDatBuf[e] !== 0) e++;
        name = strDatBuf.toString("latin1", s, e);
      }
      texName[i] = name;
    }
    const tiFlags = new Int32Array(nTexinfo), tiMat = new Uint8Array(nTexinfo);
    for (let i = 0; i < nTexinfo; i++) {
      const flags = texinfoBuf.readInt32LE(i * TEXINFO_SIZE + 64);
      const td = texinfoBuf.readInt32LE(i * TEXINFO_SIZE + 68);
      tiFlags[i] = flags;
      tiMat[i] = classifyMaterial(td >= 0 && td < nTexdata ? texName[td] : "", flags);
    }

    // brush-entity face ranges -> world offset (most brush ents sit at 0 0 0, but
    // doors/elevators with an origin brush need the shift or they float away)
    const nModels = (modelsBuf.length / MODEL_SIZE) | 0;
    const faceOffset = new Map(); // firstface -> {numfaces, off:[x,y,z]}
    if (nModels > 1) {
      const byModel = new Map();
      for (const e of ents) {
        const mdl = e.model;
        if (mdl && mdl[0] === "*") {
          const idx = parseInt(mdl.slice(1), 10);
          if (Number.isFinite(idx)) byModel.set(idx, e);
        }
      }
      for (let i = 1; i < nModels; i++) {
        const e = byModel.get(i);
        const o = e && vec3(e.origin);
        if (!o || (!o[0] && !o[1] && !o[2])) continue;
        const base = i * MODEL_SIZE;
        faceOffset.set(modelsBuf.readInt32LE(base + 40), { numfaces: modelsBuf.readInt32LE(base + 44), off: o });
      }
    }
    // expand to a per-face offset lookup
    const perFaceOff = faceOffset.size ? new Map() : null;
    if (perFaceOff) for (const [first, { numfaces, off }] of faceOffset) for (let f = first; f < first + numfaces; f++) perFaceOff.set(f, off);

    // 3D-skybox mini-world: real geometry parked far from the playspace. Culling it
    // keeps the camera framing (and the view) sane.
    const skyCam = (() => { const e = ents.find((x) => x.classname === "sky_camera"); return e ? vec3(e.origin) : null; })();
    const SKY_CULL_R = 2600;

    // playable bounds from spawn points (used to frame the camera and as a sanity check)
    let pMinX = Infinity, pMinY = Infinity, pMinZ = Infinity, pMaxX = -Infinity, pMaxY = -Infinity, pMaxZ = -Infinity;
    for (const e of ents) {
      if (!/^info_(player_(terrorist|counterterrorist|start|deathmatch)|deathmatch_spawn)$/.test(e.classname || "")) continue;
      const o = vec3(e.origin);
      if (!o) continue;
      if (o[0] < pMinX) pMinX = o[0]; if (o[1] < pMinY) pMinY = o[1]; if (o[2] < pMinZ) pMinZ = o[2];
      if (o[0] > pMaxX) pMaxX = o[0]; if (o[1] > pMaxY) pMaxY = o[1]; if (o[2] > pMaxZ) pMaxZ = o[2];
    }
    const hasPlay = pMinX < Infinity;

    // typed views over the raw lumps (little-endian everywhere Source runs)
    const vx = new Float32Array(vertsBuf.buffer, vertsBuf.byteOffset, nVerts * 3);
    const ed = new Uint16Array(edgesBuf.buffer, edgesBuf.byteOffset, nEdges * 2);
    const se = new Int32Array(surfBuf.buffer, surfBuf.byteOffset, nSurf);
    const dv = new Float32Array(dispVertBuf.buffer, dispVertBuf.byteOffset, ((dispVertBuf.length / 4) | 0));

    // growable output
    let cap = 1 << 16;
    let pos = new Int16Array(cap * 9), mat = new Uint8Array(cap), n = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, m) {
      if (skyCam) {
        const mx = (ax + bx + cx) / 3 - skyCam[0], my = (ay + by + cy) / 3 - skyCam[1], mz = (az + bz + cz) / 3 - skyCam[2];
        if (mx * mx + my * my + mz * mz < SKY_CULL_R * SKY_CULL_R) { skyCulled++; return; }
      }
      // degenerate faces (slivers from bsp splitting) add nothing but bytes
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (nx * nx + ny * ny + nz * nz < 4) return;
      if (n >= cap) {
        cap *= 2;
        const p2 = new Int16Array(cap * 9); p2.set(pos); pos = p2;
        const m2 = new Uint8Array(cap); m2.set(mat); mat = m2;
      }
      const o = n * 9;
      pos[o] = q(ax); pos[o + 1] = q(ay); pos[o + 2] = q(az);
      pos[o + 3] = q(bx); pos[o + 4] = q(by); pos[o + 5] = q(bz);
      pos[o + 6] = q(cx); pos[o + 7] = q(cy); pos[o + 8] = q(cz);
      mat[n] = m; n++;
      if (ax < minX) minX = ax; if (ay < minY) minY = ay; if (az < minZ) minZ = az;
      if (ax > maxX) maxX = ax; if (ay > maxY) maxY = ay; if (az > maxZ) maxZ = az;
    }

    let skyCulled = 0, skipped = 0, dispCount = 0;
    const fv = [];  // scratch: face vertices as [x,y,z] triples

    for (let f = 0; f < nFaces; f++) {
      const b = f * FACE_SIZE;
      const firstEdge = facesBuf.readInt32LE(b + 4);
      const numEdges = facesBuf.readInt16LE(b + 8);
      const texinfo = facesBuf.readInt16LE(b + 10);
      const dispinfo = facesBuf.readInt16LE(b + 12);
      if (numEdges < 3) continue;
      const flags = texinfo >= 0 && texinfo < nTexinfo ? tiFlags[texinfo] : 0;
      if (flags & SKIP_MASK) { skipped++; continue; }
      const m = texinfo >= 0 && texinfo < nTexinfo ? tiMat[texinfo] : MAT.DEFAULT;

      // gather the face loop
      fv.length = 0;
      let bad = false;
      for (let i = 0; i < numEdges; i++) {
        const si = firstEdge + i;
        if (si < 0 || si >= nSurf) { bad = true; break; }
        const s = se[si];
        const ei = (s >= 0 ? s : -s);
        if (ei < 0 || ei >= nEdges) { bad = true; break; }
        const vi = s >= 0 ? ed[ei * 2] : ed[ei * 2 + 1];
        if (vi >= nVerts) { bad = true; break; }
        fv.push(vx[vi * 3], vx[vi * 3 + 1], vx[vi * 3 + 2]);
      }
      if (bad) continue;

      const off = perFaceOff && perFaceOff.get(f);
      if (off) for (let i = 0; i < fv.length; i += 3) { fv[i] += off[0]; fv[i + 1] += off[1]; fv[i + 2] += off[2]; }

      if (dispinfo >= 0 && dispinfo < nDisp && numEdges === 4) {
        emitDisplacement(dispinfo, fv, m);
        dispCount++;
        continue;
      }

      // convex polygon -> fan
      for (let i = 1; i + 1 < numEdges; i++) {
        pushTri(fv[0], fv[1], fv[2], fv[i * 3], fv[i * 3 + 1], fv[i * 3 + 2], fv[(i + 1) * 3], fv[(i + 1) * 3 + 1], fv[(i + 1) * 3 + 2], m);
      }
    }

    function emitDisplacement(di, corners, m) {
      const base = di * DISPINFO_SIZE;
      const sx = dispInfoBuf.readFloatLE(base), sy = dispInfoBuf.readFloatLE(base + 4), sz = dispInfoBuf.readFloatLE(base + 8);
      const vStart = dispInfoBuf.readInt32LE(base + 12);
      const power = dispInfoBuf.readInt32LE(base + 20);
      if (power < 2 || power > 4) return;
      const size = (1 << power) + 1;
      // the corner nearest startPosition is grid (0,0); rotate the quad to match
      let best = 0, bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const dx = corners[i * 3] - sx, dy = corners[i * 3 + 1] - sy, dz = corners[i * 3 + 2] - sz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      const c = [];
      for (let i = 0; i < 4; i++) { const k = ((best + i) % 4) * 3; c.push([corners[k], corners[k + 1], corners[k + 2]]); }

      const step = Math.max(1, Math.round((size - 1) / maxDispCells));
      const gp = [];   // sampled grid rows of [x,y,z]
      const rows = [];
      for (let i = 0; i < size; i += step) rows.push(i);
      if (rows[rows.length - 1] !== size - 1) rows.push(size - 1);
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (const i of rows) {
        const ti = i / (size - 1);
        const leftEnd = lerp(c[0], c[1], ti);
        const rightEnd = lerp(c[3], c[2], ti);
        const row = [];
        for (const j of rows) {
          const tj = j / (size - 1);
          const p = lerp(leftEnd, rightEnd, tj);
          const vi = vStart + i * size + j;
          const o = vi * 5;   // ddispvert_t = vec3 vec + float dist + float alpha
          if (o + 4 < dv.length) {
            const d = dv[o + 3];
            p[0] += dv[o] * d; p[1] += dv[o + 1] * d; p[2] += dv[o + 2] * d;
          }
          row.push(p);
        }
        gp.push(row);
      }
      for (let i = 0; i + 1 < gp.length; i++) {
        for (let j = 0; j + 1 < gp[i].length; j++) {
          const a = gp[i][j], b2 = gp[i][j + 1], cc = gp[i + 1][j + 1], d2 = gp[i + 1][j];
          pushTri(a[0], a[1], a[2], b2[0], b2[1], b2[2], cc[0], cc[1], cc[2], m);
          pushTri(a[0], a[1], a[2], cc[0], cc[1], cc[2], d2[0], d2[1], d2[2], m);
        }
      }
    }

    if (!n) throw new Error("no drawable faces");

    return {
      name: path.basename(file).replace(/\.bsp(\.bz2)?$/i, "").toLowerCase(),
      version: bsp.version,
      triCount: n,
      pos: pos.subarray(0, n * 9),
      mat: mat.subarray(0, n),
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
      play: hasPlay ? { minX: pMinX, minY: pMinY, minZ: pMinZ, maxX: pMaxX, maxY: pMaxY, maxZ: pMaxZ } : null,
      stats: { faces: nFaces, skipped, displacements: dispCount, skyCulled },
    };
  } finally {
    bsp.close();
  }
}

// ---------------------------------------------------------------- (de)serialize

// CCG1: [magic][triCount][bounds 6f][play 6f][flags] then int16 xyz*3 per tri, then 1 material byte per tri
const HEADER = 64;
function serialize(geo) {
  const buf = Buffer.alloc(HEADER + geo.triCount * 18 + geo.triCount);
  buf.write("CCG1", 0, "latin1");
  buf.writeUInt32LE(geo.triCount, 4);
  const b = geo.bounds;
  const f = [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
  for (let i = 0; i < 6; i++) buf.writeFloatLE(f[i], 8 + i * 4);
  const p = geo.play || b;
  const g = [p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ];
  for (let i = 0; i < 6; i++) buf.writeFloatLE(g[i], 32 + i * 4);
  buf.writeUInt32LE(geo.play ? 1 : 0, 56);
  buf.writeUInt32LE(geo.version || 0, 60);
  Buffer.from(geo.pos.buffer, geo.pos.byteOffset, geo.triCount * 18).copy(buf, HEADER);
  Buffer.from(geo.mat.buffer, geo.mat.byteOffset, geo.triCount).copy(buf, HEADER + geo.triCount * 18);
  return buf;
}

module.exports = { extract, serialize, MAT, LUMP, HEADER };
