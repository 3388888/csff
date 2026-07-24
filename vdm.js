// Generate a Valve Demo Metadata (.vdm) file so CS:GO auto-jumps through the
// highlights when you `playdemo` the demo. Place next to the .dem (same basename).
const fs = require("fs");

function buildVdm(highlights, opts = {}) {
  const timescale = opts.timescale || 1;
  const hls = [...highlights].filter((h) => h.watchTick != null).sort((a, b) => a.watchTick - b.watchTick);
  let idx = 1;
  const blocks = [];
  let prevEnd = 0;
  for (const h of hls) {
    const watch = Math.max(0, h.watchTick);
    const end = h.endTick != null ? h.endTick : (h.killTick + (opts.postTicks || 384));
    blocks.push(skipAhead(idx++, prevEnd, watch));
    const n = h.kills ? h.kills.length : 1;
    const label = `${san(h.attacker.name)} ${n > 1 ? n + "K " : ""}${san((h.tags || []).join(" "))}`.trim();
    blocks.push(playCommands(idx++, watch, `host_timescale ${timescale}; echo [HL] ${label}`));
    prevEnd = end;
  }
  blocks.push(playCommands(idx++, prevEnd, "host_timescale 1; echo [HL] end of highlights"));
  return `demoactions\n{\n${blocks.join("\n")}\n}\n`;
}

const skipAhead = (i, start, to) => ` "${i}"\n {\n  factory "SkipAhead"\n  name "skip_${i}"\n  starttick "${start}"\n  skiptotick "${to}"\n }`;
const playCommands = (i, start, cmds) => ` "${i}"\n {\n  factory "PlayCommands"\n  name "cmd_${i}"\n  starttick "${start}"\n  commands "${cmds}"\n }`;
const san = (s) => String(s || "").replace(/["\n;]/g, " ").slice(0, 60);

function writeVdmForDemo(demPath, highlights, opts) {
  const vdmPath = demPath.replace(/\.dem$/i, "") + ".vdm";
  fs.writeFileSync(vdmPath, buildVdm(highlights, opts));
  return vdmPath;
}

module.exports = { buildVdm, writeVdmForDemo };
