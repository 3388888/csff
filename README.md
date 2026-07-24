# CSGO Demo Highlights

A desktop app that scans **CS:GO (Source 1 / `HL2DEMO`) demos**, finds and ranks the
cool moments — aces, clutches, jump-noscopes, flicks, wallbangs, RNG shots, bhop
runs, edgebugs — and shows each one as a **2D radar preview** plus a one-click
**"Open in CS:GO"** that jumps the real game to the moment (via a `.vdm`).

> Source 1 / CS:GO only. CS2 and CS:S demos are **not** supported (different engines).

## Features

- **Scoreboard** + **round-by-round** kill breakdown, like the in-game one.
- **Ranked highlights** with real CS killfeed icons (weapon + modifier icons:
  no-scope, in-air, wallbang, smoke, blind, headshot).
- **Cool-kill detection**: ace / 4k / 3k, **clutch (1vX)**, jump-noscope, noscope,
  flick / flick-HS, bhop, airborne, long-range, wallbang, collateral, airshot,
  through-smoke / blind (streak), **RNG** (low-odds single-shot, with a hit-chance
  model), **off-height** and **outnumbered** risky plays.
- **Movement**: bhop runs (speed, jumps, airtime), **edgebug / jumpbug** (only shipped
  if they saved real fall damage or led to a kill).
- **2D preview** on the real map radar, with the shooter's aim cone, a live killfeed,
  and **utility on the radar** (smokes, mollies, flashes, HE).
- **Best of folder**: parse a whole folder in parallel and rank the best across all demos.
- **Tunable**: every threshold *and* every scoring weight is editable in Settings.
  Parsing is split into **decode-once (cached) + classify**, so changing settings
  re-ranks in ~1s instead of re-parsing.
- **Watch in CS:GO**: writes a `.vdm` so the game jumps to each highlight (works with HLAE).

## Install / run

Grab the **portable `.exe`** from Releases and run it — no install.

First open of each demo decodes it once (~15–40s depending on size) and caches the
result (gzipped, ~1–10 MB per demo in `%APPDATA%/CSGO Demo Highlights/cache`). After
that it's instant, and settings changes re-rank without re-decoding.

**Open in CS:GO** needs the path to your `csgo.exe` (Settings). Point it at the build
that recorded the demos — old demos on custom maps only play back in a matching build
that has those maps.

## Build from source

```bash
npm install
npm start          # run in dev
npm run dist       # build the portable .exe -> dist/
```

Radars live in `maps/` (`<map>.png` + `maps.json` calibration). Generate them from a
CS:GO install or from map BSPs:

```bash
python tools/build-radars.py "…/csgo/resource/overviews"      # official maps
python tools/extract-bsp-radars.py "…/folder-of-bsp-or-bz2"   # custom maps (needs Pillow)
```

Maps without a radar fall back to an auto-fit view. Weapon icons in `assets/` come from
[Juknum/counter-strike-icons](https://github.com/Juknum/counter-strike-icons).

## CLI

```bash
node analyze.js "match.dem"        # text scoreboard + top highlights
```

## Notes / limits

- Radar images and weapon icons are derived from CS:GO game files — bundled for
  convenience; regenerate your own if redistributing.
- Movement detection is tuned for GOTV demos (~64 tick); thresholds are adjustable.
- Pixel-surf isn't detected (needs collision geometry not present in demo data).
