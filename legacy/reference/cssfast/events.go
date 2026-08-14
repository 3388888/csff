package main

// Game events: the descriptor list (svc_GameEventList) plus the handful of events we
// actually care about — player_death for the frags, and the name/team events that keep
// the roster honest.

import (
	"fmt"
	"os"
)

type evField struct {
	name string
	typ  int
}
type evDesc struct {
	name   string
	fields []evField
}

type deathRec struct {
	tick     int
	round    int
	attacker int
	victim   int
	weapon   string
	headshot bool
	// only some server builds send these (the v34 "GameShot" event set does)
	noscope    bool
	penetrated int
	smoke      bool
	blind      bool
}

// ---------------------------------------------------------------- event list recovery
// Slides over the packet looking for a bit offset where "svc_GameEventList" decodes
// perfectly: the descriptor count, the total bit length, printable [a-z0-9_] names and
// an exact landing on start+length all have to agree, and "player_death" must be in
// there. False positives are essentially impossible.
func (p *parser) scanGameEventList(msg []byte) {
	total := len(msg) * 8
	for pos := 0; pos+40 < total; pos++ {
		b := &bitReader{data: msg, pos: pos}
		if int(b.bits(p.lay.typeBits)) != 30 { // svc_GameEventList
			continue
		}
		n := int(b.bits(9))
		length := int(b.bits(20))
		if n < 8 || n > 512 || length < 64 || b.pos+length > total {
			continue
		}
		start := b.pos
		descs := make(map[int]evDesc, n)
		ok := true
		hasDeath := false
		for i := 0; i < n && ok; i++ {
			id := int(b.bits(9))
			name := b.str()
			if !eventNameOK(name) {
				if p.dbg && os.Getenv("DBGSCAN") != "" && i >= 5 {
					fmt.Fprintf(os.Stderr, "    reject at desc #%d: bad event name %q\n", i, name)
				}
				ok = false
				break
			}
			d := evDesc{name: name}
			for {
				t := int(b.bits(3))
				if t == 0 {
					break
				}
				if t > 8 || b.over {
					ok = false
					break
				}
				fn := b.str()
				if !eventNameOK(fn) {
					if p.dbg && os.Getenv("DBGSCAN") != "" && i >= 5 {
						fmt.Fprintf(os.Stderr, "    reject at desc #%d (%s): bad key %q type=%d\n", i, name, fn, t)
					}
					ok = false
					break
				}
				d.fields = append(d.fields, evField{name: fn, typ: t})
			}
			if b.over || b.pos > start+length {
				ok = false
			}
			if name == "player_death" {
				hasDeath = true
			}
			descs[id] = d
		}
		if p.dbg && os.Getenv("DBGSCAN") != "" && len(descs) > 3 {
			fmt.Fprintf(os.Stderr, "  cand bit=%d n=%d len=%d parsed=%d ok=%v death=%v end=%d want=%d\n",
				pos, n, length, len(descs), ok, hasDeath, b.pos, start+length)
		}
		if !ok || !hasDeath || b.pos != start+length {
			continue
		}
		p.descs = descs
		p.descsGood = true
		if p.dbg {
			fmt.Fprintf(os.Stderr, "  recovered GameEventList at bit %d: %d events\n", pos, n)
		}
		return
	}
}

func eventNameOK(s string) bool {
	// single-char keys are real (hegrenade_detonate has x/y/z)
	if len(s) < 1 || len(s) > 48 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------- game events
func (p *parser) readGameEventList(b *bitReader) {
	n := int(b.bits(9))
	length := int(b.bits(20))
	start := b.pos
	descs := make(map[int]evDesc, n)
	hasDeath := false
	for i := 0; i < n; i++ {
		id := int(b.bits(9))
		d := evDesc{name: b.str()}
		if !eventNameOK(d.name) {
			break // garbage: this list is unusable, leave whatever we already had
		}
		for {
			t := int(b.bits(3))
			if t == 0 || b.over {
				break
			}
			d.fields = append(d.fields, evField{name: b.str(), typ: t})
		}
		if d.name == "player_death" {
			hasDeath = true
		}
		descs[id] = d
	}
	if hasDeath && !p.descsGood {
		p.descs = descs
		p.descsGood = true
		if p.dbg {
			fmt.Fprintf(os.Stderr, "  GameEventList in-stream: %d events\n", len(descs))
		}
	}
	b.pos = start + length
}

func (p *parser) readGameEvent(b *bitReader) {
	d, ok := p.descs[int(b.bits(9))]
	if !ok {
		return
	}
	switch d.name {
	case "player_death":
		rec := deathRec{tick: p.curTick, round: p.round}
		for _, f := range d.fields {
			v := readEventField(b, f.typ)
			switch f.name {
			case "userid":
				rec.victim = toInt(v)
			case "attacker":
				rec.attacker = toInt(v)
			case "weapon":
				if s, o := v.(string); o {
					rec.weapon = s
				}
			case "headshot":
				rec.headshot = toInt(v) != 0
			case "noscope":
				rec.noscope = toInt(v) != 0
			case "penetrated":
				rec.penetrated = toInt(v)
			case "smoke", "thrusmoke":
				rec.smoke = toInt(v) != 0
			case "attackerblind":
				rec.blind = toInt(v) != 0
			}
		}
		p.deaths = append(p.deaths, rec)
	// Names and teams come from the events themselves — much more robust across
	// engine branches than decoding the userinfo string table.
	case "player_team", "player_spawn", "player_info", "player_connect", "player_changename":
		uid, team, name := 0, 0, ""
		bot := false
		for _, f := range d.fields {
			v := readEventField(b, f.typ)
			switch f.name {
			case "userid":
				uid = toInt(v)
			case "team", "teamnum":
				team = toInt(v)
			case "name", "newname", "playername":
				if s, o := v.(string); o && s != "" {
					name = s
				}
			case "isbot", "bot":
				bot = toInt(v) != 0
			}
		}
		if uid > 0 {
			if name != "" {
				p.names[uid] = name
			}
			if team == 2 || team == 3 {
				p.teams[uid] = team
			}
			if bot {
				p.bots[uid] = true
			}
		}
	case "round_start":
		p.round++
	}
}

func toInt(v interface{}) int {
	switch x := v.(type) {
	case int:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	}
	return 0
}

func readEventField(b *bitReader, typ int) interface{} {
	switch typ {
	case 1: // string
		return b.str()
	case 2: // float
		return int(int32(b.bits(32)))
	case 3: // long
		return int(int32(b.bits(32)))
	case 4: // short
		return int(int16(uint16(b.bits(16))))
	case 5: // byte
		return int(b.byte8())
	case 6: // bool
		return b.bit()
	case 7: // uint64
		b.bits(32)
		b.bits(32)
	case 8: // wstring
		return b.str()
	}
	return 0
}
