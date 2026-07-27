// cssfast — Steam CS:S (Source 2007 / networkProtocol 24) demo frag finder.
// No library parses these, so this walks the raw net-message bitstream itself.
// KEY TRICK: every bulky message (PacketEntities, string tables, game events, user
// messages...) carries an explicit BIT-LENGTH, so we realign to (start+length) after
// each — the stream can never desync on those, and we never need to decode entities.
// This first cut targets game events (player_death / weapon_fire) -> frags.
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"sort"
)

// ---------- bit reader (Source bf_read: LSB-first) ----------
type bitReader struct {
	data []byte
	pos  int // in bits
}

func (b *bitReader) left() int { return len(b.data)*8 - b.pos }
func (b *bitReader) bit() int {
	if b.pos>>3 >= len(b.data) {
		b.pos++
		return 0
	}
	v := int(b.data[b.pos>>3]>>(uint(b.pos&7))) & 1
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
	for {
		c := b.byte8()
		if c == 0 || b.pos > len(b.data)*8 {
			break
		}
		s = append(s, c)
	}
	return string(s)
}
func (b *bitReader) varint() uint32 {
	var r uint32
	for i := 0; i < 5; i++ {
		c := b.byte8()
		r |= uint32(c&0x7f) << uint(7*i)
		if c&0x80 == 0 {
			break
		}
	}
	return r
}
func (b *bitReader) skipBits(n int) { b.pos += n }

// ---------- game event descriptors ----------
type evField struct {
	name string
	typ  int
}
type evDesc struct {
	name   string
	fields []evField
}

type frag struct {
	Tick   int
	Player string
	Team   int
	Desc   string
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: cssfast <demo.dem> [out]")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	if string(data[0:8-1]) != "HL2DEMO" && string(data[0:7]) != "HL2DEMO" {
		fmt.Fprintln(os.Stderr, "not a source demo")
		os.Exit(1)
	}
	netProto := int(binary.LittleEndian.Uint32(data[12:16]))
	mapName := cstr(data[536:796])
	// header is 1072 bytes
	p := &parser{
		data:    data,
		off:     1072,
		descs:   map[int]evDesc{},
		players: map[int]string{},
		teams:   map[int]int{},
	}
	p.run()

	// diagnostic first: prove the framing works
	fmt.Fprintf(os.Stderr, "netProto=%d map=%s events=%d player_death id=%d deaths=%d fires=%d\n",
		netProto, mapName, len(p.descs), p.deathID, p.deaths, p.fires)

	// build simple frags: multikills (kills clustered <=8s by one attacker), plus knife/nade singles
	frags := p.buildFrags()
	fmt.Fprintf(os.Stderr, "frags=%d\n", len(frags))
	for _, f := range frags {
		fmt.Printf("Tick: %d  Player: %s (%s)\n  Frag: %s\n", f.Tick, f.Player, teamName(f.Team), f.Desc)
	}
}

func teamName(t int) string {
	if t == 3 {
		return "CT"
	} else if t == 2 {
		return "TERRORIST"
	}
	return "Unassigned"
}
func cstr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

// ---------- demo command + net message walker ----------
type deathRec struct {
	tick     int
	attacker int // userid
	victim   int
	weapon   string
	headshot bool
}
type parser struct {
	data       []byte
	off        int
	descs      map[int]evDesc
	deathID    int
	deaths     int
	fires      int
	curTick    int
	deathList  []deathRec
	players    map[int]string // userid -> name (from string table; may stay empty in v1)
	teams      map[int]int
}

func (p *parser) u32() uint32 {
	v := binary.LittleEndian.Uint32(p.data[p.off : p.off+4])
	p.off += 4
	return v
}
func (p *parser) i32() int { return int(int32(p.u32())) }

func (p *parser) run() {
	defer func() { recover() }() // never crash on a malformed tail
	for p.off < len(p.data) {
		if p.off >= len(p.data) {
			break
		}
		cmd := p.data[p.off]
		p.off++
		if cmd == 7 { // dem_stop
			break
		}
		// tick (int32). Source 2007 has NO playerslot byte.
		if p.off+4 > len(p.data) {
			break
		}
		tick := p.i32()
		p.curTick = tick
		switch cmd {
		case 1, 2: // dem_signon, dem_packet
			p.readPacket()
		case 3: // dem_synctick
		case 4: // dem_consolecmd
			n := p.i32()
			p.off += n
		case 5: // dem_usercmd
			p.off += 4 // outgoing seq
			n := p.i32()
			p.off += n
		case 6: // dem_datatables
			n := p.i32()
			p.off += n
		case 8: // dem_stringtables
			n := p.i32()
			p.off += n
		default:
			return // unknown command -> bail (misaligned)
		}
	}
}

// dem_packet: democmdinfo (aligned), seq in/out, length, then net messages
func (p *parser) readPacket() {
	// democmdinfo_t: for Source 2007 it's 2 * (flags + 6 vectors)?? Actually it's a single
	// democmdinfo with primary+secondary = 76 bytes. Try 76; validated by alignment in testing.
	p.off += 76 // democmdinfo
	p.off += 8  // seqnr in + out
	if p.off+4 > len(p.data) {
		return
	}
	length := p.i32()
	if length < 0 || p.off+length > len(p.data) {
		return
	}
	msg := p.data[p.off : p.off+length]
	p.off += length
	p.readMessages(&bitReader{data: msg})
}

var dbgN int
func (p *parser) readMessages(b *bitReader) {
	for b.left() >= 6 {
		typ := int(b.bits(6)); if os.Getenv("DBG2")!="" && dbgN<40 { fmt.Fprintf(os.Stderr,"%d ",typ); dbgN++ }
		if !p.handle(b, typ) {
			return // couldn't frame -> stop this packet
		}
	}
}

// returns false if it can't safely advance
func (p *parser) handle(b *bitReader, typ int) bool {
	switch typ {
	case 0: // net_NOP
		return true
	case 1: // net_Disconnect
		b.str()
	case 2: // net_File
		b.bits(32)
		b.str()
		b.bit()
	case 3: // net_Tick
		b.bits(32)
		b.bits(16)
		b.bits(16)
	case 4: // net_StringCmd
		b.str()
	case 5: // net_SetConVar
		n := int(b.byte8())
		for i := 0; i < n; i++ {
			b.str()
			b.str()
		}
	case 6: // net_SignonState
		b.byte8()
		b.bits(32)
	case 7: // svc_Print
		b.str()
	case 8: // svc_ServerInfo
		b.bits(16) // protocol
		b.bits(32) // server count
		b.bit()    // hltv
		b.bit()    // dedicated
		b.bits(32) // client crc
		b.bits(16) // max classes
		b.skipBits(128) // map md5 (16 bytes)
		b.byte8()  // current players
		b.byte8()  // max players
		b.bits(32) // tick interval (float)
		b.byte8()  // os char
		b.str()    // game dir
		b.str()    // map name
		b.str()    // sky name
		b.str()    // host name
	case 9: // svc_SendTable
		b.bit()
		n := int(b.bits(16))
		b.skipBits(n * 8)
	case 10: // svc_ClassInfo
		n := int(b.bits(16))
		create := b.bit()
		if create == 0 {
			bitsFor := numBits(n)
			for i := 0; i < n; i++ {
				b.bits(bitsFor)
				b.str()
				b.str()
			}
		}
	case 11: // svc_SetPause
		b.bit()
	case 12: // svc_CreateStringTable
		b.str()          // name
		b.bits(16)       // max entries
		nb := numBits(int(b.bits(16)))
		_ = nb
		length := int(b.bits(20)) // length in BITS
		b.bit()                   // userdata fixed size
		b.skipBits(length)        // realign past table data
	case 13: // svc_UpdateStringTable
		b.bits(5)                 // table id (5 bits)
		if b.bit() == 1 {
			b.bits(16)
		}
		length := int(b.bits(20))
		b.skipBits(length)
	case 14: // svc_VoiceInit
		b.str()
		b.byte8()
	case 15: // svc_VoiceData
		b.byte8()
		b.byte8()
		length := int(b.bits(16))
		b.skipBits(length)
	case 17: // svc_Sounds
		reliable := b.bit()
		var length int
		if reliable == 1 {
			length = int(b.bits(8))
		} else {
			b.bits(8)
			length = int(b.bits(16))
		}
		b.skipBits(length)
	case 18: // svc_SetView
		b.bits(11)
	case 19: // svc_FixAngle
		b.bit()
		b.bits(16)
		b.bits(16)
		b.bits(16)
	case 20: // svc_CrosshairAngle
		b.bits(16)
		b.bits(16)
		b.bits(16)
	case 21: // svc_BSPDecal
		p.readBSPDecal(b)
	case 23: // svc_UserMessage
		b.byte8()
		length := int(b.bits(12))
		b.skipBits(length)
	case 24: // svc_EntityMessage
		b.bits(11)
		b.bits(9)
		length := int(b.bits(11))
		b.skipBits(length)
	case 25: // svc_GameEvent
		length := int(b.bits(11))
		start := b.pos
		p.readGameEvent(b)
		b.pos = start + length // realign no matter what
	case 26: // svc_PacketEntities
		b.bits(11) // max entries
		if b.bit() == 1 {
			b.bits(32)
		}
		b.bit()     // baseline
		b.bits(11)  // updated entries
		length := int(b.bits(20))
		b.bit()     // update baseline
		b.skipBits(length)
	case 27: // svc_TempEntities
		b.byte8()
		length := int(b.bits(17))
		b.skipBits(length)
	case 28: // svc_Prefetch
		b.bits(13)
	case 29: // svc_Menu
		b.bits(16)
		length := int(b.bits(16))
		b.skipBits(length * 8)
	case 30: // svc_GameEventList
		p.readGameEventList(b)
	case 31: // svc_GetCvarValue
		b.bits(32)
		b.str()
	default:
		return false // unknown message type -> desync
	}
	return true
}

func (p *parser) readBSPDecal(b *bitReader) {
	// pos vector (coord), decal index (9), then optional entity/model
	readVecCoord(b)
	b.bits(9)
	if b.bit() == 1 {
		b.bits(11)
		b.bits(11) // model index (SP_MODEL_INDEX_BITS ~ 11)
	}
	b.bit() // low priority
}

func readVecCoord(b *bitReader) {
	// 3 coords, each: 1 bit hasInt, 1 bit hasFrac, then int (14) + frac (5) + sign
	for i := 0; i < 3; i++ {
		hasInt := b.bit()
		hasFrac := b.bit()
		if hasInt == 1 || hasFrac == 1 {
			b.bit() // sign
			if hasInt == 1 {
				b.bits(14)
			}
			if hasFrac == 1 {
				b.bits(5)
			}
		}
	}
}

func (p *parser) readGameEventList(b *bitReader) {
	n := int(b.bits(9))
	length := int(b.bits(20))
	start := b.pos
	for i := 0; i < n; i++ {
		id := int(b.bits(9))
		name := b.str()
		d := evDesc{name: name}
		for {
			t := int(b.bits(3))
			if t == 0 {
				break
			}
			d.fields = append(d.fields, evField{name: b.str(), typ: t})
		}
		p.descs[id] = d
		if os.Getenv("DBG") != "" {
			fmt.Fprintf(os.Stderr, "  ev[%d]=%q fields=%d\n", id, name, len(d.fields))
		}
		if name == "player_death" {
			p.deathID = id
		}
	}
	b.pos = start + length // realign
}

func (p *parser) readGameEvent(b *bitReader) {
	id := int(b.bits(9))
	d, ok := p.descs[id]
	if !ok {
		return
	}
	if d.name == "player_death" {
		p.deaths++
		rec := deathRec{tick: p.curTick}
		for _, f := range d.fields {
			v := readEventField(b, f.typ)
			switch f.name {
			case "attacker":
				rec.attacker = v.(int)
			case "userid":
				rec.victim = v.(int)
			case "weapon":
				if s, o := v.(string); o {
					rec.weapon = s
				}
			case "headshot":
				if bo, o := v.(bool); o {
					rec.headshot = bo
				}
			}
		}
		p.deathList = append(p.deathList, rec)
	} else if d.name == "weapon_fire" {
		p.fires++
	}
	// other events ignored (realigned by caller)
}

func readEventField(b *bitReader, typ int) interface{} {
	switch typ {
	case 1: // string
		return b.str()
	case 2: // float
		return int(b.bits(32))
	case 3: // long
		return int(int32(b.bits(32)))
	case 4: // short
		return int(int16(uint16(b.bits(16))))
	case 5: // byte
		return int(b.byte8())
	case 6: // bool
		return b.bit() == 1
	case 7: // uint64
		b.bits(32)
		b.bits(32)
		return 0
	case 8: // wstring
		return b.str()
	}
	return 0
}

func numBits(n int) int {
	bits := 0
	for (1 << uint(bits)) < n {
		bits++
	}
	if bits == 0 {
		bits = 1
	}
	return bits
}

// ---------- frag building (positions unavailable in v1: timing + weapon only) ----------
func (p *parser) buildFrags() []frag {
	sort.Slice(p.deathList, func(i, j int) bool { return p.deathList[i].tick < p.deathList[j].tick })
	tickrate := 66
	byAtt := map[int][]deathRec{}
	for _, d := range p.deathList {
		if d.attacker == 0 || d.attacker == d.victim {
			continue
		}
		byAtt[d.attacker] = append(byAtt[d.attacker], d)
	}
	var frags []frag
	for att, ds := range byAtt {
		i := 0
		for i < len(ds) {
			j := i
			for j+1 < len(ds) && ds[j+1].tick-ds[j].tick <= 8*tickrate {
				j++
			}
			n := j - i + 1
			if n >= 2 {
				span := float64(ds[j].tick-ds[i].tick) / float64(tickrate)
				hs := 0
				weap := ds[i].weapon
				for k := i; k <= j; k++ {
					if ds[k].headshot {
						hs++
					}
				}
				name := fmt.Sprintf("%dk", n)
				if hs > 0 {
					name = fmt.Sprintf("%dk (%dhs)", n, hs)
				}
				frags = append(frags, frag{Tick: ds[i].tick, Player: fmt.Sprintf("uid%d", att),
					Desc: fmt.Sprintf("%s %s in %.2f seconds", name, cleanWeap(weap), span)})
			}
			i = j + 1
		}
	}
	sort.Slice(frags, func(i, j int) bool { return frags[i].Tick < frags[j].Tick })
	return frags
}
func cleanWeap(w string) string {
	if len(w) > 7 && w[:7] == "weapon_" {
		w = w[7:]
	}
	return w
}
