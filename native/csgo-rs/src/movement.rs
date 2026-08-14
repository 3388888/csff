// Movement runs + telemetry tricks, ported from native/csgofast/main.go.
//
// Every packet we feed each alive player a per-tick Sample {x,y,z, horizontal speed,
// vertical speed, on_ground}. Velocity is derived from position deltas (CS:GO GOTV does
// not network velocity for non-local players — demoinfocs derives it the same way).
//
//   bhop run : sustained speed >=200 with >=3 jumps, closes on a gap
//   edgebug  : hard fall (vz<-350) that snaps to ~flat (vz>-45) while still airborne
//   jumpbug  : landing during a hard fall then instantly airborne again at kept speed
//   surf     : long airborne travel at speed with controlled descent

use crate::entity::PlayerState;
use std::collections::HashMap;

pub struct Trick {
    pub slot: i32,
    pub tick: i32,
    pub kind: &'static str,
    pub fall_vel: i32,
    pub spd: i32,
    pub dur_ticks: i32,
    pub dist: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub struct MRun {
    pub slot: i32,
    pub start_tick: i32,
    pub end_tick: i32,
    pub jumps: i32,
    pub max_speed: i32,
    pub avg_speed: i32,
    pub air_pct: i32,
    pub dist_units: i32,
    pub dur_sec: f32,
}

#[derive(Clone, Copy)]
struct Sample {
    x: f32,
    y: f32,
    z: f32,
    spd: i32,
    vz: i32,
    on_ground: bool,
}

// per-tick telemetry sample kept per slot for per-kill difficulty enrichment
#[derive(Clone, Copy)]
struct Tel {
    tick: i32,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    spd: i32,
    vz: i32,
    on_ground: bool,
    team: i32,
}

#[derive(Default, Clone, Copy)]
pub struct Telemetry {
    pub has: bool,
    pub airborne: bool,
    pub spd: i32,
    pub vz: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub flick: i32,
}

#[derive(Clone, Copy)]
pub struct FlashEv {
    pub tick: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Default)]
struct PixelState {
    on: bool,
    start_tick: i32,
    ticks: i32,
    start_x: f32,
    start_y: f32,
    start_z: f32,
    drift: f32,
    max_spd: i32,
    idx: i32, // index into tricks once emitted (-1 until then)
}

#[derive(Default)]
struct RunState {
    active: bool,
    prev_ground: bool,
    start_tick: i32,
    end_tick: i32,
    jumps: i32,
    n: i32,
    air_n: i32,
    slow: i32,
    max_speed: i32,
    sum_speed: i64,
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
}

#[derive(Default)]
struct TrickPrev {
    vz: i32,
    has_vz: bool,
    on_ground: bool,
    spd: i32,
    jb_tick: i32,
    jb_fall: i32,
    jb_spd: i32,
    jb_active: bool,
}

#[derive(Default)]
struct SurfState {
    air: bool,
    start_tick: i32,
    ticks: i32,
    max_speed: i32,
    n: i32,
    bad_vz: i32,
    descend: i32, // ticks actually falling (vz < -120) — real surf rides gravity down ramps
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
}

pub struct Movement {
    tickrate: i32,
    run_gap: i32,
    runs: HashMap<i32, RunState>,
    tprev: HashMap<i32, TrickPrev>,
    surf: HashMap<i32, SurfState>,
    pixel: HashMap<i32, PixelState>,
    fb_prev: HashMap<i32, i32>,
    flashes: Vec<FlashEv>,
    tel: HashMap<i32, Vec<Tel>>,
    pub runs_out: Vec<MRun>,
    pub tricks: Vec<Trick>,
}

impl Movement {
    pub fn new(tickrate: i32) -> Self {
        Movement {
            tickrate,
            run_gap: ((tickrate as f32) * 0.45).round() as i32,
            runs: HashMap::new(),
            tprev: HashMap::new(),
            surf: HashMap::new(),
            pixel: HashMap::new(),
            fb_prev: HashMap::new(),
            flashes: Vec::new(),
            tel: HashMap::new(),
            runs_out: Vec::new(),
            tricks: Vec::new(),
        }
    }

    // nearest telemetry sample to `tick` for a slot (binary search, samples are tick-ordered)
    fn sample_near(&self, slot: i32, tick: i32) -> Option<Tel> {
        let v = self.tel.get(&slot)?;
        if v.is_empty() {
            return None;
        }
        let i = v.partition_point(|s| s.tick < tick);
        let mut best: Option<Tel> = None;
        for c in [i.checked_sub(1), (i < v.len()).then_some(i)].into_iter().flatten() {
            let s = v[c];
            if best.map_or(true, |b| (s.tick - tick).abs() < (b.tick - tick).abs()) {
                best = Some(s);
            }
        }
        best
    }

    pub fn pos_at(&self, slot: i32, tick: i32) -> Option<(f32, f32, f32)> {
        self.sample_near(slot, tick).map(|s| (s.x, s.y, s.z))
    }

    pub fn team_at(&self, slot: i32, tick: i32) -> i32 {
        self.sample_near(slot, tick).map(|s| s.team).unwrap_or(0)
    }

    pub fn slots(&self) -> Vec<i32> {
        self.tel.keys().copied().collect()
    }

    // is this slot inside a (vetted-later) pixelsurf hold at `tick`?
    pub fn on_pixel(&self, slot: i32, tick: i32) -> bool {
        self.tricks.iter().any(|t| {
            t.kind == "pixelsurf"
                && t.slot == slot
                && tick >= t.tick - 4
                && tick <= t.tick + t.dur_ticks + 8
        })
    }

    // attacker state at a kill: airborne, speed, position, and the flick angle just before
    pub fn telemetry_at(&self, slot: i32, kill_tick: i32, tickrate: i32) -> Telemetry {
        let now = match self.sample_near(slot, kill_tick) {
            Some(s) => s,
            None => return Telemetry::default(),
        };
        let mut flick = 0.0f32;
        for &w in &[0.08f32, 0.12, 0.16, 0.2, 0.26] {
            let back = kill_tick - (tickrate as f32 * w) as i32;
            if let Some(past) = self.sample_near(slot, back) {
                let d = angle_diff(now.yaw, past.yaw).abs();
                if d > flick {
                    flick = d;
                }
            }
        }
        Telemetry {
            has: true,
            airborne: !now.on_ground,
            spd: now.spd,
            vz: now.vz,
            x: now.x,
            y: now.y,
            z: now.z,
            flick: flick.round() as i32,
        }
    }

    // total absolute yaw swept over [tick-window, tick] — a big number == a spin/360
    pub fn spin_in_window(&self, slot: i32, tick: i32, tickrate: i32) -> i32 {
        let v = match self.tel.get(&slot) {
            Some(v) => v,
            None => return 0,
        };
        let a = tick - tickrate;
        let mut sum = 0.0f32;
        let mut prev: Option<f32> = None;
        for s in v {
            if s.tick < a || s.tick > tick {
                continue;
            }
            if let Some(p) = prev {
                sum += angle_diff(s.yaw, p).abs();
            }
            prev = Some(s.yaw);
        }
        sum.round() as i32
    }

    // how far a player moved over [a,b] — small == AFK victim
    pub fn moved_in_window(&self, slot: i32, a: i32, b: i32) -> f32 {
        let v = match self.tel.get(&slot) {
            Some(v) => v,
            None => return 9999.0,
        };
        let mut d = 0.0f32;
        let mut prev: Option<Tel> = None;
        for s in v {
            if s.tick < a || s.tick > b {
                continue;
            }
            if let Some(p) = prev {
                d += (s.x - p.x).hypot(s.y - p.y);
            }
            prev = Some(*s);
        }
        if prev.is_some() {
            d
        } else {
            9999.0
        }
    }

    pub fn add_flash(&mut self, tick: i32, x: f32, y: f32, z: f32) {
        self.flashes.push(FlashEv { tick, x, y, z });
    }

    pub fn feed(&mut self, slot: i32, st: &PlayerState, tick: i32) {
        if !st.has_pos {
            return;
        }
        if !st.alive {
            self.runs.remove(&slot);
            self.surf.remove(&slot);
            self.tprev.remove(&slot);
            self.pixel.remove(&slot);
            return;
        }
        // networked velocity (localdata.m_vecVelocity), like demoinfocs for Source 1
        let spd = st.vx.hypot(st.vy).round() as i32;
        let s = Sample {
            x: st.x,
            y: st.y,
            z: st.z,
            spd,
            vz: st.vz.round() as i32,
            on_ground: st.on_ground,
        };
        self.tel.entry(slot).or_default().push(Tel {
            tick,
            x: st.x,
            y: st.y,
            z: st.z,
            yaw: st.yaw,
            spd,
            vz: st.vz.round() as i32,
            on_ground: st.on_ground,
            team: st.team,
        });
        self.track_run(slot, s, tick);
        self.track_tricks(slot, s, tick);
        self.track_surf(slot, s, tick);
        self.track_flashboost(slot, s, tick);
        self.track_pixelsurf(slot, s, tick);
    }

    fn track_run(&mut self, slot: i32, s: Sample, ct: i32) {
        let tickrate = self.tickrate;
        let run_gap = self.run_gap;
        let r = self.runs.entry(slot).or_insert(RunState {
            prev_ground: true,
            ..Default::default()
        });
        let fast = s.spd >= 200;
        let jumped = r.prev_ground && !s.on_ground;
        if fast {
            if !r.active {
                let pg = r.prev_ground;
                *r = RunState {
                    active: true,
                    prev_ground: pg,
                    start_tick: ct,
                    start_x: s.x,
                    start_y: s.y,
                    end_x: s.x,
                    end_y: s.y,
                    ..Default::default()
                };
            }
            r.end_tick = ct;
            r.slow = 0;
            if s.spd > r.max_speed {
                r.max_speed = s.spd;
            }
            r.sum_speed += s.spd as i64;
            r.n += 1;
            if !s.on_ground {
                r.air_n += 1;
            }
            if jumped {
                r.jumps += 1;
            }
            r.end_x = s.x;
            r.end_y = s.y;
        } else if r.active {
            r.slow += 1;
            if r.slow > run_gap {
                let r = self.runs.remove(&slot).unwrap();
                Self::close_run(&mut self.runs_out, slot, r, tickrate);
                return;
            }
        }
        r.prev_ground = s.on_ground;
    }

    fn close_run(out: &mut Vec<MRun>, slot: i32, r: RunState, tickrate: i32) {
        if r.jumps >= 3 && r.max_speed >= 250 {
            let n = r.n.max(1);
            out.push(MRun {
                slot,
                start_tick: r.start_tick,
                end_tick: r.end_tick,
                jumps: r.jumps,
                max_speed: r.max_speed,
                avg_speed: (r.sum_speed as f32 / n as f32).round() as i32,
                air_pct: ((r.air_n as f32 / n as f32) * 100.0).round() as i32,
                dist_units: (r.end_x - r.start_x).hypot(r.end_y - r.start_y).round() as i32,
                dur_sec: ((r.end_tick - r.start_tick) as f32 / tickrate as f32 * 10.0).round() / 10.0,
            });
        }
    }

    fn track_tricks(&mut self, slot: i32, s: Sample, ct: i32) {
        let p = self.tprev.entry(slot).or_default();
        if p.has_vz && s.spd > 120 {
            if p.vz < -350 && s.vz > -45 && !s.on_ground && !p.on_ground {
                self.tricks.push(Trick {
                    slot,
                    tick: ct,
                    kind: "edgebug",
                    fall_vel: p.vz.abs(),
                    spd: s.spd,
                    dur_ticks: 0,
                    dist: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                });
            }
            if p.vz < -300 && !p.on_ground && s.on_ground {
                p.jb_active = true;
                p.jb_tick = ct;
                p.jb_fall = p.vz.abs();
                p.jb_spd = p.spd;
            } else if p.jb_active && !s.on_ground && ct - p.jb_tick <= 3 && s.spd as f32 > p.jb_spd as f32 * 0.85 {
                let (jt, jf) = (p.jb_tick, p.jb_fall);
                p.jb_active = false;
                self.tricks.push(Trick {
                    slot,
                    tick: jt,
                    kind: "jumpbug",
                    fall_vel: jf,
                    spd: s.spd,
                    dur_ticks: 0,
                    dist: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                });
            } else if p.jb_active && ct - p.jb_tick > 3 {
                p.jb_active = false;
            }
        }
        p.vz = s.vz;
        p.has_vz = true;
        p.on_ground = s.on_ground;
        p.spd = s.spd;
    }

    fn track_surf(&mut self, slot: i32, s: Sample, ct: i32) {
        let tickrate = self.tickrate;
        let st = self.surf.entry(slot).or_default();
        if !s.on_ground && s.spd >= 250 {
            if !st.air {
                *st = SurfState {
                    air: true,
                    start_tick: ct,
                    start_x: s.x,
                    start_y: s.y,
                    ..Default::default()
                };
            }
            st.ticks += 1;
            st.n += 1;
            if s.spd > st.max_speed {
                st.max_speed = s.spd;
            }
            if s.vz < -420 {
                st.bad_vz += 1;
            }
            if s.vz < -120 {
                st.descend += 1;
            }
            st.end_x = s.x;
            st.end_y = s.y;
        } else if st.air {
            st.air = false;
            let dur = ct - st.start_tick;
            let dist = (st.end_x - st.start_x).hypot(st.end_y - st.start_y).round() as i32;
            // real surf rides ramps DOWN, so a good share of the run is spent descending.
            // noclip "flying" (fake demos) hovers at ~level (vz≈0) — exclude that from surf.
            let descends = st.descend >= (st.ticks / 4).max(3);
            if dur >= (tickrate as f32 * 0.8).round() as i32
                && st.max_speed >= 350
                && dist >= 500
                && st.bad_vz <= st.ticks / 2
                && descends
            {
                self.tricks.push(Trick {
                    slot,
                    tick: st.start_tick,
                    kind: "surf",
                    fall_vel: st.max_speed,
                    spd: s.spd,
                    dur_ticks: dur,
                    dist,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                });
            }
        }
    }

    // flashboost: sudden speed spike right after a flash detonates within 320u
    fn track_flashboost(&mut self, slot: i32, s: Sample, ct: i32) {
        let pv = self.fb_prev.insert(slot, s.spd);
        let pv = match pv {
            Some(v) => v,
            None => return,
        };
        if s.spd - pv < 180 || s.spd < 300 {
            return;
        }
        let win = (self.tickrate as f32 * 0.4) as i32;
        let mut hit = false;
        for f in self.flashes.iter().rev() {
            if ct - f.tick > win {
                break; // flashes are in tick order
            }
            if ct - f.tick < 0 {
                continue;
            }
            let d = ((s.x - f.x).powi(2) + (s.y - f.y).powi(2) + (s.z - f.z).powi(2)).sqrt();
            if d <= 320.0 {
                hit = true;
                break;
            }
        }
        if hit {
            self.tricks.push(Trick {
                slot,
                tick: ct,
                kind: "flashboost",
                fall_vel: s.spd,
                spd: s.spd - pv,
                dur_ticks: 0,
                dist: 0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            });
        }
    }

    // pixelsurf candidate: airborne, ~motionless, held >=0.5s with little drift.
    // (map-geometry vetting against ladders/water happens later, outside this crate.)
    fn track_pixelsurf(&mut self, slot: i32, s: Sample, ct: i32) {
        const MAX_SPEED: i32 = 45;
        const MAX_VZ: i32 = 20;
        const MIN_SEC: f32 = 0.5;
        const MAX_DRIFT: f32 = 72.0;
        let tickrate = self.tickrate;
        let st = self.pixel.entry(slot).or_insert(PixelState {
            idx: -1,
            ..Default::default()
        });
        if !s.on_ground && s.spd <= MAX_SPEED && s.vz.abs() <= MAX_VZ {
            if !st.on {
                *st = PixelState {
                    on: true,
                    start_tick: ct,
                    start_x: s.x,
                    start_y: s.y,
                    start_z: s.z,
                    idx: -1,
                    ..Default::default()
                };
            }
            st.ticks += 1;
            if s.spd > st.max_spd {
                st.max_spd = s.spd;
            }
            let d = (s.x - st.start_x).hypot(s.y - st.start_y);
            if d > st.drift {
                st.drift = d;
            }
            if st.drift > MAX_DRIFT {
                st.on = false; // drifting → glide/surf, not a perch
                return;
            }
            if st.ticks >= (tickrate as f32 * MIN_SEC).round() as i32 {
                if st.idx < 0 {
                    st.idx = self.tricks.len() as i32;
                    let (sx, sy, sz, mx, stt) =
                        (st.start_x, st.start_y, st.start_z, st.max_spd, st.start_tick);
                    self.tricks.push(Trick {
                        slot,
                        tick: stt,
                        kind: "pixelsurf",
                        fall_vel: 0,
                        spd: mx,
                        dur_ticks: 0,
                        dist: 0,
                        x: sx,
                        y: sy,
                        z: sz,
                    });
                }
                let idx = st.idx as usize;
                let ticks = st.ticks;
                self.tricks[idx].dur_ticks = ticks;
            }
            return;
        }
        st.on = false;
    }

    pub fn finish(&mut self) {
        let tickrate = self.tickrate;
        let slots: Vec<i32> = self.runs.keys().copied().collect();
        for slot in slots {
            if let Some(r) = self.runs.remove(&slot) {
                if r.active {
                    Self::close_run(&mut self.runs_out, slot, r, tickrate);
                }
            }
        }
    }
}

// smallest signed difference between two yaw angles (degrees), in [-180,180]
fn angle_diff(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    } else if d < -180.0 {
        d += 360.0;
    }
    d
}
