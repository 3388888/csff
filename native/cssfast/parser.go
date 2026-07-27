package main

// The parser's state and the outer demo-file loop (dem_* commands). Net-message framing
// lives in messages.go, the payload decoders in their own files.

import (
	"encoding/binary"
	"fmt"
	"os"
)

type parser struct {
	data     []byte
	off      int
	cmd      cmds
	lay      layout
	netProto int

	descs     map[int]evDesc
	descsGood bool
	deaths    []deathRec
	names     map[int]string // userid -> name
	teams     map[int]int    // userid -> team (2 T, 3 CT)
	bots      map[int]bool
	round     int
	curTick   int

	// framing stats used by the auto-tuner
	packets       int
	cleanPkts     int
	serverInfoOK  int
	serverInfoBad int
	maxPackets    int // stop after N packets (tuning runs)
	headerMap     string
	tables        []stringTable
	dbg           bool
	trace         int

	// entity decoding (positions for the radar / 3D preview)
	world            *entityWorld
	unaryUBitVar     bool
	unaryPropUBitVar bool
	serialBits       int
	payloadSkip      int
	maxClients       int
	flagBits         int
	noEntities       bool // tuning runs skip the expensive entity work
	timeline         []tlFrame
	previewStep      int
	lastSample       int
	roster           map[int]rosterEntry
	uidBySlot        map[int]int // entity index-1 (client slot) -> userID
	tableNames       int         // userinfo entries that yielded a name + slot
	oldTableIdx      bool        // ServerInfo said "really old demo": 4-bit table ids
}

func newParser(data []byte, netProto int, mapName string, lay layout, dbg bool) *parser {
	return &parser{data: data, off: 1072, cmd: cmdsFor(netProto), lay: lay, netProto: netProto,
		descs: map[int]evDesc{}, names: map[int]string{}, teams: map[int]int{}, bots: map[int]bool{},
		roster: map[int]rosterEntry{}, uidBySlot: map[int]int{},
		headerMap: mapName, dbg: dbg, trace: traceN(dbg)}
}

func traceN(dbg bool) int {
	if dbg && os.Getenv("TRACE") != "" {
		return 30
	}
	return 0
}

func (p *parser) u32() uint32 {
	if p.off+4 > len(p.data) {
		p.off = len(p.data)
		return 0
	}
	v := binary.LittleEndian.Uint32(p.data[p.off : p.off+4])
	p.off += 4
	return v
}
func (p *parser) i32() int { return int(int32(p.u32())) }

// The demo file is a flat list of [command][tick][payload] records.
func (p *parser) run() {
	defer func() { recover() }() // a malformed tail must never crash the tool
	for p.off < len(p.data) {
		if p.maxPackets > 0 && p.packets >= p.maxPackets {
			return
		}
		cmdOff := p.off
		cmd := p.data[p.off]
		p.off++
		if cmd == p.cmd.stop {
			return
		}
		if p.off+4 > len(p.data) {
			return
		}
		p.curTick = p.i32() // CS:S demos have no playerslot byte
		if p.trace > 0 {
			fmt.Fprintf(os.Stderr, "cmd=%d tick=%d @%d\n", cmd, p.curTick, cmdOff)
			p.trace--
		}
		switch cmd {
		case 1, 2: // dem_signon, dem_packet
			p.readPacket()
		case 3: // dem_synctick
		case 4: // dem_consolecmd
			p.skipBlock()
		case 5: // dem_usercmd
			p.off += 4
			p.skipBlock()
		case 6: // dem_datatables — the send tables the entity stream is encoded against
			blk := p.skipBlock()
			if blk != nil && p.world == nil && !p.noEntities {
				if p.dbg && os.Getenv("DBGDT") != "" {
					dumpDataTableStart(blk)
				}
				w, fb, err := buildEntityWorld(blk, p.dbg)
				if err == nil {
					p.world = w
					p.world.unaryVar = p.unaryUBitVar
					p.world.unaryPropVar = p.unaryPropUBitVar
					p.world.serialBits = p.serialBits
					p.world.payloadSkip = p.payloadSkip
					p.world.maxClients = p.maxClients
					p.flagBits = fb
				} else if p.dbg {
					fmt.Fprintln(os.Stderr, "  datatables:", err)
				}
			}
		default:
			if p.cmd.stringTables != 0 && cmd == p.cmd.stringTables {
				p.readStringTablesBlock()
			} else if p.cmd.customData != 0 && cmd == p.cmd.customData {
				p.off += 4 // custom data type
				p.skipBlock()
			} else {
				return // unknown command: we're misaligned, stop cleanly
			}
		}
	}
}

func (p *parser) skipBlock() []byte {
	n := p.i32()
	if n < 0 || p.off+n > len(p.data) {
		p.off = len(p.data)
		return nil
	}
	b := p.data[p.off : p.off+n]
	p.off += n
	return b
}
