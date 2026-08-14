// vpk.rs — reader for Valve Pak archives (VPK v1/v2), the container every Source game ships
// its assets in: maps (.bsp), models (.mdl/.vvd/.vtx), materials (.vmt) and textures (.vtf).
//
// Layout: `<name>_dir.vpk` holds the directory tree; file data lives either inline in the dir
// file (archive index 0x7fff) or in sibling `<name>_000.vpk`, `_001.vpk`, … The tree is three
// nested NUL-terminated string levels — extension, path, filename — each level ended by an
// empty string:
//
//   ext\0 { path\0 { file\0 { crc:u32 preload:u16 archive:u16 offset:u32 length:u32 0xffff
//                            <preload bytes> } } }
//
// A full path is "path/file.ext" (path is " " for the archive root).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Entry {
    pub archive: u16, // 0x7fff = data sits inline in the _dir file
    pub offset: u32,
    pub length: u32,
    pub preload: Vec<u8>, // small files can live entirely here
}

pub struct Vpk {
    dir_path: PathBuf,
    prefix: String,          // "<dir>/<name>" for locating _NNN.vpk parts
    dir_data_base: u64,      // where inline (0x7fff) data starts in the _dir file
    pub files: HashMap<String, Entry>,
}

struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Rd<'a> {
    fn u16(&mut self) -> u16 {
        let v = u16::from_le_bytes(self.b[self.p..self.p + 2].try_into().unwrap());
        self.p += 2;
        v
    }
    fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes(self.b[self.p..self.p + 4].try_into().unwrap());
        self.p += 4;
        v
    }
    fn cstr(&mut self) -> String {
        let s = self.p;
        while self.p < self.b.len() && self.b[self.p] != 0 {
            self.p += 1;
        }
        let out = String::from_utf8_lossy(&self.b[s..self.p]).to_string();
        self.p += 1; // NUL
        out
    }
    fn ok(&self, n: usize) -> bool {
        self.p + n <= self.b.len()
    }
}

impl Vpk {
    /// Open a `*_dir.vpk` (or a single-part .vpk) and parse its directory tree.
    pub fn open(dir_vpk: &str) -> Option<Vpk> {
        let raw = std::fs::read(dir_vpk).ok()?;
        if raw.len() < 12 {
            return None;
        }
        let mut r = Rd { b: &raw, p: 0 };
        if r.u32() != 0x55aa_1234 {
            return None; // not a VPK
        }
        let version = r.u32();
        let tree_size = r.u32() as usize;
        // v2 adds four more u32 header fields we don't need to read the tree
        let header = if version >= 2 { 28 } else { 12 };
        if header + tree_size > raw.len() {
            return None;
        }
        let mut t = Rd { b: &raw[header..header + tree_size], p: 0 };

        let mut files = HashMap::new();
        loop {
            if !t.ok(1) {
                break;
            }
            let ext = t.cstr();
            if ext.is_empty() {
                break;
            }
            loop {
                if !t.ok(1) {
                    break;
                }
                let path = t.cstr();
                if path.is_empty() {
                    break;
                }
                loop {
                    if !t.ok(1) {
                        break;
                    }
                    let name = t.cstr();
                    if name.is_empty() {
                        break;
                    }
                    if !t.ok(18) {
                        break;
                    }
                    let _crc = t.u32();
                    let preload_len = t.u16() as usize;
                    let archive = t.u16();
                    let offset = t.u32();
                    let length = t.u32();
                    let _term = t.u16();
                    let preload = if preload_len > 0 && t.ok(preload_len) {
                        let v = t.b[t.p..t.p + preload_len].to_vec();
                        t.p += preload_len;
                        v
                    } else {
                        Vec::new()
                    };
                    // " " means the archive root
                    let full = if path == " " {
                        format!("{name}.{ext}")
                    } else {
                        format!("{path}/{name}.{ext}")
                    };
                    files.insert(full.to_lowercase(), Entry { archive, offset, length, preload });
                }
            }
        }

        // "<dir>/<name>_dir.vpk" -> prefix "<dir>/<name>"
        let p = Path::new(dir_vpk);
        let stem = p.file_stem()?.to_string_lossy().to_string();
        let base = stem.strip_suffix("_dir").unwrap_or(&stem).to_string();
        let prefix = p.parent()?.join(base).to_string_lossy().to_string();

        Some(Vpk {
            dir_path: p.to_path_buf(),
            prefix,
            dir_data_base: (header + tree_size) as u64,
            files,
        })
    }

    /// Read one file out of the pack. Handles inline, preload-only and split-archive entries.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let e = self.files.get(&path.to_lowercase())?;
        if e.length == 0 {
            return Some(e.preload.clone()); // tiny file: preload IS the file
        }
        let (file, base) = if e.archive == 0x7fff {
            (self.dir_path.clone(), self.dir_data_base)
        } else {
            (PathBuf::from(format!("{}_{:03}.vpk", self.prefix, e.archive)), 0)
        };
        let mut f = std::fs::File::open(file).ok()?;
        f.seek(SeekFrom::Start(base + e.offset as u64)).ok()?;
        let mut buf = vec![0u8; e.length as usize];
        f.read_exact(&mut buf).ok()?;
        // a split file = preload bytes followed by the archived remainder
        if e.preload.is_empty() {
            Some(buf)
        } else {
            let mut out = e.preload.clone();
            out.extend_from_slice(&buf);
            Some(out)
        }
    }

    /// Every path whose name contains `needle` (case-insensitive); `ext` filters by extension.
    pub fn find(&self, needle: &str, ext: Option<&str>) -> Vec<String> {
        let n = needle.to_lowercase();
        let mut v: Vec<String> = self
            .files
            .keys()
            .filter(|k| k.contains(&n) && ext.map(|e| k.ends_with(e)).unwrap_or(true))
            .cloned()
            .collect();
        v.sort();
        v
    }
}

/// Open every `*_dir.vpk` in a game content folder (e.g. `.../csgo`), newest-listed last so
/// later packs override earlier ones — the same precedence the engine uses.
pub fn open_game_dir(dir: &str) -> Vec<Vpk> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        let mut paths: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().ends_with("_dir.vpk"))
                    .unwrap_or(false)
            })
            .collect();
        paths.sort();
        for p in paths {
            if let Some(v) = Vpk::open(&p.to_string_lossy()) {
                out.push(v);
            }
        }
    }
    out
}

/// Find a file across several packs (first hit wins).
pub fn read_any(packs: &[Vpk], path: &str) -> Option<Vec<u8>> {
    packs.iter().find_map(|v| v.read(path))
}
