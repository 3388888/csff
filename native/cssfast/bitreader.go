package main

// Source's bf_read, the only primitive the whole decoder is built on: little-endian,
// LSB-first within each byte. Every read is bounds-checked and sets `over` instead of
// panicking, so a truncated or misframed demo degrades into "no more data" rather than
// a crash.

type bitReader struct {
	data []byte
	pos  int // bits
	over bool
}

func (b *bitReader) left() int { return len(b.data)*8 - b.pos }

func (b *bitReader) bit() int {
	if b.pos>>3 >= len(b.data) {
		b.pos++
		b.over = true
		return 0
	}
	v := int(b.data[b.pos>>3]>>uint(b.pos&7)) & 1
	b.pos++
	return v
}

func (b *bitReader) bits(n int) uint32 {
	var v uint32
	for i := 0; i < n; i++ {
		v |= uint32(b.bit()) << uint(i)
	}
	return v
}

func (b *bitReader) byte8() byte { return byte(b.bits(8)) }

func (b *bitReader) str() string {
	var s []byte
	for len(s) < 1024 {
		c := b.byte8()
		if c == 0 || b.over {
			break
		}
		s = append(s, c)
	}
	return string(s)
}

func (b *bitReader) bytesN(n int) []byte {
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = b.byte8()
	}
	return out
}

func (b *bitReader) skip(n int) { b.pos += n }

func numBits(n int) int { // Q_log2: bits needed to hold n-1
	bits := 0
	for (1 << uint(bits)) < n {
		bits++
	}
	return bits
}

// NUL-terminated string out of a fixed-size field
func cstr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
