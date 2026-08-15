// bspgeo.rs — strip renderable triangle geometry out of a Source VBSP .bsp for the 3D
// preview. Ported from bspgeo.js. Output = the same CCG1 blob preview3d.js parses:
//   [magic "CCG1"][triCount u32][bounds 6×f32][play 6×f32][hasPlay u32][version u32]
//   then int16 xyz×3 per tri (18 B), then 1 material byte per tri.
// Reads only the lumps needed (verts/edges/surfedges/faces/texinfo/texdata/disp/models/ents).
// .bsp.bz2 is not handled here (decompress before calling).

#![allow(clippy::needless_range_loop)]

fn i32le(b: &[u8], o: usize) -> i32 {
    if o + 4 > b.len() { return 0; }
    i32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn i16le(b: &[u8], o: usize) -> i16 {
    if o + 2 > b.len() { return 0; }
    i16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u16le(b: &[u8], o: usize) -> u16 {
    if o + 2 > b.len() { return 0; }
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn f32le(b: &[u8], o: usize) -> f32 {
    if o + 4 > b.len() { return 0.0; }
    f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

const FACE_SIZE: usize = 56;
const TEXINFO_SIZE: usize = 72;
const TEXDATA_SIZE: usize = 32;
const DISPINFO_SIZE: usize = 176;
const MODEL_SIZE: usize = 48;

const SURF_WARP: i32 = 0x8;
const SKIP_MASK: i32 = 0x4 | 0x2 | 0x80 | 0x40 | 0x100 | 0x200 | 0x8000; // sky|sky2d|nodraw|trigger|hint|skip|hitbox

fn classify_material(name: &str, flags: i32) -> u8 {
    if flags & SURF_WARP != 0 {
        return 6; // water
    }
    let n = name.to_lowercase();
    let rules: &[(u8, &[&str])] = &[
        (6, &["water", "slime", "liquid"]),
        (7, &["glass", "window", "mirror"]),
        (12, &["snow", "frost"]),
        (5, &["grass", "foliage", "hedge", "bush", "leaf", "leaves", "moss", "jungle"]),
        (4, &["sand", "dirt", "mud", "gravel", "desert"]),
        (8, &["rock", "cliff", "sandstone", "boulder", "cobble", "limestone"]),
        (2, &["wood", "plank", "crate", "plywood", "lumber"]),
        (3, &["metal", "steel", "iron", "alum", "corrugate", "chainlink", "grate", "pipe", "vent", "container", "train"]),
        (1, &["brick", "masonry"]),
        (9, &["tile", "marble", "checker"]),
        (11, &["carpet", "fabric", "cloth", "canvas", "tarp", "rug", "awning"]),
        (10, &["plaster", "stucco", "drywall", "paint", "wallpaper", "paper", "sheetrock"]),
    ];
    // "sandstone" is rock, not sand — the sand rule excludes it here
    for (m, keys) in rules {
        for k in *keys {
            if *k == "sand" {
                if n.contains("sand") && !n.contains("sandstone") {
                    return *m;
                }
            } else if n.contains(k) {
                return *m;
            }
        }
    }
    0
}

struct Ent {
    map: std::collections::HashMap<String, String>,
}
fn parse_entities(buf: &[u8]) -> Vec<Ent> {
    let txt = String::from_utf8_lossy(buf);
    let mut out = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    for c in txt.chars() {
        match c {
            '{' => {
                depth += 1;
                if depth == 1 {
                    cur.clear();
                }
            }
            '}' => {
                if depth == 1 {
                    let mut m = std::collections::HashMap::new();
                    // scan "key" "val" pairs
                    let bytes: Vec<char> = cur.chars().collect();
                    let mut i = 0;
                    let mut toks = Vec::new();
                    while i < bytes.len() {
                        if bytes[i] == '"' {
                            let mut s = String::new();
                            i += 1;
                            while i < bytes.len() && bytes[i] != '"' {
                                s.push(bytes[i]);
                                i += 1;
                            }
                            toks.push(s);
                        }
                        i += 1;
                    }
                    let mut k = 0;
                    while k + 1 < toks.len() {
                        m.insert(toks[k].to_lowercase(), toks[k + 1].clone());
                        k += 2;
                    }
                    out.push(Ent { map: m });
                }
                depth -= 1;
            }
            _ if depth == 1 => cur.push(c),
            _ => {}
        }
    }
    out
}
fn vec3(s: Option<&String>) -> Option<[f32; 3]> {
    let s = s?;
    let p: Vec<f32> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    if p.len() >= 3 {
        Some([p[0], p[1], p[2]])
    } else {
        None
    }
}

/// Extract geometry from a plain .bsp file → serialized CCG1 blob, or None.
pub fn map_geo(path: &str) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 1036 || &data[..4] != b"VBSP" {
        return None;
    }
    let version = i32le(&data, 4);
    let lump = |i: usize| -> &[u8] {
        let o = 8 + i * 16;
        let ofs = i32le(&data, o) as usize;
        let len = i32le(&data, o + 4) as usize;
        if len == 0 || ofs + len > data.len() {
            return &[];
        }
        let s = &data[ofs..ofs + len];
        if s.len() >= 4 && &s[..4] == b"LZMA" {
            return &[]; // lump-compressed, unsupported
        }
        s
    };

    let verts = lump(3);
    let edges = lump(12);
    let surf = lump(13);
    let mut faces = lump(7);
    if faces.is_empty() {
        faces = lump(58);
    }
    let texinfo = lump(6);
    let texdata = lump(2);
    let strtab = lump(44);
    let strdat = lump(43);
    let dispinfo = lump(26);
    let dispvert = lump(33);
    let models = lump(14);
    let ents = parse_entities(lump(0));

    if verts.is_empty() || faces.is_empty() {
        return None;
    }

    let n_verts = verts.len() / 12;
    let n_edges = edges.len() / 4;
    let n_surf = surf.len() / 4;
    let n_faces = faces.len() / FACE_SIZE;
    let n_texinfo = texinfo.len() / TEXINFO_SIZE;
    let n_texdata = texdata.len() / TEXDATA_SIZE;
    let n_disp = dispinfo.len() / DISPINFO_SIZE;

    // texture name per texdata → material per texinfo
    let mut tex_name = vec![String::new(); n_texdata];
    let n_strofs = strtab.len() / 4;
    for i in 0..n_texdata {
        let id = i32le(texdata, i * TEXDATA_SIZE + 12);
        if id >= 0 && (id as usize) < n_strofs {
            let s = i32le(strtab, id as usize * 4) as usize;
            let mut e = s;
            while e < strdat.len() && strdat[e] != 0 {
                e += 1;
            }
            if s <= strdat.len() {
                tex_name[i] = String::from_utf8_lossy(&strdat[s..e.min(strdat.len())]).to_string();
            }
        }
    }
    let mut ti_flags = vec![0i32; n_texinfo];
    let mut ti_mat = vec![0u8; n_texinfo];
    for i in 0..n_texinfo {
        let flags = i32le(texinfo, i * TEXINFO_SIZE + 64);
        let td = i32le(texinfo, i * TEXINFO_SIZE + 68);
        ti_flags[i] = flags;
        let nm = if td >= 0 && (td as usize) < n_texdata { tex_name[td as usize].as_str() } else { "" };
        ti_mat[i] = classify_material(nm, flags);
    }

    // brush-entity face offsets (doors/elevators with an origin)
    let n_models = models.len() / MODEL_SIZE;
    let mut per_face_off: std::collections::HashMap<usize, [f32; 3]> = std::collections::HashMap::new();
    if n_models > 1 {
        let mut by_model: std::collections::HashMap<i32, &Ent> = std::collections::HashMap::new();
        for e in &ents {
            if let Some(mdl) = e.map.get("model") {
                if let Some(rest) = mdl.strip_prefix('*') {
                    if let Ok(idx) = rest.parse::<i32>() {
                        by_model.insert(idx, e);
                    }
                }
            }
        }
        for i in 1..n_models {
            if let Some(e) = by_model.get(&(i as i32)) {
                if let Some(o) = vec3(e.map.get("origin")) {
                    if o[0] != 0.0 || o[1] != 0.0 || o[2] != 0.0 {
                        let base = i * MODEL_SIZE;
                        let first = i32le(models, base + 40) as usize;
                        let num = i32le(models, base + 44) as usize;
                        for f in first..first + num {
                            per_face_off.insert(f, o);
                        }
                    }
                }
            }
        }
    }

    // 3D-skybox cull center + playable bounds from spawns
    let sky_cam = ents
        .iter()
        .find(|e| e.map.get("classname").map(|c| c == "sky_camera").unwrap_or(false))
        .and_then(|e| vec3(e.map.get("origin")));
    const SKY_CULL_R: f32 = 2600.0;
    let (mut pmin, mut pmax) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    let mut has_play = false;
    for e in &ents {
        let cn = e.map.get("classname").cloned().unwrap_or_default();
        let spawn = matches!(
            cn.as_str(),
            "info_player_terrorist"
                | "info_player_counterterrorist"
                | "info_player_start"
                | "info_player_deathmatch"
                | "info_deathmatch_spawn"
        );
        if !spawn {
            continue;
        }
        if let Some(o) = vec3(e.map.get("origin")) {
            has_play = true;
            for k in 0..3 {
                pmin[k] = pmin[k].min(o[k]);
                pmax[k] = pmax[k].max(o[k]);
            }
        }
    }

    // output accumulators
    let mut pos: Vec<i16> = Vec::new();
    let mut mat: Vec<u8> = Vec::new();
    let (mut mn, mut mx) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    let q = |v: f32| -> i16 { v.round().clamp(-32768.0, 32767.0) as i16 };
    let mut push_tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3], m: u8| {
        if let Some(sc) = sky_cam {
            let mid = [(a[0] + b[0] + c[0]) / 3.0 - sc[0], (a[1] + b[1] + c[1]) / 3.0 - sc[1], (a[2] + b[2] + c[2]) / 3.0 - sc[2]];
            if mid[0] * mid[0] + mid[1] * mid[1] + mid[2] * mid[2] < SKY_CULL_R * SKY_CULL_R {
                return;
            }
        }
        let (e1, e2) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2] < 4.0 {
            return; // degenerate
        }
        for p in [a, b, c] {
            pos.push(q(p[0]));
            pos.push(q(p[1]));
            pos.push(q(p[2]));
        }
        mat.push(m);
        for k in 0..3 {
            mn[k] = mn[k].min(a[k]);
            mx[k] = mx[k].max(a[k]);
        }
    };

    let max_disp_cells = 8usize;
    for f in 0..n_faces {
        let bb = f * FACE_SIZE;
        let first_edge = i32le(faces, bb + 4);
        let num_edges = i16le(faces, bb + 8) as i32;
        let ti = i16le(faces, bb + 10) as i32;
        let di = i16le(faces, bb + 12) as i32;
        if num_edges < 3 {
            continue;
        }
        let flags = if ti >= 0 && (ti as usize) < n_texinfo { ti_flags[ti as usize] } else { 0 };
        if flags & SKIP_MASK != 0 {
            continue;
        }
        let m = if ti >= 0 && (ti as usize) < n_texinfo { ti_mat[ti as usize] } else { 0 };

        // gather face loop verts
        let mut fv: Vec<[f32; 3]> = Vec::with_capacity(num_edges as usize);
        let mut bad = false;
        for i in 0..num_edges {
            let si = (first_edge + i) as i64;
            if si < 0 || si as usize >= n_surf {
                bad = true;
                break;
            }
            let s = i32le(surf, si as usize * 4);
            let ei = s.unsigned_abs() as usize;
            if ei >= n_edges {
                bad = true;
                break;
            }
            let vi = if s >= 0 { u16le(edges, ei * 4) } else { u16le(edges, ei * 4 + 2) } as usize;
            if vi >= n_verts {
                bad = true;
                break;
            }
            fv.push([f32le(verts, vi * 12), f32le(verts, vi * 12 + 4), f32le(verts, vi * 12 + 8)]);
        }
        if bad {
            continue;
        }
        if let Some(off) = per_face_off.get(&f) {
            for v in fv.iter_mut() {
                v[0] += off[0];
                v[1] += off[1];
                v[2] += off[2];
            }
        }

        if di >= 0 && (di as usize) < n_disp && num_edges == 4 {
            emit_disp(di as usize, &fv, m, dispinfo, dispvert, max_disp_cells, &mut push_tri);
            continue;
        }
        // convex polygon → triangle fan
        for i in 1..(num_edges as usize - 1) {
            push_tri(fv[0], fv[i], fv[i + 1], m);
        }
    }

    if mat.is_empty() {
        return None;
    }

    // serialize CCG1
    let tri = mat.len();
    let mut out = vec![0u8; 64 + tri * 18 + tri];
    out[..4].copy_from_slice(b"CCG1");
    out[4..8].copy_from_slice(&(tri as u32).to_le_bytes());
    let bounds = [mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]];
    for i in 0..6 {
        out[8 + i * 4..12 + i * 4].copy_from_slice(&bounds[i].to_le_bytes());
    }
    let play = if has_play {
        [pmin[0], pmin[1], pmin[2], pmax[0], pmax[1], pmax[2]]
    } else {
        bounds
    };
    for i in 0..6 {
        out[32 + i * 4..36 + i * 4].copy_from_slice(&play[i].to_le_bytes());
    }
    out[56..60].copy_from_slice(&(has_play as u32).to_le_bytes());
    out[60..64].copy_from_slice(&(version as u32).to_le_bytes());
    let pbytes: Vec<u8> = pos.iter().flat_map(|v| v.to_le_bytes()).collect();
    out[64..64 + tri * 18].copy_from_slice(&pbytes[..tri * 18]);
    out[64 + tri * 18..].copy_from_slice(&mat);
    Some(out)
}

#[allow(clippy::too_many_arguments)]
fn emit_disp(
    di: usize,
    corners: &[[f32; 3]],
    m: u8,
    dispinfo: &[u8],
    dispvert: &[u8],
    max_cells: usize,
    push_tri: &mut impl FnMut([f32; 3], [f32; 3], [f32; 3], u8),
) {
    let base = di * DISPINFO_SIZE;
    let sp = [f32le(dispinfo, base), f32le(dispinfo, base + 4), f32le(dispinfo, base + 8)];
    let v_start = i32le(dispinfo, base + 12);
    let power = i32le(dispinfo, base + 20);
    if !(2..=4).contains(&power) || corners.len() < 4 {
        return;
    }
    let size = (1usize << power) + 1;
    // corner nearest startPosition = grid (0,0)
    let mut best = 0;
    let mut bd = f32::INFINITY;
    for i in 0..4 {
        let d = [corners[i][0] - sp[0], corners[i][1] - sp[1], corners[i][2] - sp[2]];
        let dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if dd < bd {
            bd = dd;
            best = i;
        }
    }
    let c: Vec<[f32; 3]> = (0..4).map(|i| corners[(best + i) % 4]).collect();
    let step = (((size - 1) / max_cells).max(1)) as usize;
    let mut rows: Vec<usize> = (0..size).step_by(step).collect();
    if *rows.last().unwrap() != size - 1 {
        rows.push(size - 1);
    }
    let lerp = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    let mut grid: Vec<Vec<[f32; 3]>> = Vec::new();
    for &i in &rows {
        let ti = i as f32 / (size - 1) as f32;
        let le = lerp(c[0], c[1], ti);
        let re = lerp(c[3], c[2], ti);
        let mut row = Vec::new();
        for &j in &rows {
            let tj = j as f32 / (size - 1) as f32;
            let mut p = lerp(le, re, tj);
            let vi = (v_start as usize + i * size + j) * 5;
            if vi + 4 < dispvert.len() / 4 {
                let dvo = vi * 4; // dispvert is f32 array; index*4 bytes
                let dvec = [f32le(dispvert, dvo), f32le(dispvert, dvo + 4), f32le(dispvert, dvo + 8)];
                let dist = f32le(dispvert, dvo + 12);
                p[0] += dvec[0] * dist;
                p[1] += dvec[1] * dist;
                p[2] += dvec[2] * dist;
            }
            row.push(p);
        }
        grid.push(row);
    }
    for i in 0..grid.len().saturating_sub(1) {
        for j in 0..grid[i].len().saturating_sub(1) {
            let (a, b, cc, d) = (grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]);
            push_tri(a, b, cc, m);
            push_tri(a, cc, d, m);
        }
    }
}

/// One placed static prop: model path, world origin, and Euler angles (pitch, yaw, roll).
pub struct PropInst {
    pub model: String,
    pub origin: [f32; 3],
    pub angles: [f32; 3],
}

/// Read `prop_static` placements out of a BSP's game lump (lump 35, sub-lump "sprp").
/// Layout: dictionary of model paths (128-byte names), a leaf array we skip, then the prop
/// array. The per-prop struct grew across versions, so we derive its stride from the block
/// size rather than hard-coding one — that keeps it working from CS:S through CS:GO.
pub fn map_props(path: &str) -> Vec<PropInst> {
    let mut out = Vec::new();
    let b = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return out,
    };
    if b.len() < 1036 || &b[..4] != b"VBSP" {
        return out;
    }
    // lump 35 header: 8 + 35*16
    let lh = 8 + 35 * 16;
    let ofs = i32le(&b, lh).max(0) as usize;
    let len = i32le(&b, lh + 4).max(0) as usize;
    if ofs == 0 || ofs + len > b.len() {
        return out;
    }
    let g = &b[ofs..ofs + len];
    let n_lumps = i32le(g, 0).max(0) as usize;
    let mut sprp: Option<(usize, usize, i32)> = None; // (offset, len, version)
    for i in 0..n_lumps.min(64) {
        let e = 4 + i * 20;
        if e + 20 > g.len() {
            break;
        }
        let id = i32le(g, e);
        let ver = i16le(g, e + 6) as i32;
        let fo = i32le(g, e + 8).max(0) as usize;
        let fl = i32le(g, e + 12).max(0) as usize;
        if id == 0x7370_7270 {
            // 'sprp'
            sprp = Some((fo, fl, ver));
            break;
        }
    }
    let (so, sl, _ver) = match sprp {
        Some(v) => v,
        None => return out,
    };
    if so + sl > b.len() {
        return out;
    }
    let s = &b[so..so + sl];
    let n_dict = i32le(s, 0).max(0) as usize;
    let mut names = Vec::with_capacity(n_dict);
    let mut p = 4;
    for _ in 0..n_dict.min(8192) {
        if p + 128 > s.len() {
            return out;
        }
        let raw = &s[p..p + 128];
        let end = raw.iter().position(|&c| c == 0).unwrap_or(128);
        names.push(String::from_utf8_lossy(&raw[..end]).replace('\\', "/").to_lowercase());
        p += 128;
    }
    if p + 4 > s.len() {
        return out;
    }
    let n_leaf = i32le(s, p).max(0) as usize;
    p += 4 + n_leaf * 2; // leaf array: u16 each
    if p + 4 > s.len() {
        return out;
    }
    let n_props = i32le(s, p).max(0) as usize;
    p += 4;
    let remain = s.len().saturating_sub(p);
    if n_props == 0 || remain == 0 {
        return out;
    }
    // stride varies by lump version (56, 60, 64, 72, 76…) — infer it
    let stride = remain / n_props;
    if !(40..=256).contains(&stride) {
        return out;
    }
    for i in 0..n_props {
        let o = p + i * stride;
        if o + 26 > s.len() {
            break;
        }
        let origin = [f32le(s, o), f32le(s, o + 4), f32le(s, o + 8)];
        let angles = [f32le(s, o + 12), f32le(s, o + 16), f32le(s, o + 20)];
        let ptype = i16le(s, o + 24) as usize;
        if let Some(m) = names.get(ptype) {
            out.push(PropInst { model: m.clone(), origin, angles });
        }
    }
    out
}

/// Map geometry WITH texture coordinates, grouped by material — what the glTF exporter needs
/// to actually skin the map. `map_geo` (the CCG1 blob) deliberately has no UVs because the
/// in-app 3D preview doesn't texture; this walks the same lumps and additionally computes
/// UVs from each face's texinfo vectors:  u = (dot(v, s.xyz) + s.w) / texWidth.
pub struct MapSurf {
    pub material: String,
    pub pos: Vec<[f32; 3]>,
    pub uv: Vec<[f32; 2]>,
    pub idx: Vec<u32>,
}

pub fn map_geo_textured(path: &str) -> Vec<MapSurf> {
    let b = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    if b.len() < 1036 || &b[..4] != b"VBSP" {
        return Vec::new();
    }
    let lump = |i: usize| -> &[u8] {
        let h = 8 + i * 16;
        let o = i32le(&b, h).max(0) as usize;
        let l = i32le(&b, h + 4).max(0) as usize;
        if o == 0 || o + l > b.len() { &[] } else { &b[o..o + l] }
    };
    let verts = lump(3);
    let edges = lump(12);
    let surf = lump(13);
    let mut faces = lump(7);
    if faces.is_empty() {
        faces = lump(58);
    }
    let texinfo = lump(6);
    let texdata = lump(2);
    let strtab = lump(44);
    let strdat = lump(43);
    let dispinfo = lump(26);
    let dispvert = lump(33);
    let n_disp = dispinfo.len() / DISPINFO_SIZE;
    if verts.is_empty() || faces.is_empty() || texinfo.is_empty() {
        return Vec::new();
    }

    // texdata -> material name (+ the texture size the UVs are normalised by)
    let n_texdata = texdata.len() / 32;
    let mut tex_name = vec![String::new(); n_texdata];
    let mut tex_wh = vec![(1f32, 1f32); n_texdata];
    for i in 0..n_texdata {
        let id = i32le(texdata, i * 32 + 12);
        tex_wh[i] = (i32le(texdata, i * 32 + 16).max(1) as f32, i32le(texdata, i * 32 + 20).max(1) as f32);
        if id >= 0 && (id as usize) < strtab.len() / 4 {
            let s = i32le(strtab, id as usize * 4) as usize;
            let mut e = s;
            while e < strdat.len() && strdat[e] != 0 {
                e += 1;
            }
            if s <= strdat.len() {
                tex_name[i] = String::from_utf8_lossy(&strdat[s..e.min(strdat.len())])
                    .replace('\\', "/")
                    .to_lowercase();
            }
        }
    }

    let n_texinfo = texinfo.len() / TEXINFO_SIZE;
    let n_faces = faces.len() / FACE_SIZE;
    let n_verts = verts.len() / 12;
    let n_edges = edges.len() / 4;
    let n_surf = surf.len() / 4;

    let mut by_mat: std::collections::HashMap<String, MapSurf> = std::collections::HashMap::new();
    for f in 0..n_faces {
        let bb = f * FACE_SIZE;
        let first_edge = i32le(faces, bb + 4);
        let num_edges = i16le(faces, bb + 8) as i32;
        let ti = i16le(faces, bb + 10) as i32;
        if num_edges < 3 || ti < 0 || ti as usize >= n_texinfo {
            continue;
        }
        let to = ti as usize * TEXINFO_SIZE;
        let flags = i32le(texinfo, to + 64);
        if flags & SKIP_MASK != 0 {
            continue;
        }
        let td = i32le(texinfo, to + 68);
        let (name, tw, th) = if td >= 0 && (td as usize) < n_texdata {
            (tex_name[td as usize].clone(), tex_wh[td as usize].0, tex_wh[td as usize].1)
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        // texture vectors: s = [0..16], t = [16..32]
        let sv = [f32le(texinfo, to), f32le(texinfo, to + 4), f32le(texinfo, to + 8), f32le(texinfo, to + 12)];
        let tv = [f32le(texinfo, to + 16), f32le(texinfo, to + 20), f32le(texinfo, to + 24), f32le(texinfo, to + 28)];

        let mut fv: Vec<[f32; 3]> = Vec::with_capacity(num_edges as usize);
        let mut bad = false;
        for i in 0..num_edges {
            let si = (first_edge + i) as i64;
            if si < 0 || si as usize >= n_surf {
                bad = true;
                break;
            }
            let s = i32le(surf, si as usize * 4);
            let ei = s.unsigned_abs() as usize;
            if ei >= n_edges {
                bad = true;
                break;
            }
            let vi = if s >= 0 { u16le(edges, ei * 4) } else { u16le(edges, ei * 4 + 2) } as usize;
            if vi >= n_verts {
                bad = true;
                break;
            }
            fv.push([f32le(verts, vi * 12), f32le(verts, vi * 12 + 4), f32le(verts, vi * 12 + 8)]);
        }
        if bad || fv.len() < 3 {
            continue;
        }
        let e = by_mat.entry(name.clone()).or_insert_with(|| MapSurf {
            material: name.clone(),
            pos: Vec::new(),
            uv: Vec::new(),
            idx: Vec::new(),
        });
        let mut uv_of = |v: &[f32; 3]| [
            (v[0] * sv[0] + v[1] * sv[1] + v[2] * sv[2] + sv[3]) / tw,
            (v[0] * tv[0] + v[1] * tv[1] + v[2] * tv[2] + tv[3]) / th,
        ];
        // Displacements (terrain, ground, rubble) are a 4-corner face plus a height grid — fan
        // triangulating the corners would leave a flat quad and lose the surface entirely,
        // which is why ground was missing from textured exports.
        let di = i16le(faces, bb + 12) as i32;
        if di >= 0 && (di as usize) < n_disp && fv.len() == 4 {
            let mut tri = |a: [f32; 3], b2: [f32; 3], c: [f32; 3], _m: u8| {
                let base = e.pos.len() as u32;
                for v in [a, b2, c] {
                    e.pos.push(v);
                    e.uv.push(uv_of(&v));
                }
                e.idx.extend_from_slice(&[base, base + 1, base + 2]);
            };
            emit_disp(di as usize, &fv, 0, dispinfo, dispvert, 8, &mut tri);
            continue;
        }
        let base = e.pos.len() as u32;
        for v in &fv {
            e.pos.push(*v);
            let t = uv_of(v);
            e.uv.push(t);
        }
        // fan-triangulate the face loop
        for i in 1..(fv.len() as u32 - 1) {
            e.idx.extend_from_slice(&[base, base + i, base + i + 1]);
        }
    }
    let mut out: Vec<MapSurf> = by_mat.into_values().filter(|s| !s.idx.is_empty()).collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.idx.len()));
    out
}


/// Sun + ambient taken from the map's `light_environment` entity, so an exported scene is lit
/// the way the map intends instead of relying on the viewer's default headlight.
/// Returns (sun_rgb, sun_intensity, sun_dir, ambient_rgb).
pub fn map_light(path: &str) -> Option<([f32; 3], f32, [f32; 3], [f32; 3])> {
    let b = std::fs::read(path).ok()?;
    if b.len() < 1036 || &b[..4] != b"VBSP" {
        return None;
    }
    let h = 8;
    let o = i32le(&b, h).max(0) as usize;
    let l = i32le(&b, h + 4).max(0) as usize;
    if o == 0 || o + l > b.len() {
        return None;
    }
    let ents = String::from_utf8_lossy(&b[o..o + l]).to_string();
    for block in ents.split('}') {
        if !block.contains("light_environment") {
            continue;
        }
        let kv = |key: &str| -> Option<String> {
            let pat = format!("\"{key}\"");
            let i = block.find(&pat)? + pat.len();
            let rest = &block[i..];
            let a = rest.find('"')? + 1;
            let bnd = rest[a..].find('"')? + a;
            Some(rest[a..bnd].to_string())
        };
        let nums = |v: &str| -> Vec<f32> {
            v.split_whitespace().filter_map(|x| x.parse::<f32>().ok()).collect()
        };
        let li = kv("_light").map(|v| nums(&v)).unwrap_or_default();
        let amb = kv("_ambient").map(|v| nums(&v)).unwrap_or_default();
        let pitch = kv("pitch").and_then(|v| v.parse::<f32>().ok());
        let ang = kv("angles").map(|v| nums(&v)).unwrap_or_default();
        // _light is "R G B brightness" in 0..255
        let (sr, sg, sb, bright) = (
            li.first().copied().unwrap_or(255.0) / 255.0,
            li.get(1).copied().unwrap_or(255.0) / 255.0,
            li.get(2).copied().unwrap_or(255.0) / 255.0,
            li.get(3).copied().unwrap_or(200.0),
        );
        let yaw = ang.get(1).copied().unwrap_or(0.0).to_radians();
        let pit = pitch.or_else(|| ang.first().copied()).unwrap_or(-45.0).to_radians();
        // Source: pitch is negative when pointing down; direction the light travels
        let dir = [pit.cos() * yaw.cos(), pit.cos() * yaw.sin(), pit.sin()];
        let ambient = [
            amb.first().copied().unwrap_or(40.0) / 255.0,
            amb.get(1).copied().unwrap_or(40.0) / 255.0,
            amb.get(2).copied().unwrap_or(50.0) / 255.0,
        ];
        return Some(([sr, sg, sb], (bright / 200.0).clamp(0.2, 8.0), dir, ambient));
    }
    None
}

/// Append static-prop geometry to a CCG1 blob so the in-app 3D preview shows the rails,
/// crates and clutter that make a map readable. `load` resolves a model path to its triangle
/// list (the caller owns VPK access, so bspgeo stays free of asset-pipeline dependencies).
///
/// CCG1 layout: [64-byte header][int16 xyz*3 per tri][1 material byte per tri]. Props are
/// appended to both arrays and triCount is bumped, so existing readers need no changes.
#[allow(clippy::type_complexity)]
pub fn append_props(
    blob: &[u8],
    bsp_path: &str,
    mut load: impl FnMut(&str) -> Option<Vec<[f32; 3]>>,
    max_tris: usize,
) -> Vec<u8> {
    const HDR: usize = 64;
    if blob.len() < HDR + 8 {
        return blob.to_vec();
    }
    let n0 = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
    let pos_end = HDR + n0 * 18;
    if pos_end + n0 > blob.len() {
        return blob.to_vec();
    }
    let props = map_props(bsp_path);
    if props.is_empty() {
        return blob.to_vec();
    }
    // group by model so each mesh is loaded once, most-used first
    let mut by_model: std::collections::HashMap<&str, Vec<&PropInst>> = std::collections::HashMap::new();
    for p in &props {
        by_model.entry(p.model.as_str()).or_default().push(p);
    }
    let mut groups: Vec<(&str, Vec<&PropInst>)> = by_model.into_iter().collect();
    groups.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));

    let mut new_pos: Vec<i16> = Vec::new();
    let mut new_mat: Vec<u8> = Vec::new();
    let mut budget = max_tris;
    let q = |v: f32| -> i16 { v.round().clamp(-32768.0, 32767.0) as i16 };
    for (model, insts) in groups {
        if budget == 0 {
            break;
        }
        let Some(tris) = load(model) else { continue };
        let per = tris.len() / 3;
        if per == 0 || per * insts.len() > budget {
            continue;
        }
        budget -= per * insts.len();
        for inst in insts {
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
            for t in &tris {
                let w = [
                    m[0][0] * t[0] + m[0][1] * t[1] + m[0][2] * t[2] + inst.origin[0],
                    m[1][0] * t[0] + m[1][1] * t[1] + m[1][2] * t[2] + inst.origin[1],
                    m[2][0] * t[0] + m[2][1] * t[1] + m[2][2] * t[2] + inst.origin[2],
                ];
                new_pos.push(q(w[0]));
                new_pos.push(q(w[1]));
                new_pos.push(q(w[2]));
            }
            for _ in 0..per {
                new_mat.push(3); // "prop" material slot
            }
        }
    }
    if new_mat.is_empty() {
        return blob.to_vec();
    }
    let total = n0 + new_mat.len();
    let mut out = Vec::with_capacity(blob.len() + new_pos.len() * 2 + new_mat.len());
    out.extend_from_slice(&blob[..HDR]);
    out[4..8].copy_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&blob[HDR..pos_end]);          // original positions
    for v in &new_pos {
        out.extend_from_slice(&v.to_le_bytes());          // prop positions
    }
    out.extend_from_slice(&blob[pos_end..pos_end + n0]);  // original materials
    out.extend_from_slice(&new_mat);                      // prop materials
    out
}
