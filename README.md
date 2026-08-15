# csff — CS demo highlight finder

Point it at a folder of demos. It finds the best moments across all of them — aces, clutches,
noscopes, flicks, wallbangs, jumpshots, pixelsurfs, bhop runs, edgebugs — ranks them by how hard
they actually were, and lets you watch each one in a built-in 2D/3D preview, jump the real game
straight to the tick, export a demopack, or port the clip into Blender / Unreal.

Everything is Rust. No Node, no Electron, no external parser.

| Game | Support |
| --- | --- |
| CS:GO (Source 1, `HL2DEMO`) | full — kills, telemetry, positions, movement tricks |
| CS:S / TF2 (Orange Box) | frags, player names, SteamID64 |
| CS2 (`PBDEMS2`) | opt-in build feature |

---

## Install

Grab the installer from [Releases](https://github.com/3388888/csff/releases) and run it, or use
the portable `.exe` if you'd rather not install anything.

On first run, open **⚙ Settings** and set:

- **Demos folder** — where your `.dem` / `.dem.bz2` files live
- **Maps folder** *(optional)* — a `csgo/maps` directory, enables the 3D preview
- **Game content folder** *(optional)* — e.g. `…/csgo` or `…/cstrike`, enables real player
  models, weapons and textures in the 3D export

---

## What's in the repo

GitHub's file list shows each file's *last commit message*, not what it does — so here's the map.

### Top level

| Path | What it is |
| --- | --- |
| `native/csgo-rs/` | **The engine.** Demo parsing, highlight scoring, asset extraction, 3D export. Builds standalone as a CLI. |
| `tauri-app/` | **The desktop app.** Rust backend (`src-tauri/`) + the HTML/JS UI (`frontend/`). |
| `maps/` | Radar images (WebP) and `maps.json` — per-map calibration used to place players on the 2D radar. |
| `assets/` | Weapon and modifier icons (SVG) drawn in the killfeed and on highlight cards. |
| `vendor/cssff/` | `cssff_settings.ini` — the rulebook that decides what counts as a highlight. Editable in Settings. |
| `release/` | Built artifacts to attach to a GitHub Release. |
| `Cargo.toml` | Cargo **workspace** root — ties the engine and the app together. |

### The engine — `native/csgo-rs/src/`

| File | What it does |
| --- | --- |
| `lib.rs` | Demo container reader (CS:GO protobuf net messages), string tables, game events, and the public API. |
| `css.rs` | CS:S / TF2 parser — Orange Box bit-packed messages, auto-tuned per engine branch. |
| `entity.rs` | Entity/prop decoding — player positions, angles, velocity, team, alive state. |
| `sendtables.rs` | Network schema (`dem_datatables`) → flattened property tables for entity decode. |
| `movement.rs` | Per-tick movement tracking: bhop runs, surf, edgebug, jumpbug, pixelsurf, flashboost. |
| `classify.rs` | Turns kills and movement into ranked highlights with tags and difficulty scores. |
| `cssff.rs` | Reads `cssff_settings.ini` so the scoring thresholds are yours, not hardcoded. |
| `raw.rs` | Emits the full match JSON the UI consumes. |
| `bspgeo.rs` | Strips geometry, displacements, static props and lighting out of a `.bsp`. |
| `vpk.rs` | Reads Valve Pak archives — how every game asset is retrieved. |
| `mdl.rs` | Model geometry: `.mdl` + `.vvd` + `.vtx` → a mesh. |
| `vtf.rs` | Valve textures (DXT1/3/5) → PNG. |
| `vmt.rs` | Materials — maps a model's material name to its actual texture. |
| `export.rs` | Writes glTF (`.glb`) for Blender / Unreal: player motion, kill markers, map, props. |
| `pb.rs` | Minimal protobuf + bit reader. No codegen, no dependencies. |
| `cs2.rs` | CS2 demos, behind the `cs2` feature. |

### The app — `tauri-app/`

| File | What it does |
| --- | --- |
| `src-tauri/src/main.rs` | Every command the UI calls: scanning, caching, favourites, launching the game, exports. |
| `frontend/app.js` | The UI — highlight cards, filters, scoreboard, round timeline, settings. |
| `frontend/preview3d.js` | The 3D map preview (WebGL). |
| `frontend/classify.js` | Legacy JS scoring, kept as a reference implementation. |
| `frontend/weapons.js` | Maps weapon names to killfeed icons. |
| `frontend/style.css` | Styling. |

---

## Building

Needs a Rust toolchain. On Windows this project uses the **GNU** target.

```bash
# the app (installer lands in target/release/bundle/)
cd tauri-app/src-tauri && cargo tauri build

# the engine on its own
cargo build --release -p csgo-rs --features full
```

### Build features

The engine is modular — the core is just parsing and scoring, everything heavier is opt-in.

| Feature | Adds |
| --- | --- |
| *(default)* | Demo parsing + highlight classification |
| `bsp` | Map geometry, displacements, static props, lighting |
| `assets` | VPK / MDL / VTF / VMT extraction |
| `export3d` | glTF export (implies `bsp` + `assets`) |
| `cs2` | CS2 demo support |
| `full` | All of the above |

Core builds to ~0.48 MB; `full` to ~0.62 MB.

---

## Credit

Highlight thresholds follow [cssff](https://github.com/kkthxbye-code/cssff)'s frag model, and
`cssff_settings.ini` is compatible with it.
