// `app` feature: emit the csgofast-compatible gzipped raw JSON, so the Electron app's
// parse-worker.js can use this Rust binary as a drop-in decoder and run its existing
// classify() unchanged. Fields we don't track (per-player damage/assists/mvps, round
// winners, some telemetry extras) are emitted as zeros/empty — classify degrades
// gracefully on those.

use crate::Parser;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;

#[derive(Serialize)]
struct PInfo {
    name: String,
    #[serde(rename = "steamId")]
    steam_id: Option<String>,
    team: i32,
    uid: i64,
}

#[derive(Serialize)]
struct Tele {
    #[serde(rename = "airborneAtKill")]
    airborne_at_kill: bool,
    #[serde(rename = "speedAtKill")]
    speed_at_kill: i32,
    #[serde(rename = "vzAtKill")]
    vz_at_kill: i32,
    #[serde(rename = "flickDeg")]
    flick_deg: i32,
    #[serde(rename = "maxYawRate")]
    max_yaw_rate: i32,
    #[serde(rename = "maxAirStreakTicks")]
    max_air_streak_ticks: i32,
    #[serde(rename = "maxAirSpeed")]
    max_air_speed: i32,
    #[serde(rename = "maxVz")]
    max_vz: i32,
    #[serde(rename = "maxSpeed")]
    max_speed: i32,
}

#[derive(Serialize)]
struct Pt {
    x: f64,
    y: f64,
}
#[derive(Serialize)]
struct Shot {
    from: Option<Pt>,
    to: Option<Pt>,
}

#[derive(Serialize)]
struct KillOut {
    round: i32,
    #[serde(rename = "killTick")]
    kill_tick: i32,
    time: f64,
    weapon: String,
    headshot: bool,
    penetrated: i32,
    noscope: bool,
    smoke: bool,
    blind: bool,
    airshot: bool,
    #[serde(rename = "distUnits")]
    dist_units: Option<i32>,
    #[serde(rename = "distM")]
    dist_m: Option<i32>,
    #[serde(rename = "teamAlive")]
    team_alive: i32,
    #[serde(rename = "enemyAliveAfter")]
    enemy_alive_after: i32,
    #[serde(rename = "enemyDists")]
    enemy_dists: Vec<i32>,
    #[serde(rename = "hitChance")]
    hit_chance: f64,
    #[serde(rename = "shotsBeforeKill")]
    shots_before_kill: i32,
    attacker: PInfo,
    victim: PInfo,
    telemetry: Tele,
    shot: Shot,
}

#[derive(Serialize)]
struct MRunOut {
    uid: i64,
    name: String,
    #[serde(rename = "steamId")]
    steam_id: Option<String>,
    team: i32,
    #[serde(rename = "startTick")]
    start_tick: i32,
    #[serde(rename = "endTick")]
    end_tick: i32,
    jumps: i32,
    #[serde(rename = "maxSpeed")]
    max_speed: i32,
    #[serde(rename = "avgSpeed")]
    avg_speed: i32,
    #[serde(rename = "airPct")]
    air_pct: i32,
    #[serde(rename = "distUnits")]
    dist_units: i32,
    #[serde(rename = "durSec")]
    dur_sec: f64,
}

#[derive(Serialize)]
struct TrickOut {
    uid: i64,
    name: String,
    #[serde(rename = "steamId")]
    steam_id: Option<String>,
    team: i32,
    tick: i32,
    kind: String,
    #[serde(rename = "fallVel")]
    fall_vel: i32,
    spd: i32,
    #[serde(rename = "durTicks", skip_serializing_if = "is_zero")]
    dur_ticks: i32,
    #[serde(skip_serializing_if = "is_zero")]
    dist: i32,
    #[serde(skip_serializing_if = "is_zero_f")]
    x: f64,
    #[serde(skip_serializing_if = "is_zero_f")]
    y: f64,
    #[serde(skip_serializing_if = "is_zero_f")]
    z: f64,
}
fn is_zero(n: &i32) -> bool {
    *n == 0
}
fn is_zero_f(n: &f64) -> bool {
    *n == 0.0
}

#[derive(Serialize)]
struct PStat {
    #[serde(rename = "steamId")]
    steam_id: String,
    name: String,
    kills: i32,
    deaths: i32,
    assists: i32,
    headshots: i32,
    damage: i32,
    mvps: i32,
    team: i32,
}

#[derive(Serialize)]
struct Frame {
    t: i32,
    p: Vec<(i64, f64, f64, i32, i32, i32)>, // [uid, x, y, yaw, team, z]
}

#[derive(Serialize)]
struct RawOut {
    header: HashMap<String, serde_json::Value>,
    #[serde(rename = "mapName")]
    map_name: String,
    tickrate: i32,
    #[serde(rename = "previewStep")]
    preview_step: i32,
    score: HashMap<String, i32>,
    players: Vec<PStat>,
    #[serde(rename = "roundWinners")]
    round_winners: Vec<i32>,
    kills: Vec<KillOut>,
    #[serde(rename = "movementRuns")]
    movement_runs: Vec<MRunOut>,
    tricks: Vec<TrickOut>,
    timeline: Vec<Frame>,
    roster: HashMap<String, serde_json::Value>,
    utils: Vec<serde_json::Value>,
}

fn build(p: &Parser) -> RawOut {
    let tr = p.tickrate;
    let name_of = |uid: i64| -> String {
        p.names.get(&uid).cloned().unwrap_or_else(|| format!("uid{uid}"))
    };
    let slot_uid: HashMap<i32, i64> = p.slot_uid.clone();
    // Real SteamID64 when the demo carried it; falls back to the per-server "uid{n}" so the
    // field is never null (classify matches tricks to kills on it).
    let sid = |uid: i64| -> Option<String> {
        Some(match p.xuids.get(&uid) {
            Some(x) => x.to_string(),
            None => format!("uid{uid}"),
        })
    };

    // roster: uid -> (name, team) from the timeline
    let mut roster_team: HashMap<i64, i32> = HashMap::new();
    for f in &p.timeline {
        for (slot, st) in &f.players {
            if let Some(&uid) = slot_uid.get(slot) {
                roster_team.insert(uid, st.team);
            }
        }
    }
    let team_of = |uid: i64| roster_team.get(&uid).copied().unwrap_or(0);

    // scoreboard (kills/deaths/hs) derived from the kill list
    let mut stats: HashMap<i64, (i32, i32, i32, i32)> = HashMap::new(); // uid -> (k,d,hs,team)
    for k in &p.kills {
        let a = stats.entry(k.attacker).or_insert((0, 0, 0, k.attacker_team));
        a.0 += 1;
        if k.headshot {
            a.2 += 1;
        }
        stats.entry(k.victim).or_insert((0, 0, 0, 0)).1 += 1;
    }

    let mv = p.movement.as_ref();
    let mut kills = Vec::with_capacity(p.kills.len());
    for k in &p.kills {
        let atk_team = if k.attacker_team != 0 { k.attacker_team } else { team_of(k.attacker) };
        let vic_team = if atk_team == 2 { 3 } else { 2 };
        let shot = if let Some(m) = mv {
            let from = p.uid_slot.get(&k.attacker).and_then(|&s| m.pos_at(s, k.tick));
            let to = p.uid_slot.get(&k.victim).and_then(|&s| m.pos_at(s, k.tick));
            Shot {
                from: from.map(|(x, y, _)| Pt { x: x as f64, y: y as f64 }),
                to: to.map(|(x, y, _)| Pt { x: x as f64, y: y as f64 }),
            }
        } else {
            Shot { from: None, to: None }
        };
        kills.push(KillOut {
            round: k.round,
            kill_tick: k.tick,
            time: (k.tick as f64 / tr as f64 * 100.0).round() / 100.0,
            weapon: k.weapon.clone(),
            headshot: k.headshot,
            penetrated: k.penetrated,
            noscope: k.noscope,
            smoke: k.smoke,
            blind: k.blind,
            airshot: false,
            dist_units: if k.dist > 0 { Some(k.dist) } else { None },
            dist_m: if k.dist_m > 0 { Some(k.dist_m) } else { None },
            team_alive: k.team_alive,
            enemy_alive_after: k.enemy_alive,
            enemy_dists: vec![500; k.nearby.max(0) as usize], // synthetic (classify only counts ≤1000u)
            hit_chance: (k.hit_chance as f64 * 1000.0).round() / 1000.0,
            shots_before_kill: k.shots_before_kill,
            // per-player id MUST be non-null: classify.js matches a movement trick to a kill via
            // `k.attacker.steamId === tr.steamId`, and two nulls compare equal → it grabbed ANY
            // kill in the window (wrong killer). "uid{n}" makes the comparison discriminate.
            attacker: PInfo { name: name_of(k.attacker), steam_id: sid(k.attacker), team: atk_team, uid: k.attacker },
            victim: PInfo { name: name_of(k.victim), steam_id: sid(k.victim), team: vic_team, uid: k.victim },
            telemetry: Tele {
                airborne_at_kill: k.airborne,
                speed_at_kill: k.spd,
                vz_at_kill: k.vz,
                flick_deg: k.flick,
                max_yaw_rate: 0,
                max_air_streak_ticks: 0,
                max_air_speed: 0,
                max_vz: 0,
                max_speed: k.spd,
            },
            shot,
        });
    }

    let mk_run = |r: &crate::movement::MRun| {
        let uid = slot_uid.get(&r.slot).copied().unwrap_or(0);
        MRunOut {
            uid,
            name: name_of(uid),
            steam_id: sid(uid),
            team: team_of(uid),
            start_tick: r.start_tick,
            end_tick: r.end_tick,
            jumps: r.jumps,
            max_speed: r.max_speed,
            avg_speed: r.avg_speed,
            air_pct: r.air_pct,
            dist_units: r.dist_units,
            dur_sec: (r.dur_sec as f64 * 10.0).round() / 10.0,
        }
    };
    let mk_trick = |t: &crate::movement::Trick| {
        let uid = slot_uid.get(&t.slot).copied().unwrap_or(0);
        TrickOut {
            uid,
            name: name_of(uid),
            steam_id: sid(uid),
            team: team_of(uid),
            tick: t.tick,
            kind: t.kind.to_string(),
            fall_vel: t.fall_vel,
            spd: t.spd,
            dur_ticks: t.dur_ticks,
            dist: t.dist,
            x: (t.x as f64 * 10.0).round() / 10.0,
            y: (t.y as f64 * 10.0).round() / 10.0,
            z: (t.z as f64 * 10.0).round() / 10.0,
        }
    };

    let (runs, tricks): (Vec<MRunOut>, Vec<TrickOut>) = match mv {
        Some(m) => (
            m.runs_out.iter().map(mk_run).collect(),
            m.tricks.iter().map(mk_trick).collect(),
        ),
        None => (vec![], vec![]),
    };

    let timeline: Vec<Frame> = p
        .timeline
        .iter()
        .map(|f| Frame {
            t: f.t,
            p: f
                .players
                .iter()
                .filter_map(|(slot, st)| {
                    slot_uid.get(slot).map(|&uid| {
                        (
                            uid,
                            (st.x * 10.0).round() as f64 / 10.0,
                            (st.y * 10.0).round() as f64 / 10.0,
                            st.yaw.round() as i32,
                            st.team,
                            st.z.round() as i32,
                        )
                    })
                })
                .collect(),
        })
        .collect();

    let rounds = p.round_ticks.len().max(1) as i32;
    let players: Vec<PStat> = stats
        .iter()
        .map(|(&uid, &(k, d, hs, team))| PStat {
            steam_id: sid(uid).unwrap_or_default(),
            name: name_of(uid),
            kills: k,
            deaths: d,
            assists: 0,
            headshots: hs,
            damage: 0,
            mvps: 0,
            team: if team != 0 { team } else { team_of(uid) },
        })
        .collect();

    let mut header = HashMap::new();
    header.insert("mapName".into(), serde_json::json!(p.map_name));
    // the match view renders header.serverName; without it the whole view threw
    header.insert("serverName".into(), serde_json::json!(p.server_name));
    header.insert("playbackTicks".into(), serde_json::json!(p.playback_ticks));
    header.insert("playbackTime".into(), serde_json::json!(p.playback_time));
    let mut score = HashMap::new();
    // The demo never states who won a round, so infer it from the LAST kill of each round —
    // whoever got it is almost always on the winning side. Wrong for defuse/time wins, but far
    // better than the zeros this used to report (which rendered as "CT undefined : undefined T").
    let mut last_by_round: HashMap<i32, i32> = HashMap::new();
    for k in &p.kills {
        let t = if k.attacker_team != 0 { k.attacker_team } else { team_of(k.attacker) };
        last_by_round.insert(k.round, t);
    }
    let ct_wins = last_by_round.values().filter(|&&t| t == 3).count() as i32;
    let t_wins = last_by_round.values().filter(|&&t| t == 2).count() as i32;
    score.insert("ct".into(), ct_wins);
    score.insert("t".into(), t_wins);
    score.insert("rounds".into(), rounds);
    let mut roster = HashMap::new();
    for (&uid, team) in &roster_team {
        roster.insert(
            uid.to_string(),
            serde_json::json!({"name": name_of(uid), "team": team}),
        );
    }

    let out = RawOut {
        header,
        map_name: p.map_name.clone(),
        tickrate: tr,
        preview_step: p.step,
        score,
        players,
        round_winners: (0..rounds).map(|r| last_by_round.get(&r).copied().unwrap_or(0)).collect(),
        kills,
        movement_runs: runs,
        tricks,
        timeline,
        roster,
        utils: vec![],
    };
    out
}

/// Raw JSON string (what the JS classify() consumes).
pub fn to_json(p: &Parser) -> Result<String, String> {
    serde_json::to_string(&build(p)).map_err(|e| e.to_string())
}

/// Gzip the raw JSON to a file (csgofast-compatible cache for parse-worker.js).
pub fn emit(p: &Parser, out_path: &str) -> Result<(), String> {
    let json = serde_json::to_vec(&build(p)).map_err(|e| e.to_string())?;
    let file = std::fs::File::create(out_path).map_err(|e| e.to_string())?;
    let mut gz = GzEncoder::new(file, Compression::fast());
    gz.write_all(&json).map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())?;
    Ok(())
}
