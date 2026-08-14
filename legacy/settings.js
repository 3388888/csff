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
  clutchMaxSec: 45,     // max seconds a clutch may span (first -> last kill)
  clutchMaxGapSec: 20,  // max seconds between two kills of a clutch
  focusNamedTick: true, // demo named after a tick -> focus on that moment, hide the rest
  focusWindowSec: 15,   // how close a clip must be to the named tick to count as "the moment"
  focusKeepScore: 110,   // ...unless it scores at least this (insane moments are never hidden)
  rngMaxChance: 0.25,   // single-shot hit-chance at/below this = an "rng" kill
  runMinJumps: 5,       // jumps a bhop run must chain
  runMinPeak: 300,      // top speed a bhop run must reach
  runMinAir: 45,        // % airborne a bhop run must be
  runMaxSec: 12,        // a bhop run longer than this is aimless wandering, not a route
  nearbyRadius: 1000,   // close-range radius for "outnumbered"
  edgebugMinDmg: 20,    // min fall damage an edgebug must save (unless it leads to a kill)
  maxPreviewSec: 25,    // cap movement preview length
  mapsDir: "",          // where the .bsp files live (for the 3D preview); auto-detected from csgoExe if empty
  mapsDir2: "",         // extra maps folder (e.g. downloaded custom maps)
  prefer3d: true,       // open previews in 3D when the map's geometry is available
  cam3d: "chase",       // chase | pov | orbit | top
  cutRoofs: true,       // hide geometry above the action so you can see inside buildings
  weights: {},          // per-tag point overrides for scoring (empty = defaults)
  cssExe: "",           // path to css hl2.exe / launcher for "Open in CS:S"
  csgoNetconPort: "",   // if set, "Open in CS:GO" jumps in the running game (launch it with -netconport)
  cssNetconPort: "",
  frag: {},             // cssff-style frag rule overrides (noscope distance, multikill times, ...)
  deleteBz2: true,      // auto-delete the .bz2 after extracting (avoids duplicate entries)
  soloView: false,      // preview shows only the highlighted player
  disabledCats: ["troll"], // category tags hidden by default (troll off unless enabled)
  scanConcurrency: 6,   // demos parsed in parallel during "Best of folder"
  _trollDefaulted: false, // one-time migration flag so existing installs also get troll off
};

function init(userDataDir) { file = path.join(userDataDir, "settings.json"); }
function load() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
  // one-time: turn Troll off for people who saved settings before it existed
  if (!s._trollDefaulted) {
    if (Array.isArray(s.disabledCats) && !s.disabledCats.includes("troll")) s.disabledCats.push("troll");
    s._trollDefaulted = true;
    try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch {}
  }
  return s;
}
function save(obj) {
  const merged = { ...load(), ...obj };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}
module.exports = { init, load, save, DEFAULTS };
