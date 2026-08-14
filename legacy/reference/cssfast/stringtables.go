package main

// String tables. We only care about "userinfo", whose per-entry user data is a
// player_info_t blob: that's what gives us slot -> userID -> name, which the radar needs
// for its labels and the preview needs to follow the right player.

import (
	"encoding/binary"
	"fmt"
	"os"
)

type stringTable struct {
	name      string
	maxEnt    int
	fixedSize bool
	udSize    int
	udBits    int
	entries   []string
}

func (p *parser) readCreateStringTable(b *bitReader) {
	name := b.str()
	posName := b.pos
	if name == "userinfo" && p.dbg && os.Getenv("DBGUI") != "" {
		p.probeUserinfoHeader(b, posName)
	}
	maxEnt := int(b.bits(16))
	encodeBits := numBits(maxEnt)
	numEnt := int(b.bits(encodeBits + 1))
	length := int(b.bits(20))
	// The userDataFixedSize flag (and its 12+4 size fields) only exists on the newer
	// engine branches. Remember both possible data starts; for "userinfo" we try both
	// and keep whichever actually yields player names.
	posOld := b.pos
	fixed := b.bit() == 1
	udSize, udBits := 0, 0
	if fixed {
		udSize = int(b.bits(12))
		udBits = int(b.bits(4))
	}
	posNew := b.pos
	t := stringTable{name: name, maxEnt: maxEnt, fixedSize: fixed, udSize: udSize, udBits: udBits}
	if p.dbg {
		fmt.Fprintf(os.Stderr, "  table[%d] %-24s max=%d num=%d len=%d fixed=%v udSize=%d udBits=%d\n",
			len(p.tables), name, maxEnt, numEnt, length, fixed, udSize, udBits)
	}
	end := posNew + length
	if name == "userinfo" {
		before := len(p.names)
		sub := &bitReader{data: b.data, pos: posNew}
		p.decodeTableEntries(sub, &t, numEnt, end)
		if len(p.names) == before {
			// nothing decoded: retry assuming the older layout, where the flag we just
			// consumed doesn't exist (decode only — framing still uses `end`)
			t2 := stringTable{name: name, maxEnt: maxEnt}
			sub2 := &bitReader{data: b.data, pos: posOld}
			p.decodeTableEntries(sub2, &t2, numEnt, posOld+length)
			if len(p.names) > before {
				t = t2
				if p.dbg {
					fmt.Fprintln(os.Stderr, "  userinfo: decoded with the old-engine table layout")
				}
			}
		}
	}
	p.tables = append(p.tables, t)
	b.pos = end
}

// Debug helper (DBGUI=1): the svc_CreateStringTable header widths differ between
// engine branches, and a single misplaced bit turns the userinfo blob into noise.
// Brute-force the plausible widths and report which one yields real player names.
func (p *parser) probeUserinfoHeader(b *bitReader, posName int) {
	for _, meBits := range []int{16} {
		for _, neExtra := range []int{1, 0, 2} {
			for _, lenBits := range []int{20, 18, 17, 16} {
				for _, withFlag := range []bool{true, false} {
					s := &bitReader{data: b.data, pos: posName}
					maxEnt := int(s.bits(meBits))
					if maxEnt <= 0 || maxEnt > 1<<16 {
						continue
					}
					numEnt := int(s.bits(numBits(maxEnt) + neExtra))
					length := int(s.bits(lenBits))
					t := stringTable{name: "probe", maxEnt: maxEnt}
					if withFlag {
						if s.bit() == 1 {
							t.fixedSize = true
							t.udSize = int(s.bits(12))
							t.udBits = int(s.bits(4))
						}
					}
					if numEnt <= 0 || numEnt > maxEnt || length <= 0 {
						continue
					}
					probe := &parser{names: map[int]string{}, teams: map[int]int{}, bots: map[int]bool{},
						roster: map[int]rosterEntry{}, uidBySlot: map[int]int{}, descs: map[int]evDesc{}}
					n := numEnt
					if n > 64 {
						n = 64
					}
					probe.decodeTableEntries(s, &t, n, s.pos+length)
					if len(probe.names) > 0 {
						var sample []string
						for uid, nm := range probe.names {
							sample = append(sample, fmt.Sprintf("%d:%q", uid, nm))
							if len(sample) >= 4 {
								break
							}
						}
						fmt.Fprintf(os.Stderr, "  probeUI me=%d neExtra=%d len=%d flag=%v -> max=%d num=%d length=%d fixed=%v/%d names=%d %v\n",
							meBits, neExtra, lenBits, withFlag, maxEnt, numEnt, length, t.fixedSize, t.udSize, len(probe.names), sample)
					}
				}
			}
		}
	}
}

func (p *parser) readUpdateStringTable(b *bitReader) {
	// Table ids are 5 bits except on really old demos, where they're 4 (cssff gates this
	// on the OS char in svc_ServerInfo). The payload length is a WORD, always.
	idBits := p.lay.tableIdBits
	if idBits == 0 {
		idBits = 5
	}
	if p.oldTableIdx {
		idBits = 4
	}
	id := int(b.bits(idBits))
	num := 1
	if b.bit() == 1 {
		num = int(b.bits(16))
	}
	length := int(b.bits(p.lay.tableUpdBits))
	start := b.pos
	if id >= 0 && id < len(p.tables) && p.tables[id].name == "userinfo" {
		if p.dbg {
			fmt.Fprintf(os.Stderr, "  userinfo update: %d entries, %d bits\n", num, length)
		}
		sub := &bitReader{data: b.data, pos: b.pos}
		p.decodeTableEntries(sub, &p.tables[id], num, start+length)
	}
	b.pos = start + length
}

// Standard Source string-table entry encoding (index deltas + a 32-entry substring
// history). We only care about "userinfo", whose user data is a player_info_t blob.
func (p *parser) decodeTableEntries(b *bitReader, t *stringTable, num int, limit int) {
	entryBits := numBits(t.maxEnt)
	last := -1
	var history []string
	for i := 0; i < num; i++ {
		if b.pos >= limit || b.over {
			return
		}
		idx := last + 1
		if b.bit() == 0 {
			idx = int(b.bits(entryBits))
		}
		last = idx
		var entry string
		if b.bit() == 1 {
			if b.bit() == 1 { // substring of an earlier entry
				hi := int(b.bits(5))
				n := int(b.bits(5))
				if hi < len(history) && n <= len(history[hi]) {
					entry = history[hi][:n]
				}
				entry += b.str()
			} else {
				entry = b.str()
			}
		}
		hasUD := b.bit() == 1
		if p.dbg && os.Getenv("DBGTAB") != "" && i < 20 {
			fmt.Fprintf(os.Stderr, "    entry[%d] idx=%d %q ud=%v\n", i, idx, entry, hasUD)
		}
		if hasUD { // user data
			if t.fixedSize {
				data := b.bytesN(t.udSize)
				p.readPlayerInfo(data, idx)
			} else {
				// MAX_USERDATA_BITS is 12 on this engine branch (it grew to 14 in CS:GO);
				// reading 14 here shifts every following entry into noise.
				n := int(b.bits(12))
				if n > 0 && n <= 1<<12 {
					p.readPlayerInfo(b.bytesN(n), idx)
				} else {
					return
				}
			}
		}
		history = append(history, entry)
		if len(history) > 32 {
			history = history[1:]
		}
	}
}

// player_info_t layout moved between engine branches (the xuid field was added later),
// so instead of hard-coding an offset we look for the first plausible
// (printable name, sane userID) pair at the known candidate offsets.
func (p *parser) readPlayerInfo(d []byte, slot int) {
	if len(d) < 40 {
		return
	}
	for _, nameOff := range []int{0, 8} { // 0 = pre-xuid layout, 8 = with xuid
		if nameOff+36 > len(d) {
			continue
		}
		name := cstr(d[nameOff : nameOff+32])
		if !printableName(name) {
			continue
		}
		uid := int(binary.BigEndian.Uint32(d[nameOff+32 : nameOff+36]))
		if uid <= 0 || uid > 65535 {
			// some branches store it little-endian
			uid = int(binary.LittleEndian.Uint32(d[nameOff+32 : nameOff+36]))
		}
		if uid <= 0 || uid > 65535 {
			continue
		}
		p.names[uid] = name
		if slot >= 0 {
			p.uidBySlot[slot] = uid // entity index-1 -> userID, for the position timeline
			p.tableNames++
		}
		if p.dbg {
			fmt.Fprintf(os.Stderr, "  userinfo slot=%d uid=%d name=%q\n", slot, uid, name)
		}
		return
	}
}

func printableName(s string) bool {
	if len(s) < 1 || len(s) > 31 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return false
		}
	}
	return true
}

// dem_stringtables block (protocol 14+): a plain, non-delta dump.
func (p *parser) readStringTablesBlock() {
	raw := p.skipBlock()
	if raw == nil {
		return
	}
	defer func() { recover() }()
	b := &bitReader{data: raw}
	n := int(b.byte8())
	for i := 0; i < n && !b.over; i++ {
		name := b.str()
		cnt := int(b.bits(16))
		for j := 0; j < cnt && !b.over; j++ {
			b.str()
			if b.bit() == 1 {
				l := int(b.bits(16))
				data := b.bytesN(l)
				if name == "userinfo" {
					p.readPlayerInfo(data, j)
				}
			}
		}
		if b.bit() == 1 { // client-side table follows
			cnt2 := int(b.bits(16))
			for j := 0; j < cnt2 && !b.over; j++ {
				b.str()
				if b.bit() == 1 {
					b.skip(int(b.bits(16)) * 8)
				}
			}
		}
	}
}
