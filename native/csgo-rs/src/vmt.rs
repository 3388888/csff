// vmt.rs — Valve Material Type: the text file that maps a model's material NAME to the actual
// texture file. A .mdl says "use material `ak47`"; materials/…/ak47.vmt then says
// `"$basetexture" "models/weapons/w_models/w_rif_ak47/ak47"`. Without this link you can
// extract a model and its texture but not know which belongs to which.
//
// Format is a nested brace block of "key" "value" pairs; we only need a few keys, so we scan
// tokens rather than building a full tree. Patch materials ("patch" shaders) redirect to
// another vmt via `include`, which we follow.

/// Pull `$basetexture` (or the patch `include` target) out of a .vmt.
pub fn base_texture(text: &str) -> Option<String> {
    let mut include = None;
    let mut it = tokens(text).into_iter().peekable();
    while let Some(t) = it.next() {
        let k = t.trim_matches('"').to_lowercase();
        if k == "$basetexture" || k == "$basetexture2" {
            if let Some(v) = it.peek() {
                let v = v.trim_matches('"').replace('\\', "/");
                if !v.is_empty() && !v.starts_with('{') {
                    return Some(v);
                }
            }
        } else if k == "include" {
            if let Some(v) = it.peek() {
                include = Some(v.trim_matches('"').replace('\\', "/"));
            }
        }
    }
    include // a patch material: caller resolves the included vmt
}

/// True when this vmt is a `patch` that only redirects.
pub fn is_patch(text: &str) -> bool {
    text.trim_start().trim_start_matches('"').to_lowercase().starts_with("patch")
}

fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_q = !in_q;
                if !in_q {
                    out.push(cur.clone());
                    cur.clear();
                }
            }
            '/' if !in_q && chars.peek() == Some(&'/') => {
                for c2 in chars.by_ref() {
                    if c2 == '\n' {
                        break;
                    }
                }
            }
            c if in_q => cur.push(c),
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(cur.clone());
                    cur.clear();
                }
            }
            '{' | '}' => {
                if !cur.is_empty() {
                    out.push(cur.clone());
                    cur.clear();
                }
                out.push(c.to_string());
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Material names + search paths a .mdl declares (mstudiotexture_t + cdtextures).
/// MDL header: numtextures@204, textureindex@208, numcdtextures@212, cdtextureindex@216.
pub fn mdl_materials(mdl: &[u8]) -> (Vec<String>, Vec<String>) {
    let g32 = |o: usize| -> i32 {
        if o + 4 > mdl.len() { 0 } else { i32::from_le_bytes(mdl[o..o + 4].try_into().unwrap()) }
    };
    let cstr = |o: usize| -> String {
        if o >= mdl.len() { return String::new(); }
        let e = mdl[o..].iter().position(|&c| c == 0).unwrap_or(0) + o;
        String::from_utf8_lossy(&mdl[o..e]).to_string()
    };
    let mut names = Vec::new();
    let n_tex = g32(204).max(0) as usize;
    let tex_i = g32(208).max(0) as usize;
    for i in 0..n_tex.min(256) {
        let base = tex_i + i * 64; // mstudiotexture_t is 64 bytes; sznameindex is relative
        let off = g32(base);
        if off != 0 {
            names.push(cstr((base as i32 + off).max(0) as usize).replace('\\', "/"));
        }
    }
    let mut dirs = Vec::new();
    let n_cd = g32(212).max(0) as usize;
    let cd_i = g32(216).max(0) as usize;
    for i in 0..n_cd.min(32) {
        let p = g32(cd_i + i * 4);
        if p > 0 {
            dirs.push(cstr(p as usize).replace('\\', "/"));
        }
    }
    (names, dirs)
}
