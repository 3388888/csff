package main

// Reading a single send prop off the wire. Pure bit-level work: given a sendProp's type
// and flags, pull its value out of the stream. The coord encodings are the ones that
// matter for us, since m_vecOrigin is what the radar and the 3D view draw.

import "math"

func decodeProp(b *bitReader, p *sendProp) interface{} {
	switch p.typ {
	case dptInt:
		if p.flags&spropVarInt != 0 { // SPROP_VARINT (aliased onto the NORMAL bit for ints)
			if p.flags&spropUnsigned != 0 {
				return int(b.readVarInt32())
			}
			return b.readSignedVarInt32()
		}
		if p.flags&spropUnsigned != 0 {
			return int(b.bits(p.nBits))
		}
		return signedBits(b, p.nBits)
	case dptFloat:
		return decodeFloat(b, p)
	case dptVector:
		x := decodeFloat(b, p)
		y := decodeFloat(b, p)
		var z float32
		if p.flags&spropNormal == 0 {
			z = decodeFloat(b, p)
		} else {
			sign := b.bit()
			f := x*x + y*y
			if f < 1 {
				z = float32(math.Sqrt(float64(1 - f)))
			}
			if sign == 1 {
				z = -z
			}
		}
		return [3]float32{x, y, z}
	case dptVectorXY:
		x := decodeFloat(b, p)
		y := decodeFloat(b, p)
		return [3]float32{x, y, 0}
	case dptString:
		n := int(b.bits(dtMaxStringBits))
		if n > 512 {
			n = 512
		}
		return string(b.bytesN(n))
	case dptArray:
		// element count width: 1 + integer log2( maxElements )
		bits := 1
		for m := p.nElements; m>>1 != 0; m >>= 1 {
			bits++
		}
		n := int(b.bits(bits))
		if p.arrayElem != nil {
			for i := 0; i < n && i < p.nElements+1; i++ {
				decodeProp(b, p.arrayElem)
			}
		}
		return nil
	}
	return nil
}

func signedBits(b *bitReader, n int) int {
	v := int(b.bits(n))
	if n < 32 && v&(1<<(n-1)) != 0 {
		v -= 1 << n
	}
	return v
}

func decodeFloat(b *bitReader, p *sendProp) float32 {
	if p.flags&spropCoord != 0 {
		return readBitCoord(b)
	}
	if p.flags&spropCoordMP != 0 || p.flags&spropCoordMPLP != 0 || p.flags&spropCoordMPInt != 0 {
		return readBitCoordMP(b, p.flags&spropCoordMPInt != 0, p.flags&spropCoordMPLP != 0)
	}
	if p.flags&spropNoScale != 0 {
		return math.Float32frombits(b.bits(32))
	}
	if p.flags&spropNormal != 0 {
		return readBitNormal(b)
	}
	// scaled to [low, high] across nBits
	iv := b.bits(p.nBits)
	den := float32((uint32(1) << uint(p.nBits)) - 1)
	f := float32(iv) / den
	return p.low + (p.high-p.low)*f
}

func readBitCoord(b *bitReader) float32 {
	intPart := b.bit()
	fracPart := b.bit()
	if intPart == 0 && fracPart == 0 {
		return 0
	}
	sign := b.bit()
	var iv, fv uint32
	if intPart == 1 {
		iv = b.bits(coordIntBits) + 1
	}
	if fracPart == 1 {
		fv = b.bits(coordFracBits)
	}
	v := float32(iv) + float32(fv)*coordRes
	if sign == 1 {
		return -v
	}
	return v
}

func readBitCoordMP(b *bitReader, isInt, lowPrec bool) float32 {
	inBounds := b.bit() == 1
	var value float32
	sign := 0
	if isInt {
		if b.bit() == 1 { // has int part
			sign = b.bit()
			if inBounds {
				value = float32(b.bits(11) + 1)
			} else {
				value = float32(b.bits(coordIntBits) + 1)
			}
		}
	} else {
		hasInt := b.bit()
		sign = b.bit()
		var iv uint32
		if hasInt == 1 {
			if inBounds {
				iv = b.bits(11) + 1
			} else {
				iv = b.bits(coordIntBits) + 1
			}
		}
		fracBits := coordFracBits
		if lowPrec {
			fracBits = coordFracBitsMPLP
		}
		fv := b.bits(fracBits)
		value = float32(iv) + float32(fv)/float32(uint32(1)<<uint(fracBits))
	}
	if sign == 1 {
		return -value
	}
	return value
}

func readBitNormal(b *bitReader) float32 {
	sign := b.bit()
	v := float32(b.bits(normalFracBits)) * normalRes
	if sign == 1 {
		return -v
	}
	return v
}
