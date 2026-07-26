// Tiny JSON settings store in Electron userData.
const fs = require("fs");
const path = require("path");

let file = null;
const DEFAULTS = {
  demosDir: "",
  csgoExe: "",     // full path to csgo.exe (for "Open in CS:GO")
  hlaeExe: "",     // optional HLAE launcher
  prerollSec: 1.0,
  longRangeM: 25,
  flickMinDeg: 22,      // yaw snap to count as a flick
  bhopMinSpeed: 260,    // airborne speed to count as a bhop kill
  multikillGapSec: 8,   // max seconds between kills to still count as a multikill
  rngMaxChance: 0.25,   // single-shot hit-chance at/below this = an "rng" kill
  runMinJumps: 5,       // jumps a bhop run must chain
  runMinPeak: 300,      // top speed a bhop run must reach
  runMinAir: 45,        // % airborne a bhop run must be
  nearbyRadius: 1000,   // close-range radius for "outnumbered"
  edgebugMinDmg: 20,    // min fall damage an edgebug must save (unless it leads to a kill)
  maxPreviewSec: 25,    // cap movement preview length
  weights: {},          // per-tag point overrides for scoring (empty = defaults)
  cssExe: "",           // path to css hl2.exe / launcher for "Open in CS:S"
  frag: {},             // cssff-style frag rule overrides (noscope distance, multikill times, ...)
  deleteBz2: true,      // auto-delete the .bz2 after extracting (avoids duplicate entries)
  soloView: false,      // preview shows only the highlighted player
  disabledCats: [],     // category tags the user has hidden
  scanConcurrency: 6,   // demos parsed in parallel during "Best of folder"
};

function init(userDataDir) { file = path.join(userDataDir, "settings.json"); }
function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function save(obj) {
  const merged = { ...load(), ...obj };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}
module.exports = { init, load, save, DEFAULTS };
