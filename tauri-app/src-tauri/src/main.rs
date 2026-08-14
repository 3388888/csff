// CSGO Demo Highlights — Tauri (Rust) shell.
//
// Replaces the Electron main process. Each renderer `window.api.*` call (see the Electron
// preload.js) becomes a #[tauri::command] here. The heavy lifting — decoding + classifying
// demos — is done IN-PROCESS by the csgo_rs library (no Node, no Go subprocess).
//
// STATUS: the core flow (settings, list demos, parse demo, pick folder) is implemented.
// The rest are stubbed with TODOs pointing at the Electron main.js handler they replace.
// This compiles against tauri v2; run with `cargo tauri dev` (needs WebView2).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join("settings.json")
}

// ---- settings -------------------------------------------------------------
#[tauri::command]
fn settings_get(app: tauri::AppHandle) -> Value {
    fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn settings_set(app: tauri::AppHandle, value: Value) -> Result<(), String> {
    let dir = config_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // MERGE, never replace. A wholesale write means any caller that sends a partial object
    // silently destroys every other setting — that's how gameDir/mapsDir kept vanishing and
    // exports quietly fell back to untextured geometry. Keys are only overwritten, never dropped.
    let mut cur = fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}));
    if !cur.is_object() {
        cur = json!({});
    }
    if let (Some(dst), Some(src)) = (cur.as_object_mut(), value.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    fs::write(
        settings_path(&app),
        serde_json::to_vec_pretty(&cur).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

// ---- demos ----------------------------------------------------------------
#[derive(serde::Serialize)]
struct DemoItem {
    name: String,
    path: String,
    mtime: f64,
    compressed: bool,
}
// async: recursively stats a whole demo library (12k+ files on a spinning disk) — that is not
// main-thread work.
#[tauri::command]
async fn list_demos(dir: String) -> Vec<DemoItem> {
    tauri::async_runtime::spawn_blocking(move || list_demos_blocking(dir))
        .await
        .unwrap_or_default()
}

fn list_demos_blocking(dir: String) -> Vec<DemoItem> {
    fn walk(p: &Path, out: &mut Vec<DemoItem>) {
        let rd = match fs::read_dir(p) {
            Ok(r) => r,
            Err(_) => return,
        };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, out);
                continue;
            }
            let low = path.to_string_lossy().to_lowercase();
            let (is_dem, compressed) = if low.ends_with(".dem") {
                (true, false)
            } else if low.ends_with(".dem.bz2") {
                (true, true)
            } else {
                (false, false)
            };
            if !is_dem {
                continue;
            }
            let name = path
                .file_name()
                .map(|x| x.to_string_lossy().trim_end_matches(".bz2").to_string())
                .unwrap_or_default();
            let mtime = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            out.push(DemoItem {
                name,
                path: path.to_string_lossy().to_string(),
                mtime,
                compressed,
            });
        }
    }
    let mut all = Vec::new();
    walk(Path::new(&dir), &mut all);
    // ONE entry per demo. After extracting, a demo exists as BOTH foo.dem and foo.dem.bz2 —
    // listing both counted every archive twice (7k demos showed as 12k), parsed them twice,
    // and produced duplicate cards (same clip, two different demPaths, so dedup couldn't see
    // it). The extracted .dem always wins; the .bz2 is only used when nothing else exists.
    let mut best: HashMap<String, DemoItem> = HashMap::new();
    for d in all {
        let key = d.path.to_lowercase().trim_end_matches(".bz2").to_string();
        match best.get(&key) {
            Some(prev) if !prev.compressed => {} // already have the extracted one
            _ => {
                best.insert(key, d);
            }
        }
    }
    let mut out: Vec<DemoItem> = best.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// cache file for a demo's raw JSON. Kept in a visible `demo-cache` subfolder RIGHT NEXT TO
// the demos (not a hidden AppData dir) so users can see it, gauge its size, and delete it.
// Named after the demo file so it's obvious which cache belongs to which demo.
fn raw_cache_path(demo_path: &str) -> PathBuf {
    let p = Path::new(demo_path);
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_name().and_then(|s| s.to_str()).unwrap_or("demo");
    // Old flat location: <demos>/demo-cache. If a valid cache already sits there, keep using it
    // rather than forcing a full re-parse just because the folder layout moved.
    let old = parent.join("demo-cache").join(format!("{}.raw.v5.json", stem));
    if old.is_file() {
        return old;
    }
    let dir = parent.join(".demo-reader").join("demo-cache");
    let _ = fs::create_dir_all(&dir);
    // v4 = steamId + shotsBeforeKill + alive-only timeline + deterministic slot→uid names
    // (the "card says x, preview says Lucas" fix). Bump invalidates older cached raws.
    dir.join(format!("{}.raw.v5.json", stem))
}

/// Decode one demo in-process. CS:GO → the csgofast-schema RAW (the frontend runs classify
/// on it, using your cssff .ini). CS:S → the css-frags result. Caches the raw so re-scans
/// don't re-decode (this is the "I parsed this folder a billion times" fix).
///
/// This is `async` + `spawn_blocking` on purpose: Tauri runs *sync* commands on the main
/// thread, so 10 concurrent `invoke("parse_demo")` calls would serialize onto one core and
/// freeze the UI. Offloading the decode to the blocking pool gives real N-core parallelism
/// and keeps the webview responsive.
#[tauri::command]
async fn parse_demo(app: tauri::AppHandle, path: String, full: bool) -> Result<Value, String> {
    // read the setting here (cheap) so the blocking worker never touches the AppHandle
    let del = fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|s| s.get("deleteBz2").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || parse_demo_blocking(&path, full, del))
        .await
        .map_err(|e| e.to_string())?
}

// CS:GO can't play a .bz2 and our decoder can't read one either. Extract it ONCE to the sibling
// .dem (idempotent) and use that — same thing the Electron build did with seek-bzip. Without
// this every compressed demo failed, which is why a 7k-demo folder only yielded a few hundred.
fn ensure_extracted(path: &str, delete_bz2: bool) -> Result<String, String> {
    if !path.to_lowercase().ends_with(".bz2") {
        return Ok(path.to_string());
    }
    let out = &path[..path.len() - 4]; // strip ".bz2"
    if !Path::new(path).is_file() && Path::new(out).is_file() {
        return Ok(out.to_string()); // archive already gone, extracted .dem is what we have
    }
    if Path::new(out).is_file() {
        // already extracted: honour "delete .bz2 after extracting" for the leftover archive
        if delete_bz2 {
            let _ = fs::remove_file(path);
        }
        return Ok(out.to_string());
    }
    // Prefer 7-Zip, fall back to bzip2 (Git for Windows ships one).
    let sevenz = ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
        .iter()
        .find(|p| Path::new(p).is_file())
        .map(|s| s.to_string());
    let ok = if let Some(z) = sevenz {
        let dir = Path::new(path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        std::process::Command::new(z)
            .args(["e", "-y", path, &format!("-o{}", dir.to_string_lossy())])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        let bz = ["C:\\Program Files\\Git\\usr\\bin\\bzip2.exe", "bzip2"]
            .iter()
            .find(|p| **p == "bzip2" || Path::new(p).is_file())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "bzip2".into());
        std::process::Command::new(bz)
            .args(["-dkf", path])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if ok && Path::new(out).is_file() {
        if delete_bz2 {
            let _ = fs::remove_file(path); // Settings ▸ "delete .bz2 after extracting"
        }
        Ok(out.to_string())
    } else {
        Err("could not extract .bz2 (install 7-Zip, or extract the demo manually)".into())
    }
}

/// Extract many .bz2 in ONE 7-Zip invocation. Spawning a process costs ~145ms; doing that per
/// archive across thousands of demos is pure waste. 7z accepts a list, so one spawn handles a
/// whole batch and the overhead per demo drops to a few ms. Returns how many were extracted.
#[tauri::command]
async fn extract_batch(app: tauri::AppHandle, paths: Vec<String>) -> Value {
    let del = fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|s| s.get("deleteBz2").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let sevenz = ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
            .iter()
            .find(|p| Path::new(p).is_file())
            .map(|s| s.to_string());
        let Some(z) = sevenz else { return json!({ "ok": false, "done": 0 }) };
        // group by folder — 7z writes all outputs to a single -o directory
        let mut by_dir: HashMap<String, Vec<String>> = HashMap::new();
        for p in paths.iter() {
            if !p.to_lowercase().ends_with(".bz2") || Path::new(&p[..p.len() - 4]).is_file() {
                continue; // not compressed, or already extracted
            }
            let d = Path::new(p).parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            by_dir.entry(d).or_default().push(p.clone());
        }
        let mut done = 0;
        for (dir, files) in by_dir {
            for chunk in files.chunks(64) {
                let mut cmd = std::process::Command::new(&z);
                cmd.arg("e").arg("-y").args(chunk).arg(format!("-o{dir}"));
                if cmd.output().map(|o| o.status.success()).unwrap_or(false) {
                    for f in chunk {
                        if Path::new(&f[..f.len() - 4]).is_file() {
                            done += 1;
                            if del {
                                let _ = fs::remove_file(f);
                            }
                        }
                    }
                }
            }
        }
        json!({ "ok": true, "done": done })
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "done": 0 }))
}

fn parse_demo_blocking(path: &str, _full: bool, delete_bz2: bool) -> Result<Value, String> {
    let path = &ensure_extracted(path, delete_bz2)?;
    let data = fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 16 || &data[..7] != b"HL2DEMO" {
        return Err("unsupported demo (not a Source-1 CS:GO/CS:S demo)".into());
    }
    let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
    if net > 0 && net < 1000 {
        // CS:S (fast frag path — not cached; it's already quick)
        let j = csgo_rs::css_result_json(path).ok_or("CS:S parse failed")?;
        return serde_json::from_str(&j).map_err(|e| e.to_string());
    }
    // CS:GO — classify entirely in Rust (same cssff rulebook, no JS pass)
    // cached raw if the cache is newer than the demo file
    let cache = raw_cache_path(path);
    let demo_mtime = fs::metadata(path).and_then(|m| m.modified()).ok();
    if let (Ok(cm), Some(dm)) = (fs::metadata(&cache).and_then(|m| m.modified()), demo_mtime) {
        if cm >= dm {
            if let Ok(txt) = fs::read_to_string(&cache) {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    return Ok(v);
                }
            }
        }
    }
    // (No legacy-cache reuse here: older caches predate the steamId/misses schema, so reusing
    // them would reintroduce the wrong-killer attribution + all-one-tap bugs. Decode fresh.)
    // decode + cache
    let j = csgo_rs::parse_raw_json(path).ok_or("CS:GO parse failed")?;
    let _ = fs::write(&cache, &j);
    serde_json::from_str(&j).map_err(|e| e.to_string())
}

/// Classify a demo in Rust and return the finished highlights — the renderer no longer runs
/// classify.js at all. Same rulebook (the cssff .ini) and same scoring, one pass, no JS.
#[tauri::command]
async fn classify_demo(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let ini = cssff_ini(app.clone());
    let del = fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|s| s.get("deleteBz2").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let src = ensure_extracted(&path, del).map_err(|e| e.to_string())?;
        // CS:S/TF2 keep their own frag path — detect here so the renderer only makes ONE call
        // (it used to invoke parse_demo just to sniff the format, decoding every demo twice).
        let data = fs::read(&src).map_err(|e| e.to_string())?;
        if data.len() >= 16 && &data[..7] == b"HL2DEMO" {
            let net = i32::from_le_bytes(data[12..16].try_into().unwrap());
            if net > 0 && net < 1000 {
                let j = csgo_rs::css_result_json(&src).ok_or("CS:S parse failed")?;
                return serde_json::from_str::<Value>(&j).map_err(|e| e.to_string());
            }
        }
        let ini_opt = if ini.trim().is_empty() { None } else { Some(ini.as_str()) };
        let j = csgo_rs::classify_demo_json(&src, ini_opt).ok_or("classify failed")?;
        serde_json::from_str::<Value>(&j).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Text of the cssff_settings.ini (the classify rulebook) so the frontend classify can use it.
#[tauri::command]
fn cssff_ini(app: tauri::AppHandle) -> String {
    let s = store_read(&app, "settings.json");
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = s.get("cssffIni").and_then(|v| v.as_str()) {
        cands.push(PathBuf::from(p));
    }
    cands.push(PathBuf::from("../../vendor/cssff/cssff_settings.ini"));
    cands.push(PathBuf::from("vendor/cssff/cssff_settings.ini"));
    if let Ok(res) = app.path().resource_dir() {
        cands.push(res.join("cssff_settings.ini"));
    }
    for p in cands {
        if let Ok(t) = fs::read_to_string(&p) {
            return t;
        }
    }
    String::new()
}

// Where the rulebook .ini actually lives (first hit wins), so the UI can show + reveal it.
fn cssff_ini_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let s = store_read(app, "settings.json");
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = s.get("cssffIni").and_then(|v| v.as_str()) {
        cands.push(PathBuf::from(p));
    }
    cands.push(PathBuf::from("../../vendor/cssff/cssff_settings.ini"));
    cands.push(PathBuf::from("vendor/cssff/cssff_settings.ini"));
    if let Ok(res) = app.path().resource_dir() {
        cands.push(res.join("cssff_settings.ini"));
    }
    cands.into_iter().find(|p| p.is_file())
}

/// The rulebook as STRUCTURED data: { file, mtime, ok, error, general, sections }.
/// This was a `() => ({})` stub, so Settings showed "ini not found" and, worse, the scan
/// signature saw mtime=undefined — editing the .ini never triggered a re-extract.
#[tauri::command]
fn cssff_config(app: tauri::AppHandle) -> Value {
    let Some(path) = cssff_ini_path(&app) else {
        return json!({ "ok": false, "error": "cssff_settings.ini not found", "file": null,
                       "mtime": 0, "general": {}, "sections": {} });
    };
    let mtime = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let text = fs::read_to_string(&path).unwrap_or_default();
    // parse into [General] + per-weapon sections, same shape the Electron handler returned
    let mut general = serde_json::Map::new();
    let mut sections: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut cur: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(sec) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let name = sec.trim();
            cur = if name.eq_ignore_ascii_case("general") { None } else { Some(name.to_string()) };
            if let Some(n) = &cur {
                sections.entry(n.clone()).or_insert_with(|| json!({}));
            }
            continue;
        }
        if let Some(eq) = line.find('=') {
            if eq >= 1 {
                let k = line[..eq].trim().to_string();
                let v = line[eq + 1..].trim();
                let lv = v.to_lowercase();
                let val = if lv == "true" || lv == "yes" {
                    json!(true)
                } else if lv == "false" || lv == "no" {
                    json!(false)
                } else if let Ok(n) = v.parse::<f64>() {
                    json!(n)
                } else {
                    json!(v)
                };
                match &cur {
                    None => {
                        general.insert(k, val);
                    }
                    Some(s) => {
                        if let Some(o) = sections.get_mut(s).and_then(|x| x.as_object_mut()) {
                            o.insert(k, val);
                        }
                    }
                }
            }
        }
    }
    json!({ "ok": true, "error": Value::Null, "file": path.to_string_lossy(), "mtime": mtime,
            "general": general, "sections": sections })
}

/// Reveal the rulebook in Explorer (Electron: cssff:reveal).
#[tauri::command]
fn reveal_cssff(app: tauri::AppHandle) -> bool {
    match cssff_ini_path(&app) {
        Some(p) => {
            let _ = std::process::Command::new("explorer").args(["/select,", &p.to_string_lossy()]).spawn();
            true
        }
        None => false,
    }
}

// ---- demopack export ------------------------------------------------------
fn sani(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let t = out.trim_matches('_').to_string();
    let t: String = t.chars().take(40).collect();
    if t.is_empty() { "clip".into() } else { t }
}

/// Copy every favourited demo into a shareable pack:
///   <out>/<kill type>/<killer>_<map>_<desc>_<weapon>_tick<N>.dem   (+ matching .vdm)
///   <out>/manifest.json
/// `compress`: "none" | "demo" (each .dem individually) | "folder" (zip each kill-type folder)
/// | "pack" (one zip for everything). Uses 7-Zip when compression is asked for.
#[tauri::command]
async fn export_demopack(app: tauri::AppHandle, favs: Vec<Value>, compress: Option<String>) -> Value {
    let favs: Vec<Value> = favs
        .into_iter()
        .filter(|f| f.get("demoPath").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false))
        .collect();
    if favs.is_empty() {
        return json!({ "ok": false, "error": "No favorites yet — star some clips first." });
    }
    let Some(out_dir) = app.dialog().file().blocking_pick_folder() else {
        return json!({ "ok": false, "error": "cancelled" });
    };
    let out_dir = PathBuf::from(out_dir.to_string());
    let mode = compress.unwrap_or_else(|| "demo".into());

    tauri::async_runtime::spawn_blocking(move || {
        // group clips per source demo so one demo carries all its favourited moments
        let mut by_demo: HashMap<String, Vec<Value>> = HashMap::new();
        for f in favs {
            let p = f.get("demoPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
            by_demo.entry(p).or_default().push(f);
        }
        let get_s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let get_i = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);

        let (mut copied, mut failed, mut clips) = (0u32, 0u32, 0u32);
        let mut manifest: Vec<Value> = Vec::new();
        let mut folders: Vec<String> = Vec::new();

        for (demo_path, mut list) in by_demo {
            // the archive may be all that's left (or the .dem) — resolve either way
            let src = if Path::new(&demo_path).is_file() {
                demo_path.clone()
            } else if demo_path.to_lowercase().ends_with(".bz2") && Path::new(&demo_path[..demo_path.len() - 4]).is_file() {
                demo_path[..demo_path.len() - 4].to_string()
            } else if Path::new(&format!("{demo_path}.bz2")).is_file() {
                match ensure_extracted(&format!("{demo_path}.bz2"), false) {
                    Ok(p) => p,
                    Err(_) => { failed += 1; continue; }
                }
            } else {
                failed += 1;
                continue;
            };
            list.sort_by_key(|c| -get_i(c, "score"));
            let top = list[0].clone();
            let kind = { let t = get_s(&top, "type"); if t.is_empty() { "clips".into() } else { t } };
            let folder = out_dir.join(sani(&kind));
            if fs::create_dir_all(&folder).is_err() {
                failed += 1;
                continue;
            }
            if !folders.contains(&sani(&kind)) {
                folders.push(sani(&kind));
            }
            // weapon of the best clip, for the filename
            let weapon = top
                .get("killData").and_then(|k| k.as_array()).and_then(|a| a.first())
                .and_then(|k| k.get("weapon")).and_then(|w| w.as_str())
                .unwrap_or("").to_string();
            let tick = get_i(&top, "tick");
            let mut parts = vec![sani(&get_s(&top, "player")), sani(&get_s(&top, "mapName")), sani(&kind)];
            if !weapon.is_empty() {
                parts.push(sani(&weapon));
            }
            if list.len() > 1 {
                parts.push(format!("{}clips", list.len()));
            }
            parts.push(format!("tick{tick}"));
            let base = parts.join("_");
            let mut dest = folder.join(format!("{base}.dem"));
            let mut n = 2;
            while dest.exists() {
                dest = folder.join(format!("{base}_{n}.dem"));
                n += 1;
            }
            if fs::copy(&src, &dest).is_err() {
                failed += 1;
                continue;
            }
            // a .vdm next to it so the game jumps straight through the clips
            let hls: Vec<Value> = list.iter().map(|c| json!({
                "watchTick": get_i(c, "tick"), "killTick": get_i(c, "killTick"),
                "endTick": get_i(c, "endTick"), "attacker": { "name": get_s(c, "player") },
                "tags": c.get("tags").cloned().unwrap_or_else(|| json!([])),
            })).collect();
            let vdm = dest.with_extension("vdm");
            let _ = fs::write(&vdm, build_vdm(&hls, true));
            manifest.push(json!({
                "file": dest.file_name().map(|x| x.to_string_lossy().to_string()),
                "folder": sani(&kind), "player": get_s(&top, "player"),
                "map": get_s(&top, "mapName"), "type": kind, "weapon": weapon,
                "sourceDemo": demo_path, "clips": hls,
            }));
            copied += 1;
            clips += list.len() as u32;
            // per-demo compression: shrink each .dem on its own (keeps them individually usable)
            if mode == "demo" {
                if let Some(z) = seven_zip() {
                    let _ = std::process::Command::new(&z)
                        .args(["a", "-tzip", "-y", &format!("{}.zip", dest.to_string_lossy()),
                               &dest.to_string_lossy(), &vdm.to_string_lossy()])
                        .output();
                    let _ = fs::remove_file(&dest);
                    let _ = fs::remove_file(&vdm);
                }
            }
        }

        let _ = fs::write(
            out_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&json!({
                "generator": "demo-reader", "demos": copied, "clips": clips, "entries": manifest
            })).unwrap_or_default(),
        );

        // folder / whole-pack compression
        if let Some(z) = seven_zip() {
            if mode == "folder" {
                for f in &folders {
                    let dir = out_dir.join(f);
                    let _ = std::process::Command::new(&z)
                        .args(["a", "-tzip", "-y", &format!("{}.zip", dir.to_string_lossy()), &dir.to_string_lossy()])
                        .output();
                    let _ = fs::remove_dir_all(&dir);
                }
            } else if mode == "pack" {
                let zipname = out_dir.with_extension("zip");
                let _ = std::process::Command::new(&z)
                    .args(["a", "-tzip", "-y", &zipname.to_string_lossy(), &out_dir.to_string_lossy()])
                    .output();
            }
        }
        let _ = std::process::Command::new("explorer").arg(&out_dir).spawn();
        json!({ "ok": true, "copied": copied, "failed": failed, "clips": clips,
                "dir": out_dir.to_string_lossy() })
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

fn seven_zip() -> Option<String> {
    ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
        .iter()
        .find(|p| Path::new(p).is_file())
        .map(|s| s.to_string())
}

/// Where 3D exports go: Settings ▸ gltfDir, else "<app folder>/3d ports". Created on demand.
fn gltf_dir(app: &tauri::AppHandle) -> PathBuf {
    let s = store_read(app, "settings.json");
    if let Some(d) = s.get("gltfDir").and_then(|v| v.as_str()) {
        if !d.trim().is_empty() {
            let p = PathBuf::from(d);
            let _ = fs::create_dir_all(&p);
            return p;
        }
    }
    let base = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let p = base.join("3d ports");
    let _ = fs::create_dir_all(&p);
    p
}

/// Export a clip to glTF (.glb) for Blender / UE4-5. Everything is optional so the user only
/// ports what they need: map mesh, players, kill markers, and how many seconds around the kill.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn export_gltf(
    app: tauri::AppHandle,
    dem_path: String,
    watch_tick: Option<i32>,
    end_tick: Option<i32>,
    tickrate: Option<i32>,
    pre_sec: Option<f32>,
    post_sec: Option<f32>,
    map_name: Option<String>,
    include_map: Option<bool>,
    include_players: Option<bool>,
    include_models: Option<bool>,
    include_kills: Option<bool>,
    only_uids: Option<Vec<i64>>,
    whole_demo: Option<bool>,
    label: Option<String>,
) -> Value {
    let dir = gltf_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let src = ensure_extracted(&dem_path, false).unwrap_or_else(|_| dem_path.clone());
        let tr = tickrate.unwrap_or(64).max(1);
        let (from, to) = if whole_demo.unwrap_or(false) {
            (None, None)
        } else {
            let pre = (pre_sec.unwrap_or(3.0) * tr as f32) as i32;
            let post = (post_sec.unwrap_or(3.0) * tr as f32) as i32;
            let w = watch_tick.unwrap_or(0);
            let e = end_tick.unwrap_or(w);
            (Some((w - pre).max(0)), Some(e + post))
        };
        let bsp = if include_map.unwrap_or(false) {
            // MUST be the MAP name, not the demo filename — looking up
            // "pug_2026-07-16_1716_de_inferno_new.bsp" never matched anything, which is why
            // exports came out with no map even with the option ticked.
            let map: String = map_name
                .filter(|m| !m.trim().is_empty() && m != "?")
                .or_else(|| {
                    // Older favourites saved no mapName (the card shows "?"), so recover it
                    // from the demo filename: pug_2026-07-06_0627_de_nuke_2023 -> de_nuke_2023
                    let stem = Path::new(&src).file_stem()?.to_string_lossy().to_string();
                    let low = stem.to_lowercase();
                    for pfx in ["de_", "cs_", "ar_", "dz_", "gd_", "aim_", "awp_", "fy_", "surf_", "bhop_", "kz_", "koth_", "cp_", "pl_"] {
                        if let Some(i) = low.find(pfx) {
                            return Some(stem[i..].to_string());
                        }
                    }
                    None
                })
                .unwrap_or_default();
            if map.is_empty() {
                eprintln!("export: no map name — skipping map geometry");
            }
            find_bsp(&app, &map).map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };
        let base = san(&label.unwrap_or_else(|| {
            Path::new(&src).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".into())
        }));
        let mut out = dir.join(format!("{base}.glb"));
        let mut n = 2;
        while out.exists() {
            out = dir.join(format!("{base}_{n}.glb"));
            n += 1;
        }
        let uids = only_uids.unwrap_or_default();
        // real CT/T character models come from a game content folder (Settings ▸ gameDir);
        // without one, players export as proxy boxes
        let sset = store_read(&app, "settings.json");
        let game = if include_models.unwrap_or(true) {
            sset.get("gameDir").and_then(|v| v.as_str()).map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
        } else {
            None
        };
        match csgo_rs::export_gltf_clip(
            &src, &out.to_string_lossy(), bsp.as_deref(), from, to, &uids,
            include_players.unwrap_or(true), include_kills.unwrap_or(true),
            game.as_deref(),
        ) {
            Some(()) => json!({ "ok": true, "file": out.to_string_lossy(), "dir": dir.to_string_lossy() }),
            None => json!({ "ok": false, "error": "export failed (demo unreadable?)" }),
        }
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

/// Reveal the 3D-export folder.
#[tauri::command]
fn open_gltf_dir(app: tauri::AppHandle) -> String {
    let d = gltf_dir(&app);
    let _ = std::process::Command::new("explorer").arg(&d).spawn();
    d.to_string_lossy().to_string()
}

// ---- dialogs --------------------------------------------------------------
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn pick_file(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_file().map(|p| p.to_string())
}

// ---- persisted JSON stores (favorites / ratings / aggregate) --------------
// Data lives NEXT TO THE DEMOS in `<demosDir>/.demo-reader/` so it's visible, backup-able and
// travels with the demos — not buried in AppData. settings.json itself must stay in AppData
// (it's what tells us where the demos are).
fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let s = fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}));
    if let Some(d) = s.get("demosDir").and_then(|v| v.as_str()) {
        if !d.is_empty() && Path::new(d).is_dir() {
            let dir = Path::new(d).join(".demo-reader");
            let _ = fs::create_dir_all(&dir);
            return dir;
        }
    }
    config_dir(app)
}

// Old locations we still read from (once) so nothing is lost: the Tauri config dir and the
// Electron app's userData folder — that's where 164 favorites / 74 ratings were living.
fn legacy_store_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut v = vec![config_dir(app)];
    if let Ok(appdata) = std::env::var("APPDATA") {
        v.push(Path::new(&appdata).join("CSGO Demo Highlights"));
        v.push(Path::new(&appdata).join("csgo-demo-highlights"));
    }
    v
}

fn store_read(app: &tauri::AppHandle, name: &str) -> Value {
    // settings.json is the ONE store that must stay in the config dir: it's what tells us
    // where the demos are, so it can't live next to them. Reading it from data_dir gave a
    // split brain — settings_set wrote AppData while every store_read caller (maps lookup,
    // game launch, cssff path, export dir) read an empty file next to the demos.
    if name == "settings.json" {
        return fs::read_to_string(settings_path(app))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}));
    }
    let primary = data_dir(app).join(name);
    if let Some(v) = fs::read_to_string(&primary).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        return v;
    }
    // not migrated yet → adopt the first legacy copy we find and write it forward
    for d in legacy_store_dirs(app) {
        let p = d.join(name);
        if let Some(v) = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            if v.is_object() && !v.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                let _ = store_write(app, name, &v); // migrate into the demos folder
                return v;
            }
        }
    }
    json!({})
}
fn store_write(app: &tauri::AppHandle, name: &str, v: &Value) -> Result<(), String> {
    if name == "settings.json" {
        let dir = config_dir(app);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return fs::write(settings_path(app), serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string());
    }
    let dir = data_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(name), serde_json::to_vec(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn store_merge(app: &tauri::AppHandle, name: &str, key: &str, entry: Value) -> Result<(), String> {
    let mut v = store_read(app, name);
    if !v.is_object() {
        v = json!({});
    }
    if entry.is_null() {
        v.as_object_mut().unwrap().remove(key);
    } else {
        v.as_object_mut().unwrap().insert(key.to_string(), entry);
    }
    store_write(app, name, &v)
}

#[tauri::command]
fn get_favorites(app: tauri::AppHandle) -> Value {
    store_read(&app, "favorites.json")
}
#[tauri::command]
fn set_favorite(app: tauri::AppHandle, key: String, entry: Value) -> Result<Value, String> {
    // MUST return the updated map: the renderer does `favorites = await setFavorite(...)`,
    // so returning nothing left it holding the stale map and the ★ never toggled.
    store_merge(&app, "favorites.json", &key, entry)?;
    Ok(store_read(&app, "favorites.json"))
}
#[tauri::command]
fn get_ratings(app: tauri::AppHandle) -> Value {
    store_read(&app, "ratings.json")
}
#[tauri::command]
fn set_rating(app: tauri::AppHandle, key: String, patch: Value) -> Result<Value, String> {
    // merge patch into the existing rating object for this key
    let mut ratings = store_read(&app, "ratings.json");
    if !ratings.is_object() {
        ratings = json!({});
    }
    let cur = ratings.get(&key).cloned().unwrap_or_else(|| json!({}));
    let mut merged = cur.as_object().cloned().unwrap_or_default();
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            merged.insert(k.clone(), v.clone());
        }
    }
    ratings
        .as_object_mut()
        .unwrap()
        .insert(key, Value::Object(merged));
    store_write(&app, "ratings.json", &ratings)?;
    Ok(ratings) // return the updated map, same contract as set_favorite
}
// The aggregate is 18MB+ (and grows with the library). Parsing/serialising that much JSON is
// far too heavy for the main thread — as sync commands these froze the window on every load
// and on EVERY 25-demo checkpoint during a scan. Both run on the blocking pool now.
#[tauri::command]
async fn load_aggregate(app: tauri::AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || store_read(&app, "aggregate.json"))
        .await
        .unwrap_or_else(|_| json!({}))
}
#[tauri::command]
async fn save_aggregate(app: tauri::AppHandle, data: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store_write(&app, "aggregate.json", &data))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn clear_aggregate(app: tauri::AppHandle) -> Result<(), String> {
    // remove from BOTH the demos-folder store and the legacy config dir, else a stale copy
    // in the old location gets adopted again by store_read's migration path
    let _ = fs::remove_file(data_dir(&app).join("aggregate.json"));
    let _ = fs::remove_file(config_dir(&app).join("aggregate.json"));
    Ok(())
}

// ---- radar image (maps/<map>.png → data URL) ------------------------------
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}
// Custom map versions (de_nuke_2023, de_vertigo_2019, de_cache_2014_og…) reuse the base
// map's radar art + calibration. Try the exact name, then progressively drop trailing
// `_parts`, most-specific first — mirrors the Electron mapAliases().
fn map_aliases(name: &str) -> Vec<String> {
    let mut out = vec![name.to_string()];
    let parts: Vec<&str> = name.split('_').collect();
    let mut n = parts.len().saturating_sub(1);
    while n >= 2 {
        let cand = parts[..n].join("_");
        if !out.contains(&cand) {
            out.push(cand);
        }
        n -= 1;
    }
    out
}

fn maps_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("../../maps"),
        PathBuf::from("../maps"),
        PathBuf::from("maps"),
        PathBuf::from("./maps"),
    ];
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("maps"));
    }
    roots
}

// Radar image (data URL) + per-map calibration from maps/maps.json, in the shape the renderer
// expects: { dataUrl, cal, usedMap }. Returning a bare string (the old bug) left `r.cal`
// undefined so the 2D radar never loaded for ANY map.
#[tauri::command]
async fn maps_radar(app: tauri::AppHandle, map: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || maps_radar_blocking(&app, map))
        .await
        .ok()
        .flatten()
}

// reads maps.json + a radar image and base64s it (~150KB) — off the UI thread
fn maps_radar_blocking(app: &tauri::AppHandle, map: String) -> Option<Value> {
    let safe: String = map.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    let roots = maps_roots(&app);
    // load maps.json (calibration table) from the first root that has it
    let cal_all: Value = roots
        .iter()
        .find_map(|r| fs::read_to_string(r.join("maps.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    for cand in map_aliases(&safe) {
        let cal = match cal_all.get(&cand) {
            Some(c) => c.clone(),
            None => continue, // no calibration for this name → keep trying aliases
        };
        for (ext, mime) in [("webp", "image/webp"), ("png", "image/png")] {
            for r in &roots {
                if let Ok(bytes) = fs::read(r.join(format!("{cand}.{ext}"))) {
                    let data_url = format!("data:{mime};base64,{}", b64(&bytes));
                    let used = if cand == safe { Value::Null } else { Value::String(cand.clone()) };
                    return Some(json!({ "dataUrl": data_url, "cal": cal, "usedMap": used }));
                }
            }
        }
    }
    None
}

// ---- game launch (netcon jump-in, else spawn) + VDM writer ----------------
fn send_netcon(port: u16, cmds: &[String]) -> bool {
    use std::io::Write;
    use std::time::Duration;
    match std::net::TcpStream::connect(("127.0.0.1", port)) {
        Ok(mut s) => {
            let _ = s.set_write_timeout(Some(Duration::from_millis(700)));
            let payload = cmds.join("\n") + "\n";
            s.write_all(payload.as_bytes()).is_ok()
        }
        Err(_) => false,
    }
}
fn is_running(exe_base: &str) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {exe_base}"), "/NH"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains(&exe_base.to_lowercase())
        })
        .unwrap_or(false)
}

fn launch_game(app: &tauri::AppHandle, exe_key: &str, port_key: &str, default_port: u16, dem_path: &str) -> Value {
    let s = store_read(app, "settings.json");
    let exe = s.get(exe_key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut port = s
        .get(port_key)
        .map(|v| v.as_str().map(|x| x.to_string()).unwrap_or_else(|| v.to_string()))
        .unwrap_or_default();
    if port.trim().is_empty() || port == "null" {
        port = default_port.to_string();
        let _ = store_merge(app, "settings.json", port_key, json!(port));
    }
    let portn: u16 = port.trim().parse().unwrap_or(default_port);
    // 1) jump the already-running game via netcon
    if send_netcon(portn, &["demo_resume".into(), format!("playdemo \"{dem_path}\"")]) {
        return json!({ "ok": true, "running": true });
    }
    // 2) need the exe to launch
    if exe.is_empty() || !Path::new(&exe).exists() {
        return json!({ "ok": false, "error": "Set the game exe path in Settings (or launch the game with -netconport)." });
    }
    let base = Path::new(&exe).file_name().and_then(|x| x.to_str()).unwrap_or("").to_string();
    // 3) already open without console access → can't control it
    if is_running(&base) {
        return json!({ "ok": false, "running": true,
            "error": format!("{base} is already open but wasn't started with console access. Close it, then click again to relaunch with jump-in. (The .vdm is next to the demo, so playdemo works too.)") });
    }
    // 4) launch WITH -netconport so later clips jump into this instance
    let dir = Path::new(&exe).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    match std::process::Command::new(&exe)
        .args(["-novid", "-insecure", "-netconport", &port, "+playdemo", dem_path])
        .current_dir(dir)
        .spawn()
    {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn san(s: &str) -> String {
    s.chars().map(|c| if c == '"' || c == '\n' || c == ';' { ' ' } else { c }).take(60).collect()
}
fn spec_token(name: &str) -> String {
    name.split_whitespace()
        .map(|t| t.replace(['"', '\n'], ""))
        .filter(|t| t.len() >= 2)
        .max_by_key(|t| t.len())
        .unwrap_or_default()
}

/// Build a .vdm (Valve Demo Metadata) that auto-jumps the game through the highlights.
fn build_vdm(highlights: &[Value], pause: bool) -> String {
    let get_i = |h: &Value, k: &str| h.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let mut hls: Vec<&Value> = highlights.iter().filter(|h| h.get("watchTick").is_some()).collect();
    hls.sort_by_key(|h| get_i(h, "watchTick"));
    let mut blocks = Vec::new();
    let mut idx = 1;
    let mut prev_end = 0i64;
    let mut first = true;
    let skip = |i: i32, start: i64, to: i64| {
        format!(" \"{i}\"\n {{\n  factory \"SkipAhead\"\n  name \"skip_{i}\"\n  starttick \"{start}\"\n  skiptotick \"{to}\"\n }}")
    };
    let play = |i: i32, start: i64, cmds: &str| {
        format!(" \"{i}\"\n {{\n  factory \"PlayCommands\"\n  name \"cmd_{i}\"\n  starttick \"{start}\"\n  commands \"{cmds}\"\n }}")
    };
    for h in &hls {
        let watch = get_i(h, "watchTick").max(0);
        let end = if h.get("endTick").is_some() { get_i(h, "endTick") } else { get_i(h, "killTick") + 384 };
        let ktick = get_i(h, "killTick");
        let name = h.get("attacker").and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or("");
        let n = h.get("kills").and_then(|k| k.as_array()).map(|a| a.len()).unwrap_or(1);
        let tags = h.get("tags").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let label = format!("{} {}{}", san(name), if n > 1 { format!("{n}K ") } else { String::new() }, san(&tags));
        let tok = spec_token(name);
        let spec = if tok.is_empty() { String::new() } else { format!("; spec_mode 4; spec_player {tok}") };
        let bind = if first { first = false; "; bind p demo_togglepause" } else { "" };
        let pausec = if pause { "; demo_pause" } else { "" };
        blocks.push(skip(idx, prev_end, watch)); idx += 1;
        blocks.push(play(idx, watch, &format!("host_timescale 1; echo [HL] {}{}{}{}", label.trim(), bind, spec, pausec))); idx += 1;
        if !tok.is_empty() && ktick > watch {
            blocks.push(play(idx, (watch + 1).max(ktick - 32), &format!("spec_mode 4; spec_player {tok}"))); idx += 1;
        }
        prev_end = end;
    }
    blocks.push(play(idx, prev_end, "host_timescale 1; echo [HL] end of highlights"));
    format!("demoactions\n{{\n{}\n}}\n", blocks.join("\n"))
}

#[tauri::command]
fn write_vdm(dem_path: String, highlights: Vec<Value>, pause: bool) -> Result<String, String> {
    let vdm = if let Some(stripped) = dem_path.strip_suffix(".dem") {
        format!("{stripped}.vdm")
    } else {
        format!("{dem_path}.vdm")
    };
    fs::write(&vdm, build_vdm(&highlights, pause)).map_err(|e| e.to_string())?;
    Ok(vdm)
}

// async: these do a TCP connect with a 700ms timeout plus a `tasklist` process spawn — up to
// ~1s of main-thread stall per click if left synchronous.
#[tauri::command]
async fn launch_csgo(app: tauri::AppHandle, dem_path: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || launch_game(&app, "csgoExe", "csgoNetconPort", 2121, &dem_path))
        .await
        .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}
#[tauri::command]
async fn launch_css(app: tauri::AppHandle, dem_path: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || launch_game(&app, "cssExe", "cssNetconPort", 2122, &dem_path))
        .await
        .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

// Seek WITHIN the already-loaded demo instead of reloading it: demo_gototick + spec the given
// player. Only works if the demo the user wants is the one currently playing (the frontend
// only calls this when the path matches the last-opened demo). `spec` is the player to watch
// (attacker or victim). Returns { ok, jumped } — ok:false means netcon wasn't reachable.
#[tauri::command]
async fn goto_tick(app: tauri::AppHandle, tick: i64, spec: String, css: bool, pause: bool) -> Value {
    tauri::async_runtime::spawn_blocking(move || goto_tick_blocking(&app, tick, &spec, css, pause))
        .await
        .unwrap_or_else(|_| json!({ "ok": false }))
}

// TCP connect with a 700ms timeout — off the UI thread
fn goto_tick_blocking(app: &tauri::AppHandle, tick: i64, spec: &str, css: bool, pause: bool) -> Value {
    let (port_key, default) = if css { ("cssNetconPort", 2122u16) } else { ("csgoNetconPort", 2121u16) };
    let s = store_read(app, "settings.json");
    let port: u16 = s
        .get(port_key)
        .and_then(|v| v.as_str().map(|x| x.to_string()).or_else(|| Some(v.to_string())))
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(default);
    let tok = spec_token(spec);
    let mut cmds = vec![format!("demo_gototick {}", tick.max(0))];
    if !tok.is_empty() {
        cmds.push("spec_mode 4".into());
        cmds.push(format!("spec_player {tok}"));
    }
    cmds.push(if pause { "demo_pause".into() } else { "demo_resume".into() });
    if send_netcon(port, &cmds) {
        json!({ "ok": true, "jumped": true })
    } else {
        json!({ "ok": false })
    }
}

// ---- 3D map geometry (bspgeo, in-process) ---------------------------------
fn map_search_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let s = store_read(app, "settings.json");
    let mut cand: Vec<PathBuf> = Vec::new();
    for key in ["mapsDir", "mapsDir2"] {
        if let Some(d) = s.get(key).and_then(|v| v.as_str()) {
            cand.push(PathBuf::from(d));
        }
    }
    for key in ["csgoExe", "cssExe"] {
        if let Some(exe) = s.get(key).and_then(|v| v.as_str()) {
            if let Some(base) = Path::new(exe).parent() {
                for sub in ["csgo", "cstrike", "cc", "hl2"] {
                    cand.push(base.join(sub).join("maps"));
                }
                cand.push(base.join("maps"));
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        cand.push(Path::new(&home).join("Desktop/ClassicCounter/csgo/maps"));
        cand.push(Path::new(&home).join("Downloads/custom maps"));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for d in cand {
        if d.is_dir() && !out.contains(&d) {
            out.push(d);
        }
    }
    out
}
fn find_bsp(app: &tauri::AppHandle, map: &str) -> Option<PathBuf> {
    for dir in map_search_dirs(app) {
        let p = dir.join(format!("{map}.bsp"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

// async + spawn_blocking: stripping geometry from a .bsp is heavy CPU; as a sync command it
// ran on the main thread and froze the whole window ("Not Responding") while a 3D preview loaded.
#[tauri::command]
async fn maps_geo(app: tauri::AppHandle, map: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let name: String = map.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '.' || *c == '-').collect();
        // Cached CCG1 blob (stripping a .bsp takes seconds) — kept with the rest of the app
        // data next to the demos so previews open instantly the second time.
        let cache = data_dir(&app).join("geo").join(format!("{name}.ccg1"));
        if let Ok(blob) = fs::read(&cache) {
            if blob.len() > 8 {
                let tri = u32::from_le_bytes(blob[4..8].try_into().unwrap());
                return json!({ "ok": true, "data": b64(&blob), "triCount": tri, "stripped": true, "cached": true });
            }
        }
        let bsp = match find_bsp(&app, &name) {
            Some(p) => p,
            None => return json!({ "ok": false, "error": format!("no .bsp found for {name} — set Settings ▸ Maps folder") }),
        };
        match csgo_rs::bspgeo::map_geo(&bsp.to_string_lossy()) {
            Some(blob) => {
                let tri = u32::from_le_bytes(blob[4..8].try_into().unwrap());
                if let Some(d) = cache.parent() { let _ = fs::create_dir_all(d); }
                let _ = fs::write(&cache, &blob);
                json!({ "ok": true, "data": b64(&blob), "triCount": tri, "stripped": true })
            }
            None => json!({ "ok": false, "error": "bsp parse failed (VBSP only; .bz2 unsupported)" }),
        }
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}
#[tauri::command]
fn maps_geo_available(app: tauri::AppHandle, map: String) -> bool {
    let name: String = map.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '.' || *c == '-').collect();
    find_bsp(&app, &name).is_some()
}

// ---- remaining stubs (bigger ports) ---------------------------------------
#[tauri::command]
async fn get_frames(dem_path: String, watch_tick: i32, end_tick: i32) -> Value {
    // async + spawn_blocking: this full-decodes the demo. As a sync command it ran on the main
    // thread and froze the window, so previews looked dead.
    tauri::async_runtime::spawn_blocking(move || {
        // The aggregate may store the ORIGINAL .bz2 path, but we extract (and optionally delete)
        // the archive — so fall back to the sibling .dem, else there's nothing to read.
        let mut p = dem_path.clone();
        if p.to_lowercase().ends_with(".bz2") {
            let stripped = p[..p.len() - 4].to_string();
            if Path::new(&stripped).is_file() {
                p = stripped;
            }
        } else if !Path::new(&p).is_file() && Path::new(&format!("{p}.bz2")).is_file() {
            // reverse case: only the archive survives — extract it on demand
            if let Ok(x) = ensure_extracted(&format!("{p}.bz2"), false) {
                p = x;
            }
        }
        match csgo_rs::demo_frames(&p, watch_tick, end_tick) {
            Some(json) => {
                let frames: Value = serde_json::from_str(&json).unwrap_or_else(|_| json!([]));
                json!({ "frames": frames, "utils": [] })
            }
            None => json!({ "frames": [], "utils": [] }),
        }
    })
    .await
    .unwrap_or_else(|_| json!({ "frames": [], "utils": [] }))
}
#[tauri::command]
fn get_default_weights() -> Value {
    serde_json::from_str(&csgo_rs::default_weights_json()).unwrap_or_else(|_| json!({}))
}

// reveal a file in Explorer (Electron: shell:showItem)
#[tauri::command]
fn show_item(path: String) {
    let _ = std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn();
}

// UI icons: assets/*.svg → { name: "<svg…>" }
#[tauri::command]
async fn get_icons() -> Value {
    tauri::async_runtime::spawn_blocking(get_icons_blocking)
        .await
        .unwrap_or_else(|_| json!({ "weapons": {}, "modifiers": {} }))
}

// reads ~50 SVG files off disk — small, but no reason to do it on the UI thread
fn get_icons_blocking() -> Value {
    // The renderer (weapons.js) expects { weapons: {stem: svg}, modifiers: {stem: svg} } and
    // does `window.ICONS = ic` wholesale — a flat map here left ICONS.weapons undefined, so
    // EVERY card's weaponIcon() threw "reading 'awp'". Read the two subfolders into that shape.
    fn read_cat(base: &Path, cat: &str) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        if let Ok(rd) = fs::read_dir(base.join(cat)) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("svg") {
                    if let (Some(stem), Ok(txt)) =
                        (p.file_stem().and_then(|s| s.to_str()), fs::read_to_string(&p))
                    {
                        m.insert(stem.to_string(), Value::String(txt));
                    }
                }
            }
        }
        m
    }
    for base in ["../../assets", "../assets", "assets", "./assets"] {
        let b = Path::new(base);
        let weapons = read_cat(b, "weapons");
        let modifiers = read_cat(b, "modifiers");
        if !weapons.is_empty() || !modifiers.is_empty() {
            return json!({ "weapons": weapons, "modifiers": modifiers });
        }
    }
    json!({ "weapons": {}, "modifiers": {} })
}

// The renderer's pool controller expects { idlePct, cores } — it ramps the worker count up
// while there's spare CPU. Returning a bare int (the old bug) left `idlePct` undefined, so
// every ramp test failed and the pool froze at its initial guess instead of using your cores.
// We don't meter per-core load (no winapi dep), so report "plenty free" and let the pool grow
// to the ceiling; the decode is already off the UI thread via spawn_blocking.
#[tauri::command]
fn cpu_sample(_ms: Option<u64>) -> Value {
    let cores = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4);
    json!({ "idlePct": 100, "cores": cores })
}

// which demos still need pixelsurf re-processing — always up to date here (done in one pass)
#[tauri::command]
fn pixelsurf_pending(_paths: Vec<String>) -> Vec<String> {
    Vec::new()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            list_demos,
            parse_demo,
            extract_batch,
            cssff_ini,
            classify_demo,
            cssff_config,
            reveal_cssff,
            export_demopack,
            export_gltf,
            open_gltf_dir,
            pick_folder,
            pick_file,
            get_favorites,
            set_favorite,
            get_ratings,
            set_rating,
            load_aggregate,
            save_aggregate,
            clear_aggregate,
            maps_radar,
            maps_geo,
            maps_geo_available,
            get_frames,
            write_vdm,
            launch_csgo,
            launch_css,
            goto_tick,
            get_default_weights,
            show_item,
            get_icons,
            cpu_sample,
            pixelsurf_pending,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
