// Shared low-level readers: protobuf varints on a byte slice, and an LSB-first bit reader
// for the bit-packed payloads (string tables, entity deltas).

pub fn varint(b: &[u8], p: &mut usize) -> u64 {
    let mut r = 0u64;
    let mut sh = 0u32;
    loop {
        if *p >= b.len() {
            break;
        }
        let x = b[*p];
        *p += 1;
        r |= ((x & 0x7f) as u64) << sh;
        if x & 0x80 == 0 {
            break;
        }
        sh += 7;
    }
    r
}

// skip one protobuf field payload given its wire type; returns the bytes if wt==2 (len-delimited)
pub fn skip_field<'a>(b: &'a [u8], p: &mut usize, wt: u64) -> Option<&'a [u8]> {
    match wt {
        0 => {
            varint(b, p);
            None
        }
        1 => {
            *p += 8;
            None
        }
        2 => {
            let n = varint(b, p) as usize;
            let end = (*p + n).min(b.len());
            let s = &b[*p..end];
            *p += n;
            Some(s)
        }
        5 => {
            *p += 4;
            None
        }
        _ => None,
    }
}

pub fn f32_le(b: &[u8], p: usize) -> f32 {
    if p + 4 > b.len() {
        return 0.0;
    }
    f32::from_le_bytes(b[p..p + 4].try_into().unwrap())
}

// ---- LSB-first bit reader over a byte slice ----
pub struct Bits<'a> {
    pub d: &'a [u8],
    pub bit: usize,
    pub over: bool,
}
impl<'a> Bits<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        Bits { d, bit: 0, over: false }
    }
    pub fn at(d: &'a [u8], bit: usize) -> Self {
        Bits { d, bit, over: false }
    }
    pub fn ok(&self) -> bool {
        (self.bit >> 3) < self.d.len()
    }
    pub fn pos(&self) -> usize {
        self.bit
    }
    pub fn left(&self) -> i64 {
        self.d.len() as i64 * 8 - self.bit as i64
    }
    pub fn skip(&mut self, n: usize) {
        self.bit += n;
    }
    pub fn byte8(&mut self) -> u8 {
        self.read_bits(8) as u8
    }
    pub fn read_bit(&mut self) -> u32 {
        if !self.ok() {
            self.bit += 1;
            self.over = true;
            return 0;
        }
        let b = (self.d[self.bit >> 3] >> (self.bit & 7)) & 1;
        self.bit += 1;
        b as u32
    }
    pub fn read_bits(&mut self, n: u32) -> u64 {
        if n == 0 {
            return 0;
        }
        // fast path: n<=57 keeps bitofs(0..7)+n within 8 bytes; load LE, shift, mask
        let start = self.bit;
        let byte0 = start >> 3;
        let end = start + n as usize;
        if n <= 57 && (end + 7) / 8 <= self.d.len() {
            let bitofs = start & 7;
            let take = ((bitofs + n as usize + 7) / 8).min(8);
            let mut acc = 0u64;
            for i in 0..take {
                acc |= (self.d[byte0 + i] as u64) << (8 * i);
            }
            self.bit = end;
            return (acc >> bitofs) & ((1u64 << n) - 1);
        }
        // slow path (handles overrun + sets `over`)
        let mut r = 0u64;
        for i in 0..n {
            r |= (self.read_bit() as u64) << i;
        }
        r
    }
    pub fn read_signed_bits(&mut self, n: u32) -> i64 {
        let v = self.read_bits(n) as i64;
        if n < 64 && v & (1 << (n - 1)) != 0 {
            v - (1i64 << n)
        } else {
            v
        }
    }
    pub fn read_string(&mut self) -> String {
        let mut s = Vec::new();
        loop {
            let c = self.read_bits(8) as u8;
            if c == 0 || s.len() > 512 || !self.ok() {
                break;
            }
            s.push(c);
        }
        String::from_utf8_lossy(&s).to_string()
    }
    pub fn read_bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.read_bits(8) as u8).collect()
    }
    // Source "UBitVar": 6-bit value with 2-bit escape in the high bits
    pub fn read_ubitvar(&mut self) -> u32 {
        let ret = self.read_bits(6) as u32;
        match ret & 0x30 {
            0x10 => (ret & 15) | ((self.read_bits(4) as u32) << 4),
            0x20 => (ret & 15) | ((self.read_bits(8) as u32) << 4),
            0x30 => (ret & 15) | ((self.read_bits(32 - 4) as u32) << 4),
            _ => ret,
        }
    }
    pub fn read_varint32(&mut self) -> u32 {
        let mut r = 0u32;
        let mut sh = 0u32;
        loop {
            let x = self.read_bits(8) as u32;
            r |= (x & 0x7f) << sh;
            if x & 0x80 == 0 || sh >= 28 {
                break;
            }
            sh += 7;
        }
        r
    }
    pub fn read_signed_varint32(&mut self) -> i32 {
        let v = self.read_varint32();
        ((v >> 1) as i32) ^ -((v & 1) as i32)
    }
}
