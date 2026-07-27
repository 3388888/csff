# CSGO Demo Highlights

A Windows desktop app that scans **CS:GO (Source 1 / `HL2DEMO`) demos**, finds and ranks
the coolest moments — aces, clutches, jump-noscopes, flicks, wallbangs, RNG shots, surfs,
bhop runs, flashboosts — and shows each one as a **2D radar preview** plus a one-click
**"Open in CS:GO"** that jumps the real game to the moment (via a `.vdm`).

## Features

- **Scoreboard** + round-by-round kill breakdown, with real CS killfeed icons.
- **Difficulty-weighted ranking** — long-range noscopes, flicks, wallbangs and hard
  clutches rise to the top; close-range tag-salad and **warmup/DM** kills are excluded.
- **cssff-style frag rules** as the minimum bar: distance-gated noscopes (scoped vs
  no-scoped), jumpshots, flicks, and hard weapon-specific multikill timing — all editable.
- **Movement**: bhop runs, **surf / wall-glide**, **edgebug / jumpbug**, **flashboost**
  (a flash detonating next to a mate → velocity spike), all detected from telemetry.
- **Troll kills**: knife / grenade / zeus (incl. knife multikills). Off by default.
- **2D preview** on the real map radar — aim cone, live killfeed, utility (smokes/mollies/
  flashes/HE), and **height cues** (elevation sticks + `↓150u` on cards, since demos are 2D).
- **Best of folder**: scans a whole folder in parallel across **all your CPU cores**, then
  **persists** the results — reopening loads instantly and only new demos get scanned.
- **Instant filters**: map / weapon / kill-type / min-distance / favorites — all in-memory,
  no reparse. Find e.g. a long-range AWP air-noscope or a long-range deagle in one click.
- **Favorites → Demopack**: star clips, then export their demos (renamed `player_type_tick.dem`
  + a `.vdm` per demo) into a folder for a fragmovie.
- **Auto-updater** (electron-updater + GitHub releases).

## Architecture

Decode is split from ranking so settings changes never re-decode:

- **`native/csgofast`** (Go, `demoinfocs-golang`) — the CS:GO decoder. ~3× faster than the
  Node fallback, reads `.bz2` natively, emits the same `raw` JSON into a gzip cache.
- **`vendor/cssff`** (bundled 3rd-party binary) — CS:S frag finder for older-protocol CS:S demos.
- **`parser.js`** (Node) — `classify(raw, cfg)`: tags, scores, filters. Re-runs in ~1s from cache.
- **Electron** main/preload/renderer for the UI; per-demo work runs in forked workers.

Caches live in `%APPDATA%/CSGO Demo Highlights/` (`cache/`, `aggregate_v2.json.gz`,
`favorites.json`, `settings.json`).

## Install / run

Grab the installer from **Releases** and run it. First scan of a folder decodes each demo
once (~4s per big demo via the Go decoder) and caches it; after that, reopening is instant.

**Open in CS:GO** needs your `csgo.exe` path (Settings). Set a **netcon port** and launch
CS:GO with `-netconport 2121` to jump in the *already-running* game.

## Build from source

```bash
npm install
npm start          # run in dev
npm run dist       # build the installer -> dist/
npm run publish    # build + upload to the GitHub release (needs GH_TOKEN); enables auto-update
```

The Go decoder is prebuilt at `native/csgofast/csgofast.exe` and committed, so `npm run dist`
works without Go. To rebuild it:

```bash
cd native/csgofast && go build -o csgofast.exe .
```

## Notes / limits

- **Source 1 / CS:GO** demos. Older-protocol **CS:S** works via cssff; **Steam CS:S (v77)**
  is not supported (WIP parser in `native/cssfast`).
- Radar images and weapon icons are derived from CS:GO game files, bundled for convenience.
- Pixel-surf isn't detected (needs collision geometry not present in demo data).
- A 3D preview from map BSPs is planned but not yet built.
