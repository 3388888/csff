// Generate a Valve Demo Metadata (.vdm) file so CS:GO auto-jumps through the
// highlights when you `playdemo` the demo. Place next to the .dem (same basename).
const fs = require("fs");

function buildVdm(highlights, opts = {}) {
  const timescale = opts.timescale || 1;
  const hls = [...highlights].filter((h) => h.watchTick != null).sort((a, b) => a.watchTick - b.watchTick);
  let idx = 1;
  const blocks = [];
  let prevEnd = 0, firstBlock = true;
  for (const h of hls) {
    const watch = Math.max(0, h.watchTick);
    const end = h.endTick != null ? h.endTick : (h.killTick + (opts.postTicks || 384));
    blocks.push(skipAhead(idx++, prevEnd, watch));
    const n = h.kills ? h.kills.length : 1;
    const label = `${san(h.attacker.name)} ${n > 1 ? n + "K " : ""}${san((h.tags || []).join(" "))}`.trim();
    const specCmd = specCommands(h.attacker); // lock camera to the player who made the play
    const spec = specCmd ? `; ${specCmd}` : "";
    // bind a key to toggle pause (once) — the built-in demo-UI play button is fiddly
    const bind = firstBlock ? "; bind p demo_togglepause" : ""; firstBlock = false;
    // Pause on arrival: CS:GO's skip lands roughly and the entities need a beat to settle,
    // so playing immediately shows the kill at a jittery moment. Pausing at the clip start
    // (preroll-seconds before the kill) lets it settle; press P (or the demo UI) to run it.
    const pause = opts.pause ? "; demo_pause" : "";
    blocks.push(playCommands(idx++, watch, `host_timescale ${timescale}; echo [HL] ${label}${bind}${spec}${pause}`));
    // Re-lock the camera right at the kill: the lock issued right after a skip often doesn't
    // "take" until the spectator system updates, so reinforce it a moment before the kill.
    if (specCmd && h.killTick != null && h.killTick > watch) {
      blocks.push(playCommands(idx++, Math.max(watch + 1, h.killTick - 32), specCmd));
    }
    prevEnd = end;
  }
  blocks.push(playCommands(idx++, prevEnd, "host_timescale 1; echo [HL] end of highlights"));
  return `demoactions\n{\n${blocks.join("\n")}\n}\n`;
}

const skipAhead = (i, start, to) => ` "${i}"\n {\n  factory "SkipAhead"\n  name "skip_${i}"\n  starttick "${start}"\n  skiptotick "${to}"\n }`;
const playCommands = (i, start, cmds) => ` "${i}"\n {\n  factory "PlayCommands"\n  name "cmd_${i}"\n  starttick "${start}"\n  commands "${cmds}"\n }`;
const san = (s) => String(s || "").replace(/["\n;]/g, " ").slice(0, 60);
// SteamID64 -> Steam3 account id (low 32 bits). Returns null for bots / bad ids.
function accountId(steamId) {
  try { const n = BigInt(steamId) - 76561197960265728n; return n > 0n && n < 4294967296n ? n.toString() : null; } catch { return null; }
}
// Most distinctive single token of a name (no spaces, so it survives the VDM string) — used
// with spec_player's substring match as a backup for the account-id lock.
function specToken(name) {
  const toks = String(name || "").split(/\s+/).map((t) => t.replace(/["\n;]/g, "")).filter((t) => t.length >= 2);
  return toks.length ? toks.sort((a, b) => b.length - a.length)[0] : "";
}
// Point the spectator at the player who made the play. Prefer the NON-locking spec_player
// (name substring) — spec_lock_to_accountid is a broadcast-observer lock that disables the
// scoreboard (Tab) and manual player-switching, so it's only a fallback for name-less cases.
function specCommands(attacker) {
  const tok = specToken(attacker && attacker.name);
  if (tok) return `spec_mode 4; spec_player ${tok}`;
  const acc = accountId(attacker && attacker.steamId);
  return acc ? `spec_mode 4; spec_lock_to_accountid ${acc}` : "";
}

function writeVdmForDemo(demPath, highlights, opts) {
  const vdmPath = demPath.replace(/\.dem$/i, "") + ".vdm";
  fs.writeFileSync(vdmPath, buildVdm(highlights, opts));
  return vdmPath;
}

module.exports = { buildVdm, writeVdmForDemo };
