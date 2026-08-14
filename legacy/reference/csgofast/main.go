// csgofast — native CS:GO (Source 1) demo decoder.
// Reproduces the SAME `raw` JSON that parser.js parseRaw() emits, gzipped, so the
// existing Node classify/cache/cssff pipeline is unchanged. ~10-15x faster decode.
//
//   csgofast <demo.dem> <out.json.gz>
//   progress is printed to stderr as "P <frac>\n"; final "OK\n" to stdout.
package main

import (
	"bufio"
	"bytes"
	"compress/bzip2"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	dem "github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/events"
)

// ---------- output schema (mirrors parser.js raw) ----------
type vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}
type pinfo struct {
	Name    string  `json:"name"`
	SteamId *string `json:"steamId"`
	Team    int     `json:"team"`
	Uid     int     `json:"uid"`
}
type tele struct {
	AirborneAtKill    bool `json:"airborneAtKill"`
	SpeedAtKill       int  `json:"speedAtKill"`
	VzAtKill          int  `json:"vzAtKill"`
	FlickDeg          int  `json:"flickDeg"`
	MaxYawRate        int  `json:"maxYawRate"`
	MaxAirStreakTicks int  `json:"maxAirStreakTicks"`
	MaxAirSpeed       int  `json:"maxAirSpeed"`
	MaxVz             int  `json:"maxVz"`
	MaxSpeed          int  `json:"maxSpeed"`
}
type shot struct {
	From *vec2 `json:"from"`
	To   *vec2 `json:"to"`
}
type kill struct {
	Round           int    `json:"round"`
	KillTick        int    `json:"killTick"`
	Time            float64 `json:"time"`
	Weapon          string `json:"weapon"`
	Headshot        bool   `json:"headshot"`
	Penetrated      int    `json:"penetrated"`
	Noscope         bool   `json:"noscope"`
	Smoke           bool   `json:"smoke"`
	Blind           bool   `json:"blind"`
	Airshot         bool   `json:"airshot"`
	DistUnits       *int   `json:"distUnits"`
	DistM           *int   `json:"distM"`
	TeamAlive       int    `json:"teamAlive"`
	EnemyAliveAfter int    `json:"enemyAliveAfter"`
	EnemyDists      []int  `json:"enemyDists"`
	HitChance       float64 `json:"hitChance"`
	ShotsBeforeKill int    `json:"shotsBeforeKill"`
	Attacker        pinfo  `json:"attacker"`
	Victim          pinfo  `json:"victim"`
	Telemetry       tele   `json:"telemetry"`
	Shot            shot   `json:"shot"`
}
type pstat struct {
	SteamId   string `json:"steamId"`
	Name      string `json:"name"`
	Kills     int    `json:"kills"`
	Deaths    int    `json:"deaths"`
	Assists   int    `json:"assists"`
	Headshots int    `json:"headshots"`
	Damage    int    `json:"damage"`
	Mvps      int    `json:"mvps"`
	Team      int    `json:"team"`
}
type mrun struct {
	Uid       int     `json:"uid"`
	Name      string  `json:"name"`
	SteamId   *string `json:"steamId"`
	Team      int     `json:"team"`
	StartTick int     `json:"startTick"`
	EndTick   int     `json:"endTick"`
	Jumps     int     `json:"jumps"`
	MaxSpeed  int     `json:"maxSpeed"`
	AvgSpeed  int     `json:"avgSpeed"`
	AirPct    int     `json:"airPct"`
	DistUnits int     `json:"distUnits"`
	DurSec    float64 `json:"durSec"`
}
type trick struct {
	Uid     int     `json:"uid"`
	Name    string  `json:"name"`
	SteamId *string `json:"steamId"`
	Team    int     `json:"team"`
	Tick    int     `json:"tick"`
	Kind     string  `json:"kind"`
	FallVel  int     `json:"fallVel"`
	Spd      int     `json:"spd"`
	DurTicks int     `json:"durTicks,omitempty"`
	Dist     int     `json:"dist,omitempty"`
	X        float64 `json:"x,omitempty"` // perch location (pixelsurf: vetted vs map brushes)
	Y        float64 `json:"y,omitempty"`
	Z        float64 `json:"z,omitempty"`
}
type util struct {
	Kind    string  `json:"kind"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Tick    int     `json:"tick"`
	EndTick int     `json:"endTick"`
}
type frame struct {
	T int             `json:"t"`
	P [][]interface{} `json:"p"`
}
type rosterEnt struct {
	Name string `json:"name"`
	Team int    `json:"team"`
}
type rawOut struct {
	Header       map[string]interface{} `json:"header"`
	MapName      string                 `json:"mapName"`
	Tickrate     int                    `json:"tickrate"`
	PreviewStep  int                    `json:"previewStep"`
	Score        map[string]int         `json:"score"`
	Players      []pstat                `json:"players"`
	RoundWinners []int                  `json:"roundWinners"`
	Kills        []kill                 `json:"kills"`
	MovementRuns []mrun                 `json:"movementRuns"`
	Tricks       []trick                `json:"tricks"`
	Timeline     []frame                `json:"timeline"`
	Roster       map[string]rosterEnt   `json:"roster"`
	Utils        []util                 `json:"utils"`
}

// ---------- hit-chance model (ported from parser.js) ----------
var snipers = map[string]bool{"awp": true, "ssg08": true, "scar20": true, "g3sg1": true}
var wbase = map[string]float64{"awp": .95, "ssg08": .92, "scar20": .85, "g3sg1": .85, "ak47": .72, "m4a1": .75, "m4a1_silencer": .78, "sg556": .7, "aug": .74, "famas": .66, "galilar": .64,
	"deagle": .6, "revolver": .55, "glock": .66, "hkp2000": .7, "usp_silencer": .72, "p250": .68, "tec9": .62, "cz75a": .6, "fiveseven": .7, "elite": .58,
	"mp9": .66, "mac10": .6, "mp7": .66, "ump45": .66, "p90": .64, "bizon": .62, "mp5sd": .68, "nova": .5, "xm1014": .48, "mag7": .5, "sawedoff": .45, "m249": .55, "negev": .5}

func hitChance(weapon string, t tele, distM *int, noscope bool) float64 {
	sniper := snipers[weapon]
	c, ok := wbase[weapon]
	if !ok {
		c = 0.6
	}
	if sniper && noscope {
		c = 0.22
	}
	if t.AirborneAtKill {
		c *= 0.16
	} else if t.SpeedAtKill > 130 {
		c *= (1 - math.Min(float64(t.SpeedAtKill-130)/250, 0.6))
	}
	if distM != nil {
		c *= math.Max(0.2, 1-math.Max(0, float64(*distM)-15)/60)
	}
	return math.Max(0.01, math.Min(0.99, c))
}

// ---------- weapon enum -> csgo token (matches parser.js WPCAT/TROLL_RE) ----------
func weaponToken(eq *common.Equipment) string {
	if eq == nil {
		return "unknown"
	}
	switch eq.Type {
	case common.EqAK47:
		return "ak47"
	case common.EqM4A4:
		return "m4a1"
	case common.EqM4A1:
		return "m4a1_silencer"
	case common.EqAUG:
		return "aug"
	case common.EqSG553:
		return "sg556"
	case common.EqFamas:
		return "famas"
	case common.EqGalil:
		return "galilar"
	case common.EqAWP:
		return "awp"
	case common.EqSSG08:
		return "ssg08"
	case common.EqScar20:
		return "scar20"
	case common.EqG3SG1:
		return "g3sg1"
	case common.EqDeagle:
		return "deagle"
	case common.EqRevolver:
		return "revolver"
	case common.EqGlock:
		return "glock"
	case common.EqP2000:
		return "hkp2000"
	case common.EqUSP:
		return "usp_silencer"
	case common.EqP250:
		return "p250"
	case common.EqTec9:
		return "tec9"
	case common.EqCZ:
		return "cz75a"
	case common.EqFiveSeven:
		return "fiveseven"
	case common.EqDualBerettas:
		return "elite"
	case common.EqMP9:
		return "mp9"
	case common.EqMac10:
		return "mac10"
	case common.EqMP7:
		return "mp7"
	case common.EqUMP:
		return "ump45"
	case common.EqP90:
		return "p90"
	case common.EqBizon:
		return "bizon"
	case common.EqMP5:
		return "mp5sd"
	case common.EqNova:
		return "nova"
	case common.EqXM1014:
		return "xm1014"
	case common.EqMag7:
		return "mag7"
	case common.EqSawedOff:
		return "sawedoff"
	case common.EqM249:
		return "m249"
	case common.EqNegev:
		return "negev"
	case common.EqZeus:
		return "taser"
	case common.EqKnife:
		return "knife"
	case common.EqHE:
		return "hegrenade"
	case common.EqMolotov:
		return "molotov"
	case common.EqIncendiary:
		return "incgrenade"
	default:
		return strings.ToLower(strings.ReplaceAll(eq.String(), " ", "_"))
	}
}

// ---------- helpers ----------
func angleDiff(a, b float64) float64 {
	return math.Mod(math.Mod(a-b, 360)+540, 360) - 180
}
func r1(n float64) float64 { return math.Round(n*10) / 10 }
func steamStr(id uint64) *string {
	if id == 0 {
		return nil
	}
	s := strconv.FormatUint(id, 10)
	return &s
}

type sample struct {
	tick             int
	x, y, z          float64
	yaw              float64
	hasYaw           bool
	spd, vz          int
	onGround         bool
}

type runState struct {
	active               bool
	prevGround           bool
	startTick, endTick   int
	jumps, n, airN, slow int
	maxSpeed             int
	sumSpeed             int
	startX, startY       float64
	endX, endY           float64
	name                 string
	steamId              *string
	team                 int
}
type trickPrev struct {
	vz       int
	hasVz    bool
	onGround bool
	spd      int
	jbTick   int
	jbFall   int
	jbSpd    int
	jbActive bool
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: csgofast <demo.dem> <out.json.gz>")
		os.Exit(2)
	}
	demoPath, outPath := os.Args[1], os.Args[2]
	f, err := os.Open(demoPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer f.Close()
	var reader io.Reader = f
	if strings.HasSuffix(strings.ToLower(demoPath), ".bz2") {
		// native bzip2 -> full decompress into memory, then parse (robust + no temp .dem on disk)
		buf, derr := io.ReadAll(bzip2.NewReader(bufio.NewReaderSize(f, 1<<20)))
		if derr != nil {
			fmt.Fprintln(os.Stderr, "bz2:", derr)
			os.Exit(1)
		}
		reader = bytes.NewReader(buf)
	}

	p := dem.NewParser(reader)
	defer p.Close()
	header, err := p.ParseHeader()
	if err != nil {
		fmt.Fprintln(os.Stderr, "header:", err)
		os.Exit(1)
	}

	tickrate := int(math.Round(p.TickRate()))
	if tickrate != 64 && tickrate != 128 {
		if tickrate > 96 {
			tickrate = 128
		} else {
			tickrate = 64
		}
	}
	telWin := tickrate
	previewStep := int(math.Max(1, math.Round(float64(tickrate)/20))) // ~20fps timeline — lighter cache/memory, still smooth
	maxTick := header.PlaybackTicks + 2*tickrate
	runGapTicks := int(math.Round(float64(tickrate) * 0.45))
	ringLen := int(math.Round(float64(tickrate)*1.6)) + 8

	// state
	players := map[string]*pstat{}
	buffers := map[int][]sample{}
	fireBuf := map[int][]int{}
	runStates := map[int]*runState{}
	trickPrevs := map[int]*trickPrev{}
	surfStates := map[int]*surfState{}
	pixelStates := map[int]*pixelState{}
	var flashes []flashEv // recent flash detonations, for flashboost detection
	fbPrev := map[int]int{} // previous speed per player (flashboost spike detection)
	roster := map[string]rosterEnt{}
	var movementRuns []mrun
	var tricks []trick
	var timeline []frame
	var utils []util
	var kills []kill
	roundWinners := map[int]int{}
	roundNum := 0
	lastTL := -1 << 30
	lastProg := -1.0

	rec := func(id uint64, name string) *pstat {
		key := ""
		if id == 0 {
			key = "BOT:" + name
		} else {
			key = strconv.FormatUint(id, 10)
		}
		p := players[key]
		if p == nil {
			p = &pstat{SteamId: key, Name: name}
			players[key] = p
		}
		if name != "" {
			p.Name = name
		}
		return p
	}

	onGround := func(pl *common.Player) bool { return !pl.IsAirborne() }

	closeRun := func(uid int, r *runState) {
		r.active = false
		if r.jumps >= 3 && r.maxSpeed >= 250 {
			n := r.n
			if n < 1 {
				n = 1
			}
			movementRuns = append(movementRuns, mrun{
				Uid: uid, Name: r.name, SteamId: r.steamId, Team: r.team, StartTick: r.startTick, EndTick: r.endTick,
				Jumps: r.jumps, MaxSpeed: r.maxSpeed, AvgSpeed: int(math.Round(float64(r.sumSpeed) / float64(n))),
				AirPct:    int(math.Round(float64(r.airN) / float64(n) * 100)),
				DistUnits: int(math.Round(math.Hypot(r.endX-r.startX, r.endY-r.startY))),
				DurSec:    math.Round(float64(r.endTick-r.startTick)/float64(tickrate)*10) / 10,
			})
		}
	}

	// ----- events -----
	p.RegisterEventHandler(func(e events.Kill) {
		A, V := e.Killer, e.Victim
		ct := p.GameState().IngameTick()
		if V != nil {
			pv := rec(V.SteamID64, V.Name)
			if int(V.Team) != 0 {
				pv.Team = int(V.Team)
			}
			pv.Deaths++
		}
		teamKill := A != nil && V != nil && A.Team == V.Team
		suicide := A != nil && V != nil && A == V
		if A != nil && V != nil && !suicide {
			pa := rec(A.SteamID64, A.Name)
			if int(A.Team) != 0 {
				pa.Team = int(A.Team)
			}
			if teamKill {
				pa.Kills--
			} else {
				pa.Kills++
				if e.IsHeadshot {
					pa.Headshots++
				}
			}
		}
		if e.Assister != nil {
			rec(e.Assister.SteamID64, e.Assister.Name).Assists++
		}
		if A == nil || V == nil || suicide || teamKill {
			return
		}

		var apos, vpos *vec2
		var distUnits *int
		if A != nil {
			ap := A.Position()
			apos = &vec2{X: r1(ap.X), Y: r1(ap.Y), Z: r1(ap.Z)}
		}
		if V != nil {
			vp := V.Position()
			vpos = &vec2{X: r1(vp.X), Y: r1(vp.Y), Z: r1(vp.Z)}
		}
		if A != nil && V != nil {
			ap, vp := A.Position(), V.Position()
			d := int(math.Round(math.Sqrt((ap.X-vp.X)*(ap.X-vp.X) + (ap.Y-vp.Y)*(ap.Y-vp.Y) + (ap.Z-vp.Z)*(ap.Z-vp.Z))))
			distUnits = &d
		}
		var distM *int
		if distUnits != nil {
			m := int(math.Round(float64(*distUnits) / 52.49))
			distM = &m
		}

		enemyTeam := common.TeamCounterTerrorists
		if A.Team == common.TeamCounterTerrorists {
			enemyTeam = common.TeamTerrorists
		}
		aliveA, aliveEnemy := 0, 0
		enemyDists := []int{}
		ap := A.Position()
		for _, pl := range p.GameState().Participants().All() {
			if pl == nil || !pl.IsAlive() || pl.UserID == V.UserID {
				continue
			}
			if pl.Team != common.TeamTerrorists && pl.Team != common.TeamCounterTerrorists {
				continue
			}
			if pl.Team == A.Team {
				aliveA++
			}
			if pl.Team == enemyTeam {
				aliveEnemy++
				pp := pl.Position()
				enemyDists = append(enemyDists, int(math.Round(math.Sqrt((pp.X-ap.X)*(pp.X-ap.X)+(pp.Y-ap.Y)*(pp.Y-ap.Y)+(pp.Z-ap.Z)*(pp.Z-ap.Z)))))
			}
		}

		weapon := weaponToken(e.Weapon)
		tl := telemetry(buffers[A.UserID], ct, tickrate, telWin)
		// airshot: victim airborne at death (approximates the game's airshotkill flag)
		airshot := V.IsAirborne()

		kills = append(kills, kill{
			Round: roundNum, KillTick: ct, Time: math.Round(p.CurrentTime().Seconds()*100) / 100, Weapon: weapon,
			Headshot: e.IsHeadshot, Penetrated: e.PenetratedObjects,
			Noscope: e.NoScope, Smoke: e.ThroughSmoke, Blind: e.AttackerBlind, Airshot: airshot,
			DistUnits: distUnits, DistM: distM,
			TeamAlive: aliveA, EnemyAliveAfter: aliveEnemy, EnemyDists: enemyDists,
			HitChance:       math.Round(hitChance(weapon, tl, distM, e.NoScope)*1000) / 1000,
			ShotsBeforeKill: shotsNear(fireBuf[A.UserID], ct, tickrate),
			Attacker:        pinfo{Name: A.Name, SteamId: steamStr(A.SteamID64), Team: int(A.Team), Uid: A.UserID},
			Victim:          pinfo{Name: V.Name, SteamId: steamStr(V.SteamID64), Team: int(V.Team), Uid: V.UserID},
			Telemetry:       tl,
			Shot:            shot{From: apos, To: vpos},
		})
	})

	p.RegisterEventHandler(func(e events.PlayerHurt) {
		if e.Attacker == nil || e.Player == nil || e.Attacker.Team == e.Player.Team || e.Attacker == e.Player {
			return
		}
		d := e.HealthDamage
		if d > 100 {
			d = 100
		}
		rec(e.Attacker.SteamID64, e.Attacker.Name).Damage += d
	})
	p.RegisterEventHandler(func(e events.WeaponFire) {
		if e.Shooter == nil {
			return
		}
		uid := e.Shooter.UserID
		b := append(fireBuf[uid], p.GameState().IngameTick())
		if len(b) > 64 {
			b = b[1:]
		}
		fireBuf[uid] = b
	})
	p.RegisterEventHandler(func(e events.RoundMVPAnnouncement) {
		if e.Player != nil {
			rec(e.Player.SteamID64, e.Player.Name).Mvps++
		}
	})
	p.RegisterEventHandler(func(e events.RoundEnd) { roundWinners[roundNum] = int(e.Winner) })
	p.RegisterEventHandler(func(e events.RoundEndOfficial) { roundNum++ })

	addUtil := func(kind string, x, y float64, durSec float64) {
		ct := p.GameState().IngameTick()
		utils = append(utils, util{Kind: kind, X: r1(x), Y: r1(y), Tick: ct, EndTick: ct + int(math.Round(float64(tickrate)*durSec))})
	}
	p.RegisterEventHandler(func(e events.SmokeStart) { addUtil("smoke", e.Position.X, e.Position.Y, 17.5) })
	p.RegisterEventHandler(func(e events.HeExplode) { addUtil("he", e.Position.X, e.Position.Y, 0.4) })
	p.RegisterEventHandler(func(e events.FlashExplode) {
		addUtil("flash", e.Position.X, e.Position.Y, 0.4)
		flashes = append(flashes, flashEv{tick: p.GameState().IngameTick(), x: e.Position.X, y: e.Position.Y, z: e.Position.Z})
	})
	p.RegisterEventHandler(func(e events.DecoyStart) { addUtil("decoy", e.Position.X, e.Position.Y, 15) })
	p.RegisterEventHandler(func(e events.InfernoStart) {
		hull := e.Inferno.Fires().Active().ConvexHull2D()
		if len(hull) > 0 {
			var sx, sy float64
			for _, pt := range hull {
				sx += pt.X
				sy += pt.Y
			}
			addUtil("fire", sx/float64(len(hull)), sy/float64(len(hull)), 7)
		}
	})

	// ----- per-frame sampling -----
	p.RegisterEventHandler(func(e events.FrameDone) {
		ct := p.GameState().IngameTick()
		if ct < 0 {
			return
		}
		if ct <= maxTick {
			frac := math.Min(0.99, float64(ct)/float64(maxTick))
			if frac > lastProg+0.01 {
				lastProg = frac
				fmt.Fprintf(os.Stderr, "P %.3f\n", frac)
			}
		}
		valid := ct >= 0 && ct <= maxTick
		doTL := valid && (ct-lastTL >= previewStep || ct < lastTL)
		var fr *frame
		if doTL {
			fr = &frame{T: ct, P: [][]interface{}{}}
			lastTL = ct
		}
		for _, pl := range p.GameState().Participants().All() {
			if pl == nil || !pl.IsAlive() {
				continue
			}
			pos := pl.Position()
			vel := pl.Velocity()
			yaw := float64(pl.ViewDirectionX())
			og := onGround(pl)
			s := sample{tick: ct, x: pos.X, y: pos.Y, z: pos.Z, yaw: yaw, hasYaw: true,
				spd: int(math.Round(math.Hypot(vel.X, vel.Y))), vz: int(math.Round(vel.Z)), onGround: og}
			uid := pl.UserID
			roster[strconv.Itoa(uid)] = rosterEnt{Name: pl.Name, Team: int(pl.Team)}
			buf := append(buffers[uid], s)
			if len(buf) > ringLen {
				buf = buf[1:]
			}
			buffers[uid] = buf

			trackRun(runStates, uid, pl, s, ct, runGapTicks, tickrate, closeRun)
			trackTricks(trickPrevs, uid, pl, s, ct, &tricks)

			trackSurf(surfStates, uid, pl, s, ct, tickrate, &tricks)
			trackFlashboost(fbPrev, uid, pl, s, ct, tickrate, flashes, &tricks)
			trackPixelsurf(pixelStates, uid, pl, s, ct, tickrate, &tricks)

			if fr != nil {
				var yawVal interface{} = int(math.Round(yaw))
				fr.P = append(fr.P, []interface{}{uid, r1(s.x), r1(s.y), yawVal, int(pl.Team), int(math.Round(s.z))})
			}
		}
		if fr != nil {
			timeline = append(timeline, *fr)
		}
	})

	if err := p.ParseToEnd(); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}

	// close any open runs
	for uid, r := range runStates {
		if r.active {
			closeRun(uid, r)
		}
	}

	// scores
	gs := p.GameState()
	tScore := gs.TeamTerrorists().Score()
	ctScore := gs.TeamCounterTerrorists().Score()
	for _, pl := range gs.Participants().All() {
		if pl != nil && pl.SteamID64 != 0 {
			if ps := players[strconv.FormatUint(pl.SteamID64, 10)]; ps != nil {
				ps.Team = int(pl.Team)
			}
		}
	}
	rounds := roundNum
	if ctScore+tScore > rounds {
		rounds = ctScore + tScore
	}
	if rounds < 1 {
		rounds = 1
	}

	// assemble
	var plist []pstat
	for _, v := range players {
		plist = append(plist, *v)
	}
	rw := make([]int, rounds)
	for i := 0; i < rounds; i++ {
		if w, ok := roundWinners[i]; ok {
			rw[i] = w
		}
	}
	out := rawOut{
		Header: map[string]interface{}{"mapName": header.MapName, "serverName": header.ServerName,
			"playbackTicks": header.PlaybackTicks, "playbackTime": header.PlaybackTime.Seconds(), "playbackFrames": header.PlaybackFrames},
		MapName: header.MapName, Tickrate: tickrate, PreviewStep: previewStep,
		Score:        map[string]int{"ct": ctScore, "t": tScore, "rounds": rounds},
		Players:      plist,
		RoundWinners: rw,
		Kills:        kills,
		MovementRuns: movementRuns,
		Tricks:       tricks,
		Timeline:     timeline,
		Roster:       roster,
		Utils:        utils,
	}

	of, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "create:", err)
		os.Exit(1)
	}
	gz, _ := gzip.NewWriterLevel(of, gzip.BestSpeed) // faster compression, cache is transient
	enc := json.NewEncoder(gz)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
	gz.Close()
	of.Close()
	fmt.Fprintln(os.Stderr, "P 1.000")
	fmt.Println("OK")
}

// ---------- telemetry (ported) ----------
func atSample(buf []sample, t int) *sample {
	var best *sample
	bd := 1 << 30
	for i := range buf {
		d := buf[i].tick - t
		if d < 0 {
			d = -d
		}
		if d < bd {
			bd = d
			best = &buf[i]
		}
	}
	return best
}
func telemetry(buf []sample, killTick, tickrate, telWin int) tele {
	now := atSample(buf, killTick)
	flickDeg, maxYawRate := 0.0, 0.0
	if now != nil && now.hasYaw {
		for _, w := range []float64{0.08, 0.12, 0.16, 0.2, 0.26} {
			past := atSample(buf, killTick-int(math.Round(float64(tickrate)*w)))
			if past != nil && past.hasYaw {
				d := math.Abs(angleDiff(now.yaw, past.yaw))
				if d > flickDeg {
					flickDeg = d
				}
			}
		}
	}
	var prev *sample
	airStreak, maxAirStreak, maxAirSpeed, maxVz, maxSpeed := 0, 0, 0, 0, 0
	for i := range buf {
		s := &buf[i]
		if s.tick > killTick || s.tick < killTick-telWin {
			continue
		}
		if prev != nil && s.hasYaw && prev.hasYaw {
			r := math.Abs(angleDiff(s.yaw, prev.yaw))
			if r > maxYawRate {
				maxYawRate = r
			}
		}
		if !s.onGround {
			airStreak++
			if s.spd > maxAirSpeed {
				maxAirSpeed = s.spd
			}
		} else {
			airStreak = 0
		}
		if airStreak > maxAirStreak {
			maxAirStreak = airStreak
		}
		if s.vz > maxVz {
			maxVz = s.vz
		}
		if s.spd > maxSpeed {
			maxSpeed = s.spd
		}
		prev = s
	}
	t := tele{FlickDeg: int(math.Round(flickDeg)), MaxYawRate: int(math.Round(maxYawRate)),
		MaxAirStreakTicks: maxAirStreak, MaxAirSpeed: maxAirSpeed, MaxVz: maxVz, MaxSpeed: maxSpeed}
	if now != nil {
		t.AirborneAtKill = !now.onGround
		t.SpeedAtKill = now.spd
		t.VzAtKill = now.vz
	}
	return t
}
func shotsNear(b []int, killTick, tickrate int) int {
	n := 0
	for _, t := range b {
		if t >= killTick-tickrate && t <= killTick+4 {
			n++
		}
	}
	return n
}

// ---------- movement runs + tricks (ported) ----------
func trackRun(states map[int]*runState, uid int, pl *common.Player, s sample, ct, runGapTicks, tickrate int, closeRun func(int, *runState)) {
	r := states[uid]
	if r == nil {
		r = &runState{prevGround: true}
		states[uid] = r
	}
	fast := s.spd >= 200
	jumped := r.prevGround && !s.onGround
	if fast {
		if !r.active {
			*r = runState{active: true, prevGround: r.prevGround, startTick: ct, startX: s.x, startY: s.y, endX: s.x, endY: s.y}
		}
		r.endTick = ct
		r.slow = 0
		if s.spd > r.maxSpeed {
			r.maxSpeed = s.spd
		}
		r.sumSpeed += s.spd
		r.n++
		if !s.onGround {
			r.airN++
		}
		if jumped {
			r.jumps++
		}
		r.endX, r.endY = s.x, s.y
		r.name = pl.Name
		r.steamId = steamStr(pl.SteamID64)
		r.team = int(pl.Team)
	} else if r.active {
		r.slow++
		if r.slow > runGapTicks {
			closeRun(uid, r)
		}
	}
	r.prevGround = s.onGround
}
func trackTricks(prevs map[int]*trickPrev, uid int, pl *common.Player, s sample, ct int, tricks *[]trick) {
	p := prevs[uid]
	if p == nil {
		p = &trickPrev{}
		prevs[uid] = p
	}
	if p.hasVz && s.spd > 120 {
		if p.vz < -350 && s.vz > -45 && !s.onGround && !p.onGround {
			*tricks = append(*tricks, trick{Uid: uid, Name: pl.Name, SteamId: steamStr(pl.SteamID64), Team: int(pl.Team), Tick: ct, Kind: "edgebug", FallVel: abs(p.vz), Spd: s.spd})
		}
		if p.vz < -300 && !p.onGround && s.onGround {
			p.jbActive = true
			p.jbTick = ct
			p.jbFall = abs(p.vz)
			p.jbSpd = p.spd
		} else if p.jbActive && !s.onGround && ct-p.jbTick <= 3 && float64(s.spd) > float64(p.jbSpd)*0.85 {
			*tricks = append(*tricks, trick{Uid: uid, Name: pl.Name, SteamId: steamStr(pl.SteamID64), Team: int(pl.Team), Tick: p.jbTick, Kind: "jumpbug", FallVel: p.jbFall, Spd: s.spd})
			p.jbActive = false
		} else if p.jbActive && ct-p.jbTick > 3 {
			p.jbActive = false
		}
	}
	p.vz = s.vz
	p.hasVz = true
	p.onGround = s.onGround
	p.spd = s.spd
}
func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// flashboost: a flashbang detonating next to a (team)mate imparts a big velocity spike.
// Detected as a sudden speed jump right after a nearby flash detonation.
type flashEv struct {
	tick    int
	x, y, z float64
}

func trackFlashboost(prev map[int]int, uid int, pl *common.Player, s sample, ct, tickrate int, flashes []flashEv, tricks *[]trick) {
	pv, had := prev[uid]
	prev[uid] = s.spd
	if !had {
		return
	}
	// sudden spike to a high speed (not normal running/bhop acceleration)
	if s.spd-pv < 180 || s.spd < 300 {
		return
	}
	pos := pl.Position()
	win := int(float64(tickrate) * 0.4)
	for i := len(flashes) - 1; i >= 0; i-- {
		f := flashes[i]
		if ct-f.tick > win {
			break // flashes are in tick order; older ones are out of window
		}
		if ct-f.tick < 0 {
			continue
		}
		d := math.Sqrt((pos.X-f.x)*(pos.X-f.x) + (pos.Y-f.y)*(pos.Y-f.y) + (pos.Z-f.z)*(pos.Z-f.z))
		if d <= 320 {
			*tricks = append(*tricks, trick{Uid: uid, Name: pl.Name, SteamId: steamStr(pl.SteamID64), Team: int(pl.Team),
				Tick: ct, Kind: "flashboost", FallVel: s.spd, Spd: s.spd - pv})
			return
		}
	}
}

// surf / wall-glide: sustained airborne travel at speed with a controlled descent
// (not a normal jump arc, not freefall). Detected from telemetry, no map data needed.
type surfState struct {
	air              bool
	startTick        int
	ticks            int
	maxSpeed, sumSpd int
	n                int
	badVz            int // ticks in hard freefall (disqualifies a plain fall)
	startX, startY   float64
	endX, endY       float64
}

func trackSurf(states map[int]*surfState, uid int, pl *common.Player, s sample, ct, tickrate int, tricks *[]trick) {
	st := states[uid]
	if st == nil {
		st = &surfState{}
		states[uid] = st
	}
	if !s.onGround && s.spd >= 250 {
		if !st.air {
			*st = surfState{air: true, startTick: ct, startX: s.x, startY: s.y}
		}
		st.ticks++
		st.n++
		st.sumSpd += s.spd
		if s.spd > st.maxSpeed {
			st.maxSpeed = s.spd
		}
		if s.vz < -420 {
			st.badVz++
		}
		st.endX, st.endY = s.x, s.y
	} else if st.air {
		st.air = false
		dur := ct - st.startTick
		dist := int(math.Round(math.Hypot(st.endX-st.startX, st.endY-st.startY)))
		// long sustained air, high speed, mostly controlled descent, real horizontal travel
		if dur >= int(math.Round(float64(tickrate)*0.8)) && st.maxSpeed >= 350 && dist >= 500 && st.badVz <= st.ticks/2 {
			*tricks = append(*tricks, trick{Uid: uid, Name: pl.Name, SteamId: steamStr(pl.SteamID64), Team: int(pl.Team),
				Tick: st.startTick, Kind: "surf", FallVel: st.maxSpeed, Spd: s.spd, DurTicks: dur, Dist: dist})
		}
	}
}

// pixelsurf: the player is perched on a sliver of geometry too small for the engine to
// call it ground, so he reads as AIRBORNE while hanging motionless at wall height instead
// of falling. Airborne + no horizontal speed + no vertical movement, held for half a
// second, is physically impossible any other way. Two lookalikes survive this test and are
// filtered later against the map geometry (see pixelsurf.js): standing on a ladder, and
// treading water — which is why the perch location (x/y/z) is emitted with the candidate.
const (
	pixelMaxSpeed = 45   // u/s horizontal — "flush to the wall", not moving
	pixelMaxVz    = 20   // u/s vertical — not falling, not rising
	pixelMinSec   = 0.5  // held at least this long (kills the jump-apex false positive)
	pixelMaxDrift = 72.0 // units of horizontal travel allowed across the whole hold
)

type pixelState struct {
	on                     bool
	startTick              int
	ticks                  int
	startX, startY, startZ float64
	drift                  float64
	maxSpd                 int
	idx                    int // index into tricks once emitted, so it can keep growing
}

func trackPixelsurf(states map[int]*pixelState, uid int, pl *common.Player, s sample, ct, tickrate int, tricks *[]trick) {
	st := states[uid]
	if st == nil {
		st = &pixelState{idx: -1}
		states[uid] = st
	}
	if !s.onGround && s.spd <= pixelMaxSpeed && abs(s.vz) <= pixelMaxVz {
		if !st.on {
			*st = pixelState{on: true, startTick: ct, startX: s.x, startY: s.y, startZ: s.z, idx: -1}
		}
		st.ticks++
		if s.spd > st.maxSpd {
			st.maxSpd = s.spd
		}
		if d := math.Hypot(s.x-st.startX, s.y-st.startY); d > st.drift {
			st.drift = d
		}
		if st.drift > pixelMaxDrift {
			st.on = false // drifting: that's a glide/surf, not a perch
			return
		}
		// Emit as soon as it qualifies and keep the duration up to date afterwards: the
		// hold often ends with the player being shot, and a dead player leaves the sample
		// loop entirely — waiting for a clean end would lose exactly the good ones.
		if st.ticks >= int(math.Round(float64(tickrate)*pixelMinSec)) {
			if st.idx < 0 {
				st.idx = len(*tricks)
				*tricks = append(*tricks, trick{Uid: uid, Name: pl.Name, SteamId: steamStr(pl.SteamID64), Team: int(pl.Team),
					Tick: st.startTick, Kind: "pixelsurf", Spd: st.maxSpd,
					X: r1(st.startX), Y: r1(st.startY), Z: r1(st.startZ)})
			}
			(*tricks)[st.idx].DurTicks = st.ticks
		}
		return
	}
	st.on = false
}
