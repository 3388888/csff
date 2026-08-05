// CSGO Demo Highlights - barebones console edition. One small self-contained .exe: scan a
// folder of demos, rank the best moments, print them in the terminal, jump the real game to
// any of them. Radar/3D previews are optional add-ons you download from the menu when you
// want them. No install, no dependencies beyond this exe.
package main

import (
	"archive/zip"
	"bufio"
	"compress/bzip2"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	dem "github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/events"
)

type kill struct {
	round, tick                  int
	attacker, victim             string
	attackerID                   uint64
	weapon                       string
	headshot, noscope, wallbang  bool
	airborne, blind, smoke       bool
	distM, teamAlive, enemyAlive int
}

type highlight struct {
	demo, demoPath  string
	player          string
	playerID        uint64
	kills           []kill
	round           int
	watchTick, kill int
	score           int
	tags            []string
}

var snipers = map[string]bool{"awp": true, "ssg08": true, "scar20": true, "g3sg1": true}

func main() {
	fmt.Println("\n  CSGO Demo Highlights  -  console edition\n")
	in := bufio.NewReader(os.Stdin)

	folder := strings.Join(os.Args[1:], " ")
	if folder == "" {
		folder = ask(in, "  Demo folder (drag it in or paste the path): ")
	}
	folder = strings.Trim(strings.TrimSpace(folder), "\"")
	if folder == "" {
		return
	}

	demos := findDemos(folder)
	if len(demos) == 0 {
		fmt.Println("  No .dem / .dem.bz2 files found there.")
		pause(in)
		return
	}
	fmt.Printf("  Scanning %d demo(s)...\n", len(demos))

	var hls []highlight
	for i, d := range demos {
		fmt.Printf("\r  [%d/%d] %-50.50s", i+1, len(demos), filepath.Base(d))
		ks, err := parseDemo(d)
		if err != nil {
			continue
		}
		hls = append(hls, rank(d, ks)...)
	}
	fmt.Printf("\r  Done. %d highlights from %d demos.%30s\n\n", len(hls), len(demos), "")

	sort.Slice(hls, func(i, j int) bool { return hls[i].score > hls[j].score })
	if len(hls) > 100 {
		hls = hls[:100]
	}
	printList(hls)
	menu(in, hls)
}

// ------------------------------------------------------------------ decode
func parseDemo(path string) (kills []kill, err error) {
	defer func() { // a corrupt / non-CS:GO demo can panic demoinfocs — skip it, don't crash
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var r io.Reader = f
	if strings.HasSuffix(strings.ToLower(path), ".bz2") {
		r = bzip2.NewReader(f)
	}
	p := dem.NewParser(r)
	defer p.Close()

	round := 0
	p.RegisterEventHandler(func(e events.RoundEndOfficial) { round++ })
	p.RegisterEventHandler(func(e events.Kill) {
		A, V := e.Killer, e.Victim
		if A == nil || V == nil || A == V || A.Team == V.Team {
			return
		}
		ap, vp := A.Position(), V.Position()
		distM := int(math.Round(math.Sqrt((ap.X-vp.X)*(ap.X-vp.X)+(ap.Y-vp.Y)*(ap.Y-vp.Y)+(ap.Z-vp.Z)*(ap.Z-vp.Z)) / 52.49))

		aliveA, aliveE := 0, 0
		for _, pl := range p.GameState().Participants().All() {
			if pl == nil || !pl.IsAlive() || pl.UserID == V.UserID {
				continue
			}
			if pl.Team != common.TeamTerrorists && pl.Team != common.TeamCounterTerrorists {
				continue
			}
			if pl.Team == A.Team {
				aliveA++
			} else {
				aliveE++
			}
		}
		wep := ""
		if e.Weapon != nil {
			wep = normWep(e.Weapon.String())
		}
		kills = append(kills, kill{
			round: round, tick: p.GameState().IngameTick(),
			attacker: A.Name, victim: V.Name, attackerID: A.SteamID64, weapon: wep,
			headshot: e.IsHeadshot, noscope: e.NoScope, wallbang: e.PenetratedObjects > 0,
			airborne: A.IsAirborne(), blind: V.IsBlinded(), smoke: e.ThroughSmoke,
			distM: distM, teamAlive: aliveA, enemyAlive: aliveE,
		})
	})
	return kills, p.ParseToEnd()
}

func normWep(s string) string {
	s = strings.ToLower(s)
	for _, c := range []string{" ", "-", "."} {
		s = strings.ReplaceAll(s, c, "")
	}
	return s
}

// ------------------------------------------------------------------ ranking
func rank(demoPath string, kills []kill) []highlight {
	// group by round + attacker
	groups := map[string][]kill{}
	for _, k := range kills {
		key := strconv.Itoa(k.round) + "|" + strconv.FormatUint(k.attackerID, 10)
		groups[key] = append(groups[key], k)
	}
	var out []highlight
	base := map[int]int{1: 8, 2: 22, 3: 45, 4: 70}
	for _, g := range groups {
		n := len(g)
		h := highlight{demo: filepath.Base(demoPath), demoPath: demoPath, player: g[0].attacker, playerID: g[0].attackerID, round: g[0].round}
		score := base[n]
		if n >= 5 {
			score = 100
		}
		tags := []string{}
		if n >= 3 {
			tags = append(tags, map[int]string{3: "3K", 4: "4K"}[n])
			if n >= 5 {
				tags = []string{"ACE"}
			}
		}
		clutch := g[0].teamAlive <= 1 && g[0].enemyAlive >= 2
		if clutch {
			score += g[0].enemyAlive * 12
			tags = append(tags, fmt.Sprintf("clutch 1v%d", g[0].enemyAlive))
		}
		weps := map[string]bool{}
		for _, k := range g {
			weps[k.weapon] = true
			if k.noscope && snipers[k.weapon] {
				score += 35
				tags = append(tags, "noscope")
			}
			if k.airborne {
				score += 18
				tags = append(tags, "airborne")
			}
			if k.wallbang {
				score += 15
				tags = append(tags, "wallbang")
			}
			if k.smoke {
				score += 12
				tags = append(tags, "smoke")
			}
			if k.headshot {
				score += 4
			}
			if k.distM > 15 {
				score += min(k.distM, 40)
				if k.distM >= 25 {
					tags = append(tags, "long-range")
				}
			}
		}
		h.kills = g
		h.watchTick = g[0].tick - 128 // ~2s preroll @64t (in-game tick)
		h.kill = g[0].tick
		h.score = score
		h.tags = dedup(tags)
		out = append(out, h)
	}
	return out
}

// ------------------------------------------------------------------ output
func printList(hls []highlight) {
	fmt.Printf("  %-4s %-6s %-22s %-16s %-6s %s\n", "#", "score", "player", "what", "round", "weapons/tags")
	fmt.Println("  " + strings.Repeat("-", 76))
	for i, h := range hls {
		what := "kill"
		if n := len(h.kills); n >= 5 {
			what = "ACE"
		} else if n > 1 {
			what = fmt.Sprintf("%dK", n)
		}
		weps := map[string]bool{}
		for _, k := range h.kills {
			weps[k.weapon] = true
		}
		fmt.Printf("  %-4d %-6d %-22.22s %-16s r%-5d %s\n", i+1, h.score, h.player, what, h.round+1,
			trim(strings.Join(keys(weps), "/")+"  "+strings.Join(h.tags, " "), 30))
	}
	fmt.Println()
}

func menu(in *bufio.Reader, hls []highlight) {
	for {
		c := ask(in, "  # to open in CS  |  (d)ownloads  |  (q)uit : ")
		switch strings.ToLower(strings.TrimSpace(c)) {
		case "q", "":
			return
		case "d":
			downloads(in)
		default:
			n, err := strconv.Atoi(strings.TrimSpace(c))
			if err != nil || n < 1 || n > len(hls) {
				fmt.Println("  ?")
				continue
			}
			openInCS(in, hls[n-1])
		}
	}
}

// ------------------------------------------------------------------ open in game (writes a .vdm next to the demo)
func openInCS(in *bufio.Reader, h highlight) {
	dem := h.demoPath
	if strings.HasSuffix(strings.ToLower(dem), ".bz2") {
		fmt.Println("  (this demo is .bz2 — extract it to a .dem first; CS can't play compressed demos)")
		return
	}
	vdm := strings.TrimSuffix(dem, filepath.Ext(dem)) + ".vdm"
	if err := os.WriteFile(vdm, []byte(buildVDM(h)), 0644); err != nil {
		fmt.Println("  couldn't write .vdm:", err)
		return
	}
	fmt.Printf("  Wrote %s\n", filepath.Base(vdm))
	exe := gameExe(in)
	if exe == "" {
		fmt.Printf("  In CS's console:  playdemo \"%s\"   (the .vdm auto-jumps to the clip)\n", dem)
		return
	}
	run(exe, "-novid", "-insecure", "+playdemo", dem)
	fmt.Println("  Launching CS... it'll skip to the clip and pause (press P to play).")
}

func buildVDM(h highlight) string {
	tok := token(h.player)
	spec := ""
	if tok != "" {
		spec = "; spec_mode 4; spec_player " + tok
	}
	watch := h.watchTick
	if watch < 0 {
		watch = 0
	}
	return fmt.Sprintf(`demoactions
{
 "1"
 {
  factory "SkipAhead"
  name "s"
  starttick "0"
  skiptotick "%d"
 }
 "2"
 {
  factory "PlayCommands"
  name "c"
  starttick "%d"
  commands "host_timescale 1; bind p demo_togglepause%s; demo_pause"
 }
}
`, watch, watch, spec)
}

// ------------------------------------------------------------------ add-on downloads
type addon struct{ name, adds, url, dest string }

func downloads(in *bufio.Reader) {
	base := "https://github.com/3388888/cc-demo-highlights/releases/latest/download/"
	items := []addon{
		{"Radar images", "2D radar preview backgrounds", base + "addon-radars.zip", filepath.Join(dataDir(), "maps")},
		{"3D map geometry", "3D preview (stripped .bsp geometry)", base + "addon-maps3d.zip", filepath.Join(dataDir(), "maps3d")},
	}
	fmt.Println("\n  Optional add-ons:")
	for i, a := range items {
		have := "not installed"
		if isDir(a.dest) {
			have = "installed"
		}
		fmt.Printf("   [%d] %-18s - %s  (%s)\n", i+1, a.name, a.adds, have)
	}
	c := ask(in, "  number to download, or Enter to go back: ")
	n, err := strconv.Atoi(strings.TrimSpace(c))
	if err != nil || n < 1 || n > len(items) {
		return
	}
	a := items[n-1]
	fmt.Printf("  Downloading %s ...\n", a.name)
	if err := getZip(a.url, a.dest); err != nil {
		fmt.Println("  failed:", err, "\n  (this add-on may not be uploaded to the releases yet)")
		return
	}
	fmt.Println("  installed to", a.dest)
}

// ------------------------------------------------------------------ tiny helpers
func findDemos(root string) []string {
	var out []string
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		l := strings.ToLower(p)
		if strings.HasSuffix(l, ".dem") || strings.HasSuffix(l, ".dem.bz2") {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func gameExe(in *bufio.Reader) string {
	cfg := filepath.Join(dataDir(), "gameexe.txt")
	if b, err := os.ReadFile(cfg); err == nil {
		if p := strings.TrimSpace(string(b)); p != "" && fileExists(p) {
			return p
		}
	}
	p := strings.Trim(strings.TrimSpace(ask(in, "  Path to csgo.exe / cs2.exe (Enter to skip and get the console command): ")), "\"")
	if p == "" || !fileExists(p) {
		return ""
	}
	os.MkdirAll(dataDir(), 0755)
	os.WriteFile(cfg, []byte(p), 0644)
	return p
}

func token(name string) string {
	best := ""
	for _, t := range strings.Fields(name) {
		t = strings.NewReplacer("\"", "", ";", "", "\n", "").Replace(t)
		if len(t) > len(best) {
			best = t
		}
	}
	return best
}

func dataDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "cdh-cli") }
func ask(in *bufio.Reader, prompt string) string {
	fmt.Print(prompt)
	s, _ := in.ReadString('\n')
	return strings.TrimRight(s, "\r\n")
}
func pause(in *bufio.Reader) { ask(in, "  Press Enter to close...") }
func dedup(s []string) []string {
	seen := map[string]bool{}
	var o []string
	for _, x := range s {
		if !seen[x] {
			seen[x] = true
			o = append(o, x)
		}
	}
	return o
}
func keys(m map[string]bool) []string {
	var o []string
	for k := range m {
		o = append(o, k)
	}
	sort.Strings(o)
	return o
}
func trim(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func isDir(p string) bool      { i, err := os.Stat(p); return err == nil && i.IsDir() }
func fileExists(p string) bool { i, err := os.Stat(p); return err == nil && !i.IsDir() }

func run(exe string, args ...string) {
	c := exec.Command(exe, args...)
	c.Dir = filepath.Dir(exe)
	c.Start()
}

func getZip(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp("", "addon-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	r, err := zip.OpenReader(tmp.Name())
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		p := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(p, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(p)
		if err != nil {
			rc.Close()
			return err
		}
		io.Copy(w, rc)
		w.Close()
		rc.Close()
	}
	return nil
}
