# CSGO Demo Highlights — Tauri (Rust) shell

This replaces the Electron shell with a **Rust backend** (Tauri v2). The parser/classify
engine (`native/csgo-rs`) is called **in-process** as a library — no Node, no Go subprocess.

## Status (honest)

This is a **compiling scaffold**, not a finished app. I could not build/run the Tauri GUI in
a headless environment, so treat it as a starting point to `cargo tauri dev` and iterate.

| Piece | State |
|---|---|
| `native/csgo-rs` as a library (`csgo_rs::analyze_demo`) | ✅ done, compiles |
| Tauri config + backend scaffold (`src-tauri/`) | ✅ written (v2 conventions) |
| Core commands: settings, list demos, parse demo, pick folder | ✅ implemented |
| `window.api` shim (`frontend/api-shim.js`) | ✅ core wired, rest stubbed |
| Remaining commands (frames/preview, launch+VDM, radar/geo, favorites, ratings, aggregate, cpu, cssff) | ⬜ stubbed — port from Electron `main.js` |
| Renderer copied into `frontend/` | ⬜ you do this (see below) |

## Setup

```bash
# 1. install the Tauri CLI (once)
cargo install tauri-cli --version "^2"

# 2. bring the existing UI in
cp ../renderer/index.html ../renderer/app.js ../renderer/preview3d.js \
   ../renderer/weapons.js ../renderer/style.css frontend/
#    then add  <script src="api-shim.js"></script>  in index.html BEFORE app.js

# 3. run it (needs WebView2 — preinstalled on Win10/11)
cd src-tauri
cargo tauri dev
```

Build the csgo-rs lib with the `app` feature (the scaffold's Cargo.toml already requests it;
it needs `protoc` only if you also enable `cs2`).

## How the wiring works

- Renderer calls `window.api.parseDemo(path, opts)` (unchanged from Electron).
- `frontend/api-shim.js` maps that to `invoke("parse_demo", {...})`.
- `src-tauri/src/main.rs` `parse_demo` calls `csgo_rs::analyze_demo(path, full)` — the same
  Rust engine the CLI uses — and returns ranked highlights JSON.

## To finish the port

Each remaining `window.api.*` method has a matching handler in the Electron `main.js`
(`ipcMain.handle("...")`). Port each to a `#[tauri::command]`:

- `get_frames` → slice the position timeline (add a `frames(path, a, b)` to `csgo_rs`).
- `launch_csgo` → port `vdm.js` + the netcon launch (main.js `csgo:launch`).
- `maps_radar` / `maps_geo` → read `maps/*.png` as data URLs / port `bspgeo.js`.
- favorites / ratings / aggregate → JSON files in `app_config_dir()`.
- `cpu_sample`, `cssff:config`, `demos:pixelsurfPending`, `demopack:export`, `feedback:export`.
