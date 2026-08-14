// csgo-rs — hand-rolled Source-1 (CS:GO, HL2DEMO) demo frag finder, zero deps.
//
// CS2 demos (PBDEMS2) are handled by the demoparser-based build; this reads the OLD
// Source-1 CS:GO container: a 1072-byte header, then a loop of dem_* commands. The kill
// data lives inside dem_packet/dem_signon net-message chunks as PROTOBUF messages
// (svc_GameEventList = the event schema, svc_GameEvent = each fired event). We hand-decode
// just those two protobufs — no prost, no generated code — plus the userinfo string table
// for player names.
//
// Ground truth for correctness is the Go demoinfocs parser (native/csgofast). Set
// CDH_DEBUG=1 to dump the event histogram + player_death key layout.

mod classify;
mod cssff;
mod css;
#[cfg(feature = "cs2")]
mod cs2;
#[cfg(feature = "bsp")]
pub mod bspgeo;
mod entity;
#[cfg(feature = "export3d")]
pub mod export;
#[cfg(feature = "assets")]
pub mod vpk;
#[cfg(feature = "assets")]
pub mod mdl;
#[cfg(feature = "assets")]
pub mod vtf;
#[cfg(feature = "assets")]
pub mod vmt;
mod movement;
mod pb;
#[cfg(feature = "app")]
mod raw;
mod sendtables;

use pb::{skip_field, varint, Bits};
use std::collections::HashMap;
use std::env;

// ---- demo command ids (Source 1) ----
const DEM_SIGNON: u8 = 1;
const DEM_PACKET: u8 = 2;
const DEM_SYNCTICK: u8 = 3;
const DEM_CONSOLECMD: u8 = 4;
const DEM_USERCMD: u8 = 5;
const DEM_DATATABLES: u8 = 6;
const DEM_STOP: u8 = 7;
const DEM_CUSTOMDATA: u8 = 8;
const DEM_STRINGTABLES: u8 = 9;

// ---- CS:GO net/svc message ids we care about (netmessages.proto) ----
const SVC_CREATE_STRINGTABLE: u32 = 12;
const SVC_UPDATE_STRINGTABLE: u32 = 13;
const SVC_GAME_EVENT: u32 = 25;
const SVC_PACKET_ENTITIES: u32 = 26;
const SVC_GAME_EVENT_LIST: u32 = 30;

// one sampled timeline frame: tick + player states
struct TFrame {
    t: i32,
    players: Vec<(i32, entity::PlayerState)>,
}

#[derive(Clone)]
enum Val {
    Str(String),
    I64(i64),
    F32(f32),
    Bool(bool),
    None,
}
impl Val {
    fn i(&self) -> i64 {
        match self {
            Val::I64(n) => *n,
            Val::Bool(b) => *b as i64,
            Val::F32(f) => *f as i64,
            _ => 0,
        }
    }
    fn s(&self) -> &str {
        match self {
            Val::Str(s) => s,
            _ => "",
        }
    }
    fn b(&self) -> bool {
        match self {
            Val::Bool(b) => *b,
            Val::I64(n) => *n != 0,
            _ => false,
        }
    }
    fn f(&self) -> f32 {
        match self {
            Val::F32(f) => *f,
            Val::I64(n) => *n as f32,
            _ => 0.0,
        }
    }
}

struct Desc {
    name: String,
    keys: Vec<String>,
}

#[derive(Default, Clone)]
struct Kill {
    tick: i32,
    attacker: i64, // userid of killer
    victim: i64,
    weapon: String,
    headshot: bool,
    round: i32,
    // difficulty telemetry (filled in full mode)
    noscope: bool,
    penetrated: i32,
    smoke: bool,
    blind: bool,
    airborne: bool,
    spd: i32,
    vz: i32,
    dist: i32,
    dist_m: i32,
    flick: i32,
    spin: i32,
    hit_chance: f32,
    pixel: bool,
    afk: bool,
    attacker_team: i32,
    team_alive: i32,
    enemy_alive: i32,
    nearby: i32,
    shots_before_kill: i32, // shots the killer fired in the ~1s before the kill (1 = one-tap)
}

// ---------------------------------------------------------------------------
// little-endian byte cursor over the demo file
struct Cur<'a> {
    d: &'a [u8],
    p: usize,
}
impl<'a> Cur<'a> {
    fn u8(&mut self) -> u8 {
        let v = self.d[self.p];
        self.p += 1;
        v
    }
    fn i32(&mut self) -> i32 {
        let v = i32::from_le_bytes(self.d[self.p..self.p + 4].try_into().unwrap());
        self.p += 4;
        v
    }
    fn skip(&mut self, n: usize) {
        self.p += n;
    }
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.d[self.p..self.p + n];
        self.p += n;
        s
    }
    fn left(&self) -> usize {
        self.d.len().saturating_sub(self.p)
    }
}

// ---------------------------------------------------------------------------
#[derive(Clone)]
struct TableMeta {
    name: String,
    max_entries: i32,
    fixed_size: bool,
    data_bytes: usize, // fixed user-data size in bytes
}

struct Parser {
    descs: HashMap<i32, Desc>,
    kills: Vec<Kill>,
    round_ticks: Vec<i32>,
    ev_hist: HashMap<String, u32>,
    cur_tick: i32,
    debug: bool,
    dumped_death: bool,
    // userid -> name (from userinfo string table)
    names: HashMap<i64, String>,
    uid_slot: HashMap<i64, i32>, // userid -> entity slot (userinfo idx + 1)
    // slot -> the MOST RECENT userid in it. Inverting uid_slot is wrong: when a player
    // reconnects, several userids map to one slot and HashMap order picks an arbitrary
    // winner — that's how a clip labelled "x" ended up drawing "Lucas" in the preview.
    pub slot_uid: HashMap<i32, i64>,
    pub xuids: HashMap<i64, u64>, // userid -> SteamID64 (stable across servers/demos)
    fire_buf: HashMap<i64, Vec<i32>>, // killer uid -> recent weapon_fire ticks (for miss counting)
    tables: Vec<TableMeta>,
    userinfo_id: Option<usize>,
    baseline_id: Option<usize>,
    baselines: HashMap<i32, Vec<u8>>,
    dumped_pinfo: bool,
    // entity schema (from dem_datatables)
    classes: Vec<sendtables::ServerClass>,
    sendtables_done: bool,
    world: Option<entity::EntityWorld>,
    timeline: Vec<TFrame>,
    step: i32,
    next_sample: i32,
    tickrate: i32,
    movement: Option<movement::Movement>,
    full: bool, // decode positions + movement (slow); off = frags only (fast)
    map_name: String,
    playback_ticks: i32,
    playback_time: f32,
}

impl Parser {
    fn new(debug: bool, full: bool) -> Self {
        Parser {
            descs: HashMap::new(),
            kills: Vec::new(),
            round_ticks: Vec::new(),
            ev_hist: HashMap::new(),
            cur_tick: 0,
            debug,
            dumped_death: false,
            names: HashMap::new(),
            uid_slot: HashMap::new(),
            slot_uid: HashMap::new(),
            xuids: HashMap::new(),
            fire_buf: HashMap::new(),
            tables: Vec::new(),
            userinfo_id: None,
            baseline_id: None,
            baselines: HashMap::new(),
            dumped_pinfo: false,
            classes: Vec::new(),
            sendtables_done: false,
            world: None,
            timeline: Vec::new(),
            step: 6,
            next_sample: 0,
            tickrate: 64,
            movement: None,
            full,
            map_name: String::new(),
            playback_ticks: 0,
            playback_time: 0.0,
        }
    }

    fn run(&mut self, data: &[u8]) {
        // tickrate from header: playbackTicks / playbackTime
        let pt = f32::from_le_bytes(data[1056..1060].try_into().unwrap());
        let ticks = i32::from_le_bytes(data[1060..1064].try_into().unwrap());
        let mut tr = if pt > 1.0 && ticks > 0 {
            (ticks as f32 / pt).round() as i32
        } else {
            64
        };
        tr = if tr > 96 { 128 } else { 64 };
        self.tickrate = tr;
        self.playback_ticks = ticks;
        self.playback_time = pt;
        self.map_name = {
            let raw = &data[536..796];
            let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).to_string()
        };
        self.step = ((tr as f32 / 20.0).round() as i32).max(1);
        if self.full {
            self.movement = Some(movement::Movement::new(tr));
        }

        let mut c = Cur { d: data, p: 1072 };
        loop {
            if c.left() < 6 {
                break;
            }
            let cmd = c.u8();
            let tick = c.i32();
            if tick >= 0 {
                self.cur_tick = tick;
            }
            let _slot = c.u8(); // CS:GO player slot byte
            match cmd {
                DEM_SIGNON | DEM_PACKET => {
                    c.skip(152); // democmdinfo_t (2 splits x 76)
                    c.skip(4); // SeqNrIn
                    c.skip(4); // SeqNrOut
                    let n = c.i32() as usize;
                    if n > c.left() {
                        break;
                    }
                    let chunk = c.take(n);
                    self.packet(chunk);
                    // Sample positions only on real game packets. GOTV demos stamp the SIGNON
                    // at the broadcast tick (e.g. 120402) while gameplay ticks restart at 0;
                    // sampling the signon would poison `next_sample` and skip the whole match
                    // (only the tail got a timeline → "No preview data" for earlier highlights).
                    if self.full && cmd == DEM_PACKET {
                        self.feed_movement();
                        self.sample_timeline();
                    }
                }
                DEM_SYNCTICK => {}
                DEM_CONSOLECMD => {
                    let n = c.i32() as usize;
                    c.skip(n);
                }
                DEM_USERCMD => {
                    c.skip(4); // outgoing sequence
                    let n = c.i32() as usize;
                    c.skip(n);
                }
                DEM_DATATABLES => {
                    let n = c.i32() as usize;
                    if n > c.left() {
                        break;
                    }
                    let block = c.take(n);
                    if self.full && !self.sendtables_done {
                        self.sendtables_done = true;
                        let (tables, mut classes) = sendtables::parse_datatables(block);
                        sendtables::flatten_all(&tables, &mut classes);
                        if self.debug {
                            self.dump_sendtables(&tables, &classes);
                        }
                        self.classes = classes.clone();
                        self.world = Some(entity::EntityWorld::new(classes, 64));
                    }
                }
                DEM_CUSTOMDATA => {
                    c.skip(4);
                    let n = c.i32() as usize;
                    c.skip(n);
                }
                DEM_STRINGTABLES => {
                    // The signon string-table DUMP. This carries the FULL userinfo roster for
                    // everyone already connected — the players whose join happened before this
                    // demo started recording. Skipping it (the old behaviour) meant those
                    // userIDs had no name, so kills showed "uid1234" and the 3D POV couldn't
                    // lock on. demoinfocs (Go) reads this, which is why Go resolved every name.
                    let n = c.i32() as usize;
                    if n > c.left() {
                        break;
                    }
                    let block = c.take(n);
                    self.demo_stringtables(block);
                }
                DEM_STOP => break,
                _ => break, // desync
            }
        }
    }

    // walk the net-message chunk: (varint cmd, varint size, payload)*
    fn packet(&mut self, b: &[u8]) {
        let mut p = 0usize;
        while p < b.len() {
            let cmd = varint(b, &mut p) as u32;
            let size = varint(b, &mut p) as usize;
            if p + size > b.len() {
                break;
            }
            let payload = &b[p..p + size];
            p += size;
            match cmd {
                SVC_GAME_EVENT_LIST => self.game_event_list(payload),
                SVC_GAME_EVENT => self.game_event(payload),
                SVC_CREATE_STRINGTABLE => self.create_stringtable(payload),
                SVC_UPDATE_STRINGTABLE => self.update_stringtable(payload),
                SVC_PACKET_ENTITIES if self.full => self.packet_entities(payload),
                _ => {}
            }
        }
    }

    // svc_PacketEntities: max_entries=1, updated_entries=2, is_delta=3, ..., entity_data=7
    fn packet_entities(&mut self, b: &[u8]) {
        let mut p = 0usize;
        let mut updated = 0i32;
        let mut is_delta = false;
        let mut data: &[u8] = &[];
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            match (field, wt) {
                (2, 0) => updated = varint(b, &mut p) as i32,
                (3, 0) => is_delta = varint(b, &mut p) != 0,
                (7, 2) => data = skip_field(b, &mut p, 2).unwrap_or(&[]),
                _ => {
                    skip_field(b, &mut p, wt);
                }
            }
        }
        let baselines = &self.baselines;
        if let Some(w) = self.world.as_mut() {
            w.read_packet_entities(data, updated, is_delta, baselines);
        }
    }

    // feed every alive player's per-tick state to the movement/trick trackers
    fn feed_movement(&mut self) {
        let players = match self.world.as_ref() {
            Some(w) => w.players(),
            None => return,
        };
        let tick = self.cur_tick;
        if let Some(m) = self.movement.as_mut() {
            for (slot, st) in &players {
                m.feed(*slot, st, tick);
            }
        }
    }

    // capture a timeline frame every `step` ticks
    fn sample_timeline(&mut self) {
        if self.cur_tick < self.next_sample {
            return;
        }
        self.next_sample = self.cur_tick + self.step;
        let players = match self.world.as_ref() {
            Some(w) => w.players(),
            None => return,
        };
        if !players.is_empty() {
            self.timeline.push(TFrame {
                t: self.cur_tick,
                players,
            });
        }
    }

    fn game_event_list(&mut self, b: &[u8]) {
        let mut p = 0usize;
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            if field == 1 && wt == 2 {
                let n = varint(b, &mut p) as usize;
                let sub = &b[p..(p + n).min(b.len())];
                p += n;
                self.parse_descriptor(sub);
            } else {
                skip_field(b, &mut p, wt);
            }
        }
    }

    fn parse_descriptor(&mut self, b: &[u8]) {
        let mut p = 0usize;
        let mut eventid = 0i32;
        let mut name = String::new();
        let mut keys: Vec<String> = Vec::new();
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            match (field, wt) {
                (1, 0) => eventid = varint(b, &mut p) as i32,
                (2, 2) => {
                    let s = skip_field(b, &mut p, 2).unwrap_or(&[]);
                    name = String::from_utf8_lossy(s).to_string();
                }
                (3, 2) => {
                    let sub = skip_field(b, &mut p, 2).unwrap_or(&[]);
                    // key_t { type=1 varint, name=2 string }
                    let mut q = 0usize;
                    let mut kn = String::new();
                    while q < sub.len() {
                        let t = varint(sub, &mut q);
                        let (f2, w2) = (t >> 3, t & 7);
                        if f2 == 2 && w2 == 2 {
                            let s = skip_field(sub, &mut q, 2).unwrap_or(&[]);
                            kn = String::from_utf8_lossy(s).to_string();
                        } else {
                            skip_field(sub, &mut q, w2);
                        }
                    }
                    keys.push(kn);
                }
                _ => {
                    skip_field(b, &mut p, wt);
                }
            }
        }
        self.descs.insert(eventid, Desc { name, keys });
    }

    fn game_event(&mut self, b: &[u8]) {
        let mut p = 0usize;
        let mut eventid = 0i32;
        let mut vals: Vec<Val> = Vec::new();
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            match (field, wt) {
                (1, 2) => {
                    skip_field(b, &mut p, 2);
                } // event_name (rarely present)
                (2, 0) => eventid = varint(b, &mut p) as i32,
                (3, 2) => {
                    let sub = skip_field(b, &mut p, 2).unwrap_or(&[]);
                    vals.push(parse_key_value(sub));
                }
                _ => {
                    skip_field(b, &mut p, wt);
                }
            }
        }
        let desc = match self.descs.get(&eventid) {
            Some(d) => d,
            None => return,
        };
        *self.ev_hist.entry(desc.name.clone()).or_insert(0) += 1;

        if desc.name == "round_start" {
            self.round_ticks.push(self.cur_tick);
            return;
        }
        if self.full && desc.name == "flashbang_detonate" {
            let mut m: HashMap<&str, &Val> = HashMap::new();
            for (i, v) in vals.iter().enumerate() {
                if let Some(k) = desc.keys.get(i) {
                    m.insert(k.as_str(), v);
                }
            }
            let g = |k: &str| m.get(k).map(|v| v.f()).unwrap_or(0.0);
            let (x, y, z) = (g("x"), g("y"), g("z"));
            let tick = self.cur_tick;
            if let Some(mv) = self.movement.as_mut() {
                mv.add_flash(tick, x, y, z);
            }
            return;
        }
        // buffer each shot the shooter fires, so a kill can report shots-in-the-last-second
        // (1 = a genuine one-tap). Without this every kill looked like a one-tap.
        if desc.name == "weapon_fire" {
            let mut shooter = 0i64;
            for (i, v) in vals.iter().enumerate() {
                if desc.keys.get(i).map(|k| k.as_str()) == Some("userid") {
                    shooter = v.i();
                    break;
                }
            }
            if shooter != 0 {
                let b = self.fire_buf.entry(shooter).or_default();
                b.push(self.cur_tick);
                if b.len() > 64 {
                    b.remove(0);
                }
            }
            return;
        }
        if desc.name != "player_death" {
            return;
        }
        if self.debug && !self.dumped_death {
            self.dumped_death = true;
            eprintln!("  [debug] player_death keys: {:?}", desc.keys);
        }
        // map key name -> value
        let mut m: HashMap<&str, &Val> = HashMap::new();
        for (i, v) in vals.iter().enumerate() {
            if let Some(k) = desc.keys.get(i) {
                m.insert(k.as_str(), v);
            }
        }
        let g = |k: &str| m.get(k).copied();
        let attacker = g("attacker").map(|v| v.i()).unwrap_or(0);
        let victim = g("userid").map(|v| v.i()).unwrap_or(0);
        let weapon = g("weapon").map(|v| v.s().to_string()).unwrap_or_default();
        let headshot = g("headshot").map(|v| v.b()).unwrap_or(false);
        // Valve's key names differ per build/server: vanilla uses noscope/thrusmoke/attackerblind,
        // while these ClassicCounter demos emit noscopekill/smokekill/blindkill/airshotkill.
        // Accept both, else every kill looked like a plain (non-noscope) kill.
        let any = |keys: &[&str]| keys.iter().any(|k| g(k).map(|v| v.b()).unwrap_or(false));
        let noscope = any(&["noscope", "noscopekill"]);
        let penetrated = g("penetrated").map(|v| v.i() as i32).unwrap_or(0);
        let smoke = any(&["thrusmoke", "smokekill"]);
        let blind = any(&["attackerblind", "blindkill"]);
        // shots the killer fired in the second before the kill (shotsNear): [kt - tickrate, kt+4]
        let kt = self.cur_tick;
        let tr = if self.tickrate > 0 { self.tickrate } else { 64 };
        let shots_before_kill = self
            .fire_buf
            .get(&attacker)
            .map(|b| b.iter().filter(|&&t| t >= kt - tr && t <= kt + 4).count() as i32)
            .unwrap_or(0);
        // self-kills / world kills (attacker==0 or attacker==victim) don't score
        if attacker != 0 && attacker != victim {
            self.kills.push(Kill {
                tick: self.cur_tick,
                attacker,
                victim,
                weapon,
                headshot,
                round: 0,
                noscope,
                penetrated,
                smoke,
                blind,
                shots_before_kill,
                ..Default::default()
            });
        }
    }

    // svc_CreateStringTable: name, max_entries, num_entries, fixed_size, data_size,
    // data_size_bits, flags, string_data(bytes, bit-packed)
    fn create_stringtable(&mut self, b: &[u8]) {
        let mut p = 0usize;
        let mut name = String::new();
        let mut max_entries = 0i32;
        let mut num_entries = 0i32;
        let mut fixed = false;
        let mut data_size = 0i32;
        let mut data_bits = 0i32;
        let mut flags = 0i32;
        let mut sdata: &[u8] = &[];
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            match (field, wt) {
                (1, 2) => name = String::from_utf8_lossy(skip_field(b, &mut p, 2).unwrap_or(&[])).to_string(),
                (2, 0) => max_entries = varint(b, &mut p) as i32,
                (3, 0) => num_entries = varint(b, &mut p) as i32,
                (4, 0) => fixed = varint(b, &mut p) != 0,
                (5, 0) => data_size = varint(b, &mut p) as i32,
                (6, 0) => data_bits = varint(b, &mut p) as i32,
                (7, 0) => flags = varint(b, &mut p) as i32,
                (8, 2) => sdata = skip_field(b, &mut p, 2).unwrap_or(&[]),
                _ => {
                    skip_field(b, &mut p, wt);
                }
            }
        }
        let db = if data_size > 0 {
            data_size as usize
        } else {
            ((data_bits + 7) / 8) as usize
        };
        let id = self.tables.len();
        if self.debug {
            eprintln!(
                "  [tbl] id={id} name={name:?} max={max_entries} num={num_entries} fixed={fixed} dsize={data_size} dbits={data_bits} flags={flags} sdata={}B",
                sdata.len()
            );
        }
        self.tables.push(TableMeta {
            name: name.clone(),
            max_entries,
            fixed_size: fixed,
            data_bytes: db,
        });
        if name == "userinfo" {
            self.userinfo_id = Some(id);
            if flags & 0x1 == 0 {
                self.decode_table_entries(id, sdata, num_entries);
            }
        } else if name == "instancebaseline" {
            self.baseline_id = Some(id);
            if self.full && flags & 0x1 == 0 {
                self.decode_table_entries(id, sdata, num_entries);
            }
        }
    }

    // dem_stringtables (cmd 9): bit-packed dump of every string table.
    //   u8 numTables, then per table: string name, u16 numEntries,
    //   per entry: string name, 1 bit hasUserData -> u16 size + bytes.
    //   Then 1 bit "has client-side entries" -> u16 count + the same entry layout.
    // We only care about userinfo (player_info_t blobs) — that's where the missing names live.
    fn demo_stringtables(&mut self, b: &[u8]) {
        let mut r = pb::Bits::new(b);
        let num_tables = r.read_bits(8) as usize;
        for _ in 0..num_tables {
            if !r.ok() {
                return;
            }
            let tname = r.read_string();
            let n_entries = r.read_bits(16) as usize;
            let is_userinfo = tname == "userinfo";
            for _ in 0..n_entries {
                if !r.ok() {
                    return;
                }
                let _ename = r.read_string();
                if r.read_bit() == 1 {
                    let size = r.read_bits(16) as usize;
                    let udata = r.read_bytes(size);
                    if is_userinfo && udata.len() >= 148 {
                        if let Some((uid, nm)) = parse_player_info(&udata) {
                            if !nm.is_empty() {
                                self.names.entry(uid).or_insert(nm);
                            }
                            // the signon roster is where MOST players come from, so the
                            // SteamID64 has to be captured here too — not just in the
                            // svc_*StringTable path (that left 10/12 players without one)
                            if let Some(x) = parse_player_xuid(&udata) {
                                self.xuids.entry(uid).or_insert(x);
                            }
                        }
                    }
                }
            }
            // client-side entries (rarely populated, but must be consumed to stay aligned)
            if r.read_bit() == 1 {
                let n_client = r.read_bits(16) as usize;
                for _ in 0..n_client {
                    if !r.ok() {
                        return;
                    }
                    let _ = r.read_string();
                    if r.read_bit() == 1 {
                        let size = r.read_bits(16) as usize;
                        let _ = r.read_bytes(size);
                    }
                }
            }
        }
    }

    fn update_stringtable(&mut self, b: &[u8]) {
        let mut p = 0usize;
        let mut table_id = -1i32;
        let mut num = 1i32;
        let mut sdata: &[u8] = &[];
        while p < b.len() {
            let tag = varint(b, &mut p);
            let (field, wt) = (tag >> 3, tag & 7);
            match (field, wt) {
                (1, 0) => table_id = varint(b, &mut p) as i32,
                (2, 0) => num = varint(b, &mut p) as i32,
                (3, 2) => sdata = skip_field(b, &mut p, 2).unwrap_or(&[]),
                _ => {
                    skip_field(b, &mut p, wt);
                }
            }
        }
        if Some(table_id as usize) == self.userinfo_id
            || (self.full && Some(table_id as usize) == self.baseline_id)
        {
            self.decode_table_entries(table_id as usize, sdata, num);
        }
    }

    // shared bit-decode of a string-table's entry blob (Create + Update use the same format)
    fn decode_table_entries(&mut self, id: usize, data: &[u8], num_entries: i32) {
        let meta = self.tables[id].clone();
        let mut entry_bits = 0u32;
        let mut t = meta.max_entries;
        while t > 1 {
            t >>= 1;
            entry_bits += 1;
        }
        let mut r = Bits::new(data);
        // leading bit: dictionary encoding (unused by CS:GO demos). If set, bail.
        if r.read_bit() == 1 {
            return;
        }
        let mut history: Vec<String> = Vec::new();
        let mut idx: i64 = -1;
        let trace = self.debug && meta.name == "userinfo" && env::var("TBLTRACE").is_ok();
        for e in 0..num_entries {
            if !r.ok() {
                break;
            }
            idx += 1;
            if r.read_bit() == 0 {
                idx = r.read_bits(entry_bits) as i64;
            }
            let mut ename = String::new();
            let mut has_name = false;
            if r.read_bit() == 1 {
                has_name = true;
                if r.read_bit() == 1 {
                    // substring from history
                    let hidx = r.read_bits(5) as usize;
                    let n = r.read_bits(5) as usize;
                    let base = history.get(hidx).cloned().unwrap_or_default();
                    let pre: String = base.chars().take(n).collect();
                    ename = pre + &r.read_string();
                } else {
                    ename = r.read_string();
                }
            }
            let mut udata: Vec<u8> = Vec::new();
            if r.read_bit() == 1 {
                if meta.fixed_size {
                    udata = r.read_bytes(meta.data_bytes.max(1));
                } else {
                    let nbytes = r.read_bits(14) as usize;
                    udata = r.read_bytes(nbytes);
                }
            }
            if trace && e < 16 {
                eprintln!(
                    "    e={e} idx={idx} hasName={has_name} name={ename:?} udata={}B",
                    udata.len()
                );
            }
            history.push(ename.clone());
            if history.len() > 32 {
                history.remove(0);
            }
            if meta.name == "userinfo" && udata.len() >= 148 {
                if let Some((uid, nm)) = parse_player_info(&udata) {
                    if self.debug && !self.dumped_pinfo {
                        self.dumped_pinfo = true;
                        eprintln!(
                            "  [debug] userinfo entry idx={idx} len={} -> userid={uid} name={:?}",
                            udata.len(),
                            nm
                        );
                    }
                    if !nm.is_empty() {
                        self.names.insert(uid, nm);
                    }
                    if let Some(x) = parse_player_xuid(&udata) {
                        self.xuids.insert(uid, x);
                    }
                    // userinfo entry index (client slot) → player entity index is slot+1
                    if uid > 0 {
                        let slot = idx as i32 + 1;
                        self.uid_slot.insert(uid, slot);
                        self.slot_uid.insert(slot, uid); // latest occupant wins (reconnects)
                    }
                }
            } else if meta.name == "instancebaseline" && !udata.is_empty() {
                // entry name is the server-class id; userdata is the baseline prop blob
                if let Ok(class_id) = ename.parse::<i32>() {
                    self.baselines.insert(class_id, udata);
                }
            }
        }
    }

    fn dump_sendtables(&self, tables: &[sendtables::SendTable], classes: &[sendtables::ServerClass]) {
        eprintln!(
            "  [dt] {} send tables, {} server classes",
            tables.len(),
            classes.len()
        );
        for want in ["CCSPlayer", "CCSPlayerResource", "CWorld"] {
            if let Some(c) = classes.iter().find(|c| c.name == want) {
                eprintln!("  [dt] {} (dt={}) flat props={}", c.name, c.dt_name, c.flat.len());
            }
        }
        if let Some(c) = classes.iter().find(|c| c.name == "CCSPlayer") {
            use std::collections::BTreeMap;
            let mut hist: BTreeMap<i32, u32> = BTreeMap::new();
            for f in &c.flat {
                *hist.entry(f.prop.priority).or_insert(0) += 1;
            }
            eprintln!("  [dt] CCSPlayer priority histogram: {:?}", hist);
            eprintln!("  [dt] CCSPlayer first 16 flat props:");
            for (i, f) in c.flat.iter().take(16).enumerate() {
                let co = if f.prop.flags & sendtables::SPROP_CHANGES_OFTEN != 0 { "CO" } else { "  " };
                eprintln!(
                    "      [{i:>3}] pri={:>3} {co} {:<44} type={} bits={}",
                    f.prop.priority, f.path, f.prop.typ, f.prop.num_bits
                );
            }
        }
    }

    fn finish(&mut self) {
        if let Some(m) = self.movement.as_mut() {
            m.finish();
        }
        self.round_ticks.sort_unstable();
        for k in self.kills.iter_mut() {
            k.round = self
                .round_ticks
                .partition_point(|&t| t <= k.tick) as i32;
        }
        // slot→uid + first-death-per-round, for alive-count / clutch / outnumbered context
        let slot_uid: HashMap<i32, i64> = self.slot_uid.clone();
        let mut death_at: HashMap<(i32, i64), i32> = HashMap::new();
        for k in &self.kills {
            let e = death_at.entry((k.round, k.victim)).or_insert(k.tick);
            if k.tick < *e {
                *e = k.tick;
            }
        }
        // enrich each kill with per-kill difficulty telemetry (full mode only)
        if let Some(mv) = self.movement.as_ref() {
            let tr = self.tickrate;
            let all_slots = mv.slots();
            for k in self.kills.iter_mut() {
                let aslot = match self.uid_slot.get(&k.attacker) {
                    Some(&s) => s,
                    None => continue,
                };
                let t = mv.telemetry_at(aslot, k.tick, tr);
                if !t.has {
                    continue;
                }
                k.airborne = t.airborne;
                k.spd = t.spd;
                k.vz = t.vz;
                k.flick = t.flick;
                k.spin = mv.spin_in_window(aslot, k.tick, tr);
                if let Some(&vslot) = self.uid_slot.get(&k.victim) {
                    if let Some((vx, vy, vz)) = mv.pos_at(vslot, k.tick) {
                        k.dist = ((t.x - vx).powi(2) + (t.y - vy).powi(2) + (t.z - vz).powi(2))
                            .sqrt()
                            .round() as i32;
                        k.dist_m = (k.dist as f32 / 52.49).round() as i32;
                    }
                    k.afk = mv.moved_in_window(vslot, k.tick - tr * 3, k.tick) < 120.0;
                }
                k.hit_chance = classify::hit_chance(&k.weapon, t.airborne, t.spd, k.dist_m, k.noscope);
                k.pixel = t.airborne && mv.on_pixel(aslot, k.tick);

                // alive counts at the kill tick (victim excluded = "after this kill")
                let atk_team = mv.team_at(aslot, k.tick);
                k.attacker_team = atk_team;
                let (mut talive, mut ealive, mut nearby) = (0, 0, 0);
                for &sl in &all_slots {
                    let u = match slot_uid.get(&sl) {
                        Some(&u) => u,
                        None => continue,
                    };
                    if u == k.victim {
                        continue;
                    }
                    let team = mv.team_at(sl, k.tick);
                    if team != 2 && team != 3 {
                        continue;
                    }
                    let alive = death_at.get(&(k.round, u)).map_or(true, |&d| d > k.tick);
                    if !alive {
                        continue;
                    }
                    if team == atk_team {
                        talive += 1;
                    } else {
                        ealive += 1;
                        if let Some((ex, ey, ez)) = mv.pos_at(sl, k.tick) {
                            let d = ((t.x - ex).powi(2) + (t.y - ey).powi(2) + (t.z - ez).powi(2))
                                .sqrt();
                            if d <= 1000.0 {
                                nearby += 1;
                            }
                        }
                    }
                }
                k.team_alive = talive;
                k.enemy_alive = ealive;
                k.nearby = nearby;
            }
        }
    }
}

// a game-event key_t submessage carries exactly one val_* field
fn parse_key_value(b: &[u8]) -> Val {
    let mut p = 0usize;
    let mut out = Val::None;
    while p < b.len() {
        let tag = varint(b, &mut p);
        let (field, wt) = (tag >> 3, tag & 7);
        match (field, wt) {
            (1, 0) => {
                varint(b, &mut p);
            } // type
            (2, 2) => {
                let s = skip_field(b, &mut p, 2).unwrap_or(&[]);
                out = Val::Str(String::from_utf8_lossy(s).to_string());
            }
            (3, 5) => {
                let f = f32::from_le_bytes(b[p..p + 4].try_into().unwrap());
                p += 4;
                out = Val::F32(f);
            }
            (4, 0) | (5, 0) | (6, 0) | (8, 0) => {
                out = Val::I64(varint(b, &mut p) as i64);
            }
            (7, 0) => {
                out = Val::Bool(varint(b, &mut p) != 0);
            }
            _ => {
                skip_field(b, &mut p, wt);
            }
        }
    }
    out
}

// CS:GO player_info_t (big-endian integers):
//   u64 version | u64 xuid | char name[128] | int32 userID | char guid[33] | ...
// name at offset 16, userID (BE int32) at offset 144.
fn parse_player_info(b: &[u8]) -> Option<(i64, String)> {
    if b.len() < 148 {
        return None;
    }
    let name_end = b[16..144].iter().position(|&c| c == 0).unwrap_or(128);
    let name = String::from_utf8_lossy(&b[16..16 + name_end]).to_string();
    let userid = i32::from_be_bytes(b[144..148].try_into().unwrap()) as i64;
    Some((userid, name))
}

/// The player's real SteamID64 (xuid, big-endian u64 at offset 8). userids are per-server and
/// meaningless across demos — this is the only identity that works library-wide, so it's what
/// search / "only my highlights" should key on.
fn parse_player_xuid(b: &[u8]) -> Option<u64> {
    if b.len() < 16 {
        return None;
    }
    let x = u64::from_be_bytes(b[8..16].try_into().unwrap());
    // sanity: real individual accounts start at 7656119...
    if x > 76561197960265728 {
        Some(x)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
struct Highlight {
    player: String,
    n: usize,
    score: i32,
    weapons: Vec<String>,
    hs: usize,
    demo: String,
}

// group a demo's kills into per-round multikills, resolve names, drop warmup
fn demo_highlights(p: &Parser, demo: &str) -> Vec<Highlight> {
    // full mode: use the ported classify (tags + difficulty scoring)
    if p.full {
        // the CLI ranking uses the cssff .ini if one sits next to the binary/cwd, else defaults
        let cfg = cssff::Cfg::load("cssff_settings.ini")
            .or_else(|| cssff::Cfg::load("vendor/cssff/cssff_settings.ini"));
        let mut hls = classify::classify(&p.kills, p.tickrate, cfg.as_ref());
        if let Some(mv) = &p.movement {
            let slot_uid: HashMap<i32, i64> = p.slot_uid.clone();
            hls.extend(classify::movement_highlights(
                &mv.runs_out,
                &mv.tricks,
                &p.kills,
                &slot_uid,
                p.tickrate,
            ));
        }
        return hls
            .into_iter()
            .map(|h| {
                let name = p
                    .names
                    .get(&h.uid)
                    .cloned()
                    .unwrap_or_else(|| format!("uid {}", h.uid));
                let mut weapons = h.weapons;
                for t in &h.tags {
                    if !matches!(t.as_str(), "ace" | "quad" | "triple") {
                        weapons.push(format!("+{t}"));
                    }
                }
                Highlight {
                    player: name,
                    n: h.n,
                    score: h.score,
                    weapons,
                    hs: h.hs,
                    demo: demo.to_string(),
                }
            })
            .collect();
    }
    let mut groups: HashMap<(i32, i64), Vec<&Kill>> = HashMap::new();
    for k in &p.kills {
        groups.entry((k.round, k.attacker)).or_default().push(k);
    }
    let mut out = Vec::new();
    for ((_r, uid), g) in groups {
        let n = g.len();
        // a real round caps at 5 kills; >5 in one "round" == deathmatch warmup, skip it
        if n > 5 {
            continue;
        }
        let name = p
            .names
            .get(&uid)
            .cloned()
            .unwrap_or_else(|| format!("uid {uid}"));
        let mut score = match n {
            0 | 1 => 8,
            2 => 22,
            3 => 45,
            4 => 70,
            _ => 100,
        };
        let mut hs = 0;
        let mut weps: Vec<String> = Vec::new();
        let mut tags: Vec<&str> = Vec::new();
        for k in &g {
            if k.headshot {
                score += 4;
                hs += 1;
            }
            // per-kill difficulty (full mode: telemetry is populated)
            if k.airborne {
                score += 30; // airshot — killing while airborne is hard
                if !tags.contains(&"airshot") {
                    tags.push("airshot");
                }
            }
            if k.flick >= 40 {
                score += (k.flick / 3).min(30); // fast flick
                if k.flick >= 90 && !tags.contains(&"flick") {
                    tags.push("flick");
                }
            }
            if k.dist >= 1800 {
                score += ((k.dist - 1800) / 120).min(20); // long range
                if k.dist >= 2600 && !tags.contains(&"long") {
                    tags.push("long");
                }
            }
            if k.noscope {
                score += 25;
                if !tags.contains(&"noscope") {
                    tags.push("noscope");
                }
            }
            if k.penetrated > 0 {
                score += 15;
                if !tags.contains(&"wallbang") {
                    tags.push("wallbang");
                }
            }
            if !k.weapon.is_empty() && !weps.contains(&k.weapon) {
                weps.push(k.weapon.clone());
            }
        }
        for t in tags {
            weps.push(format!("+{t}"));
        }
        out.push(Highlight {
            player: name,
            n,
            score,
            weapons: weps,
            hs,
            demo: demo.to_string(),
        });
    }
    out
}

// convert CS2 kills to ranked highlights (group by round+attacker)
#[cfg(feature = "cs2")]
fn cs2_highlights(r: &cs2::Cs2Result, demo: &str) -> Vec<Highlight> {
    let mut groups: HashMap<(i32, String), (usize, usize, Vec<String>)> = HashMap::new();
    for k in &r.kills {
        let e = groups.entry((k.round, k.attacker.clone())).or_default();
        e.0 += 1;
        if k.headshot {
            e.1 += 1;
        }
        if !k.weapon.is_empty() && !e.2.contains(&k.weapon) {
            e.2.push(k.weapon.clone());
        }
    }
    groups
        .into_iter()
        .filter(|(_, (n, _, _))| *n <= 5)
        .map(|((_, player), (n, hs, weapons))| {
            let mut score = match n {
                0 | 1 => 8,
                2 => 22,
                3 => 45,
                4 => 70,
                _ => 100,
            };
            score += hs as i32 * 4;
            Highlight {
                player,
                n,
                score,
                weapons,
                hs,
                demo: format!("{demo} [CS2]"),
            }
        })
        .collect()
}

// convert CS:S frags to ranked highlights
fn css_highlights(r: &css::CssResult, demo: &str) -> Vec<Highlight> {
    r.frags
        .iter()
        .map(|f| {
            let mut score = match f.kills {
                0 | 1 => 8,
                2 => 22,
                3 => 45,
                4 => 70,
                _ => 100,
            };
            score += f.hs as i32 * 4;
            Highlight {
                player: f.player.clone(),
                n: f.kills,
                score,
                weapons: f.weapons.clone(),
                hs: f.hs,
                demo: format!("{demo} [CS:S]"),
            }
        })
        .collect()
}

fn parse_one(data: &[u8], debug: bool, full: bool) -> Option<Parser> {
    if data.len() < 1072 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let mut p = Parser::new(debug, full);
    p.run(data);
    p.finish();
    if debug {
        if let Some(w) = &p.world {
            eprintln!(
                "  [debug] entity: classBits={} packets={} enterPVS={} playerEnter={} hasPos={} desync={}",
                w.class_bits(),
                w.n_packets,
                w.n_enter,
                w.n_player_enter,
                w.n_haspos,
                w.n_desync
            );
        }
        eprintln!("  [debug] timeline frames: {}", p.timeline.len());
        if let Some(m) = &p.movement {
            use std::collections::BTreeMap;
            let mut kinds: BTreeMap<&str, u32> = BTreeMap::new();
            for t in &m.tricks {
                *kinds.entry(t.kind).or_insert(0) += 1;
            }
            eprintln!(
                "  [debug] tickrate={} movementRuns={} tricks={} {:?}",
                p.tickrate,
                m.runs_out.len(),
                m.tricks.len(),
                kinds
            );
        }
        if let Some(f) = p.timeline.iter().find(|f| f.players.len() >= 6) {
            eprintln!(
                "  [debug] sample frame tick={} players={}",
                f.t,
                f.players.len()
            );
            for (slot, st) in f.players.iter().take(6) {
                eprintln!(
                    "      slot {slot:>3}  pos=({:>9.1},{:>9.1},{:>7.1})  yaw={:>6.1} team={} alive={}",
                    st.x, st.y, st.z, st.yaw, st.team, st.alive
                );
            }
        }
    }
    Some(p)
}

fn find_demos(root: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(x) => x,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("dem") {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out
}

fn base(p: &str) -> String {
    std::path::PathBuf::from(p)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(feature="app")]

// ---------------------------------------------------------------------------
// Library API (for a Tauri/Rust backend to call in-process instead of shelling out)

/// Analyze one demo file and return ranked highlights as JSON (full = decode positions/movement).
pub fn analyze_demo(path: &str, full: bool) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
    let base = base(path);
    let hls: Vec<Highlight> = if css::looks_like_css(net) {
        css::parse(&data).map(|r| css_highlights(&r, &base)).unwrap_or_default()
    } else {
        parse_one(&data, false, full).map(|p| demo_highlights(&p, &base)).unwrap_or_default()
    };
    #[derive(serde::Serialize)]
    struct HlOut { player: String, kills: usize, hs: usize, score: i32, tags: Vec<String>, demo: String }
    let out: Vec<HlOut> = hls.into_iter().map(|h| HlOut {
        player: h.player, kills: h.n, hs: h.hs, score: h.score, tags: h.weapons, demo: h.demo,
    }).collect();
    serde_json::to_string(&out).ok()
}

/// Full-decode a CS:GO demo → the csgofast-schema raw JSON that classify() consumes.
/// (The Tauri/Electron frontend runs the JS classify on this.)
#[cfg(feature = "app")]
pub fn parse_raw_json(path: &str) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
    if css::looks_like_css(net) {
        return None; // CS:S handled separately
    }
    let mut p = Parser::new(false, true);
    p.run(&data);
    p.finish();
    p.map_name = p.map_name.clone();
    raw::to_json(&p).ok()
}

/// CS:S demo → the css-frags result the renderer expects ({css:true, frags:[…]}).
#[cfg(feature = "app")]
pub fn css_result_json(path: &str) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let r = css::parse(&data)?;
    #[derive(serde::Serialize)]
    struct FragO {
        tick: i32,
        #[serde(rename = "endTick")]
        end_tick: i32,
        player: String,
        team: i32,
        desc: String,
        kills: usize,
        headshots: usize,
        weapon: String,
        round: i32,
    }
    #[derive(serde::Serialize)]
    struct CssO {
        css: bool,
        #[serde(rename = "mapName")]
        map_name: String,
        tickrate: i32,
        players: Vec<u8>,
        frags: Vec<FragO>,
    }
    let frags = r
        .frags
        .iter()
        .map(|f| FragO {
            tick: f.tick,
            end_tick: f.tick + r.tickrate * 4,
            player: f.player.clone(),
            team: f.team,
            desc: f.desc.clone(),
            kills: f.kills,
            headshots: f.hs,
            weapon: f.weapons.join("/"),
            round: 0,
        })
        .collect();
    serde_json::to_string(&CssO {
        css: true,
        map_name: r.map.clone(),
        tickrate: r.tickrate,
        players: vec![],
        frags,
    })
    .ok()
}

/// Classify tag weights as a JSON object {tag: weight} (for the Settings UI).
#[cfg(feature = "app")]
pub fn default_weights_json() -> String {
    let m: std::collections::BTreeMap<&str, i32> = classify::all_tag_weights().into_iter().collect();
    serde_json::to_string(&m).unwrap_or_else(|_| "{}".into())
}

/// Slice the position timeline for a preview: full-decode `path`, return frames in [a,b] as
/// JSON `[{tick, players:[{uid,x,y,yaw,team,z,name}]}]` (CS:GO only; CS:S has no timeline).
#[cfg(feature = "app")]
pub fn demo_frames(path: &str, a: i32, b: i32) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
    if css::looks_like_css(net) {
        return None;
    }
    let p = parse_one(&data, false, true)?; // full decode (positions)
    let slot_uid: std::collections::HashMap<i32, i64> = p.slot_uid.clone();
    #[derive(serde::Serialize)]
    struct Pl {
        uid: i64,
        x: f32,
        y: f32,
        yaw: i32,
        team: i32,
        z: i32,
        name: String,
    }
    #[derive(serde::Serialize)]
    struct Fr {
        tick: i32,
        players: Vec<Pl>,
    }
    let frames: Vec<Fr> = p
        .timeline
        .iter()
        .filter(|f| f.t >= a && f.t <= b)
        .map(|f| Fr {
            tick: f.t,
            players: f
                .players
                .iter()
                .filter_map(|(slot, st)| {
                    slot_uid.get(slot).map(|&uid| Pl {
                        uid,
                        x: (st.x * 10.0).round() / 10.0,
                        y: (st.y * 10.0).round() / 10.0,
                        yaw: st.yaw.round() as i32,
                        team: st.team,
                        z: st.z.round() as i32,
                        name: p.names.get(&uid).cloned().unwrap_or_default(),
                    })
                })
                .collect(),
        })
        .collect();
    serde_json::to_string(&frames).ok()
}

/// Export a demo (or a slice of one) to .glb for Blender / UE4-5.
///
/// * `from_tick`/`to_tick` — clip window; pass `None` for the whole demo. This is what makes
///   the file usable: a full match is thousands of keyframes, a 6-second clip is a handful.
/// * `bsp` — include the map mesh stripped out of the .bsp. Omit to export motion only
///   (what you want when importing the map separately, e.g. with Plumber).
/// * `only_uids` — restrict to specific players (empty = everyone in the window).
#[cfg(feature = "export3d")]
struct KillRef { attacker: i64 }

#[cfg(feature = "export3d")]
pub fn export_gltf_clip(
    demo: &str,
    out: &str,
    bsp: Option<&str>,
    from_tick: Option<i32>,
    to_tick: Option<i32>,
    only_uids: &[i64],
    want_players: bool,
    want_kills: bool,
    game_dir: Option<&str>,
) -> Option<()> {
    let data = std::fs::read(demo).ok()?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let p = parse_one(&data, false, true)?;
    let lo = from_tick.unwrap_or(i32::MIN);
    let hi = to_tick.unwrap_or(i32::MAX);
    let keep = |uid: i64| only_uids.is_empty() || only_uids.contains(&uid);

    let frames: Vec<(i32, Vec<(i64, f32, f32, f32, f32, i32)>)> = if want_players {
        p.timeline
            .iter()
            .filter(|f| f.t >= lo && f.t <= hi)
            .map(|f| {
                let v = f
                    .players
                    .iter()
                    .filter_map(|(slot, st)| {
                        p.slot_uid.get(slot).filter(|&&u| keep(u)).map(|&uid| {
                            (uid, st.x, st.y, st.z, st.yaw, st.team)
                        })
                    })
                    .collect();
                (f.t, v)
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut tracks = export::tracks_from_timeline(&frames, &p.names, p.tickrate);

    // Attach the real CT/T character models when a game folder is available, so players come
    // out as actual soldiers instead of proxy boxes. One mesh per team, shared by every player.
    let mut models: Vec<(mdl::Mesh, Option<Vec<u8>>)> = Vec::new();
    if let Some(gd) = game_dir {
        let packs = vpk::open_game_dir(gd);
        if !packs.is_empty() {
            // first model that actually loads for each side
            // CS:GO renamed the convention (ctm_*/tm_*) and moved the legacy T models into
            // custom_player/legacy/. Try CS:GO names first, then CS:S (ct_*/t_*), so one
            // gameDir setting works for either engine generation.
            let ct = [
                "models/player/ctm_st6", "models/player/ctm_gign", "models/player/ctm_sas",
                "models/player/ctm_fbi", "models/player/custom_player/legacy/ctm_st6",
                "models/player/ct_urban", "models/player/ct_gign", "models/player/ct_sas",
            ];
            // NOTE: custom_player/legacy/* models are authored LYING DOWN (~0.3 m tall) — they
            // are skin references, not stand-alone characters. Keep them out of the list; the
            // upright check below is the backstop.
            let t = [
                "models/player/tm_phoenix", "models/player/tm_anarchist",
                "models/player/tm_professional", "models/player/tm_leet",
                "models/player/t_phoenix", "models/player/t_leet", "models/player/t_guerilla",
            ];
            let mut load = |cands: &[&str]| -> Option<usize> {
                for c in cands {
                    // `continue`, not `?`: a missing candidate must fall through to the next
                    // name, otherwise one absent model aborted the entire search.
                    let Some(vvd) = vpk::read_any(&packs, &format!("{c}.vvd")) else { continue };
                    let vtx = vpk::read_any(&packs, &format!("{c}.dx90.vtx"))
                        .or_else(|| vpk::read_any(&packs, &format!("{c}.dx80.vtx")))
                        .or_else(|| vpk::read_any(&packs, &format!("{c}.vtx")));
                    let mdlb = vpk::read_any(&packs, &format!("{c}.mdl"));
                    let built = match (&mdlb, &vtx) {
                        (Some(mb), Some(v)) => mdl::mesh_from_mdl(mb, &vvd, v),
                        (None, Some(v)) => mdl::mesh_from(&vvd, v),
                        _ => None,
                    };
                    // A character should be taller than it is deep. Some models (the legacy
                    // skin references) are authored flat; skipping them here means one bad
                    // candidate can never become the team's model.
                    let upright = built.as_ref().map(|m: &mdl::Mesh| {
                        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
                        for v in &m.pos {
                            for k in 0..3 {
                                lo[k] = lo[k].min(v[k]);
                                hi[k] = hi[k].max(v[k]);
                            }
                        }
                        (hi[2] - lo[2]) > 40.0 // Source units: a standing player is ~72
                    }).unwrap_or(false);
                    if !upright {
                        continue;
                    }
                    if let (Some(mesh), Some(_)) = (built, vtx) {
                        let png = model_texture_png(&packs, c);
                        models.push((mesh, png));
                        return Some(models.len() - 1);
                    }
                }
                None
            };
            let ct_i = load(&ct);
            let t_i = load(&t);
            for tr in tracks.iter_mut() {
                tr.model = if tr.team == 3 { ct_i } else if tr.team == 2 { t_i } else { None };
            }
        }
    }

    let name_of = |uid: i64| p.names.get(&uid).cloned().unwrap_or_else(|| format!("uid{uid}"));
    let mut markers = Vec::new();
    if want_kills {
        if let Some(mv) = &p.movement {
            for k in p.kills.iter().filter(|k| k.tick >= lo && k.tick <= hi) {
                if !only_uids.is_empty() && !keep(k.attacker) && !keep(k.victim) {
                    continue;
                }
                if let Some(&vslot) = p.uid_slot.get(&k.victim) {
                    if let Some((x, y, z)) = mv.pos_at(vslot, k.tick) {
                        markers.push(export::marker(
                            &format!("kill_{}_{}_{}", name_of(k.attacker), name_of(k.victim), k.tick),
                            k.tick, p.tickrate, x, y, z,
                        ));
                    }
                }
            }
        }
    }

    // --- map geometry ---------------------------------------------------------
    // With a game folder we can texture the map: map_geo_textured gives per-material surfaces
    // WITH uvs, and each material resolves through VMT -> VTF -> PNG exactly like a model.
    // Without one we fall back to the untextured CCG1 triangle soup.
    let mut map_surfs: Vec<(mdl::Mesh, Option<Vec<u8>>)> = Vec::new();
    let mut tris: Option<Vec<[f32; 3]>> = None;
    if let Some(bsp_path) = bsp {
        let surfs = if game_dir.is_some() { bspgeo::map_geo_textured(bsp_path) } else { Vec::new() };
        if let (Some(gd), false) = (game_dir, surfs.is_empty()) {
            let packs = vpk::open_game_dir(gd);
            let mut budget = 700_000usize;
            for sf in surfs {
                let t = sf.idx.len() / 3;
                if t > budget {
                    continue;
                }
                budget -= t;
                let png = vpk::read_any(&packs, &format!("materials/{}.vmt", sf.material))
                    .and_then(|d| vmt::base_texture(&String::from_utf8_lossy(&d)))
                    .and_then(|mut tex| {
                        if tex.ends_with(".vmt") {
                            let d = vpk::read_any(&packs, &tex)?;
                            tex = vmt::base_texture(&String::from_utf8_lossy(&d))?;
                        }
                        let v = vpk::read_any(&packs, &format!("materials/{tex}.vtf"))?;
                        let (w, h, rgba) = vtf::decode_max(&v, 512)?;
                        let tmp = std::env::temp_dir().join("dr_map_tex.png");
                        vtf::write_png(w, h, &rgba, &tmp.to_string_lossy()).ok()?;
                        std::fs::read(tmp).ok()
                    });
                let n = sf.pos.len();
                map_surfs.push((
                    mdl::Mesh { pos: sf.pos, norm: vec![[0.0, 0.0, 1.0]; n], uv: sf.uv, idx: sf.idx },
                    png,
                ));
            }
        } else {
            tris = bspgeo::map_geo(bsp_path).map(|blob| {
                const HDR: usize = 64;
                let n = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
                let mut o = Vec::with_capacity(n * 3);
                for i in 0..n {
                    let bb = HDR + i * 18;
                    if bb + 18 > blob.len() {
                        break;
                    }
                    for v in 0..3 {
                        let q = bb + v * 6;
                        let g = |k: usize| i16::from_le_bytes(blob[q + k..q + k + 2].try_into().unwrap()) as f32;
                        o.push([g(0), g(2), g(4)]);
                    }
                }
                o
            });
        }
    }

    // --- static props: the crates/railings/lights that make a map look like a map ---------
    // 6,891 props on a map like nuke is far too much for a clip, so we keep only those near
    // the action, then BAKE each instance into world space and merge per model. Baking avoids
    // per-instance transforms (and the Source-angle -> glTF quaternion conversion that goes
    // with them) while still sharing one texture per model.
    let mut props: Vec<(mdl::Mesh, Option<Vec<u8>>)> = Vec::new();
    let mut weapon_slots: Vec<usize> = Vec::new(); // which props entries are weapons
    if let (Some(bsp_path), Some(gd)) = (bsp, game_dir) {
        // where the action is
        let mut c = [0f32; 3];
        let mut n = 0f32;
        for f in &frames {
            for (_, x, y, z, _, _) in &f.1 {
                c[0] += x; c[1] += y; c[2] += z; n += 1.0;
            }
        }
        if n > 0.0 {
            c = [c[0] / n, c[1] / n, c[2] / n];
            let radius = 2200.0f32; // ~40m around the play
            let placed = bspgeo::map_props(bsp_path);
            let mut by_model: HashMap<String, Vec<&bspgeo::PropInst>> = HashMap::new();
            for p in &placed {
                let d = ((p.origin[0] - c[0]).powi(2) + (p.origin[1] - c[1]).powi(2)).sqrt();
                if d <= radius {
                    by_model.entry(p.model.clone()).or_default().push(p);
                }
            }
            let packs = vpk::open_game_dir(gd);
            // most-used models first, capped so a clip never explodes in size
            let mut groups: Vec<(String, Vec<&bspgeo::PropInst>)> = by_model.into_iter().collect();
            groups.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
            let mut budget_tris = 300_000usize;
            for (model, insts) in groups.into_iter().take(400) {
                let base = model.trim_end_matches(".mdl").to_string();
                let Some(vvd) = vpk::read_any(&packs, &format!("{base}.vvd")) else { continue };
                let vtx = vpk::read_any(&packs, &format!("{base}.dx90.vtx"))
                    .or_else(|| vpk::read_any(&packs, &format!("{base}.dx80.vtx")))
                    .or_else(|| vpk::read_any(&packs, &format!("{base}.vtx")));
                let mdlb = vpk::read_any(&packs, &format!("{base}.mdl"));
                let Some(src) = vtx.as_ref().and_then(|v| match &mdlb {
                    Some(mb) => mdl::mesh_from_mdl(mb, &vvd, v),
                    None => mdl::mesh_from(&vvd, v),
                }) else { continue };
                let cost = (src.idx.len() / 3) * insts.len();
                if cost > budget_tris {
                    continue;
                }
                budget_tris -= cost;
                let png = model_texture_png_max(&packs, &base, 256);
                let mut merged = mdl::Mesh::default();
                for inst in insts {
                    // Full QAngle(pitch, yaw, roll) — Source order is Rz(yaw)*Ry(pitch)*Rx(roll).
                    // Yaw-only was fine for crates but left tilted pipes and angled signs upright.
                    let (p_, y_, r_) = (
                        inst.angles[0].to_radians(),
                        inst.angles[1].to_radians(),
                        inst.angles[2].to_radians(),
                    );
                    let (sp, cp) = p_.sin_cos();
                    let (sy, cy) = y_.sin_cos();
                    let (sr, cr) = r_.sin_cos();
                    let m = [
                        [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
                        [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
                        [-sp, sr * cp, cr * cp],
                    ];
                    let rot = |v: &[f32; 3]| {
                        [
                            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
                            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
                            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
                        ]
                    };
                    let off = merged.pos.len() as u32;
                    for v in &src.pos {
                        let w = rot(v);
                        merged.pos.push([
                            inst.origin[0] + w[0],
                            inst.origin[1] + w[1],
                            inst.origin[2] + w[2],
                        ]);
                    }
                    for v in &src.norm {
                        merged.norm.push(rot(v));
                    }
                    merged.uv.extend_from_slice(&src.uv);
                    merged.idx.extend(src.idx.iter().map(|i| i + off));
                }
                props.push((merged, png));
            }
        }
    }

    // --- weapon models --------------------------------------------------------
    // One mesh per distinct weapon used in the clip, attached to whoever used it. The world
    // model path is found by searching the pack (w_rif_ak47, w_snip_awp, …) rather than
    // hard-coding a table, so it works across games.
    let mut weapon_idx: HashMap<i64, usize> = HashMap::new();
    if let Some(gd) = game_dir {
        let packs = vpk::open_game_dir(gd);
        if !packs.is_empty() {
            let mut cache: HashMap<String, Option<usize>> = HashMap::new();
            // Every player carries something, not just whoever got a kill in this window:
            // prefer a weapon they actually used in the clip, then anywhere in the demo, then
            // the team default. Otherwise 9 of 10 players export empty-handed.
            let mut want: Vec<(i64, String)> = Vec::new();
            for k in p.kills.iter().filter(|k| k.tick >= lo && k.tick <= hi) {
                want.push((k.attacker, k.weapon.trim_start_matches("weapon_").to_lowercase()));
            }
            for k in &p.kills {
                if !want.iter().any(|(u, _)| *u == k.attacker) {
                    want.push((k.attacker, k.weapon.trim_start_matches("weapon_").to_lowercase()));
                }
            }
            for (&slot, &uid) in p.slot_uid.iter() {
                let _ = slot;
                if !want.iter().any(|(u, _)| *u == uid) {
                    let team = p.kills.iter().find(|k| k.attacker == uid).map(|k| k.attacker_team).unwrap_or(0);
                    want.push((uid, if team == 3 { "m4a1".into() } else { "ak47".into() }));
                }
            }
            for (attacker, w) in want {
                if w.is_empty() {
                    continue;
                }
                let k = KillRef { attacker };
                let slot = *cache.entry(w.clone()).or_insert_with(|| {
                    // any models/weapons/w_*<name>.mdl
                    let hit = packs.iter().find_map(|pk| {
                        pk.find(&format!("w_"), Some(".mdl"))
                            .into_iter()
                            .find(|f| f.starts_with("models/weapons/w_") && f.ends_with(&format!("{w}.mdl")))
                    })?;
                    let base = hit.trim_end_matches(".mdl").to_string();
                    let vvd = vpk::read_any(&packs, &format!("{base}.vvd"))?;
                    let vtx = vpk::read_any(&packs, &format!("{base}.dx90.vtx"))
                        .or_else(|| vpk::read_any(&packs, &format!("{base}.dx80.vtx")))
                        .or_else(|| vpk::read_any(&packs, &format!("{base}.vtx")))?;
                    let mdlb = vpk::read_any(&packs, &format!("{base}.mdl"));
                    let mesh = match &mdlb {
                        Some(mb) => mdl::mesh_from_mdl(mb, &vvd, &vtx)?,
                        None => mdl::mesh_from(&vvd, &vtx)?,
                    };
                    let png = model_texture_png_max(&packs, &base, 512);
                    props.push((mesh, png));
                    weapon_slots.push(props.len() - 1);
                    Some(props.len() - 1)
                });
                if let Some(si) = slot {
                    weapon_idx.insert(k.attacker, si);
                }
            }
        }
    }
    for t in tracks.iter_mut() {
        // tracks are keyed by name; match back to a uid through the name map
        if let Some((uid, _)) = p.names.iter().find(|(_, n)| **n == t.name) {
            if let Some(&wi) = weapon_idx.get(uid) {
                t.weapon = Some(wi);
            }
        }
        // name lookup can miss (duplicate/renamed players) — never leave someone empty-handed
        if t.weapon.is_none() {
            t.weapon = weapon_slots.first().copied();
        }
    }

    // map surfaces come first, so weapon indices (into `props`) shift by that many
    let base = map_surfs.len();
    let is_weapon: Vec<usize> = weapon_slots.iter().map(|i| i + base).collect();
    for t in tracks.iter_mut() {
        if let Some(w) = t.weapon {
            t.weapon = Some(w + base);
        }
    }
    let mut statics = map_surfs;
    statics.extend(props);
    let light = bsp.and_then(bspgeo::map_light);
    export::write_glb(&tracks, &markers, tris.as_deref(), &models, &statics, &is_weapon, light, out).ok()
}

/// Whole-demo export (kept for the CLI).
#[cfg(feature = "export3d")]
pub fn export_gltf(demo: &str, out: &str, bsp: Option<&str>) -> Option<()> {
    export_gltf_clip(demo, out, bsp, None, None, &[], true, true, None)
}

/// material name (from the .mdl) -> .vmt -> $basetexture -> .vtf -> PNG bytes.
/// This is the link that makes a model come out textured instead of grey.
#[allow(clippy::manual_strip)]
#[cfg(feature = "assets")]
pub fn model_texture_png(packs: &[vpk::Vpk], mdl_base: &str) -> Option<Vec<u8>> {
    model_texture_png_max(packs, mdl_base, 1024)
}

/// Same, but capped to `max_dim` — props use a smaller cap so a clip doesn't balloon.
#[cfg(feature = "assets")]
pub fn model_texture_png_max(packs: &[vpk::Vpk], mdl_base: &str, max_dim: usize) -> Option<Vec<u8>> {
    let mdl = vpk::read_any(packs, &format!("{mdl_base}.mdl"))?;
    let (names, dirs) = vmt::mdl_materials(&mdl);
    let name = names.first()?.clone();
    // try each cdmaterials dir the model declares, then the model's own folder
    let mut cands: Vec<String> = dirs
        .iter()
        .map(|d| format!("materials/{}{}.vmt", d.trim_end_matches('/').to_string() + "/", name))
        .collect();
    cands.push(format!("materials/{name}.vmt"));
    let mut text = None;
    for c in &cands {
        if let Some(d) = vpk::read_any(packs, c) {
            text = Some(String::from_utf8_lossy(&d).to_string());
            break;
        }
    }
    let mut tex = vmt::base_texture(&text?)?;
    // a `patch` vmt just points at another vmt — follow it once
    if tex.ends_with(".vmt") {
        let d = vpk::read_any(packs, &tex)?;
        tex = vmt::base_texture(&String::from_utf8_lossy(&d))?;
    }
    let vtf = vpk::read_any(packs, &format!("materials/{tex}.vtf"))?;
    let (w, h, rgba) = vtf::decode_max(&vtf, max_dim)?;
    let tmp = std::env::temp_dir().join(format!("dr_tex_{:x}.png", mdl_base.len() * 2654435761 % 0xffff_ffff));
    vtf::write_png(w, h, &rgba, &tmp.to_string_lossy()).ok()?;
    std::fs::read(tmp).ok()
}

/// Classify a demo entirely in Rust and emit the exact highlight schema the renderer draws.
/// This replaces the JavaScript classify pass: same rulebook (cssff .ini), same scoring, but
/// no 66 KB of JS re-deriving what the parser already knows.
#[cfg(feature = "app")]
pub fn classify_demo_json(path: &str, ini_text: Option<&str>) -> Option<String> {
    use serde_json::json;
    let data = std::fs::read(path).ok()?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let p = parse_one(&data, false, true)?;
    let cfg = ini_text.map(cssff::Cfg::parse);
    let mut hls = classify::classify(&p.kills, p.tickrate, cfg.as_ref());
    if let Some(mv) = &p.movement {
        hls.extend(classify::movement_highlights(
            &mv.runs_out, &mv.tricks, &p.kills, &p.slot_uid, p.tickrate,
        ));
    }
    let tr = p.tickrate.max(1);
    let preroll = tr; // 1s of lead-in, same default the JS used
    let name_of = |uid: i64| p.names.get(&uid).cloned().unwrap_or_else(|| format!("uid{uid}"));
    let sid_of = |uid: i64| match p.xuids.get(&uid) {
        Some(x) => x.to_string(),
        None => format!("uid{uid}"),
    };
    let team_of = |uid: i64| p.kills.iter().find(|k| k.attacker == uid).map(|k| k.attacker_team).unwrap_or(0);

    let mut out = Vec::new();
    for h in &hls {
        // rebuild the kill objects this highlight covers
        let mut kills = Vec::new();
        for t in &h.kill_ticks {
            if let Some(k) = p.kills.iter().find(|k| k.tick == *t && k.attacker == h.uid) {
                let vt = if k.attacker_team == 2 { 3 } else { 2 };
                kills.push(json!({
                    "killTick": k.tick, "weapon": k.weapon, "headshot": k.headshot,
                    "penetrated": k.penetrated, "noscope": k.noscope, "smoke": k.smoke,
                    "blind": k.blind, "round": k.round,
                    "distM": if k.dist_m > 0 { json!(k.dist_m) } else { json!(null) },
                    "hitChance": (k.hit_chance * 1000.0).round() / 1000.0,
                    "shotsBeforeKill": k.shots_before_kill,
                    "nearbyEnemies": k.nearby,
                    "victim": { "name": name_of(k.victim), "steamId": sid_of(k.victim), "uid": k.victim, "team": vt },
                    "telemetry": {
                        "airborneAtKill": k.airborne, "speedAtKill": k.spd, "vzAtKill": k.vz,
                        "flickDeg": k.flick, "maxYawRate": k.spin
                    }
                }));
            }
        }
        let first = h.kill_ticks.iter().copied().min().unwrap_or(h.start_tick);
        let last = h.kill_ticks.iter().copied().max().unwrap_or(h.start_tick);
        let is_mv = h.kind == "movement";
        let watch = if is_mv { (h.start_tick - preroll).max(0) } else { (first - preroll).max(0) };
        let end = if is_mv { last.max(h.start_tick) + tr * 3 } else { last + tr * 3 };
        let movement = h.mv.as_ref().map(|m| json!({
            "maxSpeed": m.max_speed, "avgSpeed": m.avg_speed, "jumps": m.jumps,
            "airPct": m.air_pct, "distUnits": m.dist_units,
            "durSec": (m.dur_sec * 10.0).round() / 10.0,
            "fallVel": m.fall_vel, "killAfter": m.kill_after
        }));
        out.push(json!({
            "type": if is_mv { "movement" } else { "kill" },
            "attacker": { "name": name_of(h.uid), "steamId": sid_of(h.uid), "uid": h.uid, "team": team_of(h.uid) },
            "kills": kills,
            "tags": h.tags,
            "coolScore": h.score,
            "clutchX": if h.clutch_x > 0 { json!(h.clutch_x) } else { json!(null) },
            "round": h.round,
            "watchTick": watch,
            "killTick": if is_mv { h.start_tick } else { first },
            "endTick": end,
            "tickrate": tr,
            "movement": movement,
            "preview": serde_json::Value::Null,
        }));
    }
    // best first, then earliest — the order the grid renders in
    out.sort_by(|a, b| {
        let sa = a["coolScore"].as_i64().unwrap_or(0);
        let sb = b["coolScore"].as_i64().unwrap_or(0);
        sb.cmp(&sa).then(a["watchTick"].as_i64().unwrap_or(0).cmp(&b["watchTick"].as_i64().unwrap_or(0)))
    });
    serde_json::to_string(&json!({
        "mapName": p.map_name, "tickrate": tr, "highlights": out,
        "score": { "rounds": p.round_ticks.len().max(1) },
    })).ok()
}

pub fn run_cli() {
    let raw: Vec<String> = env::args().skip(1).collect();
    #[cfg(feature = "assets")]
    {
    // `--vtf <gamedir> <materials/...vtf> <out.png>`: decode a game texture to PNG
    if raw.len() == 4 && raw[0] == "--vtf" {
        let packs = vpk::open_game_dir(&raw[1]);
        match vpk::read_any(&packs, &raw[2]) {
            Some(d) => match vtf::vtf_to_png(&d, &raw[3]) {
                Some((w, h)) => {
                    eprintln!("vtf: {}x{} -> {}", w, h, raw[3]);
                    println!("OK");
                }
                None => {
                    eprintln!("vtf: decode failed (unsupported format?)");
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("vtf: not found: {}", raw[2]);
                std::process::exit(1);
            }
        }
        return;
    }
    }
    #[cfg(feature = "assets")]
    {
    // `--model <gamedir> <models/...mdl path> <out.glb>`: pull a model out of the VPKs and
    // write it as glTF (LOD0 geometry; materials/textures are a separate job).
    if raw.len() == 4 && raw[0] == "--model" {
        let packs = vpk::open_game_dir(&raw[1]);
        let base = raw[2].trim_end_matches(".mdl").to_string();
        let vvd = vpk::read_any(&packs, &format!("{base}.vvd"));
        let vtx = vpk::read_any(&packs, &format!("{base}.dx90.vtx"))
            .or_else(|| vpk::read_any(&packs, &format!("{base}.dx80.vtx")))
            .or_else(|| vpk::read_any(&packs, &format!("{base}.vtx")));
        match (vvd, vtx) {
            (Some(vvd), Some(vtx)) => match vpk::read_any(&packs, &format!("{base}.mdl"))
                .map(|mb| mdl::mesh_from_mdl(&mb, &vvd, &vtx))
                .unwrap_or_else(|| mdl::mesh_from(&vvd, &vtx))
            {
                Some(m) => {
                    eprintln!("model: {} verts, {} tris", m.pos.len(), m.idx.len() / 3);
                    let png = model_texture_png(&packs, &base);
                    if png.is_none() {
                        eprintln!("model: no texture resolved (exporting untextured)");
                    }
                    match export::write_mesh_glb(&m, &raw[3], png.as_deref()) {
                        Ok(()) => {
                            eprintln!("model: wrote {}", raw[3]);
                            println!("OK");
                        }
                        Err(e) => {
                            eprintln!("model: write failed: {e}");
                            std::process::exit(1);
                        }
                    }
                }
                None => {
                    eprintln!("model: could not build mesh");
                    std::process::exit(1);
                }
            },
            _ => {
                eprintln!("model: missing .vvd or .vtx for {base}");
                std::process::exit(1);
            }
        }
        return;
    }
    }
    // `--classify <demo.dem>`: run the Rust classify and print the renderer schema
    #[cfg(feature = "app")]
    if raw.len() == 2 && raw[0] == "--classify" {
        let ini = std::fs::read_to_string("vendor/cssff/cssff_settings.ini")
            .or_else(|_| std::fs::read_to_string("../../vendor/cssff/cssff_settings.ini"))
            .ok();
        match classify_demo_json(&raw[1], ini.as_deref()) {
            Some(j) => {
                println!("{j}");
            }
            None => {
                eprintln!("classify failed");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(feature = "assets")]
    {
    // `--vpk <game content dir> [substring]`: list what's inside the game's VPK archives
    if raw.len() >= 2 && raw[0] == "--vpk" {
        let packs = vpk::open_game_dir(&raw[1]);
        eprintln!("vpk: {} pack(s) in {}", packs.len(), raw[1]);
        let total: usize = packs.iter().map(|p| p.files.len()).sum();
        eprintln!("vpk: {total} files indexed");
        if let Some(q) = raw.get(2) {
            let mut n = 0;
            for p in &packs {
                for f in p.find(q, None) {
                    println!("{f}");
                    n += 1;
                    if n >= 400 {
                        break;
                    }
                }
                if n >= 400 {
                    break;
                }
            }
            eprintln!("vpk: {n} match(es) shown for {q:?}");
        }
        return;
    }
    }
    #[cfg(feature = "assets")]
    {
    // `--vpk-extract <game dir> <path in pack> <out file>`
    if raw.len() == 4 && raw[0] == "--vpk-extract" {
        let packs = vpk::open_game_dir(&raw[1]);
        match vpk::read_any(&packs, &raw[2]) {
            Some(d) => {
                let _ = std::fs::write(&raw[3], &d);
                eprintln!("vpk: wrote {} ({} bytes)", raw[3], d.len());
                println!("OK");
            }
            None => {
                eprintln!("vpk: not found: {}", raw[2]);
                std::process::exit(1);
            }
        }
        return;
    }
    }
    #[cfg(feature = "export3d")]
    {
    // `--gltf <demo.dem> <out.glb> [map.bsp]`: export motion + kills for Blender / UE
    if (3..=5).contains(&raw.len()) && raw[0] == "--gltf" {
        let bsp = raw.get(3).map(|s| s.as_str()).filter(|s| !s.is_empty());
        let game = raw.get(4).map(|s| s.as_str()); // game content dir -> real player models
        match export_gltf_clip(&raw[1], &raw[2], bsp, None, None, &[], true, true, game) {
            Some(()) => {
                eprintln!("gltf: wrote {}", raw[2]);
                println!("OK");
            }
            None => {
                eprintln!("gltf: export failed");
                std::process::exit(1);
            }
        }
        return;
    }
    }
    #[cfg(feature = "bsp")]
    {
    // `--geo <map.bsp> <out.bin>`: strip 3D geometry (bspgeo) and write the CCG1 blob.
    #[cfg(feature = "bsp")]
    {
    // `--props <map.bsp>`: list the static props a map places
    if raw.len() == 2 && raw[0] == "--props" {
        let props = bspgeo::map_props(&raw[1]);
        let mut uniq: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for p in &props {
            *uniq.entry(p.model.as_str()).or_insert(0) += 1;
        }
        eprintln!("props: {} placed, {} unique models", props.len(), uniq.len());
        let mut v: Vec<_> = uniq.into_iter().collect();
        v.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        for (m, c) in v.into_iter().take(15) {
            println!("{c:5}  {m}")    }
;
        }
        return;
    }
    }
    #[cfg(feature = "bsp")]
    {
    if raw.len() == 3 && raw[0] == "--geo" {
        match bspgeo::map_geo(&raw[1]) {
            Some(blob) => {
                let tri = u32::from_le_bytes(blob[4..8].try_into().unwrap());
                let b: Vec<f32> = (0..6)
                    .map(|i| f32::from_le_bytes(blob[8 + i * 4..12 + i * 4].try_into().unwrap()))
                    .collect();
                let _ = std::fs::write(&raw[2], &blob);
                eprintln!(
                    "geo: tris={tri} bounds=[{:.0},{:.0},{:.0} .. {:.0},{:.0},{:.0}] bytes={}",
                    b[0], b[1], b[2], b[3], b[4], b[5], blob.len()
                );
                println!("OK");
            }
            None => {
                eprintln!("geo: failed (not VBSP / no geometry / .bz2 unsupported)");
                std::process::exit(1);
            }
        }
        return;
    }
    }
    let full = raw.iter().any(|a| a == "--full") || env::var("CDH_FULL").is_ok();
    let args: Vec<String> = raw.into_iter().filter(|a| a != "--full").collect();
    // csgofast-compatible drop-in: `csgo-rs <demo.dem> <out.json.gz>` writes the raw JSON the
    // Electron app's classify() consumes. CS:GO only; non-CS:GO exits non-zero so the app
    // falls back to its cssfast/cssff path.
    #[cfg(feature = "app")]
    {
        let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
        if pos.len() == 2 && (pos[1].ends_with(".gz") || pos[1].ends_with(".json")) {
            let data = std::fs::read(pos[0]).unwrap_or_default();
            let is_csgo = data.len() >= 16
                && &data[..7] == b"HL2DEMO"
                && !css::looks_like_css(i32::from_le_bytes(data[12..16].try_into().unwrap()));
            if !is_csgo {
                std::process::exit(3); // let the app handle CS:S / CS2
            }
            let mut p = Parser::new(false, true);
            p.run(&data);
            p.finish();
            match raw::emit(&p, pos[1]) {
                Ok(()) => {
                    eprintln!("P 1.000");
                    println!("OK");
                    return;
                }
                Err(e) => {
                    eprintln!("emit: {e}");
                    std::process::exit(1);
                }
            }
        }
    }

    let path = args.join(" ");
    let path = path.trim().trim_matches('"').to_string();
    if path.is_empty() {
        eprintln!("usage: csgo-rs <demo.dem | folder> [--full]");
        std::process::exit(2);
    }
    let debug = env::var("CDH_DEBUG").is_ok();

    let md = std::fs::metadata(&path);
    let demos = if md.map(|m| m.is_dir()).unwrap_or(false) {
        find_demos(&path)
    } else {
        vec![path.clone()]
    };
    if demos.is_empty() {
        eprintln!("no .dem files found");
        std::process::exit(1);
    }

    println!("\n  CS:GO Demo Highlights — Source-1 (Rust)\n");
    let mut all: Vec<Highlight> = Vec::new();
    let mut total_kills = 0usize;
    let single = demos.len() == 1;
    // cache the tuned CS:S layout per netProto so we tune once, not per demo
    let mut css_cache: HashMap<i32, css::Layout> = HashMap::new();
    for (i, d) in demos.iter().enumerate() {
        if !single {
            print!("\r  [{}/{}] {:<44.44}", i + 1, demos.len(), base(d));
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
        // route by engine: CS:S (Source-1, low netProto) vs CS:GO (protobuf)
        match std::fs::read(d) {
            Ok(data) if data.len() >= 16 && &data[..7] == b"HL2DEMO" => {
                let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
                if css::looks_like_css(net) {
                    let hint = css_cache.get(&net).copied();
                    if let Some((r, lay)) = css::parse_hinted(&data, hint) {
                        css_cache.insert(net, lay);
                        total_kills += r.deaths;
                        all.extend(css_highlights(&r, &base(d)));
                    }
                } else if let Some(p) = parse_one(&data, debug && single, full) {
                    total_kills += p.kills.len();
                    all.extend(demo_highlights(&p, &base(d)));
                }
            }
            Ok(data) if data.len() >= 8 && &data[..7] == b"PBDEMS2" => {
                // CS2 (Source 2) — only when built with --features cs2
                #[cfg(feature = "cs2")]
                if let Some(r) = cs2::parse(&data, debug && single) {
                    total_kills += r.kills.len();
                    all.extend(cs2_highlights(&r, &base(d)));
                }
                #[cfg(not(feature = "cs2"))]
                let _ = &data;
            }
            _ => {}
        }
    }
    if !single {
        println!("\r  {:<60}", "");
    }
    println!(
        "  {} demo(s), {} kills, {} multikills\n",
        demos.len(),
        total_kills,
        all.len()
    );

    all.sort_by(|a, b| b.score.cmp(&a.score));
    println!(
        "  {:<4} {:<6} {:<16} {:<5} {:<4} {:<30} {}",
        "#", "score", "player", "kills", "hs", "weapons / tags", "demo"
    );
    println!("  {}", "-".repeat(100));
    for (i, h) in all.iter().take(60).enumerate() {
        println!(
            "  {:<4} {:<6} {:<16.16} {:<5} {:<4} {:<30.30} {:.24}",
            i + 1,
            h.score,
            h.player,
            h.n,
            h.hs,
            h.weapons.join(","),
            h.demo
        );
    }
}
