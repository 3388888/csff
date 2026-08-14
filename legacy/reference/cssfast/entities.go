// entities.go — the entity delta stream: svc_PacketEntities -> per-entity prop values.
//
// This is what the radar / 3D preview needs: player_death only tells us WHO died, the
// coordinates live in the entity delta stream.
//
// Everything here is self-validating, because a wrong guess produces obvious garbage:
//   - each send table is bit-length prefixed, so a bad prop layout can't desync the demo
//   - the server class list must contain readable class names ("CCSPlayer", "CWorld", ...)
//   - decoded player origins must sit inside the map's coordinate range
//
// Companion files: sendtables.go (the schema and its flattening), propdecode.go (single
// prop reads), timeline.go (positions per tick), entprobe.go (which wire variant to use).
package main

import (
	"fmt"
	"os"
	"strings"
)

// ---------------------------------------------------------------- entity state
type entity struct {
	class  *serverClass
	serial int
	props  map[string]interface{}
}

type entityWorld struct {
	classes    []*serverClass
	byID       map[int]*serverClass
	tables     map[string]*sendTable
	ents       map[int]*entity
	classBits  int
	baselines  map[int][]byte
	dbg        bool
	decodeFail int
	decodeOK   int
	entLog     int
	propLog    int
	propLogCap int
	failLog    int
	curEnt      int
	curEnter    bool
	tracePlayer bool
	tracedOne   bool
	traceSnap   bool
	snapDone    bool
	peLog      int
	bitLog     int
	// The entity index and the prop index deltas do not have to use the same
	// ReadUBitVar flavour (they don't on every branch), so they're tracked separately.
	unaryVar     bool // entity index deltas
	unaryPropVar bool // prop index deltas
	serialBits   int  // ehandle serial number width in enter-PVS updates
	payloadSkip  int  // extra bits before the first entity header, if a branch has any
	maxClients   int  // from svc_ServerInfo; entity updates past it are not players
}

// entity index deltas
func (w *entityWorld) ubitVar(b *bitReader) uint32 {
	if w.unaryVar {
		return b.readUBitVarUnary()
	}
	return b.readUBitVar6()
}

// prop index deltas
func (w *entityWorld) ubitPropVar(b *bitReader) uint32 {
	if w.unaryPropVar {
		return b.readUBitVarUnary()
	}
	return b.readUBitVar6()
}

func flatLen(c *serverClass) int {
	if c == nil {
		return 0
	}
	return len(c.flat)
}

func newEntityWorld(tables map[string]*sendTable, classes []*serverClass, dbg bool) *entityWorld {
	w := &entityWorld{classes: classes, byID: map[int]*serverClass{}, tables: tables,
		ents: map[int]*entity{}, baselines: map[int][]byte{}, dbg: dbg, propLogCap: 40}
	if v := os.Getenv("PROPLOGCAP"); v != "" {
		fmt.Sscanf(v, "%d", &w.propLogCap)
	}
	for _, c := range classes {
		flattenClass(c, tables)
		w.byID[c.id] = c
	}
	// integer log2 + 1, exactly how the engine (and cssff) sizes the class id field.
	// numBits() rounds UP, which is one bit too many here and desyncs every enter-PVS.
	n := len(classes)
	w.classBits = 0
	for t := n; t>>1 != 0; t >>= 1 {
		w.classBits++
	}
	w.classBits++
	if dbg && os.Getenv("DBGORIGIN") != "" {
		for _, c := range classes {
			if c.name != "CCSPlayer" {
				continue
			}
			lim := 24
			if v := os.Getenv("FLATN"); v != "" {
				fmt.Sscanf(v, "%d", &lim)
			}
			for i, fp := range c.flat {
				if i >= lim {
					break
				}
				fmt.Fprintf(os.Stderr, "  CCSPlayer flat[%d] %-44s type=%d flags=0x%05x bits=%d low=%g high=%g\n",
					i, fp.path, fp.prop.typ, fp.prop.flags, fp.prop.nBits, fp.prop.low, fp.prop.high)
			}
		}
	}
	return w
}

// svc_PacketEntities payload (Source 1, pre-CS:GO delta format)
func (w *entityWorld) readPacketEntities(b *bitReader, updated int, isDelta bool, limit int) {
	if w.peLog < 2 && os.Getenv("DBGPE") != "" {
		w.peLog++
		fmt.Fprintf(os.Stderr, "  packetEntities: updated=%d isDelta=%v bits=%d unary=%v\n", updated, isDelta, limit-b.pos, w.unaryVar)
		peek := &bitReader{data: b.data, pos: b.pos}
		idx := -1
		for i := 0; i < 14 && peek.pos < limit; i++ {
			idx += 1 + int(w.ubitVar(peek))
			leave := peek.bit()
			extra := peek.bit()
			fmt.Fprintf(os.Stderr, "     hdr[%d] ent=%d leavePVS=%d %s\n", i, idx, leave, map[bool]string{true: "delete/enterPVS", false: "delta"}[extra == 1])
			if leave == 0 && extra == 1 { // enter PVS: class + serial + props follow, cannot peek further
				break
			}
			if leave == 0 && extra == 0 {
				break
			}
		}
	}
	if w.dbg && os.Getenv("TRACESNAP") != "" && !isDelta && !w.snapDone {
		w.traceSnap = true
		w.snapDone = true
		fmt.Fprintf(os.Stderr, "  === first full snapshot: updated=%d ===\n", updated)
	}
	entIdx := -1
	for i := 0; i < updated; i++ {
		if b.pos >= limit || b.over {
			if w.traceSnap {
				w.traceSnap = false
			}
			return
		}
		entIdx += 1 + int(w.ubitVar(b))
		if entIdx < 0 || entIdx > 2047 {
			return
		}
		// entity updates arrive in ascending index order and players occupy the first
		// slots, so once we are past them there is nothing here we need
		if w.maxClients > 0 && entIdx > w.maxClients && os.Getenv("NOCLAMP") == "" {
			if w.traceSnap {
				w.traceSnap = false
			}
			return
		}
		switch {
		case b.bit() == 1: // leave PVS / delete
			if b.bit() == 1 {
				delete(w.ents, entIdx)
			}
		default:
			if b.bit() == 1 { // enter PVS: class + serial follow
				clsID := int(b.bits(w.classBits))
				cls := w.byID[clsID]
				b.bits(w.serialBits) // ehandle serial number
				if w.dbg && w.entLog < 20 {
					name := "?"
					if cls != nil {
						name = cls.name
					}
					fmt.Fprintf(os.Stderr, "    ent %d enterPVS class=%d %s flatProps=%d\n", entIdx, clsID, name, flatLen(cls))
					w.entLog++
				}
				e := &entity{class: cls, props: map[string]interface{}{}}
				w.ents[entIdx] = e
				w.curEnt, w.curEnter = entIdx, true
				if os.Getenv("TRACE1") != "" && !w.tracedOne && cls != nil && cls.name == "CCSPlayer" {
					w.tracePlayer, w.tracedOne = true, true
					fmt.Fprintf(os.Stderr, "  === tracing first CCSPlayer enter (ent %d) @bit %d ===\n", entIdx, b.pos)
				}
				if w.dbg && os.Getenv("DBGBITS") != "" && w.bitLog < 3 {
					w.bitLog++
					peek := &bitReader{data: b.data, pos: b.pos}
					var sb strings.Builder
					for i := 0; i < 48; i++ {
						fmt.Fprintf(&sb, "%d", peek.bit())
					}
					fmt.Fprintf(os.Stderr, "      prop-list bits @%d: %s\n", b.pos, sb.String())
				}
				before := b.pos
				w.readProps(b, e, limit)
				if w.traceSnap {
					nm := "?"
					if cls != nil {
						nm = cls.name
					}
					fmt.Fprintf(os.Stderr, "  [%d] ent%d ENTER cls=%d %-24s bits=%d->%d (%d bits)\n", i, entIdx, clsID, nm, before, b.pos, b.pos-before)
				}
			} else { // delta on an existing entity
				e := w.ents[entIdx]
				if e == nil {
					return // we lost track; the caller realigns on the message length
				}
				w.curEnt, w.curEnter = entIdx, false
				before := b.pos
				w.readProps(b, e, limit)
				if w.traceSnap {
					fmt.Fprintf(os.Stderr, "  [%d] ent%d delta bits=%d->%d (%d bits)\n", i, entIdx, before, b.pos, b.pos-before)
				}
			}
		}
	}
}

// prop deltas: indices are delta-encoded with ReadUBitVar, terminated by a 0 bit
func (w *entityWorld) readProps(b *bitReader, e *entity, limit int) {
	if e.class == nil || len(e.class.flat) == 0 {
		w.decodeFail++
		return
	}
	if w.tracePlayer {
		defer func() { w.tracePlayer = false }()
	}
	idx := -1
	nDecoded := 0
	for {
		if b.pos >= limit || b.over {
			return
		}
		if b.bit() == 0 {
			if w.tracePlayer {
				fmt.Fprintf(os.Stderr, "      [stop bit @bit %d after %d props]\n", b.pos, nDecoded)
			}
			break
		}
		idx += 1 + int(w.ubitPropVar(b))
		if idx < 0 || idx >= len(e.class.flat) {
			w.decodeFail++
			if w.dbg && os.Getenv("DBGFAIL") != "" && w.failLog < 30 {
				w.failLog++
				fmt.Fprintf(os.Stderr, "    FAIL %s idx=%d (flatlen=%d) after %d props @bit %d\n", e.class.name, idx, len(e.class.flat), nDecoded, b.pos)
			}
			return
		}
		nDecoded++
		fp := e.class.flat[idx]
		v := decodeProp(b, fp.prop)
		if v != nil {
			e.props[fp.prop.name] = v
		}
		if w.dbg && (w.tracePlayer || w.propLog < w.propLogCap) && (e.isPlayer() || os.Getenv("DBGPROP") != "") {
			fmt.Fprintf(os.Stderr, "      ent%d %s prop[%d] %-40s type=%d flags=0x%x bits=%d = %v (bit %d)\n",
				w.curEnt, map[bool]string{true: "ENTER", false: "delta"}[w.curEnter], idx, fp.path, fp.prop.typ, fp.prop.flags, fp.prop.nBits, v, b.pos)
			w.propLog++
		}
	}
	w.decodeOK++
}

// player origin/yaw/team out of whatever the props gave us
func (e *entity) vec(name string) ([3]float32, bool) {
	if v, ok := e.props[name]; ok {
		if a, ok2 := v.([3]float32); ok2 {
			return a, true
		}
	}
	return [3]float32{}, false
}
func (e *entity) num(name string) (float64, bool) {
	switch v := e.props[name].(type) {
	case int:
		return float64(v), true
	case float32:
		return float64(v), true
	}
	return 0, false
}

// Exact names only: "CCSPlayerResource" also contains "CCSPlayer" but is a stats blob,
// not a player, and treating it as one poisoned the position timeline.
func (e *entity) isPlayer() bool {
	if e.class == nil {
		return false
	}
	switch e.class.name {
	case "CCSPlayer", "CBasePlayer", "CTerrorPlayer", "CHL2MP_Player":
		return true
	}
	return false
}

// ReadUBitVar comes in two flavours and picking the wrong one turns the entity stream
// into noise (entity indices in the hundreds, random classes):
//
//	2004 engine  : unary prefix — count zero bits, then read that many bits
//	Orange Box+  : 6 bits with escape codes in the top two bits
//
// Which one a given branch uses is decided by protocol and then verified: if the entity
// decode produces no player positions at all, the parse is retried with the other.
func (b *bitReader) readUBitVarUnary() uint32 {
	bits := 0
	for b.bit() == 0 && !b.over && bits < 32 {
		bits++
	}
	data := uint32(1)<<uint(bits) - 1
	if bits > 0 {
		data += b.bits(bits)
	}
	return data
}

func (b *bitReader) readUBitVar6() uint32 {
	ret := b.bits(6)
	switch ret & (16 | 32) {
	case 16:
		ret = (ret & 15) | (b.bits(4) << 4)
	case 32:
		ret = (ret & 15) | (b.bits(8) << 4)
	case 48:
		ret = (ret & 15) | (b.bits(32-4) << 4)
	}
	return ret
}

// Try the flag widths the engine branches used and keep the one that yields a clean
// parse: every table consumed exactly, readable class names, and CCSPlayer present.
func buildEntityWorld(block []byte, dbg bool) (*entityWorld, int, error) {
	var lastErr error
	var variants []dtLayout
	// DBGONE=props,type,flags,prefix,len,oldTypes — try exactly one layout, verbosely
	if one := os.Getenv("DBGONE"); one != "" {
		var np, tb, fb, pb, hl, ot, nb int
		nb = 7
		fmt.Sscanf(one, "%d,%d,%d,%d,%d,%d,%d", &np, &tb, &fb, &pb, &hl, &ot, &nb)
		dtVerbose = true
		variants = []dtLayout{{np, tb, fb, pb, hl != 0, ot != 0, nb}}
	}
	if len(variants) > 0 {
		lay := variants[0]
		tables, classes, err := parseDataTables(block, lay, true)
		fmt.Fprintf(os.Stderr, "  DBGONE [%s]: tables=%d classes=%d err=%v\n", lay, len(tables), len(classes), err)
		if err != nil {
			return nil, 0, err
		}
		return newEntityWorld(tables, classes, dbg), lay.flagBits, nil
	}
	for _, hasLength := range []bool{false, true} {
		for _, prefixBits := range []int{0, 5, 6} {
			for _, numProps := range []int{9, 10} {
				for _, typeBits := range []int{5, 4, 3} {
					for _, oldTypes := range []bool{true, false} {
						for _, numBits := range []int{7, 6} {
							for _, flagBits := range []int{16, 13, 19, 11, 12, 14, 15} {
								variants = append(variants, dtLayout{numProps, typeBits, flagBits, prefixBits, hasLength, oldTypes, numBits})
							}
						}
					}
				}
			}
		}
	}
	for _, lay := range variants {
		tables, classes, err := parseDataTables(block, lay, false)
		if err != nil {
			if dbg {
				fmt.Fprintf(os.Stderr, "  dt try [%s]: %d tables then %v\n", lay, len(tables), err)
			}
			lastErr = err
			continue
		}
		hasPlayer := false
		for _, c := range classes {
			if strings.Contains(c.name, "Player") {
				hasPlayer = true
				break
			}
		}
		if !hasPlayer {
			lastErr = fmt.Errorf("no player class among %d classes", len(classes))
			continue
		}
		w := newEntityWorld(tables, classes, dbg)
		if dbg && os.Getenv("DBGFLAT") != "" {
			for _, c := range classes {
				if c.name == "CCSPlayer" {
					fmt.Fprintf(os.Stderr, "  class %s (%s): %d flat props\n", c.name, c.dtName, len(c.flat))
					for i, f := range c.flat {
						if i > 16 {
							break
						}
						fmt.Fprintf(os.Stderr, "     %2d %-28s type=%d bits=%d flags=0x%x\n", i, f.path, f.prop.typ, f.prop.nBits, f.prop.flags)
					}
				}
			}
		}
		fmt.Fprintf(os.Stderr, "  datatables OK [%s]: %d tables, %d classes\n", lay, len(tables), len(classes))
		return w, lay.flagBits, nil
	}
	return nil, 0, lastErr
}

// diagnostics: where does the first table name actually start?
func dumpDataTableStart(block []byte) {
	n := 48
	if len(block) < n {
		n = len(block)
	}
	fmt.Fprintf(os.Stderr, "  dt block %d bytes, head:", len(block))
	for i := 0; i < n; i++ {
		fmt.Fprintf(os.Stderr, " %02x", block[i])
	}
	fmt.Fprintln(os.Stderr)
	for shift := 0; shift < 8; shift++ {
		buf := make([]byte, 64)
		for i := 0; i < 63 && i+1 < len(block); i++ {
			if shift == 0 {
				buf[i] = block[i]
			} else {
				buf[i] = block[i]>>uint(shift) | block[i+1]<<uint(8-shift)
			}
		}
		s := strings.Map(func(r rune) rune {
			if r >= 32 && r < 127 {
				return r
			}
			return '.'
		}, string(buf))
		fmt.Fprintf(os.Stderr, "   shift %d: %s\n", shift, s)
	}
}
