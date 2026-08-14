// mdl.rs — Source model geometry: .vvd (vertices) + .vtx (index buffers) -> a plain mesh.
//
// A Source model is split across three files:
//   .mdl  — bones, materials, bodyparts metadata (not needed for raw geometry)
//   .vvd  — the vertex pool: 48-byte mstudiovertex_t (boneweights 16 | pos 12 | normal 12 | uv 8)
//   .vtx  — hardware-optimised index buffers, nested
//           bodyPart -> model -> LOD -> mesh -> stripGroup -> { vertices[], indices[] }
//           A stripGroup vertex is 9 bytes and its `origMeshVertID` (u16 @4) indexes the .vvd
//           pool; the u16 indices index the stripGroup's own vertex array.
//
// We take LOD 0 and merge every bodypart/model/mesh into one mesh, which is what you want for
// dropping a weapon or player model into Blender/UE.

#[derive(Default)]
pub struct Mesh {
    pub pos: Vec<[f32; 3]>,
    pub norm: Vec<[f32; 3]>,
    pub uv: Vec<[f32; 2]>,
    pub idx: Vec<u32>,
}

fn i32le(b: &[u8], o: usize) -> i32 {
    if o + 4 > b.len() { return 0; }
    i32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u16le(b: &[u8], o: usize) -> u16 {
    if o + 2 > b.len() { return 0; }
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn f32le(b: &[u8], o: usize) -> f32 {
    if o + 4 > b.len() { return 0.0; }
    f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

/// Vertex pool from a .vvd. Applies fixups when present (they reorder verts per LOD).
fn vvd_vertices(vvd: &[u8]) -> Option<(Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<[f32; 2]>)> {
    if vvd.len() < 64 || &vvd[..4] != b"IDSV" {
        return None;
    }
    let num_lod_verts = i32le(vvd, 16).max(0) as usize; // LOD0 count
    let fixup_count = i32le(vvd, 48).max(0) as usize;
    let fixup_off = i32le(vvd, 52).max(0) as usize;
    let vert_off = i32le(vvd, 56).max(0) as usize;

    let read_vert = |i: usize| -> Option<([f32; 3], [f32; 3], [f32; 2])> {
        let o = vert_off + i * 48;
        if o + 48 > vvd.len() {
            return None;
        }
        Some((
            [f32le(vvd, o + 16), f32le(vvd, o + 20), f32le(vvd, o + 24)],
            [f32le(vvd, o + 28), f32le(vvd, o + 32), f32le(vvd, o + 36)],
            [f32le(vvd, o + 40), f32le(vvd, o + 44)],
        ))
    };

    let mut pos = Vec::new();
    let mut norm = Vec::new();
    let mut uv = Vec::new();
    if fixup_count == 0 {
        for i in 0..num_lod_verts {
            if let Some((p, n, t)) = read_vert(i) {
                pos.push(p);
                norm.push(n);
                uv.push(t);
            }
        }
    } else {
        // vertexFileFixup_t { int lod; int sourceVertexID; int numVertexes; }
        for f in 0..fixup_count {
            let o = fixup_off + f * 12;
            if o + 12 > vvd.len() {
                break;
            }
            let lod = i32le(vvd, o);
            if lod < 0 {
                continue;
            }
            let src = i32le(vvd, o + 4).max(0) as usize;
            let n = i32le(vvd, o + 8).max(0) as usize;
            for i in 0..n {
                if let Some((p, nn, t)) = read_vert(src + i) {
                    pos.push(p);
                    norm.push(nn);
                    uv.push(t);
                }
            }
        }
    }
    Some((pos, norm, uv))
}

/// Per-mesh vertex offsets read out of the .mdl. The VTX `origMeshVertID` is relative to its
/// OWN mesh, so the real .vvd index is `model.vertexindex/48 + mesh.vertexoffset + origID`.
/// Without these every mesh indexed from zero and collapsed onto the first one — which is why
/// multi-part player models exported as a flat plane while single-mesh weapons looked fine.
fn mdl_vertex_offsets(mdl: &[u8]) -> Vec<Vec<Vec<usize>>> {
    let g = |o: usize| -> i32 {
        if o + 4 > mdl.len() { 0 } else { i32::from_le_bytes(mdl[o..o + 4].try_into().unwrap()) }
    };
    let mut out = Vec::new();
    let n_bp = g(232).max(0) as usize;
    let bp_i = g(236).max(0) as usize;
    for bp in 0..n_bp.min(64) {
        let bo = bp_i + bp * 16;
        let n_mod = g(bo + 4).max(0) as usize;
        let mod_i = bo + g(bo + 12) as usize;
        let mut models = Vec::new();
        for m in 0..n_mod.min(64) {
            let mo = mod_i + m * 148;
            let n_mesh = g(mo + 72).max(0) as usize;
            let mesh_i = mo + g(mo + 76) as usize;
            let model_base = (g(mo + 84).max(0) as usize) / 48; // vertexindex is in BYTES
            let mut meshes = Vec::new();
            for me in 0..n_mesh.min(128) {
                let eo = mesh_i + me * 116;
                meshes.push(model_base + g(eo + 12).max(0) as usize); // + vertexoffset
            }
            models.push(meshes);
        }
        out.push(models);
    }
    out
}

/// Build one merged LOD-0 mesh from a .mdl + .vvd + .vtx triple.
pub fn mesh_from_mdl(mdl: &[u8], vvd: &[u8], vtx: &[u8]) -> Option<Mesh> {
    let offs = mdl_vertex_offsets(mdl);
    mesh_build(vvd, vtx, Some(&offs))
}

/// Back-compat: no .mdl available, so every offset is zero (correct for single-mesh models).
pub fn mesh_from(vvd: &[u8], vtx: &[u8]) -> Option<Mesh> {
    mesh_build(vvd, vtx, None)
}

fn mesh_build(vvd: &[u8], vtx: &[u8], offs: Option<&Vec<Vec<Vec<usize>>>>) -> Option<Mesh> {
    let (pos, norm, uv) = vvd_vertices(vvd)?;
    if pos.is_empty() || vtx.len() < 36 {
        return None;
    }
    // FileHeader_t: version@0, vertCacheSize@4, maxBonesPerStrip@8(u16), maxBonesPerTri@10(u16),
    // maxBonesPerVert@12, checkSum@16, numLODs@20, matReplListOffset@24,
    // numBodyParts@28, bodyPartOffset@32
    let num_body = i32le(vtx, 28).max(0) as usize;
    let body_off = i32le(vtx, 32).max(0) as usize;
    if num_body == 0 || num_body > 4096 {
        return None;
    }

    let mut out = Mesh { pos, norm, uv, idx: Vec::new() };
    let nverts = out.pos.len() as u32;

    for bp in 0..num_body {
        let bp_off = offs.and_then(|o| o.get(bp));
        // BodyPartHeader_t { int numModels; int modelOffset; }
        let b = body_off + bp * 8;
        if b + 8 > vtx.len() {
            break;
        }
        let num_models = i32le(vtx, b).max(0) as usize;
        let model_off = b + i32le(vtx, b + 4) as usize;
        for m in 0..num_models {
            let m_off = bp_off.and_then(|b| b.get(m));
            // ModelHeader_t { int numLODs; int lodOffset; }
            let mo = model_off + m * 8;
            if mo + 8 > vtx.len() {
                break;
            }
            let num_lods = i32le(vtx, mo).max(0) as usize;
            if num_lods == 0 {
                continue;
            }
            let lod_off = mo + i32le(vtx, mo + 4) as usize;
            // LOD 0 only: ModelLODHeader_t { int numMeshes; int meshOffset; float switchPoint; }
            if lod_off + 12 > vtx.len() {
                continue;
            }
            let num_meshes = i32le(vtx, lod_off).max(0) as usize;
            let mesh_off = lod_off + i32le(vtx, lod_off + 4) as usize;
            for me in 0..num_meshes {
                let base_vert = m_off.and_then(|mm| mm.get(me).copied()).unwrap_or(0);
                // MeshHeader_t { int numStripGroups; int stripGroupHeaderOffset; byte flags; }
                let meo = mesh_off + me * 9;
                if meo + 9 > vtx.len() {
                    break;
                }
                let num_sg = i32le(vtx, meo).max(0) as usize;
                let sg_off = meo + i32le(vtx, meo + 4) as usize;
                for sg in 0..num_sg {
                    // StripGroupHeader_t { int numVerts; int vertOffset; int numIndices;
                    //                      int indexOffset; int numStrips; int stripOffset;
                    //                      byte flags; }
                    let so = sg_off + sg * 25;
                    if so + 25 > vtx.len() {
                        break;
                    }
                    let n_v = i32le(vtx, so).max(0) as usize;
                    let v_off = so + i32le(vtx, so + 4) as usize;
                    let n_i = i32le(vtx, so + 8).max(0) as usize;
                    let i_off = so + i32le(vtx, so + 12) as usize;
                    // stripGroup vertex -> .vvd index
                    let mut map = Vec::with_capacity(n_v);
                    for v in 0..n_v {
                        let o = v_off + v * 9;
                        if o + 9 > vtx.len() {
                            break;
                        }
                        map.push(base_vert as u32 + u16le(vtx, o + 4) as u32); // mesh-relative -> global
                    }
                    for i in 0..n_i {
                        let o = i_off + i * 2;
                        if o + 2 > vtx.len() {
                            break;
                        }
                        let li = u16le(vtx, o) as usize;
                        if let Some(&gi) = map.get(li) {
                            if gi < nverts {
                                out.idx.push(gi);
                            }
                        }
                    }
                }
            }
        }
    }
    if out.idx.is_empty() {
        return None;
    }
    Some(out)
}
