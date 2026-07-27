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
- **3D preview** of the actual map — brush + displacement geometry stripped straight out of
  the `.bsp` (no game files copied), with chase / POV / orbit / top cameras, tracers, utility
  blobs and a **roof cutaway** so you can see inside buildings. Players are deliberately
  crude box models (built at runtime, so zero asset size) that hold a gun or the one knife,
  walk, and fall over when they die — just enough to read what happened.
- **Named-tick focus** — a demo called `unnBHop1_124400_agency.dem` is 20 failed attempts plus
  the one that landed, so highlights near the tick in the filename are kept (`◎ tick 124400`)
  and the rest are hidden behind the *named tick* filter. Real frags elsewhere in the file
  still survive (aces, quads, 1v3+ clutches, or anything scoring over the keep threshold);
  movement clips never do, since those are the noise. Dates and map-name years
  (`pug_2026-07-05_1032_de_cache_2014_og`) are not mistaken for ticks.
- **CS:S demos** across engine generations: v34 (network protocol 7/8), the v77 era (14/15)
  and v93/v94 (24+). Frags are grouped per round (`5k including 4k (4hs) ak47/deagle in
  2.67 seconds`) with names, teams and one-click *Open in CS:S*.
- **CS:S radar + 3D preview** on protocol 7/8: `native/cssfast` decodes the entity stream
  into the same position timeline the CS:GO side uses, so those clips play back in the 2D
  radar and the stripped-`.bsp` 3D view, and can be starred into a demopack. Old map
  versions borrow the closest radar/geometry we have (`de_tuscan` → `de_toscan`) and say so.
  Protocol 24 (v93/v94) still parses frags only — no positions yet.
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
- **`cssffcfg.js`** — reads `vendor/cssff/cssff_settings.ini`. **That file is the rulebook**: max
  times per weapon category, `Nk_special_kill_extra_max_time`, `Nk_min_headshots`,
  `Nk_must_include_special_kill`, `tick_slow_stationary_Nks` + `slow_Nk_max_range`, the
  `tick_*` switches, noscope/jumpshot/flick distances and modifiers, `wallbang_require_two`,
  `tick_frags_vs_bots`. It's re-read on every parse, so editing it and re-scanning is enough.
  Clutches have to clear the same multikill law as any other burst of that size.
- **`bspgeo.js`** (Node) — reads only the geometry lumps of a `.bsp`/`.bsp.bz2`
  (vertexes/edges/surfedges/faces + texinfo + displacements) and strips them into a triangle
  soup: int16 positions, one material byte per triangle. Sky, nodraw, trigger and hint
  surfaces are dropped, and the 3D-skybox mini-world is culled. A 40 MB map → ~300 KB gzipped.
  Runs in a forked `geo-worker.js` on first preview, then caches to `%APPDATA%/…/geo/`.
- **`renderer/preview3d.js`** — dependency-free WebGL2 renderer (flat shading via `dFdx/dFdy`,
  so no normals are stored). Players are boxes at the demo's own coordinates, so 2D and 3D
  agree exactly.
- **`native/cssfast`** (Go) — our own CS:S demo reader. It parses the header, dispatches on
  `networkProtocol` (command table + message layout differ per generation), then walks the
  net-message bitstream. The handful of field widths that moved between engine branches
  (message id 5 vs 6 bits, `net_Tick`'s extra words, the ServerInfo map hash, democmdinfo
  size, ...) are **auto-tuned per file**: each candidate layout is tried on the first 400
  packets and scored on how cleanly it frames, so an unseen protocol still lands correctly.
  `svc_GameEventList` is located by a self-validating scan (its descriptor count, bit length
  and key names all have to agree), and player names fall back to a Steam-ID-anchored scan
  of the `player_info_t` blobs for players who connected before the recording started.
  cssff.exe stays as a fallback if all of that fails.
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
- **3D preview**: needs the map's `.bsp`. It's looked up in Settings ▸ *Maps folder* /
  *Extra maps folder*, next to your game exe (`…/csgo/maps`), `Downloads/custom maps`, and
  `maps/workshop/<id>/`. First open of a map costs ~0.2 s (`.bsp`) or ~5 s (`.bsp.bz2`),
  then it's cached. Brush geometry and terrain only — no props/models, and no textures
  (surfaces are tinted by material class). Camera pitch is inferred (demos only store yaw),
  and LZMA lump-compressed maps aren't supported.
- Prebuild geometry for a whole maps folder (ships in the installer, skips runtime stripping):

  ```bash
  node tools/build-geo.js "…/csgo/maps" "…/Downloads/custom maps"   # -> maps3d/
  ```
