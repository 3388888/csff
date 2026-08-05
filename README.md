# CSGO Demo Highlights

Point it at a folder of demos. It finds the best moments across all of them — aces, clutches,
noscopes, flicks, wallbangs, pixelsurfs, movement — ranks them by how hard they actually were,
and lets you watch each one in a built-in 2D/3D preview or jump the real game straight to it.

Works on **CS:GO / Source 1 (`HL2DEMO`) demos**. CS:S demos are supported for frag detection.

---

## Install (easy way — no build tools)

1. Download **`install.cmd`** from this repo (green **Code** button, or open the file and hit **Raw** → save).
2. Double-click it.

It downloads the latest release, unpacks it to `%LOCALAPPDATA%\CSGO Demo Highlights`, and drops a
desktop shortcut. No installer UI, nothing to click through. Re-run it any time to update.

> Prefer a normal installer? Grab **`CSGO Demo Highlights Setup.exe`** from
> [Releases](https://github.com/3388888/cc-demo-highlights/releases) instead.

---

## Using it

1. **Settings** (gear) → set your **demos folder** and your **CS:GO/CS2 exe** (and CS:S exe if you have those demos).
2. **Scan folder** → **Best of folder** builds the ranked list. The first scan decodes every
   demo (using your spare CPU); after that it's cached, so reopening is fast and only new demos get read.
3. Click a card:
   - **Preview** — watch it in the built-in 2D radar or 3D map view.
   - **Open in CS:GO** — launches the game (or jumps the already-running one), skips to the clip,
     follows the player, and **pauses** so the skip settles. Press **P** to play/pause.
4. **Star** clips (☆) to build a favorites list / demopack.

**Filters** (top bar): map, weapon, kill-type, min distance, favorites, and sort
(best / newest / oldest / longest / shortest clip). Dates come from the demo filename. Selecting a
**kill-type** kicks off a deeper background pass to surface more of exactly that category.

---

## What it finds

- **Multikills & clutches** — aces / quads / triples and 1vX clutches, with a round-by-round scoreboard.
- **Aim** — noscopes (scoped vs no-scope, distance-gated), jumpshots, flicks, spins/360s, wallbangs,
  smoke / flashed kills, airshots, long-range.
- **Pixelsurf** — a kill made while perched on a sliver of geometry too small to count as ground,
  vetted against the map's ladder/water brushes so ladders don't count as false positives.
- **Movement** — bhop runs, surf / wall-glide, edgebug / jumpbug, and flashboost (a flash
  detonating next to a teammate → velocity spike), all read from telemetry.
- **Troll kills** — knife / grenade / zeus (off by default).

Everything is scored with a **difficulty multiplier**: long, airborne, fast, low-hit-chance kills
rise; close-range spray-downs and **warmup / DM** rounds are pushed down or excluded. All the
thresholds (cssff-style frag rules) are editable in Settings.

## Previews

- **2D** — the real map radar with aim cone, killfeed, utility (smokes / mollies / flashes / HE),
  and height cues (demos are 2D, so elevation shows as sticks + `↓150u` labels).
- **3D** — the actual map: brush + displacement geometry stripped straight from the `.bsp`
  (no game files copied), chase / POV / orbit / top cameras, tracers, and a roof cutaway to see
  inside buildings. The camera avoids clipping into walls. Player models are built at runtime (zero asset size).

## Performance

- Scans in parallel, sizing the worker pool to your **actually-free CPU** and backing off when the
  machine is busy — so a big folder doesn't lock you up.
- **Decode-once**: results persist. Changing scoring or filters re-ranks from cache in seconds and
  never re-decodes demos it has already read.

## CS:S notes

CS:S demos (`cstrike`) are decoded by the bundled `cssfast` (native) with `cssff` as a fallback.
**Frag detection works across engine versions** (protocol 7/8, the v77 era, and v93/v94). The
2D/3D **position preview for CS:S is experimental and protocol-dependent** — some demos produce
frags only (no radar/3D playback). Old map versions borrow the closest radar/geometry available
(`de_tuscan` → `de_toscan`) and say so.

---

## Build from source

Requires **Node 18+** (and **Go 1.21+** only if you change the native decoders).

```bash
git clone https://github.com/3388888/cc-demo-highlights
cd cc-demo-highlights
npm install
npm start            # run in dev
```

Rebuild the native decoders (optional — prebuilt `.exe`s are committed, so this isn't needed to run):

```bash
cd native/csgofast && go build -o csgofast.exe .
cd ../cssfast       && go build -o cssfast.exe .
```

Package for distribution:

```bash
npm run dist         # NSIS installer + win-unpacked -> dist/
package.cmd          # zip the portable build for a GitHub release (what install.cmd downloads)
```

## Layout

| Path | What |
|---|---|
| `main.js` / `preload.js` | Electron main process + IPC bridge |
| `renderer/` | UI, 2D radar, WebGL 3D preview |
| `parser.js` | classify engine (kills → ranked highlights) |
| `parse-worker.js` | pooled decode/classify worker |
| `native/csgofast/` | Go CS:GO decoder (demoinfocs) |
| `native/cssfast/` | Go CS:S / Source-1 decoder |
| `bspgeo.js` · `pixelsurf.js` · `mapfiles.js` | `.bsp` geometry + ladder/water brush extraction |
| `vdm.js` | writes the `.vdm` that drives in-game playback |

Caches live in `%APPDATA%\CSGO Demo Highlights\` (`cache/`, `aggregate_v2.json.gz`, `favorites.json`, `settings.json`).

## License

MIT
