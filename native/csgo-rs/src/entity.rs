// Entity delta stream (svc_PacketEntities) → per-entity prop values → player positions.
//
// CS:GO differs from Orange Box in two ways that matter here: the prop-index list uses the
// "new" ReadFieldIndex encoding (a one-bit "+1" fast path, else a 7-bit value with escapes,
// 0xFFF = end), and m_vecOrigin is networked per class (NOSCALE VectorXY absolute, or the
// cell-coord family). We decode every prop to stay bit-aligned but only keep origin/yaw/team.

use crate::pb::Bits;
use crate::sendtables::*;
use std::collections::HashMap;

#[derive(Clone, Copy, Default)]
pub struct PlayerState {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub yaw: f32,
    pub team: i32,
    pub alive: bool,
    pub on_ground: bool,
    pub has_pos: bool,
}

struct Ent {
    class_idx: usize, // index into world.classes
    st: PlayerState,
}

// per-class precomputed flat indices of the props we keep
#[derive(Default, Clone)]
struct Roles {
    is_player: bool,
    origin: i32,
    origin_z: i32,
    yaw: i32,
    team: i32,
    life: i32,
    flags: i32,
    vx: i32,
    vy: i32,
    vz: i32,
    cell_x: i32,
    cell_y: i32,
    cell_z: i32,
}

pub struct EntityWorld {
    pub classes: Vec<ServerClass>,
    by_id: HashMap<i32, usize>,
    roles: Vec<Roles>,
    class_bits: u32,
    ents: HashMap<i32, Ent>,
    pub max_clients: i32,
    // debug counters
    pub n_packets: u64,
    pub n_enter: u64,
    pub n_player_enter: u64,
    pub n_haspos: u64,
    pub n_desync: u64,
    traced: bool,
    trace_left: i32,
}

enum Val {
    F(f32),
    V2(f32, f32),
    I(i64),
    Skip,
}

impl EntityWorld {
    pub fn new(classes: Vec<ServerClass>, max_clients: i32) -> Self {
        let mut by_id = HashMap::new();
        let mut roles = Vec::with_capacity(classes.len());
        for (i, c) in classes.iter().enumerate() {
            by_id.insert(c.id, i);
            let find = |n: &str| c.flat.iter().position(|f| f.prop.name == n).map(|x| x as i32).unwrap_or(-1);
            let is_player = matches!(c.name.as_str(), "CCSPlayer" | "CCSPlayerPawn");
            roles.push(Roles {
                is_player,
                origin: find("m_vecOrigin"),
                origin_z: find("m_vecOrigin[2]"),
                yaw: find("m_angEyeAngles[1]"),
                team: find("m_iTeamNum"),
                life: find("m_lifeState"),
                flags: find("m_fFlags"),
                vx: find("m_vecVelocity[0]"),
                vy: find("m_vecVelocity[1]"),
                vz: find("m_vecVelocity[2]"),
                cell_x: find("m_cellX"),
                cell_y: find("m_cellY"),
                cell_z: find("m_cellZ"),
            });
        }
        // class id field width = Q_log2(numClasses) + 1
        let n = classes.len();
        let mut class_bits = 0u32;
        let mut t = n;
        while t >> 1 != 0 {
            t >>= 1;
            class_bits += 1;
        }
        class_bits += 1;
        EntityWorld {
            classes,
            by_id,
            roles,
            class_bits,
            ents: HashMap::new(),
            max_clients,
            n_packets: 0,
            n_enter: 0,
            n_player_enter: 0,
            n_haspos: 0,
            n_desync: 0,
            traced: false,
            trace_left: 3,
        }
    }

    pub fn class_bits(&self) -> u32 {
        self.class_bits
    }

    // snapshot current player positions: (entity slot, state)
    pub fn players(&self) -> Vec<(i32, PlayerState)> {
        let mut out = Vec::new();
        for (&id, e) in &self.ents {
            // alive only: a DEAD player who is spectating keeps a networked position that tracks
            // the player they're watching, so they'd render *inside* the killer and look like a
            // second person. (If m_lifeState isn't in the tables, `alive` stays true → no change.)
            if self.roles[e.class_idx].is_player && e.st.has_pos && e.st.alive {
                out.push((id, e.st));
            }
        }
        out.sort_by_key(|(id, _)| *id);
        out
    }

    pub fn read_packet_entities(
        &mut self,
        data: &[u8],
        updated: i32,
        is_delta: bool,
        baselines: &HashMap<i32, Vec<u8>>,
    ) {
        self.n_packets += 1;
        let trace = !is_delta && !self.traced && std::env::var("TRACE_ENT").is_ok();
        if trace {
            self.traced = true;
            eprintln!("  [ent] first snapshot: updated={updated} bytes={}", data.len());
        }
        let mut b = Bits::new(data);
        let mut ent_idx: i32 = -1;
        for _ in 0..updated {
            if !b.ok() {
                return;
            }
            ent_idx += 1 + b.read_ubitvar() as i32;
            if ent_idx < 0 || ent_idx > 2047 {
                self.n_desync += 1;
                if trace {
                    eprintln!("  [ent] DESYNC bad entIdx={ent_idx} @bit {}", b.pos());
                }
                return;
            }
            if b.read_bit() == 1 {
                // leave PVS / delete
                if b.read_bit() == 1 {
                    self.ents.remove(&ent_idx);
                }
            } else if b.read_bit() == 1 {
                // enter PVS: class id + serial, then props
                self.n_enter += 1;
                let cls_id = b.read_bits(self.class_bits) as i32;
                let _serial = b.read_bits(10);
                let class_idx = match self.by_id.get(&cls_id) {
                    Some(&i) => i,
                    None => {
                        self.n_desync += 1;
                        return; // lost sync
                    }
                };
                if self.roles[class_idx].is_player {
                    self.n_player_enter += 1;
                }
                let mut e = Ent {
                    class_idx,
                    st: PlayerState {
                        alive: true,
                        ..Default::default()
                    },
                };
                // apply the class instance-baseline first, then the enter-PVS delta
                if let Some(bl) = baselines.get(&cls_id) {
                    let mut bb = Bits::new(bl);
                    self.read_props_traced(&mut bb, &mut e, false);
                }
                let before = b.pos();
                let tr = trace && self.trace_left > 0;
                if tr {
                    self.trace_left -= 1;
                }
                self.read_props_traced(&mut b, &mut e, tr);
                if trace {
                    eprintln!(
                        "  [ent] entIdx={ent_idx} ENTER class={:<22} bits {before}->{} pos=({:.1},{:.1},{:.1}) haspos={}",
                        self.classes[class_idx].name,
                        b.pos(),
                        e.st.x, e.st.y, e.st.z, e.st.has_pos
                    );
                }
                if e.st.has_pos {
                    self.n_haspos += 1;
                }
                self.ents.insert(ent_idx, e);
            } else {
                // delta on existing entity
                if let Some(mut e) = self.ents.remove(&ent_idx) {
                    self.read_props_traced(&mut b, &mut e, false);
                    self.ents.insert(ent_idx, e);
                } else {
                    return; // lost track
                }
            }
        }
    }

    fn read_props_traced(&self, b: &mut Bits, e: &mut Ent, tr: bool) {
        let class = &self.classes[e.class_idx];
        let roles = &self.roles[e.class_idx];
        let flat = &class.flat;
        if flat.is_empty() {
            return;
        }
        // CS:GO wire format: [newWay bit][full field-index list, 0xFFF-terminated][all values].
        // Read every index first, THEN decode the values in order — not interleaved.
        let new_way = b.read_bit() == 1;
        let mut indices: Vec<i32> = Vec::new();
        let mut idx: i32 = -1;
        loop {
            if !b.ok() {
                return;
            }
            idx = read_field_index(b, idx, new_way);
            if idx == -1 {
                break;
            }
            if idx < 0 || idx as usize >= flat.len() {
                return; // desync
            }
            indices.push(idx);
            if indices.len() > flat.len() {
                return;
            }
        }
        for &idx in &indices {
            let fp = &flat[idx as usize];
            let pstart = b.pos();
            let v = decode_prop(b, &fp.prop, fp.array_elem.as_ref());
            if tr {
                let vs = match &v {
                    Val::F(f) => format!("{f:.2}"),
                    Val::V2(x, y) => format!("({x:.1},{y:.1})"),
                    Val::I(i) => format!("{i}"),
                    Val::Skip => "-".into(),
                };
                eprintln!(
                    "        prop[{idx:>4}] {:<40} type={} flags=0x{:05x} bits={} [{pstart}->{} ={}] = {vs}",
                    fp.path, fp.prop.typ, fp.prop.flags, fp.prop.num_bits, b.pos(), b.pos()-pstart
                );
            }
            if !roles.is_player {
                continue;
            }
            if idx == roles.origin {
                if let Val::V2(x, y) = v {
                    e.st.x = x;
                    e.st.y = y;
                    e.st.has_pos = true;
                }
            } else if idx == roles.origin_z {
                if let Val::F(z) = v {
                    e.st.z = z;
                }
            } else if idx == roles.yaw {
                if let Val::F(a) = v {
                    e.st.yaw = a;
                }
            } else if idx == roles.team {
                if let Val::I(t) = v {
                    e.st.team = t as i32;
                }
            } else if idx == roles.life {
                if let Val::I(l) = v {
                    e.st.alive = l == 0;
                }
            } else if idx == roles.flags {
                if let Val::I(f) = v {
                    e.st.on_ground = f & 1 != 0; // FL_ONGROUND
                }
            } else if idx == roles.vx {
                if let Val::F(f) = v {
                    e.st.vx = f;
                }
            } else if idx == roles.vy {
                if let Val::F(f) = v {
                    e.st.vy = f;
                }
            } else if idx == roles.vz {
                if let Val::F(f) = v {
                    e.st.vz = f;
                }
            } else if idx == roles.cell_x {
                if let Val::I(cx) = v {
                    e.st.x = cell_to_coord(cx as i32, e.st.x);
                }
            } else if idx == roles.cell_y {
                if let Val::I(cy) = v {
                    e.st.y = cell_to_coord(cy as i32, e.st.y);
                }
            } else if idx == roles.cell_z {
                if let Val::I(cz) = v {
                    e.st.z = cell_to_coord(cz as i32, e.st.z);
                }
            }
        }
    }
}

// CS:GO cell system: world = cell*cellwidth - MAX_COORD + in-cell offset.
// cellbits default 5 → cellwidth 32; MAX_COORD_INTEGER 16384.
fn cell_to_coord(cell: i32, offset: f32) -> f32 {
    const CELL_WIDTH: f32 = 32.0;
    const MAX_COORD: f32 = 16384.0;
    (cell as f32) * CELL_WIDTH - MAX_COORD + offset
}

// CS:GO "new" prop-index encoding
fn read_field_index(b: &mut Bits, last: i32, new_way: bool) -> i32 {
    if new_way && b.read_bit() == 1 {
        return last + 1;
    }
    let ret: i32;
    if new_way && b.read_bit() == 1 {
        ret = b.read_bits(3) as i32; // 0..7
    } else {
        let mut r = b.read_bits(7) as i32;
        match r & (32 | 64) {
            32 => r = (r & 31) | ((b.read_bits(2) as i32) << 5),
            64 => r = (r & 31) | ((b.read_bits(4) as i32) << 5),
            96 => r = (r & 31) | ((b.read_bits(7) as i32) << 5),
            _ => {}
        }
        ret = r;
    }
    if ret == 0xfff {
        return -1;
    }
    last + 1 + ret
}

fn decode_prop(b: &mut Bits, p: &SendProp, elem: Option<&SendProp>) -> Val {
    match p.typ {
        DPT_INT => {
            if p.flags & SPROP_VARINT != 0 {
                if p.flags & SPROP_UNSIGNED != 0 {
                    Val::I(b.read_varint32() as i64)
                } else {
                    Val::I(b.read_signed_varint32() as i64)
                }
            } else if p.flags & SPROP_UNSIGNED != 0 {
                Val::I(b.read_bits(p.num_bits as u32) as i64)
            } else {
                Val::I(b.read_signed_bits(p.num_bits as u32))
            }
        }
        DPT_FLOAT => Val::F(decode_float(b, p)),
        DPT_VECTOR => {
            let x = decode_float(b, p);
            let y = decode_float(b, p);
            if p.flags & SPROP_NORMAL == 0 {
                let _z = decode_float(b, p);
            } else {
                let _sign = b.read_bit();
            }
            Val::V2(x, y)
        }
        DPT_VECTORXY => {
            let x = decode_float(b, p);
            let y = decode_float(b, p);
            Val::V2(x, y)
        }
        DPT_STRING => {
            let n = (b.read_bits(9) as usize).min(512);
            let _ = b.read_bytes(n);
            Val::Skip
        }
        DPT_ARRAY => {
            let mut bits = 1u32;
            let mut m = p.num_elements;
            while m >> 1 != 0 {
                bits += 1;
                m >>= 1;
            }
            let n = b.read_bits(bits) as i32;
            if let Some(el) = elem {
                for _ in 0..n.min(p.num_elements + 1).max(0) {
                    decode_prop(b, el, None);
                }
            }
            Val::Skip
        }
        _ => Val::Skip,
    }
}

fn decode_float(b: &mut Bits, p: &SendProp) -> f32 {
    if p.flags & SPROP_COORD != 0 {
        return read_bit_coord(b);
    }
    if p.flags & (SPROP_COORD_MP | SPROP_COORD_MP_LP | SPROP_COORD_MP_INT) != 0 {
        return read_bit_coord_mp(
            b,
            p.flags & SPROP_COORD_MP_INT != 0,
            p.flags & SPROP_COORD_MP_LP != 0,
        );
    }
    if p.flags & (SPROP_CELL_COORD | SPROP_CELL_COORD_LP | SPROP_CELL_COORD_INT) != 0 {
        return read_bit_cell_coord(
            b,
            p.num_bits as u32,
            p.flags & SPROP_CELL_COORD_INT != 0,
            p.flags & SPROP_CELL_COORD_LP != 0,
        );
    }
    if p.flags & SPROP_NOSCALE != 0 {
        return f32::from_bits(b.read_bits(32) as u32);
    }
    if p.flags & SPROP_NORMAL != 0 {
        let sign = b.read_bit();
        let v = (b.read_bits(11) as f32) * (1.0 / 2047.0);
        return if sign == 1 { -v } else { v };
    }
    let iv = b.read_bits(p.num_bits as u32);
    let den = (((1u64 << p.num_bits) - 1) as f32).max(1.0);
    p.low + (p.high - p.low) * (iv as f32 / den)
}

fn read_bit_coord(b: &mut Bits) -> f32 {
    let int_part = b.read_bit();
    let frac_part = b.read_bit();
    if int_part == 0 && frac_part == 0 {
        return 0.0;
    }
    let sign = b.read_bit();
    let mut iv = 0u64;
    let mut fv = 0u64;
    if int_part == 1 {
        iv = b.read_bits(14) + 1;
    }
    if frac_part == 1 {
        fv = b.read_bits(5);
    }
    let v = iv as f32 + fv as f32 * (1.0 / 32.0);
    if sign == 1 {
        -v
    } else {
        v
    }
}

fn read_bit_coord_mp(b: &mut Bits, is_int: bool, low_prec: bool) -> f32 {
    let in_bounds = b.read_bit() == 1;
    let mut value = 0.0f32;
    let mut sign = 0u32;
    if is_int {
        if b.read_bit() == 1 {
            sign = b.read_bit();
            value = if in_bounds {
                (b.read_bits(11) + 1) as f32
            } else {
                (b.read_bits(14) + 1) as f32
            };
        }
    } else {
        let has_int = b.read_bit();
        sign = b.read_bit();
        let mut iv = 0u64;
        if has_int == 1 {
            iv = if in_bounds {
                b.read_bits(11) + 1
            } else {
                b.read_bits(14) + 1
            };
        }
        let frac_bits = if low_prec { 3 } else { 5 };
        let fv = b.read_bits(frac_bits);
        value = iv as f32 + fv as f32 / (1u32 << frac_bits) as f32;
    }
    if sign == 1 {
        -value
    } else {
        value
    }
}

fn read_bit_cell_coord(b: &mut Bits, bits: u32, is_int: bool, low_prec: bool) -> f32 {
    if is_int {
        b.read_bits(bits) as f32
    } else {
        let frac_bits = if low_prec { 3 } else { 5 };
        let iv = b.read_bits(bits);
        let fv = b.read_bits(frac_bits);
        iv as f32 + fv as f32 * (1.0 / (1u32 << frac_bits) as f32)
    }
}
