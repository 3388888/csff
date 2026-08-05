// CSGO Demo Highlights - barebones console edition. One small self-contained .exe: scan a
// folder of demos, rank the best moments, print them in the terminal, jump the real game to
// any of them. Radar/3D previews are optional add-ons you download from the menu when you
// want them. No install, no dependencies beyond this exe.
package main

import (
	"archive/zip"
	"bufio"
	"compress/bzip2"
	"encoding/json"
	"fmt"
	"hash/crc32"
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
	Round, Tick                  int
	Attacker, Victim             string
	AttackerID                   uint64
	Weapon                       string
	Headshot, Noscope, Wallbang  bool
	Airborne, Blind, Smoke       bool
	DistM, TeamAlive, EnemyAlive int
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

// user-tunable, persisted to %LOCALAPPDATA%\cdh-cli\settings.json
type config struct {
	Folder, GameExe               string
	MinScore, MinKills, LongRangeM, Top int
}

var cfg config

func loadConfig() {
	cfg = config{MinKills: 1, LongRangeM: 25, Top: 60}
	if b, err := os.ReadFile(cfgFile()); err == nil {
		json.Unmarshal(b, &cfg)
	}
	if cfg.Top < 1 {
		cfg.Top = 60
	}
	if cfg.MinKills < 1 {
		cfg.MinKills = 1
	}
	if cfg.LongRangeM < 1 {
		cfg.LongRangeM = 25
	}
}
func saveConfig() {
	os.MkdirAll(dataDir(), 0755)
	if b, err := json.Marshal(cfg); err == nil {
		os.WriteFile(cfgFile(), b, 0644)
	}
}
func cfgFile() string { return filepath.Join(dataDir(), "settings.json") }

func main() {
	fmt.Print("\n  CSGO Demo Highlights  -  console edition\n\n")
	in := bufio.NewReader(os.Stdin)
	loadConfig()

	folder := strings.Trim(strings.TrimSpace(strings.Join(os.Args[1:], " ")), "\"")
	if folder == "" {
		folder = cfg.Folder
	}
	if folder == "" {
		folder = strings.Trim(strings.TrimSpace(ask(in, "  Demo folder (drag it in or paste the path): ")), "\"")
	}
	if folder == "" {
		return
	}
	if folder != cfg.Folder {
		cfg.Folder = folder
		saveConfig()
	}

	hls := scan(in, folder)
	mainMenu(in, folder, hls)
}

func scan(in *bufio.Reader, folder string) []highlight {
	demos := findDemos(folder)
	if len(demos) == 0 {
		fmt.Println("  No .dem / .dem.bz2 files found there.")
		return nil
	}
	fmt.Printf("  Scanning %d demo(s)...\n", len(demos))
	var hls []highlight
	cached := 0
	for i, d := range demos {
		fmt.Printf("\r  [%d/%d] %-50.50s", i+1, len(demos), filepath.Base(d))
		ks, hit, err := killsFor(d)
		if err != nil {
			continue
		}
		if hit {
			cached++
		}
		hls = append(hls, rank(d, ks)...)
	}
	fmt.Printf("\r  Done. %d highlights from %d demos (%d from cache).%20s\n\n", len(hls), len(demos), cached, "")
	sort.Slice(hls, func(i, j int) bool { return hls[i].score > hls[j].score })
	return hls
}

// apply the min-score / min-kills settings
func visible(hls []highlight) []highlight {
	var o []highlight
	for _, h := range hls {
		if h.score >= cfg.MinScore && len(h.kills) >= cfg.MinKills {
			o = append(o, h)
		}
	}
	return o
}
func topN(hls []highlight, n int) []highlight {
	if n > 0 && len(hls) > n {
		return hls[:n]
	}
	return hls
}

func mainMenu(in *bufio.Reader, folder string, hls []highlight) {
	for {
		shown := topN(visible(hls), cfg.Top)
		printList(shown)
		c := strings.ToLower(strings.TrimSpace(ask(in, "  [#] open in CS   (f)ind   (s)ettings   (d)ownloads   (r)escan   (q)uit : ")))
		switch c {
		case "q", "":
			return
		case "f":
			fragFinder(in, hls)
		case "s":
			settingsMenu(in)
		case "d":
			downloads(in)
		case "r":
			hls = scan(in, folder)
		default:
			if n, err := strconv.Atoi(c); err == nil && n >= 1 && n <= len(shown) {
				openInCS(in, shown[n-1])
			} else {
				fmt.Println("  ?")
			}
		}
	}
}

// Frag finder: filter the scanned highlights by weapon / type / player / distance.
func fragFinder(in *bufio.Reader, hls []highlight) {
	fmt.Println("\n  Frag finder - leave any blank to skip it")
	wep := strings.ToLower(strings.TrimSpace(ask(in, "  weapon (ak47 / awp / deagle / ...): ")))
	typ := strings.ToLower(strings.TrimSpace(ask(in, "  type (ace / 4k / 3k / clutch / noscope / wallbang / airborne / long-range): ")))
	who := strings.ToLower(strings.TrimSpace(ask(in, "  player name contains: ")))
	minD := atoi(ask(in, "  min distance (m): "))

	var res []highlight
	for _, h := range visible(hls) {
		if who != "" && !strings.Contains(strings.ToLower(h.player), who) {
			continue
		}
		if wep != "" {
			ok := false
			for _, k := range h.kills {
				if strings.Contains(k.Weapon, wep) {
					ok = true
				}
			}
			if !ok {
				continue
			}
		}
		if typ != "" && !matchType(h, typ) {
			continue
		}
		if minD > 0 {
			md := 0
			for _, k := range h.kills {
				if k.DistM > md {
					md = k.DistM
				}
			}
			if md < minD {
				continue
			}
		}
		res = append(res, h)
	}
	fmt.Printf("\n  %d match(es):\n", len(res))
	res = topN(res, 200)
	printList(res)
	c := ask(in, "  # to open in CS, or Enter to go back: ")
	if n, err := strconv.Atoi(strings.TrimSpace(c)); err == nil && n >= 1 && n <= len(res) {
		openInCS(in, res[n-1])
	}
}

func matchType(h highlight, typ string) bool {
	n := len(h.kills)
	switch typ {
	case "ace", "5k":
		return n >= 5
	case "4k":
		return n == 4
	case "3k":
		return n == 3
	}
	for _, t := range h.tags {
		if strings.Contains(strings.ToLower(t), typ) {
			return true
		}
	}
	return false
}

func settingsMenu(in *bufio.Reader) {
	for {
		fmt.Println("\n  Settings (frag detection / display):")
		fmt.Printf("   [1] Min score to show ........ %d\n", cfg.MinScore)
		fmt.Printf("   [2] Min kills (1 = show all) . %d\n", cfg.MinKills)
		fmt.Printf("   [3] Long-range distance (m) .. %d\n", cfg.LongRangeM)
		fmt.Printf("   [4] How many to list ......... %d\n", cfg.Top)
		fmt.Printf("   [5] Game exe ................. %s\n", orNone(cfg.GameExe))
		c := strings.TrimSpace(ask(in, "  number to change, Enter to go back: "))
		switch c {
		case "1":
			cfg.MinScore = atoi(ask(in, "  min score: "))
		case "2":
			cfg.MinKills = maxi(1, atoi(ask(in, "  min kills: ")))
		case "3":
			cfg.LongRangeM = maxi(1, atoi(ask(in, "  long-range distance (m): ")))
		case "4":
			cfg.Top = maxi(1, atoi(ask(in, "  how many to list: ")))
		case "5":
			cfg.GameExe = strings.Trim(strings.TrimSpace(ask(in, "  path to csgo.exe / cs2.exe: ")), "\"")
		default:
			saveConfig()
			return
		}
		saveConfig()
	}
}

// ------------------------------------------------------------------ decode (+ cache)
type demoCache struct {
	Mtime, Size int64
	Kills       []kill
}

func cacheDir() string { return filepath.Join(dataDir(), "cache") }
func cacheFile(path string) string {
	return filepath.Join(cacheDir(), fmt.Sprintf("%08x.json", crc32.ChecksumIEEE([]byte(path))))
}

// decode a demo, but reuse a cached result when the file hasn't changed (same mtime+size).
// This is what makes a second run near-instant.
func killsFor(path string) ([]kill, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, false, err
	}
	cf := cacheFile(path)
	if b, e := os.ReadFile(cf); e == nil {
		var c demoCache
		if json.Unmarshal(b, &c) == nil && c.Mtime == info.ModTime().UnixNano() && c.Size == info.Size() {
			return c.Kills, true, nil
		}
	}
	ks, _ := parseDemo(path) // cache the result even if it errored (e.g. a non-CS:GO demo):
	os.MkdirAll(cacheDir(), 0755) // an empty result cached means we never re-try that file.
	if b, e := json.Marshal(demoCache{info.ModTime().UnixNano(), info.Size(), ks}); e == nil {
		os.WriteFile(cf, b, 0644)
	}
	return ks, false, nil
}

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
			Round: round, Tick: p.GameState().IngameTick(),
			Attacker: A.Name, Victim: V.Name, AttackerID: A.SteamID64, Weapon: wep,
			Headshot: e.IsHeadshot, Noscope: e.NoScope, Wallbang: e.PenetratedObjects > 0,
			Airborne: A.IsAirborne(), Blind: V.IsBlinded(), Smoke: e.ThroughSmoke,
			DistM: distM, TeamAlive: aliveA, EnemyAlive: aliveE,
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
		key := strconv.Itoa(k.Round) + "|" + strconv.FormatUint(k.AttackerID, 10)
		groups[key] = append(groups[key], k)
	}
	var out []highlight
	base := map[int]int{1: 8, 2: 22, 3: 45, 4: 70}
	for _, g := range groups {
		n := len(g)
		h := highlight{demo: filepath.Base(demoPath), demoPath: demoPath, player: g[0].Attacker, playerID: g[0].AttackerID, round: g[0].Round}
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
		clutch := g[0].TeamAlive <= 1 && g[0].EnemyAlive >= 2
		if clutch {
			score += g[0].EnemyAlive * 12
			tags = append(tags, fmt.Sprintf("clutch 1v%d", g[0].EnemyAlive))
		}
		for _, k := range g {
			if k.Noscope && snipers[k.Weapon] {
				score += 35
				tags = append(tags, "noscope")
			}
			if k.Airborne {
				score += 18
				tags = append(tags, "airborne")
			}
			if k.Wallbang {
				score += 15
				tags = append(tags, "wallbang")
			}
			if k.Smoke {
				score += 12
				tags = append(tags, "smoke")
			}
			if k.Headshot {
				score += 4
			}
			if k.DistM > 15 {
				score += min(k.DistM, 40)
				if k.DistM >= cfg.LongRangeM {
					tags = append(tags, "long-range")
				}
			}
		}
		h.kills = g
		h.watchTick = g[0].Tick - 128 // ~2s preroll @64t (in-game tick)
		h.kill = g[0].Tick
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
			weps[k.Weapon] = true
		}
		fmt.Printf("  %-4d %-6d %-22.22s %-16s r%-5d %s\n", i+1, h.score, h.player, what, h.round+1,
			trim(strings.Join(keys(weps), "/")+"  "+strings.Join(h.tags, " "), 30))
	}
	fmt.Println()
}

// ------------------------------------------------------------------ open in game (writes a .vdm next to the demo)
func openInCS(in *bufio.Reader, h highlight) {
	demPath, err := playable(h.demoPath) // CS can't read .bz2 -> extract to .dem
	if err != nil {
		fmt.Println("  couldn't prepare the demo:", err)
		return
	}
	vdm := strings.TrimSuffix(demPath, filepath.Ext(demPath)) + ".vdm"
	if err := os.WriteFile(vdm, []byte(buildVDM(h)), 0644); err != nil {
		fmt.Println("  couldn't write .vdm:", err)
		return
	}
	fmt.Printf("  Wrote %s\n", filepath.Base(vdm))
	exe := gameExe(in)
	if exe == "" {
		fmt.Printf("  In CS's console:  playdemo \"%s\"   (the .vdm auto-jumps to the clip)\n", demPath)
		return
	}
	run(exe, "-novid", "-insecure", "+playdemo", demPath)
	fmt.Println("  Launching CS... it'll skip to the clip and pause (press P to play).")
}

// extract a .bz2 to the sibling .dem (once) so CS can play it; return the playable path
func playable(path string) (string, error) {
	if !strings.HasSuffix(strings.ToLower(path), ".bz2") {
		return path, nil
	}
	out := path[:len(path)-4]
	if fileExists(out) {
		return out, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	w, err := os.Create(out)
	if err != nil {
		return "", err
	}
	defer w.Close()
	fmt.Println("  extracting .bz2 (first time only)...")
	if _, err := io.Copy(w, bzip2.NewReader(f)); err != nil {
		return "", err
	}
	return out, nil
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
	if cfg.GameExe != "" && fileExists(cfg.GameExe) {
		return cfg.GameExe
	}
	p := strings.Trim(strings.TrimSpace(ask(in, "  Path to csgo.exe / cs2.exe (Enter to skip and get the console command): ")), "\"")
	if p == "" || !fileExists(p) {
		return ""
	}
	cfg.GameExe = p
	saveConfig()
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
func atoi(s string) int        { n, _ := strconv.Atoi(strings.TrimSpace(s)); return n }
func maxi(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func orNone(s string) string {
	if s == "" {
		return "(not set)"
	}
	return s
}

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
