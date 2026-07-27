package main

// Send tables: the schema the entity delta stream is encoded against.
//
// dem_datatables gives us a list of tables (each a list of props) plus the server class
// list. Flattening a class into an ordered prop list is the part that has to be exactly
// right: that order IS the prop index space the delta stream uses, so one misplaced prop
// shifts every index and the whole entity decode turns to noise.
//
// Everything here is self-validating — a wrong guess produces unreadable table/prop names
// or a prop count that overruns the table's own bit length — which is what lets
// probeEntityLayout brute-force the per-branch widths safely.

import (
	"fmt"
	"math"
	"os"
)

// send prop types
const (
	dptInt = iota
	dptFloat
	dptVector
	dptVectorXY
	dptString
	dptArray
	dptDataTable
)

// send prop flags (Source 1)
const (
	spropUnsigned     = 1 << 0
	spropCoord        = 1 << 1
	spropNoScale      = 1 << 2
	spropRoundDown    = 1 << 3
	spropRoundUp      = 1 << 4
	spropNormal       = 1 << 5
	spropExclude      = 1 << 6
	spropXYZE         = 1 << 7
	spropInsideArray  = 1 << 8
	spropProxyAlways  = 1 << 9
	spropIsVectorElem = 1 << 10
	spropCollapsible  = 1 << 11
	spropCoordMP      = 1 << 12
	spropCoordMPLP    = 1 << 13
	spropCoordMPInt   = 1 << 14
	spropChangesOften = 1 << 18 // newer branches; harmless if unused
)

const (
	coordIntBits      = 14
	coordFracBits     = 5
	coordDenom        = 1 << coordFracBits
	coordRes          = 1.0 / coordDenom
	coordFracBitsMPLP = 3
	normalFracBits    = 11
	normalDenom       = (1 << normalFracBits) - 1
	normalRes         = 1.0 / normalDenom
	dtMaxStringBits   = 9
)

type sendProp struct {
	typ       int
	name      string
	flags     int
	nBits     int
	nElements int
	low, high float32
	dtName    string // for datatable / exclude props
	arrayElem *sendProp
}

type sendTable struct {
	name  string
	props []sendProp
}

type serverClass struct {
	id     int
	name   string
	dtName string
	flat   []flatProp
}

type flatProp struct {
	prop  *sendProp
	table string // owning table (for debugging)
	path  string // "table.prop"
}

// the widths that moved between engine branches
type dtLayout struct {
	numPropsBits int
	typeBits     int
	flagBits     int
	prefixBits   int
	hasLength    bool
	oldTypes     bool // 2004 enum: no DPT_VectorXY, so DataTable is 5 instead of 6
	numBitsBits  int  // width of the "how many bits does this prop use" field
}

func (l dtLayout) String() string {
	return fmt.Sprintf("props=%d type=%d flags=%d nbits=%d prefix=%d len=%v oldTypes=%v", l.numPropsBits, l.typeBits, l.flagBits, l.numBitsBits, l.prefixBits, l.hasLength, l.oldTypes)
}

var dtVerbose bool

// Bit position of SPROP_CHANGES_OFTEN in the wide (>13 bit) flags field; -1 disables the
// priority pass entirely. Set by probeEntityLayout before the real parse.
var changesOftenBit = 15

// ---------------------------------------------------------------- parsing
// dem_datatables payload: repeated [1 bit continue][1 bit needsDecoder][16 bit length]
// [length bits of table data], then the server class list.
// prefixBits: some builds write the svc_SendTable message id (5 or 6 bits) ahead of each
// table inside the demo block, others don't — that's tuned like everything else.
func parseDataTables(block []byte, lay dtLayout, dbg bool) (map[string]*sendTable, []*serverClass, error) {
	b := &bitReader{data: block}
	tables := map[string]*sendTable{}
	var order []*sendTable
	for {
		if b.left() < 2 || b.over {
			return tables, nil, fmt.Errorf("truncated datatables")
		}
		if b.bit() == 0 {
			break
		}
		if lay.prefixBits > 0 {
			b.bits(lay.prefixBits) // svc_SendTable message id (only some builds write it)
		}
		b.bit() // needsDecoder
		limit := len(block) * 8
		if lay.hasLength {
			length := int(b.bits(16))
			if length <= 0 || b.pos+length > limit {
				return tables, nil, fmt.Errorf("bad send table length %d", length)
			}
			limit = b.pos + length
		}
		t, err := parseSendTable(b, lay, limit)
		if err != nil {
			return tables, nil, err
		}
		if lay.hasLength {
			b.pos = limit
		}
		tables[t.name] = t
		order = append(order, t)
		if dbg && len(order) <= 3 {
			fmt.Fprintf(os.Stderr, "    table %-28s props=%d\n", t.name, len(t.props))
		}
	}
	n := int(int16(uint16(b.bits(16))))
	if n <= 0 || n > 4096 {
		return tables, nil, fmt.Errorf("bad server class count %d", n)
	}
	// the class id width differs by branch (a plain short vs the minimum bit count)
	var classes []*serverClass
	var cerr error
	classStart := b.pos
	for _, idBits := range []int{16, numBits(n) + 1, numBits(n)} {
		b.pos = classStart
		classes = make([]*serverClass, 0, n)
		cerr = nil
		for i := 0; i < n; i++ {
			id := int(b.bits(idBits))
			name := b.str()
			dt := b.str()
			if !classNameOK(name) || !classNameOK(dt) {
				cerr = fmt.Errorf("garbage class name %q/%q at %d (idBits=%d)", name, dt, i, idBits)
				break
			}
			classes = append(classes, &serverClass{id: id, name: name, dtName: dt})
		}
		if cerr == nil {
			break
		}
	}
	if cerr != nil {
		return tables, nil, cerr
	}
	if dbg {
		fmt.Fprintf(os.Stderr, "  datatables: %d tables, %d classes (%s)\n", len(order), len(classes), lay)
	}
	return tables, classes, nil
}

func classNameOK(s string) bool {
	if len(s) < 2 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

// raw wire value -> our canonical prop type
func canonType(raw int, oldTypes bool) int {
	if !oldTypes {
		if raw < 0 || raw > dptDataTable {
			return -1
		}
		return raw
	}
	switch raw {
	case 0:
		return dptInt
	case 1:
		return dptFloat
	case 2:
		return dptVector
	case 3:
		return dptString
	case 4:
		return dptArray
	case 5:
		return dptDataTable
	}
	return -1
}

// Flag bit positions moved between branches. The 2004 engine networks 13 flags with
// CHANGES_OFTEN / IS_A_VECTOR_ELEM / COLLAPSIBLE at 10/11/12 and no COORD_MP family;
// later branches use 16 with COLLAPSIBLE at 11 and the MP coord flags at 12..14.
// Normalise everything onto the constants at the top of this file.
// Bits 0..12 mean the same thing on every branch (UNSIGNED..COLLAPSIBLE, with
// CHANGES_OFTEN at 10, IS_A_VECTOR_ELEM at 11, COLLAPSIBLE at 12). The newer branches did
// not renumber them: they widened the field from 13 to 16 bits to ADD the multiplayer
// coord flags at 13/14/15. DT_BaseEntity.m_flSimulationTime carries flags 0x401 on
// protocol 24 - UNSIGNED | CHANGES_OFTEN - which is what pins bit 10 down.
//
// Getting this wrong mislabels COLLAPSIBLE, which changes the flatten order, which shifts
// every prop index: the entity stream then decodes to noise.
func normFlags(raw, flagBits int) int {
	out := raw & 0x3ff // bits 0..9: unsigned, coord, noscale, rounddown/up, normal, exclude, xyze, insidearray, proxy
	if raw&(1<<10) != 0 {
		out |= spropChangesOften
	}
	if raw&(1<<11) != 0 {
		out |= spropIsVectorElem
	}
	if raw&(1<<12) != 0 {
		out |= spropCollapsible
	}
	if flagBits > 13 {
		if raw&(1<<13) != 0 {
			out |= spropCoordMP
		}
		if raw&(1<<14) != 0 {
			out |= spropCoordMPLP
		}
		if raw&(1<<15) != 0 {
			out |= spropCoordMPInt
		}
	}
	return out
}

func propNameOK(s string) bool {
	if len(s) < 1 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		// array props really are called "\"player_array\"", quotes included
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func parseSendTable(b *bitReader, lay dtLayout, limit int) (*sendTable, error) {
	name := b.str()
	if !classNameOK(name) {
		return nil, fmt.Errorf("garbage table name %q", name)
	}
	if os.Getenv("DBGDT3") != "" {
		fmt.Fprintf(os.Stderr, "    [dt] table %q name ends at bit %d; next 32 bits:", name, b.pos)
		peek := &bitReader{data: b.data, pos: b.pos}
		for i := 0; i < 32; i++ {
			fmt.Fprintf(os.Stderr, "%d", peek.bit())
		}
		fmt.Fprintln(os.Stderr)
	}
	nProps := int(b.bits(lay.numPropsBits))
	if nProps < 0 || nProps > 1024 {
		return nil, fmt.Errorf("bad prop count %d in %s", nProps, name)
	}
	t := &sendTable{name: name}
	for i := 0; i < nProps; i++ {
		var p sendProp
		typePos := b.pos
		rawType := int(b.bits(lay.typeBits))
		p.typ = canonType(rawType, lay.oldTypes)
		if p.typ < 0 {
			return nil, fmt.Errorf("bad prop type %d at prop %d bit %d in %s", rawType, i, typePos, name)
		}
		p.name = b.str()
		if !propNameOK(p.name) {
			return nil, fmt.Errorf("garbage prop name %q in %s", p.name, name)
		}
		p.flags = normFlags(int(b.bits(lay.flagBits)), lay.flagBits)
		if p.typ == dptDataTable || (p.flags&spropExclude) != 0 {
			p.dtName = b.str()
		} else if p.typ == dptArray {
			p.nElements = int(b.bits(10))
		} else {
			p.low = math.Float32frombits(readBitFloat(b))
			p.high = math.Float32frombits(readBitFloat(b))
			p.nBits = int(b.bits(lay.numBitsBits))
		}
		if b.pos > limit || b.over {
			return nil, fmt.Errorf("bad prop %d (%s.%s type=%d)", i, name, p.name, p.typ)
		}
		if dtVerbose {
			fmt.Fprintf(os.Stderr, "      prop %2d %-24s type=%d flags=0x%05x bits=%2d dt=%s low=%g high=%g (pos %d)\n",
				i, p.name, p.typ, p.flags, p.nBits, p.dtName, p.low, p.high, b.pos)
		}
		t.props = append(t.props, p)
	}
	// array props take their element description from the preceding prop
	for i := range t.props {
		if t.props[i].typ == dptArray && i > 0 {
			e := t.props[i-1]
			t.props[i].arrayElem = &e
		}
	}
	return t, nil
}

func readBitFloat(b *bitReader) uint32 { return b.bits(32) }

// ---------------------------------------------------------------- flattening
// Standard Source flattening: walk the class's datatable, inline non-collapsible child
// tables, apply exclusions, then move the "changes often" props to the front.
func flattenClass(c *serverClass, tables map[string]*sendTable) {
	root := tables[c.dtName]
	if root == nil {
		return
	}
	excludes := map[string]bool{}
	collectExcludes(root, tables, excludes, map[string]bool{})
	var flat []flatProp
	gatherProps(root, tables, excludes, &flat, 0)
	// Priority pass: SPROP_CHANGES_OFTEN props move to the front. The engine does this
	// with a swap (not a stable partition), and the resulting order IS the prop index
	// space used by the delta stream, so it has to be the same swap.
	start := 0
	for i := range flat {
		if flat[i].prop.flags&spropChangesOften != 0 {
			flat[i], flat[start] = flat[start], flat[i]
			start++
		}
	}
	c.flat = flat
}

func collectExcludes(t *sendTable, tables map[string]*sendTable, ex map[string]bool, seen map[string]bool) {
	if t == nil || seen[t.name] {
		return
	}
	seen[t.name] = true
	for i := range t.props {
		p := &t.props[i]
		if p.flags&spropExclude != 0 {
			ex[p.dtName+"."+p.name] = true
		}
		if p.typ == dptDataTable {
			collectExcludes(tables[p.dtName], tables, ex, seen)
		}
	}
}

// The engine's GatherProps: a table's own scalar props are collected into a temporary
// list, while every NON-collapsible child table is flattened straight into the class list
// as it is encountered — so a child's subtree lands BEFORE the parent's own props.
// SPROP_COLLAPSIBLE children are inlined into the parent's temporary list instead.
// This order is the prop index space the delta stream uses; getting it wrong shifts every
// index and the whole entity decode turns to noise.
func gatherProps(t *sendTable, tables map[string]*sendTable, ex map[string]bool, out *[]flatProp, depth int) {
	if t == nil || depth > 32 {
		return
	}
	var temp []flatProp
	iterateProps(t, tables, ex, out, &temp, depth)
	*out = append(*out, temp...)
}

func iterateProps(t *sendTable, tables map[string]*sendTable, ex map[string]bool, out *[]flatProp, temp *[]flatProp, depth int) {
	if t == nil || depth > 32 {
		return
	}
	for i := range t.props {
		p := &t.props[i]
		if p.flags&spropExclude != 0 || p.flags&spropInsideArray != 0 {
			continue
		}
		if ex[t.name+"."+p.name] {
			continue
		}
		if p.typ == dptDataTable {
			sub := tables[p.dtName]
			if sub == nil {
				continue
			}
			if p.flags&spropCollapsible != 0 {
				iterateProps(sub, tables, ex, out, temp, depth+1) // inlined in place
			} else {
				gatherProps(sub, tables, ex, out, depth+1) // whole subtree, emitted first
			}
			continue
		}
		*temp = append(*temp, flatProp{prop: p, table: t.name, path: t.name + "." + p.name})
	}
}
