package main

// Net-message framing: dem_packet payloads are a stream of [id][message] with no outer
// lengths, so staying in sync is everything.
//
// KEY TRICK: every bulky message (PacketEntities, string tables, game events, user
// messages...) carries an explicit BIT-LENGTH, so we realign to (start+length) after
// each one — no payload decoding needed to stay in sync.

import (
	"fmt"
	"os"
	"strings"
)

// dem_packet: democmdinfo_t (76 bytes) + seq in/out + length-prefixed net messages
func (p *parser) readPacket() {
	p.off += p.lay.cmdInfoLen + 8 // democmdinfo_t + seqnr in/out
	msg := p.skipBlock()
	if msg == nil {
		return
	}
	if len(msg) < 8 {
		return // an empty "packet" means the framing guess is wrong, don't credit it
	}
	p.packets++
	defer p.sampleTimeline()
	// The signon packet's exact layout drifts between engine branches (extra
	// ServerInfo fields, table widths...), and svc_GameEventList lives in there.
	// Rather than guess, find it by scanning: the message is self-validating, so a
	// wrong offset can't be mistaken for a real list. Without the descriptors we
	// can't decode a single game event, so it's worth the one-off scan.
	if !p.descsGood && p.packets <= 64 && len(msg) > 512 {
		p.scanGameEventList(msg)
	}
	b := &bitReader{data: msg}
	ok := p.readMessages(b)
	if ok && b.left() < 8 {
		p.cleanPkts++
	}
}

func (p *parser) readMessages(b *bitReader) bool {
	trace := p.dbg && p.packets <= 4
	if trace {
		fmt.Fprintf(os.Stderr, "packet #%d (%d bits):", p.packets, len(b.data)*8)
	}
	for b.left() >= p.lay.typeBits {
		typ := int(b.bits(p.lay.typeBits))
		if trace {
			fmt.Fprintf(os.Stderr, " %d", typ)
		}
		if !p.handle(b, typ) {
			if trace {
				fmt.Fprintf(os.Stderr, " <-STOP (unhandled/desync, %d bits left)\n", b.left())
			}
			return false
		}
		if b.over {
			if trace {
				fmt.Fprintf(os.Stderr, " <-OVERRUN\n")
			}
			return false
		}
	}
	if trace {
		fmt.Fprintf(os.Stderr, " |end %d bits left\n", b.left())
	}
	return true
}

func (p *parser) handle(b *bitReader, typ int) bool {
	switch typ {
	case 0: // net_NOP
	case 1: // net_Disconnect
		b.str()
	case 2: // net_File
		b.bits(32)
		b.str()
		b.bit()
	case 3: // net_Tick
		b.bits(32)
		if p.lay.tickExtra {
			b.bits(16)
			b.bits(16)
		}
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
		p.readServerInfo(b)
	case 9: // svc_SendTable
		b.bit()
		n := int(b.bits(16))
		b.skip(n)
	case 10: // svc_ClassInfo
		n := int(b.bits(16))
		if b.bit() == 0 { // not "create on client" -> explicit list
			bitsFor := numBits(n) + 1
			for i := 0; i < n; i++ {
				b.bits(bitsFor)
				b.str()
				b.str()
			}
		}
	case 11: // svc_SetPause
		b.bit()
	case 12: // svc_CreateStringTable
		p.readCreateStringTable(b)
	case 13: // svc_UpdateStringTable
		p.readUpdateStringTable(b)
	case 14: // svc_VoiceInit
		b.str()
		b.byte8()
	case 15: // svc_VoiceData
		b.byte8()
		b.byte8()
		b.skip(int(b.bits(16)))
	case 16: // svc_HLTV / svc_Nop-ish: unknown payload -> can't frame
		return false
	case 17: // svc_Sounds
		if b.bit() == 1 {
			b.skip(int(b.bits(8)))
		} else {
			b.bits(8)
			b.skip(int(b.bits(16)))
		}
	case 18: // svc_SetView
		b.bits(11)
	case 19: // svc_FixAngle
		b.bit()
		b.bits(48)
	case 20: // svc_CrosshairAngle
		b.bits(48)
	case 21: // svc_BSPDecal
		readVecCoord(b)
		b.bits(9)
		if b.bit() == 1 {
			b.bits(11)
			b.bits(11)
		}
		b.bit()
	case 23: // svc_UserMessage
		b.byte8()
		b.skip(int(b.bits(p.lay.userMsgBits)))
	case 24: // svc_EntityMessage
		b.bits(11)
		b.bits(9)
		b.skip(int(b.bits(11)))
	case 25: // svc_GameEvent
		n := int(b.bits(11))
		start := b.pos
		p.readGameEvent(b)
		b.pos = start + n
	case 26: // svc_PacketEntities — this is where player positions live
		b.bits(11) // max entries
		isDelta := b.bit() == 1
		if isDelta {
			b.bits(32) // delta from
		}
		b.bit()                    // baseline
		updated := int(b.bits(11)) // updated entries
		n := int(b.bits(20))       // payload length in bits
		b.bit()                    // update baseline
		if p.world != nil && n > 0 {
			sub := &bitReader{data: b.data, pos: b.pos + p.world.payloadSkip}
			p.world.readPacketEntities(sub, updated, isDelta, b.pos+n)
		}
		b.skip(n)
	case 27: // svc_TempEntities
		b.byte8()
		b.skip(int(b.bits(p.lay.tempEntBits)))
	case 28: // svc_Prefetch
		b.bits(13)
	case 29: // svc_Menu
		b.bits(16)
		b.skip(int(b.bits(16)) * 8)
	case 30: // svc_GameEventList
		p.readGameEventList(b)
	case 31: // svc_GetCvarValue
		b.bits(32)
		b.str()
	default:
		return false
	}
	return true
}

func readVecCoord(b *bitReader) {
	for i := 0; i < 3; i++ {
		hasInt, hasFrac := b.bit(), b.bit()
		if hasInt == 1 || hasFrac == 1 {
			b.bit()
			if hasInt == 1 {
				b.bits(14)
			}
			if hasFrac == 1 {
				b.bits(5)
			}
		}
	}
}

// svc_ServerInfo is the one fixed-layout message we can VERIFY: it carries the map
// name, so a mismatch with the demo header tells us the layout guess was wrong.
func (p *parser) readServerInfo(b *bitReader) {
	b.bits(16)                // protocol
	b.bits(32)                // server count
	b.bit()                   // is hltv
	b.bit()                   // is dedicated
	b.bits(32)                // client dll crc
	b.bits(16)                // max classes
	b.skip(p.lay.mapHashBits) // map crc32, or an md5 on the newer branches
	b.byte8()                 // player slot
	p.maxClients = int(b.byte8())
	if p.world != nil {
		p.world.maxClients = p.maxClients
	}
	b.bits(32) // tick interval (float)
	// The OS char: 'w'/'l' on anything modern. Really old demos put something else here
	// and also use 4-bit string table indices (see cssff's m_bUse5BitStringTableIndices).
	osc := byte(b.byte8())
	if osc != 'w' && osc != 'l' {
		p.oldTableIdx = true
	}
	gd := b.str() // game dir
	m := b.str()
	sky := b.str()
	host := b.str()
	if p.dbg {
		fmt.Fprintf(os.Stderr, "  serverinfo map=%q (header %q) os=%q gamedir=%q sky=%q host=%q\n",
			m, p.headerMap, string(rune(osc)), gd, sky, host)
	}
	if m != "" && p.headerMap != "" && !strings.EqualFold(m, p.headerMap) {
		p.serverInfoBad++
	} else if m != "" {
		p.serverInfoOK++
	}
}
