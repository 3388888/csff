// CS:S (Source-1, bit-packed Orange Box) frag parser, ported from native/cssfast.
//
// CS:S demos are also HL2DEMO but — unlike CS:GO's protobuf net messages — use bit-packed
// messages whose field widths drift between engine branches (v34 proto 7, v77 proto ~24,
// Orange Box proto 36+). We auto-tune those widths per demo (tune()), recover the
// svc_GameEventList by scanning, then decode player_death into frags. Positions are NOT
// decoded (broken even in the Go original); this is the reliable frag path only.

use crate::pb::Bits;
use std::collections::HashMap;

// distinguish CS:S from CS:GO: CS:GO net protocols are huge (13xxx..1353104), CS:S is tiny.
pub fn looks_like_css(net_proto: i32) -> bool {
    net_proto > 0 && net_proto < 1000
}

#[derive(Clone, Copy)]
pub struct Layout {
    tick_extra: bool,
    user_msg_bits: u32,
    temp_ent_bits: u32,
    map_hash_bits: usize,
    cmd_info_len: usize,
    type_bits: u32,
    table_upd_bits: u32,
    table_id_bits: u32,
}

struct Cmds {
    stop: u8,
    string_tables: u8, // 0 = none
    custom_data: u8,
}

fn cmds_for(net: i32) -> Cmds {
    if net <= 8 {
        Cmds { stop: 7, string_tables: 0, custom_data: 0 }
    } else if net < 36 {
        Cmds { stop: 7, string_tables: 8, custom_data: 0 }
    } else {
        Cmds { stop: 7, string_tables: 9, custom_data: 8 }
    }
}

#[derive(Clone)]
struct EvDesc {
    name: String,
    fields: Vec<(String, u32)>, // (name, type)
}

#[derive(Default)]
struct Death {
    tick: i32,
    round: i32,
    attacker: i32,
    victim: i32,
    weapon: String,
    headshot: bool,
    noscope: bool,
    penetrated: i32,
    smoke: bool,
    blind: bool,
}

struct Css<'a> {
    data: &'a [u8],
    off: usize,
    net_proto: i32,
    header_map: String,
    lay: Layout,
    cmd: Cmds,
    descs: HashMap<i32, EvDesc>,
    descs_good: bool,
    deaths: Vec<Death>,
    names: HashMap<i32, String>,
    xuids: HashMap<i32, u64>, // userid -> SteamID64 (from the guid string)
    teams: HashMap<i32, i32>,
    round: i32,
    cur_tick: i32,
    // tuner stats
    packets: i32,
    clean_pkts: i32,
    si_ok: i32,
    si_bad: i32,
    max_packets: i32,
}

impl<'a> Css<'a> {
    fn new(data: &'a [u8], net_proto: i32, map: String, lay: Layout) -> Self {
        Css {
            data,
            off: 1072,
            net_proto,
            header_map: map,
            lay,
            cmd: cmds_for(net_proto),
            descs: HashMap::new(),
            descs_good: false,
            deaths: Vec::new(),
            names: HashMap::new(),
            xuids: HashMap::new(),
            teams: HashMap::new(),
            round: 0,
            cur_tick: 0,
            packets: 0,
            clean_pkts: 0,
            si_ok: 0,
            si_bad: 0,
            max_packets: 0,
        }
    }

    fn i32(&mut self) -> i32 {
        if self.off + 4 > self.data.len() {
            self.off = self.data.len();
            return 0;
        }
        let v = i32::from_le_bytes(self.data[self.off..self.off + 4].try_into().unwrap());
        self.off += 4;
        v
    }

    fn skip_block(&mut self) -> Option<&'a [u8]> {
        let n = self.i32();
        if n < 0 || self.off + n as usize > self.data.len() {
            self.off = self.data.len();
            return None;
        }
        let b = &self.data[self.off..self.off + n as usize];
        self.off += n as usize;
        Some(b)
    }

    fn run(&mut self) {
        while self.off < self.data.len() {
            if self.max_packets > 0 && self.packets >= self.max_packets {
                return;
            }
            let cmd = self.data[self.off];
            self.off += 1;
            if cmd == self.cmd.stop {
                return;
            }
            if self.off + 4 > self.data.len() {
                return;
            }
            self.cur_tick = self.i32();
            match cmd {
                1 | 2 => self.read_packet(),
                3 => {}
                4 => {
                    self.skip_block();
                }
                5 => {
                    self.off += 4;
                    self.skip_block();
                }
                6 => {
                    self.skip_block();
                } // datatables: entities not needed for frags
                _ => {
                    if self.cmd.string_tables != 0 && cmd == self.cmd.string_tables {
                        // The signon string-table dump carries the userinfo roster for everyone
                        // who connected before recording started. GOTV/STV demos never fire
                        // player_info events for them, so skipping this block (the old
                        // behaviour) left every such player as "uid7" — the same bug that hit
                        // the CS:GO path. TF2 and Orange Box CS:S both land here.
                        if let Some(blk) = self.skip_block() {
                            let blk = blk.to_vec();
                            self.read_stringtables(&blk);
                        }
                    } else if self.cmd.custom_data != 0 && cmd == self.cmd.custom_data {
                        self.off += 4;
                        self.skip_block();
                    } else {
                        return; // misaligned
                    }
                }
            }
        }
    }

    /// dem_stringtables (cmd 8 on Orange Box): u8 numTables, then per table a name, u16 count,
    /// and per entry a name + optional userdata. We only want `userinfo` — the player roster.
    fn read_stringtables(&mut self, data: &[u8]) {
        let mut r = Bits::new(data);
        let n_tables = r.read_bits(8) as usize;
        for _ in 0..n_tables {
            if !r.ok() {
                return;
            }
            let tname = r.read_string();
            let n_entries = r.read_bits(16) as usize;
            let want = tname == "userinfo";
            for _ in 0..n_entries {
                if !r.ok() {
                    return;
                }
                let _ = r.read_string();
                if r.read_bit() == 1 {
                    let size = r.read_bits(16) as usize;
                    let udata = r.read_bytes(size);
                    if want {
                        if let Some((uid, name, sid)) = parse_ob_player_info(&udata) {
                            if !name.is_empty() {
                                self.names.entry(uid).or_insert(name);
                            }
                            if let Some(x) = sid {
                                self.xuids.entry(uid).or_insert(x);
                            }
                        }
                    }
                }
            }
            // client-side entries — consume to stay bit-aligned
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

    fn read_packet(&mut self) {
        self.off += self.lay.cmd_info_len + 8;
        let msg = match self.skip_block() {
            Some(m) if m.len() >= 8 => m,
            _ => return,
        };
        self.packets += 1;
        if !self.descs_good && self.packets <= 64 && msg.len() > 512 {
            self.scan_game_event_list(msg);
        }
        let mut b = Bits::new(msg);
        let ok = self.read_messages(&mut b);
        if ok && b.left() < 8 {
            self.clean_pkts += 1;
        }
    }

    fn read_messages(&mut self, b: &mut Bits) -> bool {
        while b.left() >= self.lay.type_bits as i64 {
            let typ = b.read_bits(self.lay.type_bits) as i32;
            if !self.handle(b, typ) {
                return false;
            }
            if b.over {
                return false;
            }
        }
        true
    }

    fn handle(&mut self, b: &mut Bits, typ: i32) -> bool {
        match typ {
            0 => {}                       // net_NOP
            1 => { b.str(); }             // net_Disconnect
            2 => { b.read_bits(32); b.str(); b.read_bit(); } // net_File
            3 => {
                b.read_bits(32);
                if self.lay.tick_extra {
                    b.read_bits(16);
                    b.read_bits(16);
                }
            }
            4 => { b.str(); }             // net_StringCmd
            5 => {
                let n = b.byte8() as usize;
                for _ in 0..n {
                    b.str();
                    b.str();
                }
            }
            6 => { b.byte8(); b.read_bits(32); } // net_SignonState
            7 => { b.str(); }             // svc_Print
            8 => self.read_server_info(b),
            9 => {
                b.read_bit();
                let n = b.read_bits(16) as usize;
                b.skip(n);
            }
            10 => {
                let n = b.read_bits(16) as i32;
                if b.read_bit() == 0 {
                    let bits_for = num_bits(n) + 1;
                    for _ in 0..n {
                        b.read_bits(bits_for);
                        b.str();
                        b.str();
                    }
                }
            }
            11 => { b.read_bit(); }
            12 => self.skip_create_stringtable(b),
            13 => self.skip_update_stringtable(b),
            14 => { b.str(); b.byte8(); }
            15 => {
                b.byte8();
                b.byte8();
                let n = b.read_bits(16) as usize;
                b.skip(n);
            }
            16 => return false,           // svc_HLTV: unknown payload
            17 => {
                if b.read_bit() == 1 {
                    let n = b.read_bits(8) as usize;
                    b.skip(n);
                } else {
                    b.read_bits(8);
                    let n = b.read_bits(16) as usize;
                    b.skip(n);
                }
            }
            18 => { b.read_bits(11); }
            19 => { b.read_bit(); b.read_bits(48); }
            20 => { b.read_bits(48); }
            21 => {
                read_vec_coord(b);
                b.read_bits(9);
                if b.read_bit() == 1 {
                    b.read_bits(11);
                    b.read_bits(11);
                }
                b.read_bit();
            }
            23 => {
                b.byte8();
                let n = b.read_bits(self.lay.user_msg_bits) as usize;
                b.skip(n);
            }
            24 => {
                b.read_bits(11);
                b.read_bits(9);
                let n = b.read_bits(11) as usize;
                b.skip(n);
            }
            25 => {
                let n = b.read_bits(11) as usize;
                let start = b.pos();
                self.read_game_event(b);
                b.bit = start + n;
            }
            26 => {
                b.read_bits(11);
                let is_delta = b.read_bit() == 1;
                if is_delta {
                    b.read_bits(32);
                }
                b.read_bit();
                b.read_bits(11);
                let n = b.read_bits(20) as usize;
                b.read_bit();
                b.skip(n);
            }
            27 => {
                b.byte8();
                let n = b.read_bits(self.lay.temp_ent_bits) as usize;
                b.skip(n);
            }
            28 => { b.read_bits(13); }
            29 => {
                b.read_bits(16);
                let n = b.read_bits(16) as usize;
                b.skip(n * 8);
            }
            30 => self.read_game_event_list(b),
            31 => { b.read_bits(32); b.str(); }
            _ => return false,
        }
        true
    }

    fn skip_create_stringtable(&mut self, b: &mut Bits) {
        // we only need to consume it to stay framed; names come from game events
        b.str(); // table name
        let max = b.read_bits(16) as i32;
        let _ = b.read_bits(num_bits(max));
        let bits = b.read_bits(20) as usize;
        let fixed = b.read_bit() == 1;
        if fixed {
            b.read_bits(12); // userdata size
            b.read_bits(4);
        }
        b.skip(bits);
    }

    fn skip_update_stringtable(&mut self, b: &mut Bits) {
        b.read_bits(self.lay.table_id_bits);
        let changed = if b.read_bit() == 1 {
            b.read_bits(16) as usize
        } else {
            1
        };
        let _ = changed;
        let bits = b.read_bits(self.lay.table_upd_bits) as usize;
        b.skip(bits);
    }

    fn read_server_info(&mut self, b: &mut Bits) {
        b.read_bits(16);
        b.read_bits(32);
        b.read_bit();
        b.read_bit();
        b.read_bits(32);
        b.read_bits(16);
        b.skip(self.lay.map_hash_bits);
        b.byte8();
        b.byte8(); // max clients
        b.read_bits(32);
        b.byte8(); // os char
        b.str(); // game dir
        let m = b.str();
        b.str();
        b.str();
        if !m.is_empty() && !self.header_map.is_empty() && !m.eq_ignore_ascii_case(&self.header_map) {
            self.si_bad += 1;
        } else if !m.is_empty() {
            self.si_ok += 1;
        }
    }

    // slide over the packet to find a bit offset where svc_GameEventList decodes perfectly
    fn scan_game_event_list(&mut self, msg: &[u8]) {
        let total = msg.len() * 8;
        let tb = self.lay.type_bits;
        let mut pos = 0usize;
        while pos + 40 < total {
            let mut b = Bits::at(msg, pos);
            if b.read_bits(tb) as i32 != 30 {
                pos += 1;
                continue;
            }
            let n = b.read_bits(9) as i32;
            let length = b.read_bits(20) as usize;
            if n < 8 || n > 512 || length < 64 || b.pos() + length > total {
                pos += 1;
                continue;
            }
            let start = b.pos();
            let mut descs: HashMap<i32, EvDesc> = HashMap::new();
            let mut ok = true;
            let mut has_death = false;
            for _ in 0..n {
                if !ok {
                    break;
                }
                let id = b.read_bits(9) as i32;
                let name = b.str();
                if !event_name_ok(&name) {
                    ok = false;
                    break;
                }
                let mut d = EvDesc {
                    name: name.clone(),
                    fields: Vec::new(),
                };
                loop {
                    let t = b.read_bits(3) as u32;
                    if t == 0 {
                        break;
                    }
                    if t > 8 || b.over {
                        ok = false;
                        break;
                    }
                    let fnm = b.str();
                    if !event_name_ok(&fnm) {
                        ok = false;
                        break;
                    }
                    d.fields.push((fnm, t));
                }
                if b.over || b.pos() > start + length {
                    ok = false;
                }
                if name == "player_death" {
                    has_death = true;
                }
                descs.insert(id, d);
            }
            if ok && has_death && b.pos() == start + length {
                self.descs = descs;
                self.descs_good = true;
                return;
            }
            pos += 1;
        }
    }

    fn read_game_event_list(&mut self, b: &mut Bits) {
        let n = b.read_bits(9) as i32;
        let length = b.read_bits(20) as usize;
        let start = b.pos();
        let mut descs: HashMap<i32, EvDesc> = HashMap::new();
        let mut has_death = false;
        for _ in 0..n {
            let id = b.read_bits(9) as i32;
            let name = b.str();
            if !event_name_ok(&name) {
                break;
            }
            let mut d = EvDesc {
                name: name.clone(),
                fields: Vec::new(),
            };
            loop {
                let t = b.read_bits(3) as u32;
                if t == 0 || b.over {
                    break;
                }
                let fnm = b.str();
                d.fields.push((fnm, t));
            }
            if name == "player_death" {
                has_death = true;
            }
            descs.insert(id, d);
        }
        if has_death && !self.descs_good {
            self.descs = descs;
            self.descs_good = true;
        }
        b.bit = start + length;
    }

    fn read_game_event(&mut self, b: &mut Bits) {
        let id = b.read_bits(9) as i32;
        let d = match self.descs.get(&id) {
            Some(d) => d.clone(),
            None => return,
        };
        match d.name.as_str() {
            "player_death" => {
                let mut rec = Death {
                    tick: self.cur_tick,
                    round: self.round,
                    ..Default::default()
                };
                for (fname, ftyp) in &d.fields {
                    let v = read_event_field(b, *ftyp);
                    match fname.as_str() {
                        "userid" => rec.victim = v.i(),
                        "attacker" => rec.attacker = v.i(),
                        "weapon" => rec.weapon = v.s(),
                        "headshot" => rec.headshot = v.i() != 0,
                        "noscope" => rec.noscope = v.i() != 0,
                        "penetrated" => rec.penetrated = v.i(),
                        "smoke" | "thrusmoke" => rec.smoke = v.i() != 0,
                        "attackerblind" => rec.blind = v.i() != 0,
                        _ => {}
                    }
                }
                self.deaths.push(rec);
            }
            "player_team" | "player_spawn" | "player_info" | "player_connect"
            | "player_changename" => {
                let (mut uid, mut team, mut name) = (0i32, 0i32, String::new());
                for (fname, ftyp) in &d.fields {
                    let v = read_event_field(b, *ftyp);
                    match fname.as_str() {
                        "userid" => uid = v.i(),
                        "team" | "teamnum" => team = v.i(),
                        "name" | "newname" | "playername" => {
                            let s = v.s();
                            if !s.is_empty() {
                                name = s;
                            }
                        }
                        _ => {}
                    }
                }
                if uid > 0 {
                    if !name.is_empty() {
                        self.names.insert(uid, name);
                    }
                    if team == 2 || team == 3 {
                        self.teams.insert(uid, team);
                    }
                }
            }
            "round_start" => self.round += 1,
            _ => {}
        }
    }
}

enum EV {
    S(String),
    I(i32),
}
impl EV {
    fn i(&self) -> i32 {
        match self {
            EV::I(n) => *n,
            EV::S(_) => 0,
        }
    }
    fn s(&self) -> String {
        match self {
            EV::S(s) => s.clone(),
            EV::I(_) => String::new(),
        }
    }
}

fn read_event_field(b: &mut Bits, typ: u32) -> EV {
    match typ {
        1 => EV::S(b.str()),
        2 | 3 => EV::I(b.read_bits(32) as i32),
        4 => EV::I(b.read_bits(16) as i16 as i32),
        5 => EV::I(b.byte8() as i32),
        6 => EV::I(b.read_bit() as i32),
        7 => {
            b.read_bits(32);
            b.read_bits(32);
            EV::I(0)
        }
        8 => EV::S(b.str()),
        _ => EV::I(0),
    }
}

fn read_vec_coord(b: &mut Bits) {
    for _ in 0..3 {
        let hi = b.read_bit();
        let hf = b.read_bit();
        if hi == 1 || hf == 1 {
            b.read_bit();
            if hi == 1 {
                b.read_bits(14);
            }
            if hf == 1 {
                b.read_bits(5);
            }
        }
    }
}

fn event_name_ok(s: &str) -> bool {
    if s.is_empty() || s.len() > 48 {
        return false;
    }
    s.bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

fn num_bits(n: i32) -> u32 {
    let mut bits = 0u32;
    while (1i64 << bits) < n as i64 {
        bits += 1;
    }
    bits
}

// -------- bit reader string helper (CS:S strings are null-terminated bytes) --------
trait BitStr {
    fn str(&mut self) -> String;
}
impl<'a> BitStr for Bits<'a> {
    fn str(&mut self) -> String {
        let mut s = Vec::new();
        while s.len() < 1024 {
            let c = self.byte8();
            if c == 0 || self.over {
                break;
            }
            s.push(c);
        }
        String::from_utf8_lossy(&s).to_string()
    }
}

// ---------------------------------------------------------------- public API
pub struct Frag {
    pub player: String,
    pub kills: usize,
    pub hs: usize,
    pub weapons: Vec<String>,
    pub desc: String,
    pub tick: i32,
    pub team: i32,
}

pub struct CssResult {
    pub net_proto: i32,
    pub map: String,
    pub tickrate: i32,
    pub deaths: usize,
    pub frags: Vec<Frag>,
}

fn tune(data: &[u8], net: i32, map: &str) -> (Layout, i32) {
    let mut best = Layout {
        tick_extra: net > 8,
        user_msg_bits: 11,
        temp_ent_bits: 17,
        map_hash_bits: 32,
        cmd_info_len: 76,
        type_bits: 6,
        table_upd_bits: 16,
        table_id_bits: 5,
    };
    let mut best_score = -1i32;
    let mut best_clean = 0i32;
    // order candidates so the protocol's likely layout comes first → early-exit fires fast
    let tbs: [u32; 2] = if net <= 8 { [5, 6] } else { [6, 5] };
    let mhs: [usize; 2] = if net >= 14 { [128, 32] } else { [32, 128] };
    let tus: [(u32, u32); 4] = if net >= 14 {
        [(20, 5), (20, 4), (16, 5), (16, 4)]
    } else {
        [(16, 5), (16, 4), (20, 5), (20, 4)]
    };
    'outer: for &tb in &tbs {
        for &ci in &[76usize, 40, 152] {
            for &te_flag in &[net > 8, net <= 8] {
                for &mh in &mhs {
                    for &um in &[11u32, 12] {
                        for &teb in &[17u32, 16] {
                            for &(tu, ti) in &tus {
                                let lay = Layout {
                                    tick_extra: te_flag,
                                    user_msg_bits: um,
                                    temp_ent_bits: teb,
                                    map_hash_bits: mh,
                                    cmd_info_len: ci,
                                    type_bits: tb,
                                    table_upd_bits: tu,
                                    table_id_bits: ti,
                                };
                                let mut p = Css::new(data, net, map.to_string(), lay);
                                p.max_packets = 220;
                                p.run();
                                if p.packets == 0 {
                                    continue;
                                }
                                let clean = p.clean_pkts * 100 / p.packets;
                                let mut score =
                                    clean * 10 + p.packets / 2 + p.si_ok * 50 - p.si_bad * 50;
                                if p.descs_good {
                                    score += 500;
                                }
                                if (net >= 14 && mh == 128) || (net < 14 && mh == 32) {
                                    score += 200;
                                }
                                if net >= 14 && tu == 20 {
                                    score += 100;
                                }
                                if score > best_score {
                                    best_score = score;
                                    best = lay;
                                    best_clean = clean;
                                }
                                // definitive win: descriptors recovered, framing clean, map
                                // verified — no better layout exists, stop searching.
                                if p.descs_good && clean >= 99 && p.si_ok > 0 && p.si_bad == 0 {
                                    break 'outer;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (best, best_clean)
}

pub fn parse(data: &[u8]) -> Option<CssResult> {
    parse_hinted(data, None).map(|(r, _)| r)
}

// does a cached layout still frame this demo cleanly? (cheap 220-packet check)
fn layout_works(data: &[u8], net: i32, map: &str, lay: Layout) -> bool {
    let mut p = Css::new(data, net, map.to_string(), lay);
    p.max_packets = 220;
    p.run();
    p.packets > 0 && p.descs_good && p.clean_pkts * 100 / p.packets.max(1) >= 99 && p.si_bad == 0
}

// parse with an optional layout hint (from a per-protocol cache); returns the layout used
pub fn parse_hinted(data: &[u8], hint: Option<Layout>) -> Option<(CssResult, Layout)> {
    if data.len() < 1072 || &data[..7] != b"HL2DEMO" {
        return None;
    }
    let net_proto = i32::from_le_bytes(data[12..16].try_into().unwrap());
    if !looks_like_css(net_proto) {
        return None;
    }
    let map = {
        let raw = &data[536..796];
        let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        String::from_utf8_lossy(&raw[..end]).to_string()
    };
    let pt = f32::from_le_bytes(data[1056..1060].try_into().unwrap());
    let ticks = i32::from_le_bytes(data[1060..1064].try_into().unwrap());
    let tickrate = if pt > 1.0 && ticks > 0 {
        (ticks as f32 / pt).round() as i32
    } else {
        66
    };

    let lay = match hint {
        Some(h) if layout_works(data, net_proto, &map, h) => h,
        _ => tune(data, net_proto, &map).0,
    };
    let mut p = Css::new(data, net_proto, map.clone(), lay);
    p.run();
    let deaths = p.deaths.len();
    let frags = build_frags(&mut p, tickrate);
    Some((
        CssResult {
            net_proto,
            map,
            tickrate,
            deaths,
            frags,
        },
        lay,
    ))
}

fn clean_weap(w: &str) -> String {
    w.strip_prefix("weapon_").unwrap_or(w).to_string()
}
fn is_funny(w: &str) -> bool {
    matches!(
        clean_weap(w).as_str(),
        "knife" | "hegrenade" | "grenade" | "flashbang" | "smokegrenade"
    )
}
fn is_sniper(w: &str) -> bool {
    matches!(clean_weap(w).as_str(), "awp" | "scout" | "g3sg1" | "sg550")
}

fn build_frags(p: &mut Css, tickrate: i32) -> Vec<Frag> {
    p.deaths.sort_by_key(|d| d.tick);
    let mut groups: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    let mut order: Vec<(i32, i32)> = Vec::new();
    for (i, d) in p.deaths.iter().enumerate() {
        if d.attacker == 0 || d.attacker == d.victim {
            continue;
        }
        let k = (d.round, d.attacker);
        if !groups.contains_key(&k) {
            order.push(k);
        }
        groups.entry(k).or_default().push(i);
    }
    let mut out = Vec::new();
    for k in order {
        let idxs = &groups[&k];
        let ds: Vec<&Death> = idxs.iter().map(|&i| &p.deaths[i]).collect();
        let n = ds.len();
        let name = p
            .names
            .get(&k.1)
            .cloned()
            .unwrap_or_else(|| format!("uid{}", k.1));
        let mut hs = 0;
        let mut weaps: Vec<String> = Vec::new();
        for d in &ds {
            if d.headshot {
                hs += 1;
            }
            let w = clean_weap(&d.weapon);
            if !w.is_empty() && !weaps.contains(&w) {
                weaps.push(w);
            }
        }
        let wep = weaps.join("/");
        // widest burst within 8s
        let (mut bi, mut bj) = (0usize, 0usize);
        for i in 0..n {
            let mut j = i;
            while j + 1 < n && ds[j + 1].tick - ds[i].tick <= 8 * tickrate {
                j += 1;
            }
            if j as i64 - i as i64 > bj as i64 - bi as i64 {
                bi = i;
                bj = j;
            }
        }
        let burst = bj - bi + 1;
        let span = (ds[bj].tick - ds[bi].tick) as f32 / tickrate as f32;
        let full = (ds[n - 1].tick - ds[0].tick) as f32 / tickrate as f32;
        let mut extra: Vec<&str> = Vec::new();
        for d in &ds {
            if d.noscope {
                extra.push("noscope");
            }
            if d.penetrated > 0 {
                extra.push("wallbang");
            }
            if d.smoke {
                extra.push("through smoke");
            }
            if d.blind {
                extra.push("while blind");
            }
        }
        let desc = if burst >= 3 && burst < n {
            format!("{n}k including {burst}k ({hs}hs) {wep} in {span:.2} seconds")
        } else if n >= 3 && burst == n {
            format!("{n}k ({hs}hs) {wep} in {span:.2} seconds")
        } else if n >= 3 {
            format!("{n}k ({hs}hs) {wep} over {full:.1} seconds")
        } else if n == 2 && burst == 2 && span <= 2.5 {
            format!("fast 2k ({hs}hs) {wep} in {span:.2} seconds")
        } else if n <= 2 && !extra.is_empty() {
            format!("{} {wep} kill", dedup(&extra).join(" "))
        } else if n == 1 && is_funny(&ds[0].weapon) {
            format!("{} kill", clean_weap(&ds[0].weapon))
        } else if n == 1 && hs == 1 && is_sniper(&ds[0].weapon) {
            format!("{} headshot", clean_weap(&ds[0].weapon))
        } else {
            String::new()
        };
        if desc.is_empty() {
            continue;
        }
        out.push(Frag {
            player: name,
            kills: n,
            hs,
            weapons: weaps,
            desc,
            tick: ds[0].tick,
            team: p.teams.get(&k.1).copied().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.kills.cmp(&a.kills).then(a.tick.cmp(&b.tick)));
    out
}

fn dedup(v: &[&str]) -> Vec<String> {
    let mut seen = Vec::new();
    for s in v {
        if !seen.iter().any(|x| x == s) {
            seen.push(s.to_string());
        }
    }
    seen
}

/// Orange Box / Source-2013 `player_info_t` (TF2, CS:S). The layout differs from CS:GO's:
/// no leading `version` field and the name is 32 bytes, not 128:
///   u64 xuid | char name[32] | int userID (big-endian) | char guid[33] | ...
/// Some builds do carry a leading `version` u64, so we probe both name offsets and accept
/// whichever yields a printable name plus a sane userID rather than hard-coding one.
pub fn parse_ob_player_info(b: &[u8]) -> Option<(i32, String, Option<u64>)> {
    // Layout read straight off real TF2 STV bytes (132-byte entries):
    //   char name[32] @0 | int userID @32 | char guid[33] @36 ("[U:1:123]" or "STEAM_0:1:61")
    // No leading version/xuid here (that's the CS:GO shape), so probe name@0 first and fall
    // back to the CS:GO offsets so one reader serves both families.
    for (name_off, name_len) in [(0usize, 32usize), (8, 32), (16, 32), (8, 128), (16, 128)] {
        let uid_off = name_off + name_len;
        if b.len() < uid_off + 4 {
            continue;
        }
        let raw = &b[name_off..uid_off];
        let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        if end == 0 || !raw[..end].iter().all(|&c| c >= 0x20) {
            continue;
        }
        // engine branches disagree on endianness here; take whichever looks like a userid
        let be = i32::from_be_bytes(b[uid_off..uid_off + 4].try_into().ok()?);
        let le = i32::from_le_bytes(b[uid_off..uid_off + 4].try_into().ok()?);
        let uid = if (0..=4096).contains(&be) { be } else if (0..=4096).contains(&le) { le } else { continue };
        let name = String::from_utf8_lossy(&raw[..end]).to_string();
        // guid sits right after the userid — convert it to a SteamID64
        let gstart = uid_off + 4;
        let gend = (gstart + 33).min(b.len());
        let guid = if gstart < gend {
            let g = &b[gstart..gend];
            let e = g.iter().position(|&c| c == 0).unwrap_or(g.len());
            String::from_utf8_lossy(&g[..e]).to_string()
        } else {
            String::new()
        };
        return Some((uid, name, steam64_from_guid(&guid)));
    }
    None
}

/// "[U:1:121699929]" or "STEAM_0:1:60849964" -> 76561197960265728 + accountid
fn steam64_from_guid(g: &str) -> Option<u64> {
    const BASE: u64 = 76561197960265728;
    let g = g.trim();
    if let Some(inner) = g.strip_prefix("[U:1:").and_then(|x| x.strip_suffix(']')) {
        return inner.parse::<u64>().ok().map(|a| BASE + a);
    }
    if let Some(rest) = g.strip_prefix("STEAM_") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 3 {
            let y = parts[1].parse::<u64>().ok()?;
            let z = parts[2].parse::<u64>().ok()?;
            return Some(BASE + z * 2 + y);
        }
    }
    None
}
