package main

// Everything that differs between engine branches lives here: the per-protocol command
// ids, the message field widths, and the auto-tuner that picks those widths per demo.

import (
	"fmt"
	"os"
)

// ---------------------------------------------------------------- layout config
// The knobs that differ between engine branches. Values are auto-tuned per demo.
type layout struct {
	tickExtra    bool // net_Tick carries the 2x16-bit host frame time words
	userMsgBits  int  // svc_UserMessage payload length bits (11 or 12)
	tempEntBits  int  // svc_TempEntities payload length bits (16 or 17)
	mapHashBits  int  // svc_ServerInfo map hash: 32-bit CRC (older) or 128-bit md5 (newer)
	cmdInfoLen   int  // democmdinfo_t size in bytes (one or two view sets)
	typeBits     int  // net message id width: 5 on the 2004 engine, 6 later
	tableUpdBits int  // svc_UpdateStringTable payload length: 16 bits (2004) or 20
	tableIdBits  int  // svc_UpdateStringTable table id: 5, or 4 on really old demos
}

func (l layout) String() string {
	return fmt.Sprintf("type=%d tickExtra=%v userMsg=%d tempEnt=%d mapHash=%d cmdInfo=%d tableUpd=%d tableId=%d", l.typeBits, l.tickExtra, l.userMsgBits, l.tempEntBits, l.mapHashBits, l.cmdInfoLen, l.tableUpdBits, l.tableIdBits)
}

// command ids depend on the protocol generation
type cmds struct {
	stop         byte
	stringTables byte // 0 = not present
	customData   byte
}

func cmdsFor(netProto int) cmds {
	switch {
	case netProto <= 8:
		return cmds{stop: 7, stringTables: 0, customData: 0}
	case netProto < 36:
		return cmds{stop: 7, stringTables: 8, customData: 0}
	default:
		return cmds{stop: 7, stringTables: 9, customData: 8}
	}
}

// ---------------------------------------------------------------- auto-tuner
// Runs the first N packets under each candidate layout and scores by how many packets
// framed cleanly (every message consumed, no overrun) plus whether svc_ServerInfo's
// map name matched the header. The winner is used for the real pass.
func tune(data []byte, netProto int, mapName string, dbg bool) (layout, int) {
	best := layout{tickExtra: netProto > 8, userMsgBits: 11, tempEntBits: 17, mapHashBits: 32, cmdInfoLen: 76, typeBits: 6, tableUpdBits: 16, tableIdBits: 5}
	bestScore := -1
	bestClean := 0
	for _, tb := range []int{6, 5} {
		for _, ci := range []int{76, 40, 152} {
			for _, tickExtra := range []bool{netProto > 8, netProto <= 8} {
				for _, mh := range []int{32, 128} {
					for _, um := range []int{11, 12} {
						for _, te := range []int{17, 16} {
							for _, tuti := range [][2]int{{16, 5}, {16, 4}, {20, 5}, {20, 4}} {
								tu, ti := tuti[0], tuti[1]
								lay := layout{tickExtra: tickExtra, userMsgBits: um, tempEntBits: te, mapHashBits: mh, cmdInfoLen: ci, typeBits: tb, tableUpdBits: tu, tableIdBits: ti}
								p := newParser(data, netProto, mapName, lay, false)
								p.maxPackets = 400
								p.noEntities = true
								p.run()
								if p.packets == 0 {
									continue
								}
								clean := p.cleanPkts * 100 / p.packets
								// reward frames that actually walked the file: a layout that
								// bails after one packet must never beat one that walks 400
								score := clean*10 + p.packets/2 + p.serverInfoOK*50 - p.serverInfoBad*50
								if p.descsGood {
									score += 500
								}
								// protocol-appropriate map-hash size: newer engines (v77+/proto ~14+)
								// use a 128-bit md5, older CS:S a 32-bit CRC. Getting this wrong frames
								// cleanly but shifts every entity prop index -> garbage positions.
								if (netProto >= 14 && mh == 128) || (netProto < 14 && mh == 32) {
									score += 200
								}
								if netProto >= 14 && tu == 20 { // newer engines widened the stringtable length field
									score += 100
								}
								// a layout that decodes the userinfo table gives us
								// slot -> name, which the radar needs for labels.
								// count distinct slots so repeated table updates
								// can't inflate the score
								if n := len(p.uidBySlot); n > 0 {
									if n > 20 {
										n = 20
									}
									score += n * 40
								}
								if dbg {
									fmt.Fprintf(os.Stderr, "tune %-64s packets=%d clean=%d%% events=%d score=%d\n", lay.String(), p.packets, clean, len(p.descs), score)
								}
								if score > bestScore {
									bestScore, best, bestClean = score, lay, clean
								}
							}
						}
					}
				}
			}
		}
	}
	return best, bestClean
}
