package main

// Turning deaths into the clips the app shows, plus the team inference that makes the
// labels usable.
//
// The rules here are timing/weapon based (cssff's own style): multikills, fast doubles
// and "funny weapon" singles. Frags are grouped PER ROUND per attacker, the way
// frag-movie tools count them: a "5k" is five kills in one round, and we also report the
// fastest burst inside it ("5k including 4k (4hs) ak47/deagle in 2.67 seconds").

import (
	"fmt"
	"sort"
	"strings"
)

func (p *parser) buildFrags(tickrate int) []fragOut {
	sort.SliceStable(p.deaths, func(i, j int) bool { return p.deaths[i].tick < p.deaths[j].tick })
	type key struct {
		round, att int
	}
	groups := map[key][]deathRec{}
	var order []key
	for _, d := range p.deaths {
		if d.attacker == 0 || d.attacker == d.victim {
			continue // suicide / world damage
		}
		k := key{d.round, d.attacker}
		if _, seen := groups[k]; !seen {
			order = append(order, k)
		}
		groups[k] = append(groups[k], d)
	}
	var out []fragOut
	for _, k := range order {
		ds := groups[k]
		name := p.names[k.att]
		if name == "" {
			name = fmt.Sprintf("uid%d", k.att)
		}
		n := len(ds)
		hs, weaps := 0, []string{}
		seen := map[string]bool{}
		for _, d := range ds {
			if d.headshot {
				hs++
			}
			w := cleanWeap(d.weapon)
			if w != "" && !seen[w] {
				seen[w] = true
				weaps = append(weaps, w)
			}
		}
		wep := strings.Join(weaps, "/")
		// fastest burst: the widest window of kills within 8s
		bi, bj := 0, 0
		for i := 0; i < n; i++ {
			j := i
			for j+1 < n && ds[j+1].tick-ds[i].tick <= 8*tickrate {
				j++
			}
			if j-i > bj-bi {
				bi, bj = i, j
			}
		}
		burst := bj - bi + 1
		span := float64(ds[bj].tick-ds[bi].tick) / float64(tickrate)
		full := float64(ds[n-1].tick-ds[0].tick) / float64(tickrate)
		// per-kill specials (only present when the server sends the extended fields)
		var extra []string
		for _, d := range ds {
			if d.noscope {
				extra = append(extra, "noscope")
			}
			if d.penetrated > 0 {
				extra = append(extra, "wallbang")
			}
			if d.smoke {
				extra = append(extra, "through smoke")
			}
			if d.blind {
				extra = append(extra, "while blind")
			}
		}
		desc := ""
		switch {
		case burst >= 3 && burst < n:
			desc = fmt.Sprintf("%dk including %dk (%dhs) %s in %.2f seconds", n, burst, hs, wep, span)
		case n >= 3 && burst == n:
			desc = fmt.Sprintf("%dk (%dhs) %s in %.2f seconds", n, hs, wep, span)
		case n >= 3:
			desc = fmt.Sprintf("%dk (%dhs) %s over %.1f seconds", n, hs, wep, full)
		case n == 2 && burst == 2 && span <= 2.5:
			desc = fmt.Sprintf("fast 2k (%dhs) %s in %.2f seconds", hs, wep, span)
		case n <= 2 && len(extra) > 0:
			desc = fmt.Sprintf("%s %s kill", strings.Join(uniq(extra), " "), wep)
		case n == 1 && isFunny(ds[0].weapon):
			desc = fmt.Sprintf("%s kill", cleanWeap(ds[0].weapon))
		case n == 1 && hs == 1 && isSniper(ds[0].weapon):
			desc = fmt.Sprintf("%s headshot", cleanWeap(ds[0].weapon))
		}
		if desc == "" {
			continue
		}
		if n >= 3 && len(extra) > 0 {
			desc += " [" + strings.Join(uniq(extra), ", ") + "]"
		}
		out = append(out, fragOut{Tick: ds[0].tick, Player: name, Team: p.teams[k.att], Desc: desc,
			Kills: n, End: ds[n-1].tick, Round: k.round, Headshots: hs, Weapon: wep, SpanSec: round2(span)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kills != out[j].Kills {
			return out[i].Kills > out[j].Kills
		}
		return out[i].Tick < out[j].Tick
	})
	return out
}

func round2(f float64) float64  { return float64(int(f*100+0.5)) / 100 }
func cleanWeap(w string) string { return strings.TrimPrefix(w, "weapon_") }

func uniq(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func isFunny(w string) bool {
	w = cleanWeap(w)
	return w == "knife" || w == "hegrenade" || w == "grenade" || w == "flashbang" || w == "smokegrenade"
}

func isSniper(w string) bool {
	w = cleanWeap(w)
	return w == "awp" || w == "scout" || w == "g3sg1" || w == "sg550"
}

// Teams: players connected before the recording never fire player_team, so we infer
// sides from who shot whom (kills only cross team lines), then label the two groups
// CT/T from the weapons they used. Cosmetic, but it beats "Unassigned".
func (p *parser) inferTeams() {
	adj := map[int]map[int]bool{}
	link := func(a, b int) {
		if adj[a] == nil {
			adj[a] = map[int]bool{}
		}
		adj[a][b] = true
	}
	for _, d := range p.deaths {
		if d.attacker == 0 || d.victim == 0 || d.attacker == d.victim {
			continue
		}
		link(d.attacker, d.victim)
		link(d.victim, d.attacker)
	}
	side := map[int]int{}
	for start := range adj {
		if _, done := side[start]; done {
			continue
		}
		side[start] = 0
		queue := []int{start}
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			for v := range adj[u] {
				if _, done := side[v]; !done {
					side[v] = 1 - side[u]
					queue = append(queue, v)
				}
			}
		}
	}
	ctScore := [2]int{}
	for _, d := range p.deaths {
		s, ok := side[d.attacker]
		if !ok {
			continue
		}
		switch cleanWeap(d.weapon) {
		case "m4a1", "usp", "famas", "aug", "p90", "tmp", "sg550":
			ctScore[s]++
		case "ak47", "glock", "galil", "sg552", "mac10", "g3sg1", "elite":
			ctScore[s]--
		}
	}
	ctSide := 0
	if ctScore[1] > ctScore[0] {
		ctSide = 1
	}
	for uid, s := range side {
		if p.teams[uid] != 0 {
			continue // a real player_team event beats the guess
		}
		if s == ctSide {
			p.teams[uid] = 3
		} else {
			p.teams[uid] = 2
		}
	}
}

func teamName(t int) string {
	switch t {
	case 3:
		return "CT"
	case 2:
		return "TERRORIST"
	}
	return "Unassigned"
}
