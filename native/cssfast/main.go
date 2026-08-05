// cssfast — universal Counter-Strike: Source demo frag finder (v34 / v77 / v93+).
//
// No Go/JS library parses these, so this walks the raw net-message bitstream itself.
//
// VERSION AWARENESS
// The header's networkProtocol picks a command table and a message layout:
//
//	proto <= 8   (CS:S v34, "old" 2004 engine): dem_stop=7, no dem_stringtables
//	proto 14..35 (CS:S v77 era / EP1)         : dem_stringtables=8
//	proto >= 36  (CS:S v93+ / Orange Box)     : dem_customdata=8, dem_stringtables=9
//
// The few field widths that actually moved between engine branches (net_Tick's extra
// frame-time words, svc_UserMessage / svc_TempEntities length bits, ...) are not
// hard-coded: they're AUTO-TUNED per file. We try each candidate layout on the first
// packets and keep the one that frames cleanly (see tune()). That way a protocol we've
// never seen still lands on the right widths instead of silently desyncing.
//
// WHERE THINGS LIVE
//
//	bitreader.go    bf_read: the bit-level primitives
//	layout.go       per-branch field widths + the auto-tuner
//	parser.go       parser state and the dem_* command loop
//	messages.go     net/svc message framing (the "realign by bit length" trick)
//	stringtables.go userinfo -> slot/userID/name
//	events.go       GameEventList recovery + player_death and friends
//	entities.go     send tables, prop decode, positions timeline
//	names.go        STEAM_-anchored name recovery for pre-recording connects
//	frags.go        deaths -> clips, team inference
//	result.go       the JSON the app reads
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
)

func main() {
	args := os.Args[1:]
	var demo, out string
	for _, a := range args {
		if demo == "" {
			demo = a
		} else if out == "" {
			out = a
		}
	}
	if demo == "" {
		fmt.Fprintln(os.Stderr, "usage: cssfast <demo.dem> [out.json]")
		os.Exit(2)
	}
	data, err := os.ReadFile(demo)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	if len(data) < 1072 || string(data[:7]) != "HL2DEMO" {
		fmt.Fprintln(os.Stderr, "not a Source demo")
		os.Exit(1)
	}
	demProto := int(binary.LittleEndian.Uint32(data[8:12]))
	netProto := int(binary.LittleEndian.Uint32(data[12:16]))
	serverName := cstr(data[16:276])
	clientName := cstr(data[276:536])
	mapName := cstr(data[536:796])
	playbackTime := math.Float32frombits(binary.LittleEndian.Uint32(data[1056:1060]))
	ticks := int(int32(binary.LittleEndian.Uint32(data[1060:1064])))
	tickrate := 66
	if playbackTime > 1 && ticks > 0 {
		tickrate = int(float64(ticks)/float64(playbackTime) + 0.5)
	}

	dbg := os.Getenv("DBG") != ""
	lay, clean := tune(data, netProto, mapName, dbg)

	// Positions: the entity stream needs the right ReadUBitVar flavour (unary on the 2004
	// engine, 6-bit escapes later). Start from what the protocol suggests and, if no
	// player positions come out, re-run with the other one — cheap, and it means an
	// unexpected build still gets a radar instead of nothing.
	previewStep := int(math.Max(1, math.Round(float64(tickrate)/20)))
	entUnary, propUnary, serialBits, payloadSkip := probeEntityLayout(data, netProto, mapName, lay, previewStep, dbg)
	p := newParser(data, netProto, mapName, lay, dbg)
	p.previewStep = previewStep
	p.unaryUBitVar = entUnary
	p.unaryPropUBitVar = propUnary
	p.serialBits = serialBits
	p.payloadSkip = payloadSkip
	if v := os.Getenv("SERIAL"); v != "" {
		fmt.Sscanf(v, "%d", &p.serialBits)
	}
	if v := os.Getenv("ENTUNARY"); v != "" {
		p.unaryUBitVar = v == "1"
	}
	if v := os.Getenv("PROPUNARY"); v != "" {
		p.unaryPropUBitVar = v == "1"
	}
	p.run()
	fmt.Fprintf(os.Stderr, "cssfast entities: classes=%d ents=%d propOK=%d propFail=%d timeline=%d frames\n",
		worldClasses(p), worldEnts(p), worldOK(p), worldFail(p), len(p.timeline))
	if dbg && len(p.timeline) > 0 {
		for _, i := range []int{0, len(p.timeline) / 2, len(p.timeline) - 1} {
			f := p.timeline[i]
			fmt.Fprintf(os.Stderr, "  frame t=%d players=%d %v\n", f.T, len(f.P), f.P)
		}
	}
	// anyone still nameless (connected before the recording started)? go find them
	missing := false
	for _, d := range p.deaths {
		if d.attacker != 0 && p.names[d.attacker] == "" {
			missing = true
			break
		}
	}
	if missing {
		p.scanPlayerInfo()
	}
	p.inferTeams()

	res := buildResult(p, netProto, demProto, mapName, serverName, clientName, ticks, tickrate, lay, clean)

	if dbg {
		dumpDebug(p)
	}
	fmt.Fprintf(os.Stderr, "cssfast: net=%d map=%s tickrate=%d events=%d deaths=%d frags=%d players=%d clean=%d%% [%s]\n",
		netProto, mapName, tickrate, len(p.descs), len(p.deaths), len(res.Frags), len(res.Players), clean, lay)

	if out != "" {
		j, _ := json.Marshal(res)
		if err := os.WriteFile(out, j, 0644); err != nil {
			fmt.Fprintln(os.Stderr, "write:", err)
			os.Exit(1)
		}
	}
	// cssff-compatible text on stdout (kept so older callers still work)
	fmt.Printf("Map name: %s\nServer name: %s\nTickrate: %d\n", mapName, serverName, tickrate)
	for _, f := range res.Frags {
		fmt.Printf("Tick: %d  Player: %s (%s)\n  Frag: %s\n", f.Tick, f.Player, teamName(f.Team), f.Desc)
	}
	if len(p.deaths) == 0 {
		os.Exit(3) // nothing decoded — let the caller fall back
	}
}

// A real match timeline sweeps many distinct map cells across several players. A broken
// decode produces a handful of stuck/garbage coordinates. Bucket positions into 64-unit
// cells and require reasonable diversity before we let the preview draw them.
func timelineTrustworthy(tl []tlFrame) bool {
	if len(tl) < 8 {
		return false
	}
	cells := map[[2]int]bool{}
	slots := map[int]bool{}
	for _, f := range tl {
		for _, pl := range f.P {
			slots[pl[0]] = true
			cells[[2]int{pl[1] / 64, pl[2] / 64}] = true
		}
	}
	// need several players AND many distinct positions relative to frame count
	return len(slots) >= 2 && len(cells) >= 8 && len(cells) >= len(tl)/20
}

func buildResult(p *parser, netProto, demProto int, mapName, serverName, clientName string,
	ticks, tickrate int, lay layout, clean int) result {
	res := result{Css: true, NetProtocol: netProto, DemProtocol: demProto, MapName: mapName,
		Tickrate: tickrate, ServerName: serverName, ClientName: clientName, Ticks: ticks,
		Deaths: len(p.deaths), Layout: lay.String(), CleanPct: clean}
	res.Frags = p.buildFrags(tickrate)
	// Only trust the position timeline if it actually moved. The Source-1 entity decoder
	// can emit a single entity frozen at one garbage coordinate (which still passes the
	// "non-zero position" gate); that must not reach the 2D/3D preview as if it were real.
	if timelineTrustworthy(p.timeline) {
		res.Timeline = p.timeline
	}
	res.PreviewStep = p.previewStep
	if len(p.timeline) > 0 {
		res.Roster = map[int]rosterEntry{}
		for uid, n := range p.names {
			res.Roster[uid] = rosterEntry{Name: n, Team: p.teams[uid]}
		}
		// entity-derived entries the userinfo table never named
		for uid, r := range p.roster {
			if res.Roster[uid].Name == "" {
				res.Roster[uid] = r
			}
		}
	}
	for uid, n := range p.names {
		res.Players = append(res.Players, playerInfo{Name: n, UserID: uid, Team: p.teams[uid], Bot: p.bots[uid]})
	}
	sort.Slice(res.Players, func(i, j int) bool { return res.Players[i].UserID < res.Players[j].UserID })
	return res
}

func dumpDebug(p *parser) {
	for uid, n := range p.names {
		fmt.Fprintf(os.Stderr, "  name uid=%d %q team=%d\n", uid, n, p.teams[uid])
	}
	for i, d := range p.deaths {
		if i > 12 {
			break
		}
		fmt.Fprintf(os.Stderr, "  death tick=%d round=%d att=%d vic=%d %s hs=%v\n", d.tick, d.round, d.attacker, d.victim, d.weapon, d.headshot)
	}
	for _, want := range []string{"player_death", "player_connect", "player_team", "player_spawn", "round_start", "player_changename"} {
		for id, d := range p.descs {
			if d.name != want {
				continue
			}
			var fs []string
			for _, f := range d.fields {
				fs = append(fs, fmt.Sprintf("%s:%d", f.name, f.typ))
			}
			fmt.Fprintf(os.Stderr, "  desc %-18s id=%3d fields=[%s]\n", d.name, id, strings.Join(fs, " "))
		}
	}
}
