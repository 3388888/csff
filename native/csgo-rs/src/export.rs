// glTF 2.0 (.glb) exporter — player motion + kill events, optionally with map geometry.
//
// Why glTF: Blender imports it natively (File ▸ Import ▸ glTF 2.0) and UE4/5 reads it through
// the Interchange importer, so one file serves both. .glb is a single self-contained binary,
// which matters because a match is thousands of keyframes.
//
// Coordinate systems: Source is Z-up / right-handed in inches-ish units; glTF is Y-up in
// metres. We convert (x, y, z)_source -> (x, z, -y)_gltf and scale by 0.01905 (1 Source unit
// = 0.75 inch). Maps and players therefore land at real-world scale in Blender/UE.

use std::collections::HashMap;

const U: f32 = 0.019_05; // Source units -> metres

fn v3(x: f32, y: f32, z: f32) -> [f32; 3] {
    [x * U, z * U, -y * U] // Z-up -> Y-up
}

/// One player's animation track.
pub struct Track {
    pub name: String,
    pub team: i32,
    pub times: Vec<f32>,
    pub pos: Vec<[f32; 3]>,
    pub rot: Vec<[f32; 4]>, // quaternion around the up axis (yaw)
    /// Scale keyframes: 1 while alive, 0 once dead. A dead player simply stops being sampled,
    /// so without this their node froze mid-air with no indication they'd died. Collapsing the
    /// scale makes them vanish on the exact death frame, and it's trivially editable in Blender.
    pub scale: Vec<[f32; 3]>,
    /// Index into the `models` slice passed to write_glb — the real character mesh for this
    /// player's team. None falls back to the proxy box.
    pub model: Option<usize>,
    /// Index into `props` for this player's weapon mesh — parented to the player node so it
    /// follows them through the clip.
    pub weapon: Option<usize>,
}

/// A kill, exported as a named empty at the victim's position.
pub struct Marker {
    pub name: String,
    pub time: f32,
    pub pos: [f32; 3],
}

#[derive(Default)]
struct Buf {
    data: Vec<u8>,
    views: Vec<String>,
    accessors: Vec<String>,
}

impl Buf {
    // pad to a 4-byte boundary — glTF requires aligned bufferViews
    fn align(&mut self) {
        while self.data.len() % 4 != 0 {
            self.data.push(0);
        }
    }
    fn push_f32(&mut self, vals: &[f32], comps: usize, ty: &str, minmax: bool) -> usize {
        self.align();
        let off = self.data.len();
        for v in vals {
            self.data.extend_from_slice(&v.to_le_bytes());
        }
        let len = self.data.len() - off;
        let vi = self.views.len();
        self.views.push(format!(
            r#"{{"buffer":0,"byteOffset":{off},"byteLength":{len}}}"#
        ));
        let count = vals.len() / comps;
        let mut extra = String::new();
        if minmax {
            // accessors for POSITION and animation input must carry min/max
            let mut mn = vec![f32::INFINITY; comps];
            let mut mx = vec![f32::NEG_INFINITY; comps];
            for c in vals.chunks(comps) {
                for i in 0..comps {
                    mn[i] = mn[i].min(c[i]);
                    mx[i] = mx[i].max(c[i]);
                }
            }
            let f = |a: &Vec<f32>| a.iter().map(|x| fmt(*x)).collect::<Vec<_>>().join(",");
            extra = format!(r#","min":[{}],"max":[{}]"#, f(&mn), f(&mx));
        }
        let ai = self.accessors.len();
        self.accessors.push(format!(
            r#"{{"bufferView":{vi},"componentType":5126,"count":{count},"type":"{ty}"{extra}}}"#
        ));
        ai
    }
    fn push_u32(&mut self, vals: &[u32]) -> usize {
        self.align();
        let off = self.data.len();
        for v in vals {
            self.data.extend_from_slice(&v.to_le_bytes());
        }
        let len = self.data.len() - off;
        let vi = self.views.len();
        self.views.push(format!(
            r#"{{"buffer":0,"byteOffset":{off},"byteLength":{len}}}"#
        ));
        let ai = self.accessors.len();
        self.accessors.push(format!(
            r#"{{"bufferView":{vi},"componentType":5125,"count":{},"type":"SCALAR"}}"#,
            vals.len()
        ));
        ai
    }
}

fn fmt(v: f32) -> String {
    if v.is_finite() {
        format!("{:.5}", v)
    } else {
        "0".into()
    }
}

/// A simple upright box, used as the player proxy (real player models aren't in the demo).
fn player_box() -> (Vec<f32>, Vec<u32>) {
    // 32x32x72 Source units, origin at the feet
    let (hx, hy, hz) = (16.0f32, 16.0, 72.0);
    let c = [
        v3(-hx, -hy, 0.0), v3(hx, -hy, 0.0), v3(hx, hy, 0.0), v3(-hx, hy, 0.0),
        v3(-hx, -hy, hz), v3(hx, -hy, hz), v3(hx, hy, hz), v3(-hx, hy, hz),
    ];
    let mut pos = Vec::new();
    for p in c {
        pos.extend_from_slice(&p);
    }
    let idx = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3,
        3, 7, 4, 3, 4, 0u32,
    ];
    (pos, idx)
}

/// Write a .glb containing every player's motion, kill markers, and optionally the map mesh.
/// `map_tris` is the CCG1 triangle soup from `bspgeo::map_geo` (already Source coords).
pub fn write_glb(
    tracks: &[Track],
    markers: &[Marker],
    map_tris: Option<&[[f32; 3]]>,
    models: &[(crate::mdl::Mesh, Option<Vec<u8>>)],
    props: &[(crate::mdl::Mesh, Option<Vec<u8>>)],
    // indices into `props` that are weapons (attached to players, not placed in the world)
    is_weapon: &[usize],
    // (sun_rgb, intensity, direction, ambient_rgb) from the map's light_environment
    light: Option<([f32; 3], f32, [f32; 3], [f32; 3])>,
    out_path: &str,
) -> std::io::Result<()> {
    let mut b = Buf::default();
    let mut nodes: Vec<String> = Vec::new();
    let mut meshes: Vec<String> = Vec::new();
    let mut anim_ch: Vec<String> = Vec::new();
    let mut anim_sa: Vec<String> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();

    // --- map mesh (optional) -------------------------------------------------
    if let Some(tris) = map_tris {
        if !tris.is_empty() {
            let mut pos = Vec::with_capacity(tris.len() * 3);
            for t in tris {
                let p = v3(t[0], t[1], t[2]);
                pos.extend_from_slice(&p);
            }
            let idx: Vec<u32> = (0..tris.len() as u32).collect();
            let pa = b.push_f32(&pos, 3, "VEC3", true);
            let ia = b.push_u32(&idx);
            let mi = meshes.len();
            meshes.push(format!(
                r#"{{"name":"map","primitives":[{{"attributes":{{"POSITION":{pa}}},"indices":{ia}}}]}}"#
            ));
            roots.push(nodes.len());
            nodes.push(format!(r#"{{"name":"map","mesh":{mi}}}"#));
        }
    }

    // --- real character models pulled from the game's VPKs -------------------
    // Each becomes its own mesh + embedded texture; players reference them by index, so ten
    // players sharing a model cost one mesh, not ten.
    let mut images: Vec<String> = Vec::new();
    let mut textures: Vec<String> = Vec::new();
    let mut materials: Vec<String> = Vec::new();
    let mut model_mesh: Vec<usize> = Vec::new();
    for (mesh, png) in models {
        let mut mpos = Vec::with_capacity(mesh.pos.len() * 3);
        for p in &mesh.pos {
            mpos.extend_from_slice(&v3(p[0], p[1], p[2]));
        }
        let mpa = b.push_f32(&mpos, 3, "VEC3", true);
        let mut mn = Vec::with_capacity(mesh.norm.len() * 3);
        for n in &mesh.norm {
            mn.extend_from_slice(&[n[0], n[2], -n[1]]);
        }
        let mna = if mn.len() == mpos.len() { Some(b.push_f32(&mn, 3, "VEC3", false)) } else { None };
        let muv: Vec<f32> = mesh.uv.iter().flat_map(|t| [t[0], t[1]]).collect();
        let mta = if mesh.uv.len() == mesh.pos.len() { Some(b.push_f32(&muv, 2, "VEC2", false)) } else { None };
        let mia = b.push_u32(&mesh.idx);
        let mut mat_ref = String::new();
        if let (Some(bytes), Some(_)) = (png.as_ref(), mta) {
            b.align();
            let off = b.data.len();
            b.data.extend_from_slice(bytes);
            let len = b.data.len() - off;
            let vi = b.views.len();
            b.views.push(format!(r#"{{"buffer":0,"byteOffset":{off},"byteLength":{len}}}"#));
            let img = images.len();
            images.push(format!(r#"{{"bufferView":{vi},"mimeType":"image/png"}}"#));
            let tex = textures.len();
            textures.push(format!(r#"{{"source":{img},"sampler":0}}"#));
            let mat = materials.len();
            materials.push(format!(r#"{{"name":"m{mat}","pbrMetallicRoughness":{{"baseColorTexture":{{"index":{tex}}},"metallicFactor":0.0,"roughnessFactor":0.9}}}}"#));
            mat_ref = format!(r#","material":{mat}"#);
        }
        let mut at = format!(r#""POSITION":{mpa}"#);
        if let Some(n) = mna {
            at.push_str(&format!(r#","NORMAL":{n}"#));
        }
        if let Some(t) = mta {
            at.push_str(&format!(r#","TEXCOORD_0":{t}"#));
        }
        model_mesh.push(meshes.len());
        meshes.push(format!(
            r#"{{"name":"model{}","primitives":[{{"attributes":{{{at}}},"indices":{mia}{mat_ref}}}]}}"#,
            model_mesh.len() - 1
        ));
    }

    let mut prop_mesh: Vec<usize> = Vec::new();
    // --- static props ---------------------------------------------------------
    // Each prop model arrives already baked into world space (rotation applied on the CPU),
    // so it is just another textured mesh with an identity node — no per-instance transforms
    // to get wrong, and props inherit the same PBR material path as characters.
    for (mesh, png) in props {
        if mesh.idx.is_empty() {
            continue;
        }
        let mut mpos = Vec::with_capacity(mesh.pos.len() * 3);
        for p in &mesh.pos {
            mpos.extend_from_slice(&v3(p[0], p[1], p[2]));
        }
        let mpa = b.push_f32(&mpos, 3, "VEC3", true);
        let mut mn = Vec::with_capacity(mesh.norm.len() * 3);
        for n in &mesh.norm {
            mn.extend_from_slice(&[n[0], n[2], -n[1]]);
        }
        let mna = if mn.len() == mpos.len() { Some(b.push_f32(&mn, 3, "VEC3", false)) } else { None };
        let muv: Vec<f32> = mesh.uv.iter().flat_map(|t| [t[0], t[1]]).collect();
        let mta = if mesh.uv.len() == mesh.pos.len() { Some(b.push_f32(&muv, 2, "VEC2", false)) } else { None };
        let mia = b.push_u32(&mesh.idx);
        let mut mat_ref = String::new();
        if let (Some(bytes), Some(_)) = (png.as_ref(), mta) {
            b.align();
            let off = b.data.len();
            b.data.extend_from_slice(bytes);
            let len = b.data.len() - off;
            let vi = b.views.len();
            b.views.push(format!(r#"{{"buffer":0,"byteOffset":{off},"byteLength":{len}}}"#));
            let img = images.len();
            images.push(format!(r#"{{"bufferView":{vi},"mimeType":"image/png"}}"#));
            let tex = textures.len();
            textures.push(format!(r#"{{"source":{img},"sampler":0}}"#));
            let mat = materials.len();
            materials.push(format!(r#"{{"name":"p{mat}","pbrMetallicRoughness":{{"baseColorTexture":{{"index":{tex}}},"metallicFactor":0.0,"roughnessFactor":0.9}}}}"#));
            mat_ref = format!(r#","material":{mat}"#);
        }
        let mut at = format!(r#""POSITION":{mpa}"#);
        if let Some(n) = mna {
            at.push_str(&format!(r#","NORMAL":{n}"#));
        }
        if let Some(t) = mta {
            at.push_str(&format!(r#","TEXCOORD_0":{t}"#));
        }
        let mi = meshes.len();
        meshes.push(format!(r#"{{"name":"props{mi}","primitives":[{{"attributes":{{{at}}},"indices":{mia}{mat_ref}}}]}}"#));
        prop_mesh.push(mi);
        // weapon meshes are referenced by player nodes, not placed in the world themselves
        if !is_weapon.contains(&prop_mesh.len().saturating_sub(1)) {
            roots.push(nodes.len());
            nodes.push(format!(r#"{{"name":"props{mi}","mesh":{mi}}}"#));
        }
    }

    // --- shared player proxy mesh -------------------------------------------
    let (bpos, bidx) = player_box();
    let bpa = b.push_f32(&bpos, 3, "VEC3", true);
    let bia = b.push_u32(&bidx);
    let box_mesh = meshes.len();
    meshes.push(format!(
        r#"{{"name":"player_proxy","primitives":[{{"attributes":{{"POSITION":{bpa}}},"indices":{bia}}}]}}"#
    ));

    // --- one animated node per player ---------------------------------------
    for t in tracks {
        if t.times.is_empty() {
            continue;
        }
        let ni = nodes.len();
        let team = if t.team == 3 { "CT" } else if t.team == 2 { "T" } else { "spec" };
        let mesh_idx = t.model.and_then(|i| model_mesh.get(i).copied()).unwrap_or(box_mesh);
        // weapon rides along as a child node, roughly at hand height / slightly forward-right
        let wchild = t.weapon.and_then(|i| prop_mesh.get(i).copied()).map(|wm| {
            let wi = nodes.len() + 1; // this player node is about to take `nodes.len()`
            (wi, wm)
        });
        let children = match wchild {
            Some((wi, _)) => format!(r#","children":[{wi}]"#),
            None => String::new(),
        };
        nodes.push(format!(
            r#"{{"name":{},"mesh":{mesh_idx}{children}}}"#,
            json_str(&format!("{}_{}", sanitize(&t.name), team))
        ));
        if let Some((_, wm)) = wchild {
            let h = v3(6.0, -6.0, 46.0); // right hand-ish, in metres after conversion
            nodes.push(format!(
                r#"{{"name":{},"mesh":{wm},"translation":[{},{},{}]}}"#,
                json_str(&format!("{}_weapon", sanitize(&t.name))),
                fmt(h[0]), fmt(h[1]), fmt(h[2])
            ));
        }
        roots.push(ni);

        let ta = b.push_f32(&t.times, 1, "SCALAR", true);
        let pflat: Vec<f32> = t.pos.iter().flat_map(|p| p.iter().copied()).collect();
        let pa = b.push_f32(&pflat, 3, "VEC3", false);
        let rflat: Vec<f32> = t.rot.iter().flat_map(|r| r.iter().copied()).collect();
        let ra = b.push_f32(&rflat, 4, "VEC4", false);
        let sflat: Vec<f32> = t.scale.iter().flat_map(|r| r.iter().copied()).collect();
        let sa_acc = if t.scale.len() == t.times.len() { Some(b.push_f32(&sflat, 3, "VEC3", false)) } else { None };

        let s0 = anim_sa.len();
        anim_sa.push(format!(r#"{{"input":{ta},"output":{pa},"interpolation":"LINEAR"}}"#));
        anim_sa.push(format!(r#"{{"input":{ta},"output":{ra},"interpolation":"LINEAR"}}"#));
        if let Some(sc) = sa_acc {
            // STEP so the model pops out at the death frame instead of shrinking gradually
            anim_sa.push(format!(r#"{{"input":{ta},"output":{sc},"interpolation":"STEP"}}"#));
            anim_ch.push(format!(
                r#"{{"sampler":{},"target":{{"node":{ni},"path":"scale"}}}}"#,
                anim_sa.len() - 1
            ));
        }
        anim_ch.push(format!(
            r#"{{"sampler":{s0},"target":{{"node":{ni},"path":"translation"}}}}"#
        ));
        anim_ch.push(format!(
            r#"{{"sampler":{},"target":{{"node":{ni},"path":"rotation"}}}}"#,
            s0 + 1
        ));
    }

    // --- kill markers as empties --------------------------------------------
    for m in markers {
        let ni = nodes.len();
        nodes.push(format!(
            r#"{{"name":{},"translation":[{},{},{}]}}"#,
            json_str(&m.name),
            fmt(m.pos[0]),
            fmt(m.pos[1]),
            fmt(m.pos[2])
        ));
        roots.push(ni);
    }

    let animations = if anim_ch.is_empty() {
        String::new()
    } else {
        format!(
            r#","animations":[{{"name":"demo","channels":[{}],"samplers":[{}]}}]"#,
            anim_ch.join(","),
            anim_sa.join(",")
        )
    };

    // --- map lighting (KHR_lights_punctual) ----------------------------------
    // A directional "sun" aimed the way the map's light_environment points, so imports are lit
    // like the map instead of relying on the viewer's default headlight.
    let (lights_ext, light_node, ext_used) = match light {
        Some((rgb, inten, dir, _amb)) => {
            // glTF spot/directional lights shine down -Z; build a rotation that takes -Z to dir
            let d = v3(dir[0], dir[1], dir[2]);
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-6);
            let d = [d[0] / len, d[1] / len, d[2] / len];
            // quaternion rotating (0,0,-1) onto d
            let a = [-d[1], d[0], 0.0f32]; // cross((0,0,-1), d) = (-d.y, d.x, 0)
            let w = 1.0 - d[2]; // 1 + dot((0,0,-1), d) with dot = -d.z
            let n = (a[0] * a[0] + a[1] * a[1] + w * w).sqrt().max(1e-6);
            let q = [a[0] / n, a[1] / n, 0.0, w / n];
            let ni = nodes.len();
            nodes.push(format!(
                r#"{{"name":"sun","rotation":[{},{},{},{}],"extensions":{{"KHR_lights_punctual":{{"light":0}}}}}}"#,
                fmt(q[0]), fmt(q[1]), fmt(q[2]), fmt(q[3])
            ));
            roots.push(ni);
            (
                format!(
                    r#","extensions":{{"KHR_lights_punctual":{{"lights":[{{"type":"directional","color":[{},{},{}],"intensity":{}}}]}}}}"#,
                    fmt(rgb[0]), fmt(rgb[1]), fmt(rgb[2]), fmt(inten)
                ),
                true,
                r#","extensionsUsed":["KHR_lights_punctual"]"#,
            )
        }
        None => (String::new(), false, ""),
    };
    let _ = light_node;

    let extra_assets = if images.is_empty() {
        String::new()
    } else {
        format!(
            r#","images":[{}],"textures":[{}],"samplers":[{{"wrapS":10497,"wrapT":10497}}],"materials":[{}]"#,
            images.join(","), textures.join(","), materials.join(",")
        )
    };
    b.align();
    let json = format!(
        r#"{{"asset":{{"version":"2.0","generator":"demo-reader"}},"scene":0,"scenes":[{{"nodes":[{}]}}],"nodes":[{}],"meshes":[{}]{extra_assets}{lights_ext}{ext_used},"accessors":[{}],"bufferViews":[{}],"buffers":[{{"byteLength":{}}}]{}}}"#,
        roots.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","),
        nodes.join(","),
        meshes.join(","),
        b.accessors.join(","),
        b.views.join(","),
        b.data.len(),
        animations
    );

    // --- .glb container: header + JSON chunk + BIN chunk ---------------------
    let mut jb = json.into_bytes();
    while jb.len() % 4 != 0 {
        jb.push(b' ');
    }
    let total = 12 + 8 + jb.len() + 8 + b.data.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&jb);
    out.extend_from_slice(&(b.data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&b.data);
    std::fs::write(out_path, out)
}

fn sanitize(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let t = t.trim_matches('_').to_string();
    if t.is_empty() { "player".into() } else { t.chars().take(32).collect() }
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Yaw (degrees, Source) -> glTF quaternion about the up (Y) axis.
pub fn yaw_quat(yaw_deg: f32) -> [f32; 4] {
    let a = -yaw_deg.to_radians() * 0.5;
    [0.0, a.sin(), 0.0, a.cos()]
}

/// Build per-player tracks from a sampled timeline.
/// `frames` = (tick, [(uid, x, y, z, yaw, team)]).
pub fn tracks_from_timeline(
    frames: &[(i32, Vec<(i64, f32, f32, f32, f32, i32)>)],
    names: &HashMap<i64, String>,
    tickrate: i32,
) -> Vec<Track> {
    // (see Track::scale) a player who stops appearing has died — we append a zero-scale key
    // just after their last sample so they visibly disappear.
    let tr = if tickrate > 0 { tickrate as f32 } else { 64.0 };
    let mut by_uid: HashMap<i64, Track> = HashMap::new();
    for (tick, players) in frames {
        let t = *tick as f32 / tr;
        for (uid, x, y, z, yaw, team) in players {
            let e = by_uid.entry(*uid).or_insert_with(|| Track {
                name: names.get(uid).cloned().unwrap_or_else(|| format!("uid{uid}")),
                team: *team,
                times: Vec::new(),
                pos: Vec::new(),
                rot: Vec::new(),
                scale: Vec::new(),
                model: None,
                weapon: None,
            });
            e.team = *team;
            e.times.push(t);
            e.pos.push(v3(*x, *y, *z));
            e.rot.push(yaw_quat(*yaw));
            e.scale.push([1.0, 1.0, 1.0]);
        }
    }
    // last frame in the clip — anyone missing from it died (or left) and should vanish
    let last_t = frames.last().map(|(t, _)| *t as f32 / tr).unwrap_or(0.0);
    let mut v: Vec<Track> = by_uid.into_values().collect();
    for t in v.iter_mut() {
        if let Some(&end) = t.times.last() {
            if end < last_t - 0.001 {
                let p = *t.pos.last().unwrap();
                let r = *t.rot.last().unwrap();
                t.times.push(end + 1.0 / tr.max(1.0));
                t.pos.push(p);
                t.rot.push(r);
                t.scale.push([0.0, 0.0, 0.0]); // dead: gone from here on
            }
        }
    }
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// Marker for a kill at the victim's position.
pub fn marker(name: &str, tick: i32, tickrate: i32, x: f32, y: f32, z: f32) -> Marker {
    let tr = if tickrate > 0 { tickrate as f32 } else { 64.0 };
    Marker { name: name.to_string(), time: tick as f32 / tr, pos: v3(x, y, z) }
}

/// Write a single static mesh with an optional embedded PNG texture.
/// The PNG goes straight into the .glb binary chunk (a self-contained file — no loose
/// image next to it), wired up as baseColorTexture on a PBR material.
/// Source units -> metres and Z-up -> Y-up, same convention as the demo export, so a model
/// and a demo clip line up when imported into the same scene.
pub fn write_mesh_glb(
    m: &crate::mdl::Mesh,
    out_path: &str,
    png: Option<&[u8]>,
) -> std::io::Result<()> {
    let mut b = Buf::default();
    let mut pos = Vec::with_capacity(m.pos.len() * 3);
    for p in &m.pos {
        pos.extend_from_slice(&v3(p[0], p[1], p[2]));
    }
    let pa = b.push_f32(&pos, 3, "VEC3", true);
    let mut norm = Vec::with_capacity(m.norm.len() * 3);
    for n in &m.norm {
        norm.extend_from_slice(&[n[0], n[2], -n[1]]); // rotate, never scale
    }
    let na = if norm.len() == pos.len() { Some(b.push_f32(&norm, 3, "VEC3", false)) } else { None };
    let uvflat: Vec<f32> = m.uv.iter().flat_map(|t| [t[0], t[1]]).collect();
    let ta = if m.uv.len() == m.pos.len() { Some(b.push_f32(&uvflat, 2, "VEC2", false)) } else { None };
    let ia = b.push_u32(&m.idx);

    // embed the texture as a bufferView-backed image
    let (images, textures, materials, mat_ref) = match png {
        Some(bytes) if ta.is_some() => {
            b.align();
            let off = b.data.len();
            b.data.extend_from_slice(bytes);
            let len = b.data.len() - off;
            let vi = b.views.len();
            b.views.push(format!(r#"{{"buffer":0,"byteOffset":{off},"byteLength":{len}}}"#));
            (
                format!(r#","images":[{{"bufferView":{vi},"mimeType":"image/png"}}]"#),
                r#","textures":[{"source":0,"sampler":0}],"samplers":[{"wrapS":10497,"wrapT":10497}]"#.to_string(),
                r#","materials":[{"name":"mat","pbrMetallicRoughness":{"baseColorTexture":{"index":0},"metallicFactor":0.0,"roughnessFactor":0.9}}]"#.to_string(),
                r#","material":0"#.to_string(),
            )
        }
        _ => (String::new(), String::new(), String::new(), String::new()),
    };

    let mut attrs = format!(r#""POSITION":{pa}"#);
    if let Some(n) = na {
        attrs.push_str(&format!(r#","NORMAL":{n}"#));
    }
    if let Some(t) = ta {
        attrs.push_str(&format!(r#","TEXCOORD_0":{t}"#));
    }
    b.align();
    let json = format!(
        r#"{{"asset":{{"version":"2.0","generator":"demo-reader"}},"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"name":"model","mesh":0}}],"meshes":[{{"name":"model","primitives":[{{"attributes":{{{attrs}}},"indices":{ia}{mat_ref}}}]}}]{images}{textures}{materials},"accessors":[{}],"bufferViews":[{}],"buffers":[{{"byteLength":{}}}]}}"#,
        b.accessors.join(","),
        b.views.join(","),
        b.data.len()
    );
    let mut jb = json.into_bytes();
    while jb.len() % 4 != 0 {
        jb.push(b' ');
    }
    let total = 12 + 8 + jb.len() + 8 + b.data.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&jb);
    out.extend_from_slice(&(b.data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN ");
    out.extend_from_slice(&b.data);
    std::fs::write(out_path, out)
}
