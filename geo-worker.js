// Forked worker: strip 3D geometry out of one .bsp and write it to the geo cache.
// Runs out-of-process so a 300 MB map (or a bz2 inflate) never stalls the UI.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const bspgeo = require("./bspgeo");

process.on("message", (msg) => {
  try {
    const geo = bspgeo.extract(msg.bsp, { maxDispCells: msg.maxDispCells || 8 });
    const raw = bspgeo.serialize(geo);
    if (msg.out) {
      fs.mkdirSync(path.dirname(msg.out), { recursive: true });
      const tmp = msg.out + ".tmp";
      fs.writeFileSync(tmp, zlib.gzipSync(raw, { level: 6 }));
      fs.renameSync(tmp, msg.out);
    }
    process.send({ ok: true, triCount: geo.triCount, stats: geo.stats, bytes: raw.length });
  } catch (err) {
    process.send({ ok: false, error: err.message });
  }
});
