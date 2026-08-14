// classify — kills + telemetry → tagged, difficulty-scored highlights.
// Ported from the core of parser.js classify(): per-kill category tags, weapon-category
// multikill timing, tag-weighted scoring with a hit-chance difficulty multiplier, warmup
// exclusion. Uses the built-in FRAG thresholds (the cssff .ini rulebook is not ported).
// Not yet ported: clutch/outnumbered (need a live roster), deep-scan, filename focus.

use crate::cssff;
use crate::Kill;
use std::collections::HashMap;

fn is_sniper(w: &str) -> bool {
    matches!(w, "awp" | "ssg08" | "scar20" | "g3sg1")
}

// TAGW — default point weight per tag
fn tag_weight(t: &str) -> i32 {
    match t {
        "ace" => 100,
        "clutch" => 85,
        "quad" => 70,
        "triple" => 45,
        "jump_noscope" => 90,
        "noscope" => 65,
        "pixelsurf" => 70,
        "jumpshot" => 55,
        "flick_hs" => 55,
        "spin" => 55,
        "flick" => 35,
        "outnumbered" => 35,
        "wallbang" => 45,
        "smoke_kill" => 30,
        "blind_kill" => 40,
        "long_range" => 25,
        "off_height" => 45,
        "troll" => 50,
        // movement-clip tags
        "bhop_run" => 22,
        "into_kill" => 45,
        "fast" => 12,
        "long_chain" => 20,
        "edgebug" => 55,
        "jumpbug" => 45,
        "surf" => 48,
        "flashboost" => 46,
        _ => 10,
    }
}

/// All tag weights (for the Settings UI to show/edit).
pub fn all_tag_weights() -> Vec<(&'static str, i32)> {
    [
        "ace", "clutch", "quad", "triple", "jump_noscope", "noscope", "pixelsurf", "jumpshot",
        "flick_hs", "spin", "flick", "outnumbered", "wallbang", "smoke_kill", "blind_kill",
        "long_range", "off_height", "troll", "bhop_run", "into_kill", "fast", "long_chain",
        "edgebug", "jumpbug", "surf", "flashboost",
    ]
    .iter()
    .map(|t| (*t, tag_weight(t)))
    .collect()
}

// WBASE — base single-shot hit chance per weapon
fn wbase(w: &str) -> f32 {
    match w {
        "awp" => 0.95,
        "ssg08" => 0.92,
        "scar20" | "g3sg1" => 0.85,
        "ak47" => 0.72,
        "m4a1" => 0.75,
        "m4a1_silencer" => 0.78,
        "sg556" => 0.7,
        "aug" => 0.74,
        "famas" => 0.66,
        "galilar" => 0.64,
        "deagle" => 0.6,
        "revolver" => 0.55,
        "glock" => 0.66,
        "hkp2000" | "mp7" | "usp_silencer" => 0.72,
        "p250" => 0.68,
        "tec9" => 0.62,
        "cz75a" => 0.6,
        "fiveseven" | "mp5sd" => 0.68,
        "elite" => 0.58,
        "mp9" | "ump45" => 0.66,
        "mac10" => 0.6,
        "p90" => 0.64,
        "bizon" => 0.62,
        "nova" => 0.5,
        "xm1014" => 0.48,
        "mag7" => 0.5,
        "sawedoff" => 0.45,
        "m249" | "negev" => 0.55,
        _ => 0.6,
    }
}

// weapon → category (for multikill timing)
fn wcat(w: &str) -> &'static str {
    match w {
        "ak47" | "m4a1" | "m4a1_silencer" | "sg556" | "aug" | "famas" | "galilar" | "m249"
        | "negev" => "Rifles",
        "awp" => "Snipers",
        "g3sg1" | "scar20" => "AutoSnipers",
        "ssg08" => "Scout",
        "glock" | "hkp2000" | "p2000" | "usp_silencer" | "p250" | "tec9" | "cz75a"
        | "fiveseven" | "elite" => "Pistols",
        "deagle" | "revolver" => "Deagle",
        "mp9" | "mac10" | "mp7" | "ump45" | "p90" | "bizon" | "mp5sd" => "Smgs",
        "nova" | "xm1014" | "mag7" | "sawedoff" => "Shotguns",
        _ => {
            if w.contains("knife")
                || w.contains("bayonet")
                || w.contains("karambit")
                || w.contains("dagger")
                || w.contains("hegrenade")
                || w == "taser"
            {
                "Knife"
            } else {
                "Rifles"
            }
        }
    }
}

fn is_troll(w: &str) -> bool {
    w.contains("knife")
        || w.contains("bayonet")
        || w.contains("karambit")
        || w.contains("dagger")
        || w.contains("butterfly")
        || w.contains("falchion")
        || w.contains("huntsman")
        || w.contains("ursus")
        || w.contains("navaja")
        || w.contains("stiletto")
        || w.contains("talon")
        || w.contains("nomad")
        || w.contains("skeleton")
        || w.contains("paracord")
        || w.contains("gut")
        || w.contains("flip")
        || w.contains("m9")
        || w.contains("shadow")
        || w == "hegrenade"
        || w == "taser"
}

// public: single-shot hit chance (used both to enrich kills and inside scoring)
pub fn hit_chance(weapon: &str, airborne: bool, spd: i32, dist_m: i32, noscope: bool) -> f32 {
    let sniper = is_sniper(weapon);
    let mut c = if sniper && noscope {
        (0.92 - dist_m as f32 * 0.021).max(0.02)
    } else {
        let mut b = wbase(weapon);
        if dist_m > 0 {
            b *= (1.0 - (dist_m as f32 - 15.0).max(0.0) / 60.0).max(0.2);
        }
        b
    };
    if airborne {
        c *= if sniper && noscope { 0.55 } else { 0.16 };
    } else if spd > 130 {
        c *= 1.0 - ((spd as f32 - 130.0) / 250.0).min(0.6);
    }
    c.clamp(0.02, 0.98)
}

// per-kill category tags, from the cssff .ini rulebook (falls back to defaults with no ini)
fn trick_tags(k: &Kill, grp: &[&Kill], tickrate: i32, cfg: Option<&cssff::Cfg>) -> Vec<&'static str> {
    let mut tags = Vec::new();
    let w = k.weapon.as_str();
    let sniper = is_sniper(w);
    let cat = wcat(w);
    let r = cssff::rules(cfg, Some(cat));
    let d = k.dist as f32;
    if k.pixel {
        tags.push("pixelsurf");
    }
    // no-scope (snipers): real distance; HS / wallbang lower the bar
    if k.noscope && sniper && r.noscope_tick {
        let min_d = r.noscope_dist
            * (if k.headshot { r.noscope_hs_mod } else { 1.0 })
            * (if k.penetrated > 0 { r.noscope_wb_mod } else { 1.0 });
        if d >= min_d {
            tags.push(if k.airborne && !k.pixel { "jump_noscope" } else { "noscope" });
        }
    }
    // jumpshot: airborne kill at distance
    if k.airborne && !k.pixel && !(k.noscope && sniper) && r.jump_tick {
        let min_j = r.jump_dist
            * (if k.headshot { r.jump_hs_mod } else { 1.0 })
            * (if k.penetrated > 0 { r.jump_wb_mod } else { 1.0 });
        if d >= min_j {
            tags.push("jumpshot");
        }
    }
    // flick: fast wide turn onto a target at distance (angle modifier scales the min degrees)
    if r.flick_tick
        && k.flick as f32 >= 22.0 * r.flick_angle_mod
        && d >= r.flick_dist
        && (!r.flick_hs_only || k.headshot)
    {
        tags.push(if k.headshot { "flick_hs" } else { "flick" });
    }
    if k.spin >= 300 {
        tags.push("spin");
    }
    // wallbang: per-ini tick + headshot-only + require a paired wallbang within the window
    if k.penetrated > 0 && r.wallbang_tick && (!r.wallbang_hs_only || k.headshot) {
        let paired = !r.wallbang_require_two
            || grp.iter().any(|o| {
                !std::ptr::eq(*o as *const Kill, k as *const Kill)
                    && o.penetrated > 0
                    && ((o.tick - k.tick).abs() as f32 / tickrate as f32) <= r.wallbang_pair_window
                    && (!r.wallbang_hs_only || o.headshot)
            });
        if paired {
            tags.push("wallbang");
        }
    }
    if k.smoke && r.util_kills {
        tags.push("smoke_kill");
    }
    if k.blind && r.util_kills {
        tags.push("blind_kill");
    }
    // long-range: scoped snipers need a much bigger distance (not in the ini; kept as-is)
    if sniper && !k.noscope {
        if k.dist >= 3200 {
            tags.push("long_range");
        }
    } else if k.dist >= 1400 {
        tags.push("long_range");
    }
    if k.airborne && k.vz < -180 && k.noscope {
        tags.push("off_height");
    }
    if k.nearby >= 3 && k.team_alive <= k.enemy_alive {
        tags.push("outnumbered");
    }
    if is_troll(w) {
        tags.push("troll");
    }
    tags
}

const SPECIAL: &[&str] = &[
    "noscope",
    "jump_noscope",
    "jumpshot",
    "pixelsurf",
    "flick",
    "flick_hs",
    "wallbang",
    "smoke_kill",
    "blind_kill",
    "spin",
    "troll",
];
// a lone kill needs one of these to be a highlight at all
const QUALIFY: &[&str] = &[
    "noscope",
    "jump_noscope",
    "jumpshot",
    "pixelsurf",
    "flick",
    "flick_hs",
    "spin",
    "wallbang",
    "long_range",
    "off_height",
    "troll",
];

fn has_special(tags: &[&str]) -> bool {
    tags.iter().any(|t| SPECIAL.contains(t))
}


fn dominant_cat(sub: &[&Kill]) -> &'static str {
    let mut cnt: HashMap<&str, usize> = HashMap::new();
    for k in sub {
        *cnt.entry(wcat(&k.weapon)).or_insert(0) += 1;
    }
    cnt.into_iter().max_by_key(|(_, c)| *c).map(|(c, _)| c).unwrap_or("Rifles")
}

fn multi_qualifies(
    sub: &[&Kill],
    tickrate: i32,
    tags: &[Vec<&'static str>],
    cfg: Option<&cssff::Cfg>,
) -> bool {
    let n = sub.len().min(5);
    if n < 3 {
        return false;
    }
    let cat = dominant_cat(sub);
    let r = cssff::rules(cfg, Some(cat));
    let idx = n - 3; // 0=3k,1=4k,2=5k
    if !r.tick[idx] {
        return false;
    }
    let specials = tags.iter().filter(|t| has_special(t)).count();
    if r.must_special[idx] && specials == 0 {
        return false;
    }
    let hs = sub.iter().filter(|k| k.headshot).count() as i32;
    if hs < r.min_hs[idx] && specials == 0 {
        return false;
    }
    let span = (sub[n - 1].tick - sub[0].tick) as f32 / tickrate as f32;
    let maxt = r.max_time[idx] + specials as f32 * r.extra_per_special[idx];
    // (the ini's "slow stationary" allowance needs attacker position range; skipped for now)
    maxt < 0.0 || span <= maxt
}

pub struct ClHl {
    pub uid: i64,
    pub n: usize,
    pub hs: usize,
    pub weapons: Vec<String>,
    pub tags: Vec<String>,
    pub score: i32,
    // Everything below exists so the app can rebuild the full highlight the renderer expects
    // (kills, timing, round, movement) without a second pass in JavaScript.
    pub kill_ticks: Vec<i32>,
    pub round: i32,
    pub clutch_x: i32,
    pub kind: &'static str, // "kill" | "movement"
    pub start_tick: i32,    // movement clips: where the run/trick begins
    pub mv: Option<MvOut>,
}

#[derive(Clone, Default)]
pub struct MvOut {
    pub max_speed: i32,
    pub avg_speed: i32,
    pub jumps: i32,
    pub air_pct: i32,
    pub dist_units: i32,
    pub dur_sec: f32,
    pub fall_vel: i32,
    pub kill_after: bool,
}

fn make_highlight(uid: i64, sub: &[&Kill], tagset: &[&str]) -> ClHl {
    make_highlight_x(uid, sub, tagset, 0)
}

fn make_highlight_x(uid: i64, sub: &[&Kill], tagset: &[&str], clutch_x: i32) -> ClHl {
    let kill_ticks: Vec<i32> = sub.iter().map(|k| k.tick).collect();
    let round = sub.first().map(|k| k.round).unwrap_or(0);
    // headline tag dominates; extras add with diminishing returns
    let mut ws: Vec<i32> = tagset.iter().map(|t| tag_weight(t)).collect();
    ws.sort_unstable_by(|a, b| b.cmp(a));
    let mut score = *ws.first().unwrap_or(&0) as f32;
    for w in ws.iter().skip(1) {
        score += *w as f32 * 0.35;
    }
    let hs = sub.iter().filter(|k| k.headshot).count();
    score += hs as f32 * 4.0;
    if clutch_x > 1 {
        score += (clutch_x - 1) as f32 * 12.0;
    }
    let max_dist_m = sub.iter().map(|k| k.dist_m).max().unwrap_or(0);
    score += (max_dist_m as f32).min(40.0);
    let max_spd = sub.iter().map(|k| k.spd).max().unwrap_or(0);
    if max_spd > 150 {
        score += ((max_spd as f32 - 150.0) / 6.0).min(25.0);
    }
    for k in sub {
        if k.hit_chance > 0.0 && k.hit_chance < 0.3 {
            score += 12.0;
        }
    }
    // difficulty multiplier — the big lever (hard/low-chance kills scale up)
    let avg_diff: f32 = sub
        .iter()
        .map(|k| if k.hit_chance > 0.0 { 1.0 - k.hit_chance } else { 0.4 })
        .sum::<f32>()
        / sub.len() as f32;
    score *= 0.6 + avg_diff * 0.85;
    if sub.iter().all(|k| k.afk) {
        score *= 0.25; // AFK victims
    }
    let mut weapons: Vec<String> = Vec::new();
    for k in sub {
        if !k.weapon.is_empty() && !weapons.contains(&k.weapon) {
            weapons.push(k.weapon.clone());
        }
    }
    ClHl {
        uid,
        n: sub.len(),
        hs,
        weapons,
        tags: tagset.iter().map(|s| s.to_string()).collect(),
        score: score.round() as i32,
        kill_ticks,
        round,
        clutch_x,
        kind: "kill",
        start_tick: 0,
        mv: None,
    }
}

fn warmup_rounds(kills: &[Kill]) -> std::collections::HashSet<i32> {
    let mut rv: HashMap<i32, HashMap<i64, u32>> = HashMap::new();
    let mut rk: HashMap<i32, u32> = HashMap::new();
    for k in kills {
        *rv.entry(k.round).or_default().entry(k.victim).or_insert(0) += 1;
        *rk.entry(k.round).or_insert(0) += 1;
    }
    let mut out = std::collections::HashSet::new();
    for (&r, m) in &rv {
        if m.values().any(|&c| c >= 2) || rk.get(&r).map_or(false, |&c| c >= 12) {
            out.insert(r);
        }
    }
    out
}

// movement clips: a bhop/surf/flashboost/edgebug that flows straight into a kill
pub fn movement_highlights(
    runs: &[crate::movement::MRun],
    tricks: &[crate::movement::Trick],
    kills: &[Kill],
    slot_uid: &HashMap<i32, i64>,
    tickrate: i32,
) -> Vec<ClHl> {
    let warmup = warmup_rounds(kills);
    let mut out = Vec::new();
    let after_kills = |uid: i64, from: i32, to: i32| -> Vec<&Kill> {
        let mut v: Vec<&Kill> = kills
            .iter()
            .filter(|k| k.attacker == uid && k.tick >= from && k.tick <= to)
            .collect();
        v.sort_by_key(|k| k.tick);
        v
    };
    let payoff = |uid: i64, after: &[&Kill], tags: Vec<&'static str>, mut score: f32| -> ClHl {
        for k in after {
            for t in trick_tags(k, &[], tickrate, None) {
                score += tag_weight(t) as f32 * 0.5;
            }
        }
        let mut weapons: Vec<String> = Vec::new();
        for k in after.iter().take(5) {
            if !k.weapon.is_empty() && !weapons.contains(&k.weapon) {
                weapons.push(k.weapon.clone());
            }
        }
        ClHl {
            uid,
            n: after.len().min(5),
            hs: after.iter().filter(|k| k.headshot).count(),
            weapons,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            score: score.round() as i32,
            kill_ticks: after.iter().map(|k| k.tick).collect(),
            round: after.first().map(|k| k.round).unwrap_or(0),
            clutch_x: 0,
            kind: "movement",
            start_tick: 0,
            mv: None,
        }
    };

    // bhop runs → notable kill
    let kwin = (tickrate as f32 * 2.5) as i32;
    for run in runs {
        let uid = match slot_uid.get(&run.slot) {
            Some(&u) => u,
            None => continue,
        };
        if run.jumps < 5 || run.max_speed < 300 || run.air_pct < 45 || run.dur_sec > 12.0 {
            continue;
        }
        let after = after_kills(uid, run.start_tick, run.end_tick + kwin);
        if after.is_empty() {
            continue;
        }
        let last = *after.last().unwrap();
        if warmup.contains(&last.round)
            || (last.tick - run.end_tick) as f32 / tickrate as f32 > 2.5
        {
            continue;
        }
        let notable = after.len() >= 2
            || after
                .iter()
                .any(|k| !trick_tags(k, &[], tickrate, None).is_empty() || (k.hit_chance > 0.0 && k.hit_chance < 0.4));
        if !notable {
            continue;
        }
        let mut tags = vec!["bhop_run", "into_kill"];
        if run.max_speed >= 400 {
            tags.push("fast");
        }
        if run.jumps >= 12 {
            tags.push("long_chain");
        }
        let mut score = tags.iter().map(|t| tag_weight(t)).sum::<i32>() as f32;
        score += (((run.max_speed - 250) as f32 / 8.0).min(20.0)
            + (run.jumps as f32).min(15.0)
            + run.dur_sec.min(6.0))
        .round();
        if after.len() >= 2 {
            score += 20.0;
        }
        let mut h = payoff(uid, &after, tags, score);
        h.start_tick = run.start_tick; h.mv = Some(MvOut { max_speed: run.max_speed, avg_speed: run.avg_speed, jumps: run.jumps, air_pct: run.air_pct, dist_units: run.dist_units, dur_sec: run.dur_sec, kill_after: !after.is_empty(), ..Default::default() });
        out.push(h);
    }

    // tricks: surf / flashboost / edgebug / jumpbug leading into a kill
    let tkwin = (tickrate as f32 * 4.0) as i32;
    let flash_near = |uid: i64, tick: i32| {
        tricks.iter().any(|s| {
            s.kind == "flashboost"
                && slot_uid.get(&s.slot) == Some(&uid)
                && (s.tick - tick).abs() <= (tickrate as f32 * 1.5) as i32
        })
    };
    for tr in tricks {
        if tr.kind == "pixelsurf" {
            continue; // handled as a kill tag
        }
        let uid = match slot_uid.get(&tr.slot) {
            Some(&u) => u,
            None => continue,
        };
        let after = after_kills(uid, tr.tick, tr.tick + tkwin);
        let fk = after.first().copied();
        if let Some(k) = fk {
            if warmup.contains(&k.round) {
                continue;
            }
        }
        match tr.kind {
            "surf" => {
                if flash_near(uid, tr.tick) {
                    continue;
                }
                let long = tr.dur_ticks as f32 >= tickrate as f32 * 1.2;
                if fk.is_none() && !long {
                    continue;
                }
                let mut tags = vec!["surf"];
                if fk.is_some() {
                    tags.push("into_kill");
                }
                let score = tag_weight("surf") as f32
                    + if fk.is_some() { tag_weight("into_kill") as f32 } else { 0.0 }
                    + ((tr.fall_vel as f32 / 20.0).min(20.0)
                        + (tr.dur_ticks as f32 / tickrate as f32 * 8.0).min(20.0));
                let mut h = payoff(uid, &after, tags, score);
                h.start_tick = tr.tick; h.mv = Some(MvOut { max_speed: tr.fall_vel, dur_sec: tr.dur_ticks as f32 / tickrate as f32, dist_units: tr.dist, kill_after: !after.is_empty(), ..Default::default() });
                out.push(h);
            }
            "flashboost" => {
                if fk.is_none() && (tr.fall_vel < 420 || tr.spd < 230) {
                    continue;
                }
                let mut tags = vec!["flashboost"];
                if fk.is_some() {
                    tags.push("into_kill");
                }
                let score = tag_weight("flashboost") as f32
                    + if fk.is_some() { tag_weight("into_kill") as f32 } else { 0.0 }
                    + (tr.fall_vel as f32 / 8.0).min(30.0);
                let mut h = payoff(uid, &after, tags, score);
                h.start_tick = tr.tick; h.mv = Some(MvOut { max_speed: tr.fall_vel, dur_sec: tr.dur_ticks as f32 / tickrate as f32, dist_units: tr.dist, kill_after: !after.is_empty(), ..Default::default() });
                out.push(h);
            }
            "edgebug" | "jumpbug" => {
                let k = match fk {
                    Some(k) => k,
                    None => continue,
                };
                if flash_near(uid, tr.tick) {
                    continue;
                }
                if tricks.iter().any(|s| {
                    s.kind == "surf"
                        && slot_uid.get(&s.slot) == Some(&uid)
                        && (s.tick - tr.tick).abs() <= tickrate * 2
                }) {
                    continue;
                }
                let tags = vec![
                    if tr.kind == "edgebug" { "edgebug" } else { "jumpbug" },
                    "into_kill",
                ];
                let dmg_saved = ((tr.fall_vel - 580) as f32 * 0.1333).max(0.0);
                let score = tags.iter().map(|t| tag_weight(t)).sum::<i32>() as f32 + dmg_saved;
                let mut h = payoff(uid, &[k], tags, score);
                h.start_tick = tr.tick; h.mv = Some(MvOut { fall_vel: tr.fall_vel, dur_sec: tr.dur_ticks as f32 / tickrate as f32, dist_units: tr.dist, kill_after: !after.is_empty(), ..Default::default() });
                out.push(h);
            }
            _ => {}
        }
    }
    out
}

pub fn classify(kills: &[Kill], tickrate: i32, cfg: Option<&cssff::Cfg>) -> Vec<ClHl> {
    // warmup / DM rounds: a victim dying 2+ times, or 12+ kills in a round → excluded
    let mut round_victim: HashMap<i32, HashMap<i64, u32>> = HashMap::new();
    let mut round_kills: HashMap<i32, u32> = HashMap::new();
    for k in kills {
        *round_victim
            .entry(k.round)
            .or_default()
            .entry(k.victim)
            .or_insert(0) += 1;
        *round_kills.entry(k.round).or_insert(0) += 1;
    }
    let warmup = |r: i32| -> bool {
        round_victim.get(&r).map_or(false, |m| m.values().any(|&c| c >= 2))
            || round_kills.get(&r).map_or(false, |&c| c >= 12)
    };

    // group by (round, attacker)
    let mut groups: HashMap<(i32, i64), Vec<&Kill>> = HashMap::new();
    for k in kills {
        if warmup(k.round) {
            continue;
        }
        groups.entry((k.round, k.attacker)).or_default().push(k);
    }

    let gap = 8.0f32; // multikill link seconds
    let mut out = Vec::new();
    for ((_r, uid), mut grp) in groups {
        grp.sort_by_key(|k| k.tick);
        let tags: Vec<Vec<&'static str>> =
            grp.iter().map(|k| trick_tags(k, &grp, tickrate, cfg)).collect();
        let mut used = vec![false; grp.len()];

        // CLUTCH: last-man-standing (teamAlive==1) kills that clear the enemy team
        let solo: Vec<usize> = (0..grp.len()).filter(|&i| grp[i].team_alive == 1).collect();
        if solo.len() >= 2 && grp[*solo.last().unwrap()].enemy_alive == 0 {
            let (first, last) = (solo[0], *solo.last().unwrap());
            let span = (grp[last].tick - grp[first].tick) as f32 / tickrate as f32;
            let mut maxgap = 0.0f32;
            for w in solo.windows(2) {
                let g = (grp[w[1]].tick - grp[w[0]].tick) as f32 / tickrate as f32;
                if g > maxgap {
                    maxgap = g;
                }
            }
            let sub: Vec<&Kill> = solo.iter().map(|&i| grp[i]).collect();
            let subtags: Vec<Vec<&'static str>> = solo.iter().map(|&i| tags[i].clone()).collect();
            let timing_ok = solo.len() < 3 || multi_qualifies(&sub, tickrate, &subtags, cfg);
            if span <= 45.0 && maxgap <= 20.0 && timing_ok {
                let clutch_x = grp[first].enemy_alive + 1;
                let mut set: Vec<&str> = vec!["clutch"];
                for &i in &solo {
                    used[i] = true;
                    for t in &tags[i] {
                        if !set.contains(t) {
                            set.push(t);
                        }
                    }
                }
                out.push(make_highlight_x(uid, &sub, &set, clutch_x));
            }
        }

        // multikill bursts over the kills NOT already taken by the clutch
        let rest: Vec<usize> = (0..grp.len()).filter(|&i| !used[i]).collect();
        let mut ri = 0;
        while ri < rest.len() {
            let mut rj = ri;
            while rj + 1 < rest.len()
                && (grp[rest[rj + 1]].tick - grp[rest[rj]].tick) as f32 / tickrate as f32 <= gap
            {
                rj += 1;
            }
            // chain rest[ri..=rj]; find biggest qualifying sub-run
            let chain: Vec<usize> = rest[ri..=rj].to_vec();
            let mut matched = false;
            'sz: for size in (3..=chain.len()).rev() {
                for s in 0..=chain.len() - size {
                    let idxs = &chain[s..s + size];
                    let sub: Vec<&Kill> = idxs.iter().map(|&x| grp[x]).collect();
                    let subtags: Vec<Vec<&'static str>> =
                        idxs.iter().map(|&x| tags[x].clone()).collect();
                    if !multi_qualifies(&sub, tickrate, &subtags, cfg) {
                        continue;
                    }
                    let mt = match sub.len() {
                        5.. => "ace",
                        4 => "quad",
                        _ => "triple",
                    };
                    let mut set: Vec<&str> = vec![mt];
                    for x in idxs {
                        used[*x] = true;
                        for t in &tags[*x] {
                            if !set.contains(t) {
                                set.push(t);
                            }
                        }
                    }
                    out.push(make_highlight(uid, &sub, &set));
                    matched = true;
                    break 'sz;
                }
            }
            let _ = matched;
            ri = rj + 1;
        }

        // lone qualifying kills
        for (idx, k) in grp.iter().enumerate() {
            if used[idx] {
                continue;
            }
            if tags[idx].iter().any(|t| QUALIFY.contains(t)) {
                out.push(make_highlight(uid, &[k], &tags[idx]));
            }
        }
    }
    out
}
