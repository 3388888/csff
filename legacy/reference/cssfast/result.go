package main

// The JSON the app consumes. Field names and shapes match the CS:GO decoder's output
// where they overlap (timeline / roster), so the renderer needs no CS:S-specific code.

type playerInfo struct {
	Name   string `json:"name"`
	UserID int    `json:"userId"`
	Team   int    `json:"team"`
	Bot    bool   `json:"bot"`
}

type fragOut struct {
	Tick      int     `json:"tick"`
	Player    string  `json:"player"`
	Team      int     `json:"team"`
	Desc      string  `json:"desc"`
	Kills     int     `json:"kills"`
	End       int     `json:"endTick"`
	Round     int     `json:"round"`
	Headshots int     `json:"headshots"`
	Weapon    string  `json:"weapon"`
	SpanSec   float64 `json:"spanSec"`
}

// one sampled tick of positions, shaped exactly like the CS:GO decoder's output so the
// app's radar / 3D preview can consume it unchanged: [uid, x, y, yaw, team, z]
type tlFrame struct {
	T int      `json:"t"`
	P [][6]int `json:"p"`
}

type rosterEntry struct {
	Name string `json:"name"`
	Team int    `json:"team"`
}

type result struct {
	// positions for the radar / 3D preview, shaped exactly like the CS:GO decoder's raw
	// output so the app can slice frames from it with the same code
	Timeline    []tlFrame           `json:"timeline,omitempty"`
	Roster      map[int]rosterEntry `json:"roster,omitempty"`
	PreviewStep int                 `json:"previewStep,omitempty"`
	Css         bool                `json:"css"`
	NetProtocol int                 `json:"netProtocol"`
	DemProtocol int                 `json:"demProtocol"`
	MapName     string              `json:"mapName"`
	Tickrate    int                 `json:"tickrate"`
	ServerName  string              `json:"serverName"`
	ClientName  string              `json:"clientName"`
	Ticks       int                 `json:"ticks"`
	Deaths      int                 `json:"deaths"`
	Players     []playerInfo        `json:"players"`
	Frags       []fragOut           `json:"frags"`
	Layout      string              `json:"layout"`
	CleanPct    int                 `json:"cleanPct"`
}
