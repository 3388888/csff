// Send tables for CS:GO (Source 1). Unlike CS:S (bit-packed), CS:GO ships them as
// CSVCMsg_SendTable protobufs inside dem_datatables, followed by the server-class list.
// We hand-decode the protobufs, then flatten each class into the ordered prop list the
// entity delta stream indexes against — including CS:GO's priority sort, which must match
// the engine exactly or every prop index shifts and the decode turns to noise.

use crate::pb::{f32_le, skip_field, varint};

// send prop types
pub const DPT_INT: i32 = 0;
pub const DPT_FLOAT: i32 = 1;
pub const DPT_VECTOR: i32 = 2;
pub const DPT_VECTORXY: i32 = 3;
pub const DPT_STRING: i32 = 4;
pub const DPT_ARRAY: i32 = 5;
pub const DPT_DATATABLE: i32 = 6;

// send prop flags
pub const SPROP_UNSIGNED: i32 = 1 << 0;
pub const SPROP_COORD: i32 = 1 << 1;
pub const SPROP_NOSCALE: i32 = 1 << 2;
pub const SPROP_NORMAL: i32 = 1 << 5;
pub const SPROP_EXCLUDE: i32 = 1 << 6;
pub const SPROP_INSIDEARRAY: i32 = 1 << 8;
pub const SPROP_COLLAPSIBLE: i32 = 1 << 11;
pub const SPROP_COORD_MP: i32 = 1 << 12;
pub const SPROP_COORD_MP_LP: i32 = 1 << 13;
pub const SPROP_COORD_MP_INT: i32 = 1 << 14;
// CS:GO cell-coordinate encodings (used by m_vecOrigin)
pub const SPROP_CELL_COORD: i32 = 1 << 15;
pub const SPROP_CELL_COORD_LP: i32 = 1 << 16;
pub const SPROP_CELL_COORD_INT: i32 = 1 << 17;
pub const SPROP_CHANGES_OFTEN: i32 = 1 << 18;
// CS:GO gives VARINT its own bit (Orange Box aliased it onto NORMAL; not so here)
pub const SPROP_VARINT: i32 = 1 << 19;

#[derive(Clone, Default)]
pub struct SendProp {
    pub typ: i32,
    pub name: String,
    pub flags: i32,
    pub priority: i32,
    pub dt_name: String,
    pub num_elements: i32,
    pub low: f32,
    pub high: f32,
    pub num_bits: i32,
    pub in_array: bool, // element template for an array prop
}

#[derive(Clone, Default)]
pub struct SendTable {
    pub name: String,
    pub props: Vec<SendProp>,
}

#[derive(Clone)]
pub struct FlatProp {
    pub prop: SendProp,
    pub array_elem: Option<SendProp>,
    pub path: String,
}

#[derive(Clone, Default)]
pub struct ServerClass {
    pub id: i32,
    pub name: String,
    pub dt_name: String,
    pub flat: Vec<FlatProp>,
}

// -------- parse the dem_datatables block --------
pub fn parse_datatables(block: &[u8]) -> (Vec<SendTable>, Vec<ServerClass>) {
    let mut p = 0usize;
    let mut tables: Vec<SendTable> = Vec::new();
    loop {
        if p >= block.len() {
            break;
        }
        let _msg_type = varint(block, &mut p);
        let size = varint(block, &mut p) as usize;
        if p + size > block.len() {
            break;
        }
        let buf = &block[p..p + size];
        p += size;
        let (t, is_end) = parse_send_table(buf);
        if is_end {
            break;
        }
        tables.push(t);
    }
    // server class list: int16 count, then per class int16 id + 2 null-terminated strings
    let mut classes = Vec::new();
    if p + 2 <= block.len() {
        let n = i16::from_le_bytes([block[p], block[p + 1]]) as usize;
        p += 2;
        for _ in 0..n {
            if p + 2 > block.len() {
                break;
            }
            let id = i16::from_le_bytes([block[p], block[p + 1]]) as i32;
            p += 2;
            let name = read_cstr(block, &mut p);
            let dt = read_cstr(block, &mut p);
            classes.push(ServerClass {
                id,
                name,
                dt_name: dt,
                flat: Vec::new(),
            });
        }
    }
    (tables, classes)
}

fn read_cstr(b: &[u8], p: &mut usize) -> String {
    let start = *p;
    while *p < b.len() && b[*p] != 0 {
        *p += 1;
    }
    let s = String::from_utf8_lossy(&b[start..*p]).to_string();
    if *p < b.len() {
        *p += 1; // skip null
    }
    s
}

// CSVCMsg_SendTable: is_end=1(bool), net_table_name=2(str), needs_decoder=3(bool),
// props=4(repeated sendprop_t)
fn parse_send_table(b: &[u8]) -> (SendTable, bool) {
    let mut p = 0usize;
    let mut t = SendTable::default();
    let mut is_end = false;
    while p < b.len() {
        let tag = varint(b, &mut p);
        let (field, wt) = (tag >> 3, tag & 7);
        match (field, wt) {
            (1, 0) => is_end = varint(b, &mut p) != 0,
            (2, 2) => {
                t.name = String::from_utf8_lossy(skip_field(b, &mut p, 2).unwrap_or(&[])).to_string()
            }
            (3, 0) => {
                varint(b, &mut p);
            }
            (4, 2) => {
                let sub = skip_field(b, &mut p, 2).unwrap_or(&[]);
                t.props.push(parse_prop(sub));
            }
            _ => {
                skip_field(b, &mut p, wt);
            }
        }
    }
    (t, is_end)
}

// sendprop_t: type=1, var_name=2, flags=3, priority=4, dt_name=5, num_elements=6,
// low_value=7(float), high_value=8(float), num_bits=9
fn parse_prop(b: &[u8]) -> SendProp {
    let mut p = 0usize;
    let mut sp = SendProp::default(); // priority defaults to 0 (proto default), like the engine
    while p < b.len() {
        let tag = varint(b, &mut p);
        let (field, wt) = (tag >> 3, tag & 7);
        match (field, wt) {
            (1, 0) => sp.typ = varint(b, &mut p) as i32,
            (2, 2) => {
                sp.name =
                    String::from_utf8_lossy(skip_field(b, &mut p, 2).unwrap_or(&[])).to_string()
            }
            (3, 0) => sp.flags = varint(b, &mut p) as i32,
            (4, 0) => sp.priority = varint(b, &mut p) as i32,
            (5, 2) => {
                sp.dt_name =
                    String::from_utf8_lossy(skip_field(b, &mut p, 2).unwrap_or(&[])).to_string()
            }
            (6, 0) => sp.num_elements = varint(b, &mut p) as i32,
            (7, 5) => {
                sp.low = f32_le(b, p);
                p += 4;
            }
            (8, 5) => {
                sp.high = f32_le(b, p);
                p += 4;
            }
            (9, 0) => sp.num_bits = varint(b, &mut p) as i32,
            _ => {
                skip_field(b, &mut p, wt);
            }
        }
    }
    sp
}

// -------- flatten a class into its ordered prop list --------
pub fn flatten_all(tables: &[SendTable], classes: &mut [ServerClass]) {
    use std::collections::HashMap;
    let tmap: HashMap<&str, &SendTable> = tables.iter().map(|t| (t.name.as_str(), t)).collect();
    for c in classes.iter_mut() {
        let root = match tmap.get(c.dt_name.as_str()) {
            Some(t) => *t,
            None => continue,
        };
        let mut excludes: Vec<(String, String)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        collect_excludes(root, &tmap, &mut excludes, &mut seen);
        let mut flat: Vec<FlatProp> = Vec::new();
        gather(root, &tmap, &excludes, &mut flat);
        sort_by_priority(&mut flat);
        c.flat = flat;
    }
}

fn collect_excludes<'a>(
    t: &'a SendTable,
    tmap: &std::collections::HashMap<&'a str, &'a SendTable>,
    ex: &mut Vec<(String, String)>,
    seen: &mut std::collections::HashSet<String>,
) {
    if seen.contains(&t.name) {
        return;
    }
    seen.insert(t.name.clone());
    for pr in &t.props {
        if pr.flags & SPROP_EXCLUDE != 0 {
            ex.push((pr.dt_name.clone(), pr.name.clone()));
        }
        if pr.typ == DPT_DATATABLE {
            if let Some(sub) = tmap.get(pr.dt_name.as_str()) {
                collect_excludes(sub, tmap, ex, seen);
            }
        }
    }
}

fn is_excluded(ex: &[(String, String)], table: &str, name: &str) -> bool {
    ex.iter().any(|(d, n)| d == table && n == name)
}

// engine GatherProps: child non-collapsible tables flatten in first, own props appended after
fn gather<'a>(
    t: &'a SendTable,
    tmap: &std::collections::HashMap<&'a str, &'a SendTable>,
    ex: &[(String, String)],
    out: &mut Vec<FlatProp>,
) {
    let mut temp: Vec<FlatProp> = Vec::new();
    iterate(t, tmap, ex, out, &mut temp);
    out.extend(temp);
}

fn iterate<'a>(
    t: &'a SendTable,
    tmap: &std::collections::HashMap<&'a str, &'a SendTable>,
    ex: &[(String, String)],
    out: &mut Vec<FlatProp>,
    temp: &mut Vec<FlatProp>,
) {
    for (i, pr) in t.props.iter().enumerate() {
        if pr.flags & SPROP_EXCLUDE != 0 || pr.flags & SPROP_INSIDEARRAY != 0 {
            continue;
        }
        if is_excluded(ex, &t.name, &pr.name) {
            continue;
        }
        if pr.typ == DPT_DATATABLE {
            if let Some(sub) = tmap.get(pr.dt_name.as_str()) {
                if pr.flags & SPROP_COLLAPSIBLE != 0 {
                    iterate(sub, tmap, ex, out, temp);
                } else {
                    gather(sub, tmap, ex, out);
                }
            }
            continue;
        }
        // an array prop takes its element template from the preceding prop
        let array_elem = if pr.typ == DPT_ARRAY && i > 0 {
            Some(t.props[i - 1].clone())
        } else {
            None
        };
        temp.push(FlatProp {
            prop: pr.clone(),
            array_elem,
            path: format!("{}.{}", t.name, pr.name),
        });
    }
}

// CS:GO priority sort: iterate the distinct priorities ascending (plus 64 for CHANGES_OFTEN)
// and move matching props to the front, exactly as the engine does.
fn sort_by_priority(flat: &mut [FlatProp]) {
    let mut prios: Vec<i32> = vec![64];
    for f in flat.iter() {
        if !prios.contains(&f.prop.priority) {
            prios.push(f.prop.priority);
        }
    }
    prios.sort_unstable();

    let mut start = 0usize;
    for &prio in &prios {
        let mut cur = start;
        while cur < flat.len() {
            let p = &flat[cur].prop;
            let matches = p.priority == prio || (prio == 64 && p.flags & SPROP_CHANGES_OFTEN != 0);
            if matches {
                if cur != start {
                    flat.swap(start, cur);
                }
                start += 1;
            }
            cur += 1;
        }
    }
}
