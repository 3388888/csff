// cssffcfg.js — read cssff_settings.ini and treat it as THE rulebook.
//
// The ini is the law: whatever it says about max times, minimum headshots, required
// special kills, distances and which frag types tick is what the classifier uses. Edit
// the file, re-scan, done — nothing in the app hard-codes those numbers any more.
//
// Format: [Section] blocks of key=value, "#" comments. [General] holds the defaults and
// each weapon-category section (Rifles, Snipers, Deagle, Knife, ...) overrides them.
// Section names match the parser's weapon categories 1:1.
"use strict";

const fs = require("fs");

function parseValue(v) {
  const s = String(v).trim();
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  return s;
}

function parse(text) {
  const general = {}, sections = {};
  let cur = general;
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const sec = line.match(/^\[(.+?)\]$/);
    if (sec) {
      const name = sec[1].trim();
      if (/^general$/i.test(name)) { cur = general; continue; }
      cur = sections[name] = sections[name] || {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    cur[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1));
  }
  return { general, sections };
}

// one value, category override first, then [General], then the caller's fallback
function val(cfg, key, category, fallback) {
  if (cfg) {
    if (category && cfg.sections && cfg.sections[category] && cfg.sections[category][key] !== undefined) return cfg.sections[category][key];
    if (cfg.general && cfg.general[key] !== undefined) return cfg.general[key];
  }
  return fallback;
}
const num = (cfg, key, category, fallback) => { const v = val(cfg, key, category, fallback); return typeof v === "number" ? v : fallback; };
const bool = (cfg, key, category, fallback) => { const v = val(cfg, key, category, fallback); return typeof v === "boolean" ? v : (typeof v === "number" ? v !== 0 : fallback); };

function load(file) {
  try {
    const st = fs.statSync(file);
    const cfg = parse(fs.readFileSync(file, "utf8"));
    cfg.file = file;
    cfg.mtime = st.mtimeMs;
    cfg.ok = true;
    return cfg;
  } catch (e) {
    return { general: {}, sections: {}, file, mtime: 0, ok: false, error: e.message };
  }
}

// The subset the classifier asks about, resolved per category so parser.js never has to
// know ini key names. Categories are the parser's own (Rifles, Snipers, Deagle, ...).
function rules(cfg, category) {
  const c = category || null;
  return {
    // multikill timing / requirements
    maxTime: { 3: num(cfg, "3k_max_time", c, 2), 4: num(cfg, "4k_max_time", c, 6.5), 5: num(cfg, "5k_max_time", c, 13) },
    extraPerSpecial: { 3: num(cfg, "3k_special_kill_extra_max_time", c, 0), 4: num(cfg, "4k_special_kill_extra_max_time", c, 0), 5: num(cfg, "5k_special_kill_extra_max_time", c, 0) },
    minHs: { 3: num(cfg, "3k_min_headshots", c, 0), 4: num(cfg, "4k_min_headshots", c, 0), 5: num(cfg, "5k_min_headshots", c, 0) },
    mustSpecial: { 3: bool(cfg, "3k_must_include_special_kill", c, false), 4: bool(cfg, "4k_must_include_special_kill", c, false), 5: bool(cfg, "5k_must_include_special_kill", c, false) },
    tick: { 3: bool(cfg, "tick_3ks", c, true), 4: bool(cfg, "tick_4ks", c, true), 5: bool(cfg, "tick_5ks", c, true) },
    // "slow stationary" allowance: a multikill can ignore the clock if the attacker
    // barely moved (range in units; 0 disables)
    slow: {
      3: bool(cfg, "tick_slow_stationary_3ks", c, false) ? num(cfg, "slow_3k_max_range", c, 0) : 0,
      4: bool(cfg, "tick_slow_stationary_4ks", c, false) ? num(cfg, "slow_4k_max_range", c, 0) : 0,
      5: bool(cfg, "tick_slow_stationary_5ks", c, false) ? num(cfg, "slow_5k_max_range", c, 0) : 0,
    },
    // collaterals (cssff calls them doubles/triples/quadros/pentas)
    collat: {
      tick: { 2: bool(cfg, "tick_doubles", c, true), 3: bool(cfg, "tick_triples", c, true), 4: bool(cfg, "tick_quadros", c, true), 5: bool(cfg, "tick_pentas", c, true) },
      minHs: { 2: num(cfg, "double_min_headshots", c, 0), 3: num(cfg, "triple_min_headshots", c, 0), 4: num(cfg, "quadro_min_headshots", c, 0), 5: num(cfg, "penta_min_headshots", c, 0) },
      specialIgnoresHs: { 2: bool(cfg, "special_double_ignores_min_hs", c, true), 3: bool(cfg, "special_triple_ignores_min_hs", c, true), 4: bool(cfg, "special_quadro_ignores_min_hs", c, true), 5: bool(cfg, "special_penta_ignores_min_hs", c, true) },
    },
    // single-kill frag types
    noscope: { dist: num(cfg, "noscope_min_distance", c, 2000), hsMod: num(cfg, "noscope_min_distance_hs_modifier", c, 1), wbMod: num(cfg, "noscope_min_distance_wb_modifier", c, 1), tick: bool(cfg, "tick_noscopes", c, true) },
    jump: { dist: num(cfg, "jumpshot_min_distance", c, 800), hsMod: num(cfg, "jumpshot_min_distance_hs_modifier", c, 1), wbMod: num(cfg, "jumpshot_min_distance_wb_modifier", c, 1), tick: bool(cfg, "tick_jumpshots", c, true) },
    flick: { dist: num(cfg, "flickshot_min_distance", c, 120), angleMod: num(cfg, "flickshot_min_angle_modifier", c, 1), hsOnly: bool(cfg, "flickshot_headshot_only", c, false), maxMs: num(cfg, "flickshot_max_duration", c, 170), tick: bool(cfg, "tick_flickshots", c, true) },
    wallbang: { tick: bool(cfg, "tick_wallbangs", c, false), hsOnly: bool(cfg, "wallbang_headshot_only", c, true), requireTwo: bool(cfg, "wallbang_require_two", c, false), pairWindow: num(cfg, "wallbang_another_wallbang_max_delta_time", c, 4) },
    utilKills: bool(cfg, "tick_flash_smoke_kills", c, true),
    vsBots: bool(cfg, "tick_frags_vs_bots", c, true),
    byBots: bool(cfg, "tick_frags_by_bots", c, true),
  };
}

module.exports = { load, parse, rules, val, num, bool };
