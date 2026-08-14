package main

// Positions per tick: turn the decoded entity props into the same
// [uid, x, y, yaw, team, z] frames the CS:GO decoder emits, so the radar and the 3D view
// consume CS:S demos with no special-casing.
//
// Player entities are the first MAX_PLAYERS slots, so entity index N maps to client slot
// N-1. The userinfo string table gave us slot -> name/userID already, and the events gave
// us userID -> name; we join on whichever we have.

import "sort"

type playerEnt struct {
	idx int
	ent *entity
}

// Sorted by entity index on purpose: iterating the entity map directly would order the
// players differently on every run, which makes the cached JSON (and any diff of it)
// churn for no reason.
func (w *entityWorld) playerEntities() []playerEnt {
	var out []playerEnt
	for idx, e := range w.ents {
		if idx >= 1 && idx <= 64 && e.isPlayer() {
			out = append(out, playerEnt{idx: idx, ent: e})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].idx < out[j].idx })
	return out
}

// m_vecOrigin is a Vector on the old engine and VectorXY + m_vecOrigin[2] on newer ones
func (e *entity) origin() (float32, float32, float32, bool) {
	if v, ok := e.vec("m_vecOrigin"); ok {
		z := v[2]
		if zz, ok2 := e.num("m_vecOrigin[2]"); ok2 {
			z = float32(zz)
		}
		if v[0] != 0 || v[1] != 0 || z != 0 {
			return v[0], v[1], z, true
		}
	}
	return 0, 0, 0, false
}

func (e *entity) yaw() float32 {
	for _, k := range []string{"m_angEyeAngles[1]", "m_angEyeAngles", "m_angRotation", "m_angEyeAngles[0]"} {
		if v, ok := e.num(k); ok {
			return float32(v)
		}
		if v, ok := e.vec(k); ok {
			return v[1]
		}
	}
	return 0
}

func (e *entity) alive() bool {
	if v, ok := e.num("m_lifeState"); ok {
		return v == 0
	}
	if v, ok := e.num("m_iHealth"); ok {
		return v > 0
	}
	return true
}

func (p *parser) sampleTimeline() {
	if p.world == nil || p.noEntities {
		return
	}
	if p.previewStep <= 0 {
		p.previewStep = 1
	}
	// Signon frames carry the server's uptime tick (hundreds of thousands) before the
	// real per-frame ticks start at 0, so a plain ">= step" check would latch on that
	// huge value and never sample again.
	if p.curTick < p.lastSample {
		p.lastSample = p.curTick - p.previewStep
	}
	if p.curTick-p.lastSample < p.previewStep {
		return
	}
	p.lastSample = p.curTick
	fr := tlFrame{T: p.curTick}
	for _, pe := range p.world.playerEntities() {
		idx, e := pe.idx, pe.ent
		x, y, z, ok := e.origin()
		if !ok || !e.alive() {
			continue
		}
		if x < -17000 || x > 17000 || y < -17000 || y > 17000 || z < -17000 || z > 17000 {
			continue // decoded garbage — never ship it to the radar
		}
		if v, ok := e.num("m_iTeamNum"); ok && int(v) == 1 {
			continue // spectator / the SourceTV camera, not a player on the radar
		}
		uid := p.uidBySlot[idx-1]
		if uid == 0 {
			uid = idx // fall back to the entity index so the frame is still usable
		}
		team := 0
		if v, ok := e.num("m_iTeamNum"); ok {
			team = int(v)
		}
		if team == 0 {
			team = p.teams[uid]
		}
		fr.P = append(fr.P, [6]int{uid, int(x), int(y), int(e.yaw()), team, int(z)})
		if p.roster[uid].Name == "" {
			if n := p.names[uid]; n != "" {
				p.roster[uid] = rosterEntry{Name: n, Team: team}
			}
		}
	}
	if len(fr.P) > 0 {
		p.timeline = append(p.timeline, fr)
	}
}

// small accessors so main() can report on the entity decode without poking at internals
func worldClasses(p *parser) int {
	if p.world == nil {
		return 0
	}
	return len(p.world.classes)
}

func worldEnts(p *parser) int {
	if p.world == nil {
		return 0
	}
	return len(p.world.ents)
}

func worldOK(p *parser) int {
	if p.world == nil {
		return 0
	}
	return p.world.decodeOK
}

func worldFail(p *parser) int {
	if p.world == nil {
		return 0
	}
	return p.world.decodeFail
}
