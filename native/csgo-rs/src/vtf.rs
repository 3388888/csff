// vtf.rs — Valve Texture Format -> RGBA, plus a dependency-free PNG writer.
//
// VTF stores mipmaps SMALLEST FIRST, so the full-resolution image is the last chunk; we skip
// past every smaller mip to reach it. Most Source textures are DXT1 (8 bytes / 4x4 block) or
// DXT5 (16 bytes / 4x4 block, with an interpolated alpha block); uncompressed BGR/BGRA also
// show up on UI art. v7.3+ files carry a resource table, in which case the high-res image
// offset is given explicitly rather than implied by the header size.
//
// The PNG writer emits a zlib stream made of *stored* (uncompressed) deflate blocks, so we
// need no compression library — just CRC32 and Adler32.

fn u16le(b: &[u8], o: usize) -> u16 {
    if o + 2 > b.len() { return 0; }
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u32le(b: &[u8], o: usize) -> u32 {
    if o + 4 > b.len() { return 0; }
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

// IMAGE_FORMAT_* values we handle
const DXT1: i32 = 13;
const DXT3: i32 = 14;
const DXT5: i32 = 15;
const RGBA8888: i32 = 0;
const ABGR8888: i32 = 1;
const RGB888: i32 = 2;
const BGR888: i32 = 3;
const ARGB8888: i32 = 11;
const BGRA8888: i32 = 12;
const BGRX8888: i32 = 16;
const DXT1_A: i32 = 20;

fn bytes_for(fmt: i32, w: usize, h: usize) -> usize {
    let blocks = ((w + 3) / 4) * ((h + 3) / 4);
    match fmt {
        DXT1 | DXT1_A => blocks * 8,
        DXT3 | DXT5 => blocks * 16,
        RGB888 | BGR888 => w * h * 3,
        RGBA8888 | ABGR8888 | ARGB8888 | BGRA8888 | BGRX8888 => w * h * 4,
        _ => 0, // unsupported -> caller bails
    }
}

fn c565(c: u16) -> [u8; 3] {
    let r = ((c >> 11) & 0x1f) as u32;
    let g = ((c >> 5) & 0x3f) as u32;
    let b = (c & 0x1f) as u32;
    [((r * 255 + 15) / 31) as u8, ((g * 255 + 31) / 63) as u8, ((b * 255 + 15) / 31) as u8]
}

/// Decode a DXT1/3/5 block-compressed image to RGBA8.
fn decode_dxt(src: &[u8], w: usize, h: usize, fmt: i32) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    let bw = (w + 3) / 4;
    let bh = (h + 3) / 4;
    let bsz = if fmt == DXT1 || fmt == DXT1_A { 8 } else { 16 };
    for by in 0..bh {
        for bx in 0..bw {
            let bo = (by * bw + bx) * bsz;
            if bo + bsz > src.len() {
                return out;
            }
            // DXT3/5 put alpha first, colour block is the last 8 bytes
            let cb = if bsz == 16 { bo + 8 } else { bo };
            let c0 = u16le(src, cb);
            let c1 = u16le(src, cb + 2);
            let bits = u32le(src, cb + 4);
            let p0 = c565(c0);
            let p1 = c565(c1);
            let mut pal = [[0u8; 4]; 4];
            pal[0] = [p0[0], p0[1], p0[2], 255];
            pal[1] = [p1[0], p1[1], p1[2], 255];
            if c0 > c1 || bsz == 16 {
                for i in 0..3 {
                    pal[2][i] = ((2 * p0[i] as u32 + p1[i] as u32) / 3) as u8;
                    pal[3][i] = ((p0[i] as u32 + 2 * p1[i] as u32) / 3) as u8;
                }
                pal[2][3] = 255;
                pal[3][3] = 255;
            } else {
                for i in 0..3 {
                    pal[2][i] = ((p0[i] as u32 + p1[i] as u32) / 2) as u8;
                    pal[3][i] = 0;
                }
                pal[2][3] = 255;
                pal[3][3] = 0; // 1-bit alpha
            }
            // DXT5 alpha: two endpoints + 3-bit indices
            let (a0, a1) = (src.get(bo).copied().unwrap_or(255), src.get(bo + 1).copied().unwrap_or(255));
            let abits: u64 = if fmt == DXT5 {
                let mut v = 0u64;
                for i in 0..6 {
                    v |= (src.get(bo + 2 + i).copied().unwrap_or(0) as u64) << (8 * i);
                }
                v
            } else {
                0
            };
            for py in 0..4 {
                for px in 0..4 {
                    let x = bx * 4 + px;
                    let y = by * 4 + py;
                    if x >= w || y >= h {
                        continue;
                    }
                    let i = (py * 4 + px) as u32;
                    let ci = ((bits >> (2 * i)) & 3) as usize;
                    let mut rgba = pal[ci];
                    if fmt == DXT5 {
                        let ai = ((abits >> (3 * i as u64)) & 7) as u32;
                        let a = if ai == 0 {
                            a0 as u32
                        } else if ai == 1 {
                            a1 as u32
                        } else if a0 > a1 {
                            ((8 - ai) * a0 as u32 + (ai - 1) * a1 as u32) / 7
                        } else if ai < 6 {
                            ((6 - ai) * a0 as u32 + (ai - 1) * a1 as u32) / 5
                        } else if ai == 6 {
                            0
                        } else {
                            255
                        };
                        rgba[3] = a as u8;
                    } else if fmt == DXT3 {
                        let nib = bo + (py * 4 + px) / 2;
                        let v = src.get(nib).copied().unwrap_or(0xff);
                        let a4 = if (py * 4 + px) % 2 == 0 { v & 0xf } else { v >> 4 };
                        rgba[3] = a4 * 17;
                    }
                    let o = (y * w + x) * 4;
                    out[o..o + 4].copy_from_slice(&rgba);
                }
            }
        }
    }
    out
}

fn decode_raw(src: &[u8], w: usize, h: usize, fmt: i32) -> Vec<u8> {
    let mut out = vec![255u8; w * h * 4];
    for i in 0..w * h {
        let o = i * 4;
        match fmt {
            RGB888 => { let s = i * 3; if s + 2 < src.len() { out[o] = src[s]; out[o+1] = src[s+1]; out[o+2] = src[s+2]; } }
            BGR888 => { let s = i * 3; if s + 2 < src.len() { out[o] = src[s+2]; out[o+1] = src[s+1]; out[o+2] = src[s]; } }
            RGBA8888 => { let s = i * 4; if s + 3 < src.len() { out[o..o+4].copy_from_slice(&src[s..s+4]); } }
            BGRA8888 | BGRX8888 => { let s = i * 4; if s + 3 < src.len() { out[o] = src[s+2]; out[o+1] = src[s+1]; out[o+2] = src[s]; out[o+3] = if fmt == BGRX8888 { 255 } else { src[s+3] }; } }
            ARGB8888 => { let s = i * 4; if s + 3 < src.len() { out[o] = src[s+1]; out[o+1] = src[s+2]; out[o+2] = src[s+3]; out[o+3] = src[s]; } }
            ABGR8888 => { let s = i * 4; if s + 3 < src.len() { out[o] = src[s+3]; out[o+1] = src[s+2]; out[o+2] = src[s+1]; out[o+3] = src[s]; } }
            _ => {}
        }
    }
    out
}

/// Decode a .vtf into (width, height, RGBA8) at full resolution.
pub fn decode(b: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    decode_max(b, usize::MAX)
}

/// Decode at most `max_dim` across. VTF already stores a mip chain, so instead of decoding
/// full-res and resampling we simply pick the largest mip that fits — cheaper, and it keeps
/// exported .glb files sane (a 1024px atlas per prop was making clips hundreds of MB).
pub fn decode_max(b: &[u8], max_dim: usize) -> Option<(usize, usize, Vec<u8>)> {
    if b.len() < 64 || &b[..4] != b"VTF\0" {
        return None;
    }
    let vmaj = u32le(b, 4);
    let vmin = u32le(b, 8);
    let header_size = u32le(b, 12) as usize;
    let width = u16le(b, 16) as usize;
    let height = u16le(b, 18) as usize;
    let frames = u16le(b, 24).max(1) as usize;
    let hi_fmt = u32le(b, 52) as i32;
    let mip_count = b.get(56).copied().unwrap_or(1).max(1) as usize;
    let lo_fmt = u32le(b, 57) as i32;
    let lo_w = b.get(61).copied().unwrap_or(0) as usize;
    let lo_h = b.get(62).copied().unwrap_or(0) as usize;
    if width == 0 || height == 0 || bytes_for(hi_fmt, 4, 4) == 0 {
        return None; // unsupported pixel format
    }

    // where the high-res mip chain starts
    let mut data_off = header_size;
    if vmaj == 7 && vmin >= 3 {
        // resource table: numResources @ 0x4C, entries of {tag[3], flags, offset u32} @ 0x50
        let n = u32le(b, 0x4c) as usize;
        let mut found = None;
        for i in 0..n.min(64) {
            let e = 0x50 + i * 8;
            if e + 8 > b.len() {
                break;
            }
            if b[e] == 0x30 && b[e + 1] == 0 && b[e + 2] == 0 {
                found = Some(u32le(b, e + 4) as usize);
                break;
            }
        }
        if let Some(o) = found {
            data_off = o;
        }
    } else if lo_w > 0 && lo_h > 0 {
        data_off += bytes_for(lo_fmt, lo_w, lo_h); // skip the thumbnail
    }

    // choose the mip to decode: 0 = full size, higher = smaller
    let mut want = 0usize;
    while want + 1 < mip_count
        && ((width >> want).max(1) > max_dim || (height >> want).max(1) > max_dim)
    {
        want += 1;
    }
    let ow = (width >> want).max(1);
    let oh = (height >> want).max(1);
    // mips run smallest -> largest, so skip every level below the one we want
    let mut off = data_off;
    for lvl in ((want + 1)..mip_count).rev() {
        let mw = (width >> lvl).max(1);
        let mh = (height >> lvl).max(1);
        off += bytes_for(hi_fmt, mw, mh) * frames;
    }
    let need = bytes_for(hi_fmt, ow, oh);
    if off + need > b.len() {
        return None;
    }
    let src = &b[off..off + need];
    let rgba = match hi_fmt {
        DXT1 | DXT1_A | DXT3 | DXT5 => decode_dxt(src, ow, oh, hi_fmt),
        _ => decode_raw(src, ow, oh, hi_fmt),
    };
    Some((ow, oh, rgba))
}

// ---- minimal PNG writer (no deflate library needed) ------------------------
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *t = c;
    }
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, tag: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(body);
    let mut crc_in = Vec::with_capacity(4 + body.len());
    crc_in.extend_from_slice(tag);
    crc_in.extend_from_slice(body);
    out.extend_from_slice(&crc32(&crc_in).to_be_bytes());
}

/// Write RGBA8 as a PNG. Uses stored deflate blocks (bigger file, zero dependencies).
pub fn write_png(w: usize, h: usize, rgba: &[u8], path: &str) -> std::io::Result<()> {
    // raw scanlines with filter byte 0
    let mut raw = Vec::with_capacity(h * (1 + w * 4));
    for y in 0..h {
        raw.push(0);
        let o = y * w * 4;
        raw.extend_from_slice(&rgba[o..o + w * 4]);
    }
    // Real deflate. The earlier "stored blocks" version needed no dependency but made every
    // texture ~1 MB, which turned a textured map export into 128 MB of PNG.
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write as _;
    let z = {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::fast());
        e.write_all(&raw)?;
        e.finish()?
    };

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &z);
    chunk(&mut png, b"IEND", &[]);
    std::fs::write(path, png)
}

/// Convert a .vtf straight to a .png.
pub fn vtf_to_png(vtf: &[u8], out: &str) -> Option<(usize, usize)> {
    let (w, h, rgba) = decode(vtf)?;
    write_png(w, h, &rgba, out).ok()?;
    Some((w, h))
}
