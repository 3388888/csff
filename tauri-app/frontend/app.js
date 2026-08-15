const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const TEAM = { 2: "t", 3: "ct" };
// "1 tap" vs sprayed — shotsBeforeKill counts the shooter's shots around the kill,
// so shots-1 ≈ missed bullets. Lets you tell a 1-tap from a spray at a glance.
const shotStr = (k) => {
  const s = k.shotsBeforeKill;
  if (s == null) return "";
  if (s <= 1) return ` <span class="shots tap">1 tap</span>`;
  return ` <span class="shots">${s} shots<span class="muted"> · ${s - 1} miss</span></span>`;
};
// elevation of attacker vs victim at the kill (needs z in the shot — newly parsed demos only)
const heightStr = (k) => {
  const f = k.shot && k.shot.from, t = k.shot && k.shot.to;
  if (!f || !t || f.z == null || t.z == null) return "";
  const dz = Math.round(f.z - t.z);
  if (Math.abs(dz) < 60) return "";
  return dz > 0 ? ` <span class="hgt">↓${dz}u</span>` : ` <span class="hgt up">↑${-dz}u</span>`;
};
const TAG_LABEL = {
  ace: "ACE", quad: "4K", triple: "3K", clutch: "CLUTCH", jump_noscope: "jump noscope", noscope: "noscope",
  bhop: "bhop", airborne: "airborne", boosted: "boosted", flick_hs: "flick HS", flick: "flick",
  long_range: "long range", wallbang: "wallbang", collateral: "collateral", airshot: "airshot",
  smoke_streak: "smoke (streak)", blind_streak: "blind (streak)",
  rng: "RNG", off_height: "off height", outnumbered: "outnumbered", spin: "360 / spin",
  jumpshot: "jumpshot", pixelsurf: "pixelsurf", smoke_kill: "smoke kill", blind_kill: "flashed kill",
  bhop_run: "bhop run", fast: "fast", long_chain: "long chain", edgebug: "edgebug", jumpbug: "jumpbug", into_kill: "→ kill",
  troll: "troll 🃏", surf: "surf", flashboost: "flashboost",
};
const HOT = new Set(["ace", "quad", "clutch", "jump_noscope", "collateral", "flick_hs", "bhop", "rng", "off_height"]);
const tagLabel = (tg, h) => (tg === "clutch" && h && h.clutchX ? "CLUTCH 1v" + h.clutchX : (TAG_LABEL[tg] || tg));

// category groupings for the Settings toggles
const CAT_DEFS = [
  { key: "multikill", label: "Multikills", tags: ["ace", "quad", "triple"] },
  { key: "clutch", label: "Clutches", tags: ["clutch"] },
  { key: "noscope", label: "Noscopes", tags: ["noscope", "jump_noscope"] },
  { key: "jumpshot", label: "Jumpshots", tags: ["jumpshot"] },
  { key: "pixelsurf", label: "Pixelsurf", tags: ["pixelsurf"] },
  { key: "utilkill", label: "Smoke / flashed", tags: ["smoke_kill", "blind_kill"] },
  { key: "flick", label: "Flicks", tags: ["flick", "flick_hs"] },
  { key: "spin", label: "360 / spin", tags: ["spin"] },
  { key: "bhop", label: "Bhop / air", tags: ["bhop", "airborne", "boosted"] },
  { key: "movement", label: "Movement runs", tags: ["bhop_run", "fast", "long_chain"] },
  { key: "tricks", label: "Edgebug / jumpbug", tags: ["edgebug", "jumpbug"] },
  { key: "troll", label: "Troll (knife/nade/zeus)", tags: ["troll"] },
  { key: "surf", label: "Surf / wall-glide", tags: ["surf"] },
  { key: "flashboost", label: "Flashboost", tags: ["flashboost"] },
  { key: "rng", label: "RNG / risky", tags: ["rng", "off_height", "outnumbered"] },
  { key: "long_range", label: "Long range", tags: ["long_range"] },
  { key: "wallbang", label: "Wallbangs", tags: ["wallbang"] },
  { key: "airshot", label: "Airshots", tags: ["airshot"] },
  { key: "collateral", label: "Collaterals", tags: ["collateral"] },
  { key: "smoke_streak", label: "Smoke (streak)", tags: ["smoke_streak"] },
  { key: "blind_streak", label: "Blind (streak)", tags: ["blind_streak"] },
];
const tagToCat = {}; for (const c of CAT_DEFS) for (const t of c.tags) tagToCat[t] = c.key;

let current = null, settings = null, defaultWeights = {};
const radarCache = {};
// cssff-style frag rule defaults (mirror parser FRAG), shown in Settings
const FRAG_DEF = { noscopeAwp: 2000, noscopeScout: 8000, noscopeAuto: 2000, scopedDist: 3200, longRangeUnits: 1400, jumpDist: 800, jumpSnipers: 500, flickDist: 120, multi3: 2, multi3Rifles: 0.8, multi3Snipers: 4, multi4: 6.5, multi5: 13 };

// ---------- favorites / demopack ----------
let favorites = {};
const TYPE_SHORT = { ace: "ace", quad: "4k", triple: "3k", clutch: "clutch", jump_noscope: "jns", noscope: "ns", jumpshot: "jump", flick_hs: "flick", flick: "flick", spin: "360", wallbang: "wb", collateral: "collat", airshot: "airshot", smoke_kill: "smoke", blind_kill: "flashed", bhop_run: "bhop", edgebug: "edgebug", jumpbug: "jumpbug", surf: "surf", flashboost: "flashboost", pixelsurf: "pixelsurf", troll: "troll", rng: "rng", off_height: "offheight", outnumbered: "clutch", long_range: "longrange" };
function favTypeShort(h) { if (h.clutchX) return "clutch1v" + h.clutchX; for (const t of (h.tags || [])) if (TYPE_SHORT[t]) return TYPE_SHORT[t]; return (h.tags && h.tags[0]) || "kill"; }
function favDemoName(h) { return h.demoName || ((h.demPath || (current && current.demPath) || "").split(/[\\/]/).pop()) || "demo"; }
function favKey(h) { return `${favDemoName(h)}|${h.killTick}|${h.attacker.name}|${h.type || "kill"}`; }
function favEntry(h) {
  return { demoPath: h.demPath || (current && current.demPath) || "", demoName: favDemoName(h),
    player: h.attacker.name, tick: h.watchTick, killTick: h.killTick, endTick: h.endTick,
    type: favTypeShort(h), tags: h.tags || [], score: h.coolScore || 0,
    // enough to rebuild a card and a preview later, without the demo being loaded
    mapName: hMap(h) || null, round: h.round != null ? h.round : null, kills: (h.kills || []).length,
    // the actual kills too, so the saved clip's preview can draw the kill (tracer/markers),
    // not just player movement. compact: only what the preview reads.
    killData: (h.kills || []).map((k) => ({ killTick: k.killTick, victim: k.victim, weapon: k.weapon, headshot: k.headshot, shot: k.shot, telemetry: k.telemetry })),
    headshots: (h.kills || []).filter((k) => k.headshot).length,
    weapons: [...new Set((h.kills || []).map((k) => k.weapon).filter(Boolean))].slice(0, 3),
    uid: (h.attacker && h.attacker.uid) != null ? h.attacker.uid : null,
    team: (h.attacker && h.attacker.team) || null, isMovement: h.type === "movement",
    // CS:S clips have to launch in CS:S and carry their own label (no kill list)
    css: !!(h.css || (current && current.css && (h.demPath || current.demPath) === current.demPath)),
    label: h.label || null };
}
async function toggleFav(h, btn) {
  const key = favKey(h);
  const on = !!favorites[key];
  favorites = await window.api.setFavorite(key, on ? null : favEntry(h)) || favorites;
  if (btn) { const nowOn = !!favorites[key]; btn.textContent = nowOn ? "★" : "☆"; btn.classList.toggle("on", nowOn); }
  updateDemopackBtn();
}
function favBtn(h) {
  const on = !!favorites[favKey(h)];
  const b = el("button", "mini fav" + (on ? " on" : ""), on ? "★" : "☆");
  b.title = "add to demopack"; b.onclick = () => toggleFav(h, b);
  return b;
}
function updateDemopackBtn() {
  const n = Object.keys(favorites).length;
  const b = $("#btnDemopack"); if (b) { b.textContent = `★ Favorites (${n})`; b.style.display = n ? "block" : "none"; }
  if ($("#favView").style.display !== "none") renderFavorites();
}

// ---------- favorites tab ----------
// Everything starred, browsable: preview them, unstar the weak ones, tick the keepers
// and export just those as the demopack.
let favPicked = null;   // Set of keys chosen for the pack (null = everything)
function favPickedSet() {
  if (!favPicked) favPicked = new Set(Object.keys(favorites));
  for (const k of [...favPicked]) if (!favorites[k]) favPicked.delete(k);
  return favPicked;
}
function openFavorites() {
  $("#empty").style.display = "none";
  $("#matchView").style.display = "none";
  $("#favView").style.display = "block";
  renderFavorites();
}
function favSortedEntries() {
  const f = ($("#favSearch").value || "").toLowerCase().trim();
  let list = Object.entries(favorites).map(([key, v]) => ({ key, ...v }));
  if (f) list = list.filter((e) => [e.player, e.demoName, e.mapName, e.type, (e.tags || []).join(" ")].join(" ").toLowerCase().includes(f));
  const by = $("#favSort").value;
  const cmp = {
    score: (a, b) => (b.score || 0) - (a.score || 0),
    demo: (a, b) => String(a.demoName).localeCompare(String(b.demoName)) || (a.tick || 0) - (b.tick || 0),
    tick: (a, b) => (a.tick || 0) - (b.tick || 0),
    player: (a, b) => String(a.player).localeCompare(String(b.player)) || (b.score || 0) - (a.score || 0),
    type: (a, b) => String(a.type).localeCompare(String(b.type)) || (b.score || 0) - (a.score || 0),
  }[by] || ((a, b) => (b.score || 0) - (a.score || 0));
  return list.sort(cmp);
}
function renderFavorites() {
  const picked = favPickedSet();
  const list = favSortedEntries();
  const total = Object.keys(favorites).length;
  const hd = $("#favHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", "Favorites"));
  const demos = new Set(list.map((e) => e.demoName));
  hd.appendChild(el("div", "sub", `${total} starred clip${total === 1 ? "" : "s"} · ${demos.size} demo${demos.size === 1 ? "" : "s"} · ${picked.size} picked for the pack`));
  $("#favPack").textContent = `★ Export picked (${picked.size})`;
  const box = $("#favList"); box.innerHTML = "";
  if (!list.length) {
    box.appendChild(el("div", "muted", total ? "Nothing matches that filter." : "Nothing starred yet — hit ☆ on any highlight card."));
    return;
  }
  let lastDemo = null;
  for (const e of list) {
    if ($("#favSort").value === "demo" && e.demoName !== lastDemo) {
      lastDemo = e.demoName;
      box.appendChild(el("div", "fav-group", e.demoName.replace(/\.dem$/i, "")));
    }
    const card = el("div", "ck fav-card" + (picked.has(e.key) ? " picked" : ""));
    const top = el("div", "top");
    const pick = el("input"); pick.type = "checkbox"; pick.checked = picked.has(e.key); pick.title = "include in the demopack";
    pick.onchange = () => { if (pick.checked) picked.add(e.key); else picked.delete(e.key); card.classList.toggle("picked", pick.checked); renderFavorites(); };
    top.appendChild(pick);
    const who = el("div", "who");
    const icons = (e.weapons || []).map((w) => window.weaponIcon(w)).join("");
    who.innerHTML = `<span class="${teamCls(e.team)}">${esc(e.player)}</span> ${icons} <span class="vic">${esc(e.type || "kill")}</span>`;
    top.appendChild(who);
    top.appendChild(el("div", "stars", stars(e.score || 0)));
    card.appendChild(top);
    const tags = el("div", "tags");
    for (const tg of (e.tags || []).slice(0, 6)) tags.appendChild(el("span", "chip" + (HOT.has(tg) ? " hot" : ""), TAG_LABEL[tg] || tg));
    if (e.kills > 1) tags.appendChild(el("span", "chip", e.kills + "K"));
    if (e.headshots) tags.appendChild(el("span", "chip", e.headshots + " HS"));
    card.appendChild(tags);
    // per-kill detail, same as the main cards — killData is saved with every favourite
    if (Array.isArray(e.killData) && e.killData.length) {
      const kl = el("div", "kills-list");
      const tr = e.tickrate || (current && current.tickrate) || 64;
      e.killData.forEach((k, idx) => {
        const row = el("div", "kl");
        const gap = idx > 0 ? ` <span class="gap">+${((k.killTick - e.killData[idx - 1].killTick) / tr).toFixed(1)}s</span>` : "";
        const vic = (k.victim && k.victim.name) || "?";
        row.innerHTML = `${idx + 1}. ${window.modifierIcons(k)}${window.weaponIcon(k.weapon)}${k.headshot ? window.headshotIcon() : ""} <span class="a">${esc(vic)}</span>` +
          (k.distM != null ? ` <span class="muted">· ${k.distM}m</span>` : "") + heightStr(k) + shotStr(k) + gap;
        kl.appendChild(row);
      });
      card.appendChild(kl);
    }
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, (e.mapName || "?") + " · " + String(e.demoName).replace(/\.dem$/i, "")));
    if (e.round != null) meta.appendChild(el("span", null, "round " + (e.round + 1)));
    meta.appendChild(el("span", null, `watch tick ${e.tick}`));
    card.appendChild(meta);
    const act = el("div", "actions");
    const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => previewFavorite(e); act.appendChild(pv);
    const cs = el("button", "mini ghost", e.css ? "Open in CS:S" : "Open in CS:GO"); cs.onclick = () => openFavInGame(e); act.appendChild(cs);
    { const gb = el("button", "mini ghost", "⇱ 3D"); gb.title = "Export this clip to glTF (.glb) for Blender / UE4-5"; gb.onclick = () => openExportDialog(favToHighlight(e)); act.appendChild(gb); }
    const rv = el("button", "mini ghost", "Show demo"); rv.onclick = () => window.api.showItem(e.demoPath); act.appendChild(rv);
    const un = el("button", "mini fav on", "★"); un.title = "unstar";
    un.onclick = async () => { favorites = await window.api.setFavorite(e.key, null) || favorites; picked.delete(e.key); updateDemopackBtn(); renderFavorites(); };
    act.appendChild(un);
    card.appendChild(act);
    box.appendChild(card);
  }
}

// rebuild just enough of a highlight to play the clip back from the cached demo
async function previewFavorite(e) {
  showStatus("Loading preview…");
  const pv = await window.api.getFrames(e.demoPath, e.tick, e.endTick || e.killTick + 200, (settings && settings.maxPreviewSec) || 25, e.round);
  if (!pv || !pv.frames || !pv.frames.length) { showStatus("No cached data for this demo — open it once from the sidebar first."); return; }
  hideStatus();
  let uid = e.uid;
  if (uid == null) for (const f of pv.frames) { const p = f.players.find((q) => q.name === e.player); if (p) { uid = p.uid; break; } }
  const h = { mapName: e.mapName, demPath: e.demoPath, type: e.isMovement ? "movement" : "kill", round: e.round || 0,
    watchTick: e.tick, killTick: e.killTick, endTick: e.endTick, coolScore: e.score || 0, tags: e.tags || [],
    attacker: { name: e.player, uid, team: e.team }, kills: e.killData || [], preview: pv,
    css: !!e.css, label: e.label || null,
    movement: { maxSpeed: null, dmgSaved: 0, fallVel: 0 } };
  await openPreview(h);
}
async function openFavInGame(e) {
  await window.api.writeVdm(e.demoPath, [{ watchTick: e.tick, killTick: e.killTick, endTick: e.endTick, attacker: { name: e.player }, tags: e.tags || [] }], { pause: !(settings && settings.pauseOnOpen === false) });
  const r = e.css ? await window.api.launchCss(e.demoPath) : await window.api.launchCsgo(e.demoPath);
  const game = e.css ? "CS:S" : "CS:GO";
  showStatus(r.ok ? `Launching ${game}… jumps to tick ${e.tick}` : (r.error || `Set the ${game} exe in Settings`));
}
async function exportDemopack() {
  const picked = favPickedSet();
  const favs = Object.entries(favorites).filter(([k]) => picked.has(k)).map(([, v]) => v);
  if (!favs.length) { showStatus("Pick at least one clip (the checkbox on each card)."); return; }
  showStatus("Building demopack…");
  const r = await window.api.exportDemopack(favs);
  if (r && r.ok) showStatus(`Demopack: ${r.copied} demos (${r.clips} clips) → ${r.dir}${r.failed ? ` · ${r.failed} missing` : ""}`);
  else showStatus((r && r.error) || "Demopack export failed.");
}


// all tunables sent to the engine's classify step (instant, no re-decode)
function classifyOpts() {
  const s = settings;
  const o = {
    noPreview: true, // folder scan discards previews (fetched on demand) — don't build them
    prerollSec: s.prerollSec, longRangeM: s.longRangeM, flickMinDeg: s.flickMinDeg, bhopMinSpeed: s.bhopMinSpeed,
    multikillGapSec: s.multikillGapSec, clutchMaxSec: s.clutchMaxSec, clutchMaxGapSec: s.clutchMaxGapSec, rngMaxChance: s.rngMaxChance, runMinJumps: s.runMinJumps, runMinPeak: s.runMinPeak,
    focusNamedTick: s.focusNamedTick, focusWindowSec: s.focusWindowSec, focusKeepScore: s.focusKeepScore,
    runMinAir: s.runMinAir, runMaxSec: s.runMaxSec, nearbyRadius: s.nearbyRadius, edgebugMinDmg: s.edgebugMinDmg, maxPreviewSec: s.maxPreviewSec,
    weights: s.weights || {}, frag: s.frag || {}, deleteBz2: s.deleteBz2,
  };
  // CRITICAL: classify merges opts over its internal defaults, so an explicit `undefined`
  // (which every unset setting is when settings.json = {}) CLOBBERS the default → e.g.
  // prerollSec undefined made watchTick = killTick - NaN = NaN → null → broken preview.
  // Strip undefined keys so classify's own defaults win.
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
let parseProgress = { name: "", prefix: "" };
(async () => {
  settings = await window.api.getSettings();
  try { const ic = await window.api.getIcons(); if (ic && ic.weapons) window.ICONS = { weapons: ic.weapons || {}, modifiers: ic.modifiers || {} }; } catch {}
  try { defaultWeights = await window.api.getDefaultWeights() || {}; } catch {}
  try { favorites = await window.api.getFavorites() || {}; } catch {}
  await loadCssff();
  updateDemopackBtn();

  window.api.onParseProgress(({ frac }) => { if (!scanning && $("#status").style.display !== "none") showProgress("Parsing " + parseProgress.name + " — " + Math.round(frac * 100) + "%", frac); });
  if (settings.demosDir) loadFolder(settings.demosDir);
  wire();
})();

function wire() {
  $("#btnOpenDemos").onclick = async () => { const ps = await window.api.pickDemos(); if (ps.length) parseAndShow(ps[0]); };
  $("#btnOpenFolder").onclick = async () => { const d = await window.api.pickFolder(); if (d) { await window.api.setSettings({ demosDir: d }); settings.demosDir = d; loadFolder(d); } };
  $("#btnScanFolder").onclick = (e) => scanFolder(e.shiftKey); // Shift+click = full re-extract
  $("#scanPause").onclick = scanPauseToggle;
  $("#scanStop").onclick = scanStop;
  $("#btnGltfDir").onclick = () => window.api.openGltfDir();
  wireExportDialog();
  $("#btnDemopack").onclick = openFavorites;
  $("#favPack").onclick = exportDemopack;
  $("#favSearch").oninput = () => renderFavorites();
  $("#favSort").onchange = () => renderFavorites();
  $("#favAll").onclick = () => { favPicked = new Set(Object.keys(favorites)); renderFavorites(); };
  $("#favNone").onclick = () => { favPicked = new Set(); renderFavorites(); };
  $("#btnSettings").onclick = openSettings;
  $("#settingsClose").onclick = () => $("#settingsModal").style.display = "none";
  $("#settingsSave").onclick = saveSettings;
  $("#pickCsgo").onclick = async () => { const p = await window.api.pickFile([{ name: "csgo.exe", extensions: ["exe"] }]); if (p) $("#setCsgo").value = p; };
  $("#pickHlae").onclick = async () => { const p = await window.api.pickFile([{ name: "exe", extensions: ["exe"] }]); if (p) $("#setHlae").value = p; };
  $("#pickCss").onclick = async () => { const p = await window.api.pickFile([{ name: "exe", extensions: ["exe"] }]); if (p) $("#setCss").value = p; };
  $("#pickDemosDir").onclick = async () => { const p = await window.api.pickFolder(); if (p) $("#setDemos").value = p; };
  $("#previewClose").onclick = closePreview;
  $("#playBtn").onclick = togglePlay;
  $("#scrub").oninput = (e) => { stopAnim(); drawFrame(+e.target.value); };
  $("#soloView").onchange = (e) => {
    window.api.setSettings({ soloView: e.target.checked });
    if (settings) settings.soloView = e.target.checked;
    if (view) { view.solo = e.target.checked; drawFrame(+$("#scrub").value); }
  };
  $("#openCssffIni").onclick = () => window.api.revealCssff();
  $("#pickMaps").onclick = async () => { const p = await window.api.pickFolder(); if (p) $("#setMaps").value = p; };
  $("#pickMaps2").onclick = async () => { const p = await window.api.pickFolder(); if (p) $("#setMaps2").value = p; };
  // 2D / 3D switch + camera controls
  $("#btnView2d").onclick = () => setViewMode(false);
  $("#btnView3d").onclick = async () => {
    if (!geoReady) {                     // first time on this map: strip it now
      const wasPlaying = !!anim; stopAnim();
      const ok = await prepare3d(previewMap);
      if (!ok) return;
      window.Preview3D.attach(view);
      const cut = settings.cutRoofs !== false;
      $("#cutRoofs").checked = cut;
      window.Preview3D.setRoofs(!cut);
      window.Preview3D.setMode(settings.cam3d || "chase");
      setViewMode(true);
      if (wasPlaying) play();
      return;
    }
    setViewMode(true);
  };
  document.querySelectorAll("#cam3dBar .cam").forEach((b) => {
    b.onclick = () => {
      window.Preview3D.setMode(b.dataset.cam);
      window.api.setSettings({ cam3d: b.dataset.cam }); if (settings) settings.cam3d = b.dataset.cam;
      document.querySelectorAll("#cam3dBar .cam").forEach((x) => x.classList.toggle("on", x === b));
      if (view) drawFrame(+$("#scrub").value || 0);
    };
  });
  $("#cutRoofs").onchange = (e) => {
    window.Preview3D.setRoofs(!e.target.checked);
    window.api.setSettings({ cutRoofs: e.target.checked }); if (settings) settings.cutRoofs = e.target.checked;
  };
  $("#show3dNames").onchange = (e) => window.Preview3D.setNames(e.target.checked);
  window.addEventListener("resize", () => { if (is3d && view) window.Preview3D.resize(); });
  $("#btnVdm").onclick = exportVdm;
  $("#filterRole").onchange = () => renderHighlights();
  $("#coolSearch").oninput = () => renderHighlights();
  $("#coolClear").onclick = () => { $("#coolSearch").value = ""; for (const id of ["filterMap", "filterWeapon", "filterType", "filterDist", "filterFav"]) $("#" + id).value = ""; $("#filterSort").value = "score"; $("#filterFocus").value = "focus"; renderHighlights(); };
  for (const id of ["filterMap", "filterWeapon", "filterFav", "filterSort", "filterFocus"]) $("#" + id).onchange = () => renderHighlights();
  // selecting a kill type kicks off a one-time deep scan for it (finds more of that exact
  // category across the folder, uncapped) — then just renders on later changes
  $("#filterType").onchange = () => { renderHighlights(); const v = $("#filterType").value; if (v && current && current.aggregate) deepScanCategory(v); };
  $("#filterDist").oninput = () => renderHighlights();
  document.onkeydown = (e) => { if (e.key === "Escape") { closePreview(); $("#settingsModal").style.display = "none"; } };
  // click the dark backdrop (outside the box) to close
  $("#previewModal").onclick = (e) => { if (e.target === $("#previewModal")) closePreview(); };
  $("#settingsModal").onclick = (e) => { if (e.target === $("#settingsModal")) $("#settingsModal").style.display = "none"; };
}

async function loadFolder(dir) {
  const demos = await window.api.listDemos(dir);
  const list = $("#demoList"); list.innerHTML = "";
  if (!demos.length) { list.appendChild(el("div", "muted", "No demos in this folder.")); return; }
  for (const d of demos) {
    const item = el("div", "demo-item");
    item.appendChild(el("div", null, d.name));
    if (d.compressed) item.appendChild(el("div", "tag", "compressed .bz2"));
    item.onclick = () => { document.querySelectorAll(".demo-item").forEach((x) => x.classList.remove("active")); item.classList.add("active"); parseAndShow(d.path); };
    list.appendChild(item);
  }
}

async function parseAndShow(demoPath) {
  parseProgress = { name: demoPath.split(/[\\/]/).pop(), prefix: "" };
  showProgress("Parsing " + parseProgress.name + " …", 0);
  try {
    current = await window.api.parseDemo(demoPath, classifyOpts());
    current.demPath = current.demPath || demoPath;
    if (current.css) renderCss(); else renderMatch();
    hideStatus();
    if (settings.demosDir) loadFolder(settings.demosDir); // refresh (bz2 may be gone)
  } catch (e) { showStatus("Error: " + e.message); }
}

// signature of the DETECTION settings + classifier version — if any change, saved highlights are stale
const CLASSIFY_VERSION = "14-rustclassify"; // 14: classify runs in Rust — classify.js no longer in the data path
function classifySig() {
  const s = settings;
  return CLASSIFY_VERSION + JSON.stringify({ p: s.prerollSec, l: s.longRangeM, f: s.flickMinDeg, b: s.bhopMinSpeed, g: s.multikillGapSec, r: s.rngMaxChance,
    rj: s.runMinJumps, rp: s.runMinPeak, ra: s.runMinAir, rm: s.runMaxSec, n: s.nearbyRadius, e: s.edgebugMinDmg, mp: s.maxPreviewSec, w: s.weights, fr: s.frag,
    cm: s.clutchMaxSec, cg: s.clutchMaxGapSec, ft: s.focusNamedTick, fw: s.focusWindowSec, fk: s.focusKeepScore,
    ini: cssffInfo ? cssffInfo.mtime : 0 });   // editing cssff_settings.ini re-extracts
}

let scanning = false;
// Pause / Stop for a running folder scan. Progress is checkpointed every 25 demos, so stopping
// (or pausing and closing) keeps everything parsed so far — the next scan resumes from there.
const scanCtl = { paused: false, stopped: false };
function scanPauseToggle() {
  scanCtl.paused = !scanCtl.paused;
  const b = $("#scanPause"); if (b) b.textContent = scanCtl.paused ? "▶ Resume" : "⏸ Pause";
}
function scanStop() { scanCtl.stopped = true; scanCtl.paused = false; }
// force=true re-scans every demo (e.g. after changing detection settings)
async function scanFolder(force = false) {
  // re-entry guard: two concurrent scans corrupt each other's state (and look like a crash)
  if (scanning) { showStatus("A scan is already running — use Pause/Stop first."); return; }
  if (!settings.demosDir) { const d = await window.api.pickFolder(); if (!d) return; await window.api.setSettings({ demosDir: d }); settings.demosDir = d; }
  const demos = await window.api.listDemos(settings.demosDir);
  if (!demos.length) { showStatus("No demos in this folder."); return; }
  const opts = classifyOpts();
  const sig = classifySig();

  // load the saved store; reuse it unless detection settings changed or caller forced a rescan
  let saved = force ? null : await window.api.loadAggregate();
  if (saved && (saved.sig !== sig || saved.dir !== settings.demosDir)) saved = null;
  const scanned = new Set((saved && saved.scanned) || []);   // demo paths already extracted
  let all = dedupHighlights((saved && saved.highlights) || []); // self-heal any doubled store

  const toScan = demos.filter((d) => !scanned.has(d.path));
  if (!toScan.length && all.length) {
    // everything already saved — instant, no cache reads
    current = { aggregate: true, demoCount: scanned.size, skipped: 0, highlights: all, scannedPaths: [...scanned], demos, deepDone: new Set((saved && saved.deepDone) || []) };
    renderAggregate(); hideStatus();
    showStatus(`Loaded ${all.length} highlights from ${scanned.size} demos (saved). ${demos.length} demos in folder.`);
    backfillPixelsurf();
    return;
  }

  // Adaptive concurrency. The saved setting is a CEILING, not a fixed count: we size the
  // live pool to the cores actually free right now (Windows Defender's real-time scan can
  // eat a third of them), and re-measure during the scan so it ramps up when the machine
  // frees up and backs off when it's slammed — no more 16 workers fighting over 6 cores.
  // hardwareConcurrency can under-report in a webview; trust the backend's core count when higher
  let hw = navigator.hardwareConcurrency || 6;
  try { const c = await window.api.cpuSample(0); if (c && c.cores > hw) hw = c.cores; } catch {}
  const cap = Math.max(1, Math.min(32, toScan.length, (settings.scanConcurrency && settings.scanConcurrency > 0) ? settings.scanConcurrency : hw));
  // Control loop, not a one-shot "free cores" read: measuring free cores while the pool is
  // running is a trap (the pool's own load looks like "busy" and it parks at half). Instead
  // we RAMP UP while the machine still has spare CPU and only back off when it's saturated,
  // so it climbs to fill idle capacity and holds a small headroom.
  let liveCap = cap; // adjustable while the scan runs (Settings ▸ concurrency)
  let target = Math.max(2, Math.min(cap, Math.round(hw / 2)));
  try { const s0 = await window.api.cpuSample(250); target = Math.max(2, Math.min(cap, Math.round(hw * (s0.idlePct || 50) / 100))); } catch {}
  // live thread box in the progress panel — the safe way to change concurrency mid-scan
  { const tb = $("#scanThreads"); if (tb) { tb.value = cap; tb.oninput = () => {
      const v = Math.max(1, Math.min(32, parseInt(tb.value) || 1));
      liveCap = v; if (target > liveCap) target = liveCap;
      // MERGE — setSettings writes the object wholesale, so sending {scanConcurrency} alone
      // would wipe demosDir/exe paths/everything else.
      settings.scanConcurrency = v; window.api.setSettings({ ...settings, scanConcurrency: v }).catch(() => {});
      prog();
    }; } }
  async function retune() {
    try {
      const s = await window.api.cpuSample(250);
      if (s.idlePct > 15) target = Math.min(liveCap, target + 2);  // spare CPU -> use more cores
      else if (s.idlePct < 7) target = Math.max(1, target - 2);    // machine saturated -> ease off
    } catch {}
    if (target > liveCap) target = liveCap;                        // honour a lowered ceiling now
  }
  let idx = 0, done = 0, ok = 0, skipped = 0, active = 0;
  const t0 = performance.now();
  scanning = true;
  scanCtl.paused = false; scanCtl.stopped = false;
  // Batch-extract the .bz2 archives up front: one 7-Zip process per 64 files instead of one
  // per file (a spawn costs ~145ms — across thousands of demos that's minutes of pure waste).
  {
    const arch = toScan.filter((d) => /\.bz2$/i.test(d.path)).map((d) => d.path);
    if (arch.length) {
      showProgress(`Extracting ${arch.length} compressed demo(s)… (batched)`, 0, true);
      for (let i = 0; i < arch.length && !scanCtl.stopped; i += 256) {
        await window.api.extractBatch(arch.slice(i, i + 256));
        showProgress(`Extracting compressed demos… ${Math.min(i + 256, arch.length)}/${arch.length}`, (i + 256) / arch.length, true);
      }
    }
  }
  { const b = $("#scanPause"); if (b) b.textContent = "⏸ Pause"; }
  const fresh = [];
  const resampler = setInterval(() => { if (scanning) retune(); }, 2000);
  // Progressive display: show the grid right away with whatever's saved, then stream new cards
  // in as demos finish — so the user watches highlights appear instead of staring at a frozen
  // "Not Responding" wait. Throttled so re-rendering doesn't fight the parse for CPU.
  current = { aggregate: true, demoCount: scanned.size, skipped: 0, highlights: all, scannedPaths: [...scanned], demos, deepDone: new Set() };
  renderAggregate(); hideStatus();
  let lastPaint = 0, lastName = "", lastStage = "";
  const repaint = (force) => {
    const now = performance.now();
    if (!force && now - lastPaint < 350) return;
    lastPaint = now;
    // sort as we go — otherwise new cards land in parse order and a 5-star kill found at
    // demo 900 sits below junk from demo 3 until the whole scan finishes
    current.highlights = dedupHighlights(all.concat(fresh))
      .sort((a, b) => b.coolScore - a.coolScore || (a.watchTick || 0) - (b.watchTick || 0));
    current.demoCount = scanned.size;
    populateFilters(); // keep the map/weapon/type dropdowns in step with what's been found
    $("#matchHeader .sub") && ($("#matchHeader").querySelector(".sub").textContent =
      `${scanned.size} demos · ${current.highlights.length} highlights — parsing ${done}/${toScan.length}…`);
    renderHighlights();
  };
  const prog = () => {
    const eta = done ? ((performance.now() - t0) / done) * (toScan.length - done) / 1000 : 0;
    const step = lastName ? ` · ${lastName}${lastStage ? " — " + lastStage : ""}` : "";
    const state = scanCtl.paused ? "PAUSED — " : "";
    showProgress(`${state}Parsing ${done}/${toScan.length} demo(s) (×${target} of ≤${liveCap} cores)${!scanCtl.paused && done && done < toScan.length ? " · ~" + Math.ceil(eta) + "s left" : ""}${step}`, done / toScan.length, true);
  };
  prog();
  async function worker() {
    while (idx < toScan.length) {
      if (scanCtl.stopped) return;                                                       // Stop: finish out
      if (scanCtl.paused) { await new Promise((r) => setTimeout(r, 250)); continue; }     // Pause: idle
      if (active >= target) { await new Promise((r) => setTimeout(r, 150)); continue; } // over CPU budget: hold
      const d = toScan[idx++];
      active++;
      lastName = d.name.replace(/\.dem(\.bz2)?$/i, "");
      // stage readout — tells the user what's actually happening instead of a silent bar
      lastStage = d.compressed || /\.bz2$/i.test(d.path) ? "extracting .bz2" : "reading kills + player info";
      prog();
      try {
        const r = await window.api.parseDemo(d.path, opts);
        lastStage = "scoring highlights";
        if (r.css) { skipped++; scanned.add(d.path); }
        else {
          const demPath = r.demPath || d.path;
          // "Only my highlights": keep just the clips where this player made the kill(s), so a
          // big shared-server library doesn't bury your own frags under everyone else's.
          // No player filter here any more: baking it into the cache meant changing who you
          // were looking for forced a full re-scan. It's a live filter in the search bar now.
          for (const h of r.highlights.slice(0, 30)) fresh.push({ ...h, preview: null, demPath, mapName: r.mapName, demoName: d.name, demoDate: d.mtime || 0 });
          scanned.add(d.path); ok++;
        }
      } catch (e) { console.warn("skip", d.name, e.message); skipped++; }
      finally { active--; }
      done++;
      prog();
      repaint(false); // stream freshly-parsed cards into the grid
      // CHECKPOINT: persist every 25 demos so closing/crashing mid-scan doesn't throw away
      // hours of parsing — the next run resumes from here instead of starting over.
      if (done % 25 === 0) {
        try {
          await window.api.saveAggregate({ sig, dir: settings.demosDir, scanned: [...scanned], highlights: dedupHighlights(all.concat(fresh)) });
        } catch {}
      }
    }
  }
  // Spawn the MAX pool we might ever want (not just the current ceiling) — workers self-limit
  // to the live target, so raising the thread box mid-scan actually adds parallelism instead
  // of being capped by however many we happened to start with.
  const maxWorkers = Math.max(1, Math.min(32, toScan.length));
  await Promise.all(Array.from({ length: maxWorkers }, worker));
  clearInterval(resampler);
  scanning = false;
  all = dedupHighlights(all.concat(fresh));
  all.sort((a, b) => b.coolScore - a.coolScore || a.watchTick - b.watchTick);
  // persist so the next open / filter never re-reads demo caches
  await window.api.saveAggregate({ sig, dir: settings.demosDir, scanned: [...scanned], highlights: all });
  current = { aggregate: true, demoCount: scanned.size, skipped, highlights: all, scannedPaths: [...scanned], demos, deepDone: new Set() };
  renderAggregate(); hideStatus();
  if (scanCtl.stopped) showStatus(`Stopped at ${done}/${toScan.length}. Kept ${all.length} highlights from ${scanned.size} demos — click ★ Best of folder to resume.`);
  else if (fresh.length) showStatus(`Added ${fresh.length} highlights from ${ok} new demo(s). Total ${all.length} — saved.`);
  backfillPixelsurf();
}

// Persist the current aggregate (highlights may have grown from a deep-scan / backfill).
async function saveCurrentAggregate() {
  if (!current || !current.aggregate) return;
  try {
    await window.api.saveAggregate({
      sig: classifySig(), dir: settings.demosDir,
      scanned: current.scannedPaths || [], highlights: current.highlights,
      deepDone: [...(current.deepDone || [])],
    });
  } catch {}
}

// Background passes re-process cached demos and merge results into the live aggregate,
// rendering progressively. A user-triggered deep-scan takes priority — the long pixelsurf
// backfill yields to it (its workers pause) so selecting a category is never blocked.
let deepActive = false;
async function bgReprocess({ demos, optsFor, merge, label, concurrency, yieldToDeep }) {
  if (!demos || !demos.length) return;
  let idx = 0, done = 0; const total = demos.length;
  const note = () => showStatus(`${label} — ${done}/${total} (background, keep using the app)`);
  note();
  async function worker() {
    while (idx < total) {
      if (yieldToDeep && deepActive) { await new Promise((r) => setTimeout(r, 400)); continue; } // let the user's deep-scan win
      const d = demos[idx++];
      try { const r = await window.api.parseDemo(d.path, optsFor(d)); if (r && !r.css) merge(d, r); } catch {}
      done++;
      if (done % 40 === 0) { note(); if (current && current.aggregate) renderHighlights(); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency || 3) }, worker));
  if (current && current.aggregate) { current.highlights = dedupHighlights(current.highlights); current.highlights.sort((a, b) => b.coolScore - a.coolScore || a.watchTick - b.watchTick); renderHighlights(); }
  await saveCurrentAggregate();
  hideStatus();
}

// Deep scan for one category: re-classify every cached demo in deep mode (finds multis a
// bit more spread out than the fast window, uncapped) and merge the results in. Cheap —
// reads the raw cache, no decode. Runs once per category (cached in the store).
function demoMeta(d) { return { demPath: d.path, mapName: "", demoName: d.name, demoDate: d.mtime || 0 }; }
async function deepScanCategory(cat) {
  if (!current || !current.aggregate || !cat) return;
  // Never deep-scan while the main folder scan is running: both mutate current.highlights
  // (the scan rebuilds it from all+fresh on every repaint, the deep pass pushes into it),
  // which duplicates cards and starves the app. Wait until the scan finishes.
  if (scanning) return;
  if (!current.deepDone) current.deepDone = new Set();
  if (current.deepDone.has(cat) || deepActive) return;
  deepActive = true;
  try {
    const demos = current.demos || (await window.api.listDemos(settings.demosDir));
    await bgReprocess({
      demos, concurrency: 4, label: `Deep-scanning “${TAG_LABEL[cat] || cat}” across ${demos.length} demos`,
      optsFor: () => ({ ...classifyOpts(), deepCategory: cat }),
      merge: (d, r) => {
        // replace this demo's clips carrying `cat` with the deep (uncapped) set
        current.highlights = current.highlights.filter((h) => !(h.demPath === d.path && (h.tags || []).includes(cat)));
        for (const h of r.highlights) current.highlights.push({ ...h, preview: null, ...demoMeta(d), mapName: r.mapName });
        current.highlights = dedupHighlights(current.highlights); // belt-and-braces: never dupe
      },
    });
    current.deepDone.add(cat);
    await saveCurrentAggregate();
  } finally { deepActive = false; }
}

// Background pixelsurf backfill: demos still on the old (v8) cache get re-decoded to v9 so
// pixelsurf fills in over time — no blocking 17h wall. Low concurrency + yields to deep-scan.
let backfillActive = false;
async function backfillPixelsurf() {
  if (!current || !current.aggregate || backfillActive || scanning) return; // see deepScanCategory
  const demos = current.demos || (await window.api.listDemos(settings.demosDir));
  let pending = [];
  try { pending = await window.api.pixelsurfPending(demos.map((d) => d.path)); } catch { return; }
  if (!pending.length) return;
  const set = new Set(pending);
  const todo = demos.filter((d) => set.has(d.path));
  backfillActive = true;
  try {
    await bgReprocess({
      demos: todo, concurrency: 2, yieldToDeep: true, label: `Backfilling pixelsurf (re-decoding ${todo.length} older demos)`,
      optsFor: () => ({ ...classifyOpts(), forceDecode: true }),
      merge: (d, r) => {
        current.highlights = current.highlights.filter((h) => h.demPath !== d.path);
        for (const h of r.highlights.slice(0, 30)) current.highlights.push({ ...h, preview: null, ...demoMeta(d), mapName: r.mapName });
      },
    });
  } finally { backfillActive = false; }
}

function renderAggregate() {
  $("#empty").style.display = "none";
  $("#favView").style.display = "none";
  $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "none";
  const hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", "Best of folder"));
  hd.appendChild(el("div", "sub", `${current.demoCount} demos · ${current.highlights.length} highlights` + (current.skipped ? ` · ${current.skipped} skipped (unsupported)` : "")));
  populateFilters();
  renderHighlights();
}

function renderMatch() {
  $("#empty").style.display = "none";
  $("#favView").style.display = "none";
  $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "";
  const h = current.header || {}, hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", current.mapName));
  const sc = el("div", "score"); const sco = current.score || { ct: 0, t: 0, rounds: 0 };
  sc.innerHTML = `<span class="ct">CT ${sco.ct || 0}</span> : <span class="t">${sco.t || 0} T</span>`;
  hd.appendChild(sc);
  hd.appendChild(el("div", "sub", `${sco.rounds || 0} rounds · ${current.tickrate || 64} tick`));
  if (current.tickHints && current.tickHints.length) {
    const s = el("div", "sub focus-note", `◎ named tick ${current.tickHints.join(", ")} — showing that moment (switch the last filter to “everything” for the rest)`);
    hd.appendChild(s);
  }
  if (h.serverName) hd.appendChild(el("div", "sub", h.serverName));
  renderScoreboard(); renderRoundBreakdown(); populateFilters(); renderHighlights();
}

function renderRoundBreakdown() {
  const box = $("#roundView"); box.innerHTML = "";
  const rounds = (current.score && current.score.rounds) || 0;
  const winners = current.roundWinners || [];
  const players = current.players || [];
  if (!rounds || !players.length) {
    box.appendChild(el("div", "muted", "No round data for this demo."));
    return;
  }
  // CS:GO's match timeline: one column per round, one lane per player, a pip per kill.
  // Reading a table of numbers is work; a lane you can scan shows who carried which rounds.
  const grid = el("div", "tl");

  // header lane: round number + who won it
  const hdr = el("div", "tl-row tl-hdr");
  hdr.appendChild(el("div", "tl-name", ""));
  for (let r = 0; r < rounds; r++) {
    const c = el("div", "tl-cell");
    const w = winners[r];
    c.className = "tl-cell " + (w === 3 ? "win-ct" : w === 2 ? "win-t" : "");
    c.textContent = r + 1;
    c.title = `round ${r + 1}${w === 3 ? " — CT" : w === 2 ? " — T" : ""}`;
    hdr.appendChild(c);
  }
  grid.appendChild(hdr);

  // kills per player per round, straight from the highlight list
  const byPlayer = {};
  for (const h of (current.highlights || [])) {
    const n = h.attacker && h.attacker.name;
    if (!n) continue;
    (byPlayer[n] = byPlayer[n] || {});
    for (const k of (h.kills || [])) {
      const r = h.round != null ? h.round : 0;
      byPlayer[n][r] = (byPlayer[n][r] || 0) + 1;
    }
  }
  for (const [tn] of [[3], [2]]) {
    for (const p of players.filter((x) => x.team === tn).sort((a, b) => (b.kills || 0) - (a.kills || 0))) {
      const row = el("div", "tl-row");
      const nm = el("div", "tl-name " + TEAM[tn], p.name);
      nm.title = p.name;
      nm.onclick = () => { $("#coolSearch").value = p.name; renderHighlights(); };
      row.appendChild(nm);
      const mine = byPlayer[p.name] || {};
      for (let r = 0; r < rounds; r++) {
        const n = mine[r] || 0;
        const c = el("div", "tl-cell k" + Math.min(n, 5));
        if (n) { c.textContent = n; c.title = `${p.name} — ${n} kill${n > 1 ? "s" : ""} in round ${r + 1}`; }
        row.appendChild(c);
      }
      grid.appendChild(row);
    }
  }
  box.appendChild(grid);
}

function renderScoreboard() {
  const box = $("#scoreboard"); box.innerHTML = "";
  const sco = current.score || {};
  const all = current.players || [];
  // CS:GO orders each side by kills and shows the team's round wins in the header bar
  for (const [tn, label] of [[3, "CT"], [2, "T"]]) {
    const ps = all.filter((p) => p.team === tn).sort((a, b) => (b.kills || 0) - (a.kills || 0));
    if (!ps.length) continue;
    const wrap = el("div", "sb-team " + TEAM[tn]);
    const head = el("div", "sb-head");
    head.innerHTML = `<span class="sb-side">${label}</span>` +
      `<span class="sb-wins">${tn === 3 ? (sco.ct || 0) : (sco.t || 0)}</span>` +
      `<span class="sb-cols"><i>K</i><i>D</i><i>A</i><i>+/-</i><i>HS%</i></span>`;
    wrap.appendChild(head);
    for (const p of ps) {
      const k = p.kills || 0, d = p.deaths || 0;
      const diff = k - d;
      const hs = k ? Math.round(((p.headshots || 0) / k) * 100) : 0;
      const row = el("div", "sb-row");
      row.innerHTML =
        `<span class="sb-name">${esc(p.name)}</span>` +
        `<span class="sb-stat">${k}</span>` +
        `<span class="sb-stat">${d}</span>` +
        `<span class="sb-stat">${p.assists || 0}</span>` +
        `<span class="sb-stat ${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}">${diff > 0 ? "+" : ""}${diff}</span>` +
        `<span class="sb-stat">${hs}%</span>`;
      row.querySelector(".sb-name").onclick = () => { $("#coolSearch").value = p.name; renderHighlights(); };
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }
  if (!all.length) box.appendChild(el("div", "muted", "No scoreboard data for this demo."));
}

function stars(score) { const n = score >= 100 ? 5 : score >= 70 ? 4 : score >= 50 ? 3 : score >= 35 ? 2 : 1; return "★".repeat(n) + "☆".repeat(5 - n); }
function teamCls(tn) { return tn === 3 ? "ct" : "t"; }

function hMap(h) { return h.mapName || (current && current.mapName) || ""; }
function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = Date.now();
  const days = Math.floor((now - ms) / 86400000);
  const rel = days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? days + "d ago" : days < 365 ? Math.floor(days / 30) + "mo ago" : Math.floor(days / 365) + "y ago";
  return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} (${rel})`;
}
// The real match date lives in the filename (pug_2026-03-16_0153_…, faceit_20260316_…) —
// file mtime is unreliable (copying/extracting resets it to "recent"). Parse the name;
// fall back to the stored mtime only if there's no date in it. A bare year inside a map
// name ("de_nuke_2023") is NOT a date — we require yyyy-mm-dd (or a compact yyyymmdd).
function parseNameDate(name) {
  if (!name) return 0;
  let m = name.match(/(20\d{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:[-_ tT]?([0-2]\d)[-_:.]?([0-5]\d))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  m = name.match(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0);
  return 0;
}
function hlDate(h) { return parseNameDate(h.demoName) || h.demoDate || 0; }
function hlClipSec(h) { return Math.max(0, (h.endTick || 0) - (h.watchTick || 0)) / (h.tickrate || current && current.tickrate || 64); }
// De-dup the aggregate: a highlight is uniquely a (demo, round, moment, attacker, tags)
// tuple. Guards against any merge path re-adding the same clip (a deep-scan bug once
// doubled the whole store), and self-heals an already-doubled store on load.
function hlKey(h) { return (h.demPath || "") + "|" + h.round + "|" + h.watchTick + "|" + ((h.attacker && h.attacker.name) || "") + "|" + (h.tags || []).join(","); }
function dedupHighlights(arr) {
  const seen = new Set(); const out = [];
  for (const h of arr || []) { const k = hlKey(h); if (seen.has(k)) continue; seen.add(k); out.push(h); }
  return out;
}
function hWeapons(h) { return (h.kills || []).map((k) => k.weapon).filter(Boolean); }
function hMaxDistM(h) { return Math.max(0, ...(h.kills || []).map((k) => k.distM || 0)); }

function highlightVisible(h, f) {
  if (f.search) {
    // match on NAME or SteamID64 — names change and userids are per-server, so the steam id
    // is the only identity that works across a whole library
    const sidOf = (p) => String((p && p.steamId) || "").toLowerCase();
    const inAttacker = h.attacker.name.toLowerCase().includes(f.search) || sidOf(h.attacker).includes(f.search);
    const inVictim = h.kills.some((k) => k.victim && (k.victim.name.toLowerCase().includes(f.search) || sidOf(k.victim).includes(f.search)));
    const inTag = h.tags.some((t) => t.replace(/_/g, " ").includes(f.search) || (TAG_LABEL[t] || "").toLowerCase().includes(f.search));
    // "killer only" / "victim only" — when you search your own name you almost always mean
    // one or the other, not both. Tags stay searchable regardless.
    if (f.role === "killer") { if (!inAttacker && !inTag) return false; }
    else if (f.role === "victim") { if (!inVictim && !inTag) return false; }
    else if (!inAttacker && !inVictim && !inTag) return false;
  }
  if (!h.tags.some((t) => !f.disabled.has(tagToCat[t] || t))) return false;
  if (f.map && hMap(h) !== f.map) return false;
  // weapon filter is "pure" by default: a selected weapon means EVERY kill in the clip used
  // it, so "deagle" + an ace shows a real deagle ace, not a 2-deagle/2-ak/1-knife salad.
  // With "broaden" on, it matches any clip that CONTAINS a kill with that weapon.
  if (f.weapon) {
    const ks = h.kills || [];
    if (!ks.length) return false;
    const ok = f.broaden ? ks.some((k) => k.weapon === f.weapon) : ks.every((k) => k.weapon === f.weapon);
    if (!ok) return false;
  }
  // type filter: the clip's own tags, plus (when broadening) any per-kill tag — so a
  // collateral or noscope buried inside a bigger multikill still matches.
  if (f.type) {
    const inHl = h.tags.includes(f.type);
    const inKill = f.broaden && (h.kills || []).some((k) => (k.tags || []).includes(f.type));
    if (!inHl && !inKill) return false;
  }
  if (f.minDist && hMaxDistM(h) < f.minDist) return false;
  if (f.fav && !favorites[favKey(h)]) return false;
  if (f.focus && h.offFocus) return false;   // demo named after a tick -> only that moment
  return true;
}

// fill the map/weapon/type dropdowns from whatever's loaded (instant, no reparse)
function populateFilters() {
  if (!current || !current.highlights) return;
  const maps = new Set(), weps = new Set(), types = new Set();
  for (const h of current.highlights) {
    const m = hMap(h); if (m) maps.add(m);
    for (const w of hWeapons(h)) weps.add(w);
    for (const t of h.tags) if (TAG_LABEL[t] && !["into_kill", "fast", "long_chain"].includes(t)) types.add(t);
  }
  const fill = (sel, items, label, cur) => {
    const v = cur != null ? cur : sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + [...items].sort().map((x) => `<option value="${esc(x)}">${esc(TAG_LABEL[x] || x)}</option>`).join("");
    sel.value = v;
  };
  fill($("#filterMap"), maps, "any map");
  fill($("#filterWeapon"), weps, "any weapon");
  fill($("#filterType"), types, "any type");
}

function currentFilters() {
  return {
    search: ($("#coolSearch").value || "").toLowerCase().trim(),
    disabled: new Set(settings.disabledCats || []),
    map: $("#filterMap") ? $("#filterMap").value : "",
    weapon: $("#filterWeapon") ? $("#filterWeapon").value : "",
    type: $("#filterType") ? $("#filterType").value : "",
    minDist: $("#filterDist") ? (parseInt($("#filterDist").value) || 0) : 0,
    fav: $("#filterFav") ? $("#filterFav").value === "fav" : false,
    sort: $("#filterSort") ? $("#filterSort").value : "score",
    broaden: !!(settings && settings.broadenSearch),
    focus: $("#filterFocus") ? $("#filterFocus").value === "focus" : true,
    role: $("#filterRole") ? $("#filterRole").value : "",
  };
}

function renderHighlights() {
  const f = currentFilters();
  const list = current.highlights.filter((h) => highlightVisible(h, f));
  // default order is best-score-first (already pre-sorted); date (from filename) and
  // clip-length sorts help find old kills / long spread-out aces.
  if (f.sort === "new") list.sort((a, b) => hlDate(b) - hlDate(a) || b.coolScore - a.coolScore);
  else if (f.sort === "old") list.sort((a, b) => hlDate(a) - hlDate(b) || b.coolScore - a.coolScore);
  else if (f.sort === "long") list.sort((a, b) => hlClipSec(b) - hlClipSec(a) || b.coolScore - a.coolScore);
  else if (f.sort === "short") list.sort((a, b) => hlClipSec(a) - hlClipSec(b) || b.coolScore - a.coolScore);
  $("#coolCount").textContent = "(" + list.length + (list.length !== current.highlights.length ? " of " + current.highlights.length : "") + ")";
  const box = $("#coolList"); box.innerHTML = "";
  if (!list.length) { box.appendChild(el("div", "muted", "No highlights match the filter.")); return; }
  // only render the top N cards — a 35k-kill aggregate would choke the DOM otherwise.
  // they're sorted by score, so the best are always shown; filter/search narrows further.
  const RENDER_CAP = 300;
  const shown = list.slice(0, RENDER_CAP);
  if (list.length > RENDER_CAP) box.appendChild(el("div", "muted", `Showing the top ${RENDER_CAP} of ${list.length}. Use the filter or a category toggle to narrow down.`));
  let _renderErr = null, _renderOk = 0;
  shown.forEach((h, i) => { try { renderCard(box, h, i); _renderOk++; } catch (e) { if (!_renderErr) _renderErr = e; } });
  if (_renderErr) {
    console.error("card render failed:", _renderErr);
    box.appendChild(el("div", "muted", `⚠ card render error (${_renderOk}/${shown.length} ok): ${_renderErr.message}`));
  }
}

function renderCard(box, h, i) {
  {
    const card = el("div", "ck");
    const top = el("div", "top");
    top.appendChild(el("div", "rank", "#" + (i + 1)));
    const who = el("div", "who");
    const n = h.kills.length;
    if (h.type === "movement") {
      const ml = h.tags.includes("edgebug") ? "edgebug" : h.tags.includes("jumpbug") ? "jumpbug" : h.tags.includes("surf") ? "surf" : h.tags.includes("flashboost") ? "flashboost" : "bhop run";
      // if it flows into a kill, show the actual kill (weapon → victim), not a vague "→ kill"
      const k0 = h.kills && h.kills[0];
      const killPart = k0 ? ` ${window.modifierIcons(k0)}${window.weaponIcon(k0.weapon)}${k0.headshot ? window.headshotIcon() : ""} <span class="vic">→ ${esc(k0.victim.name)}</span>` : "";
      who.innerHTML = `${esc(h.attacker.name)} <span class="vic">— ${ml}</span>${killPart}`;
    } else if (n > 1) {
      who.innerHTML = `${esc(h.attacker.name)} <span class="vic">— ${n} kills</span>`;
    } else {
      who.innerHTML = `${esc(h.attacker.name)} ${window.modifierIcons(h.kills[0])}${window.weaponIcon(h.kills[0].weapon)}${h.kills[0].headshot ? window.headshotIcon() : ""} <span class="vic">→ ${esc(h.kills[0].victim.name)}</span>`;
    }
    top.appendChild(who);
    const st = el("div", "stars", stars(h.coolScore)); st.title = "cool score " + h.coolScore; top.appendChild(st);
    card.appendChild(top);

    const tags = el("div", "tags");
    // why this card is here when the demo is named after a tick
    if (h.focusTick) { const c = el("span", "chip hot", "◎ tick " + h.focusTick); c.title = "this is the moment named in the filename"; tags.appendChild(c); }
    else if (h.keptAnyway) { const c = el("span", "chip", "elsewhere in demo"); c.title = "not the named tick, kept because it scored high enough"; tags.appendChild(c); }
    for (const tg of h.tags) {
      if (tg === "into_kill") continue; // redundant "→ kill" label; the kill is shown in the header
      const chip = el("span", "chip clickable" + (HOT.has(tg) ? " hot" : ""), tagLabel(tg, h));
      chip.title = "filter by " + (TAG_LABEL[tg] || tg);
      chip.onclick = () => { $("#coolSearch").value = tg.replace(/_/g, " "); renderHighlights(); };
      tags.appendChild(chip);
    }
    card.appendChild(tags);

    if (n > 1) {
      const kl = el("div", "kills-list");
      h.kills.forEach((k, idx) => {
        const row = el("div", "kl");
        const tr = h.tickrate || current.tickrate || 64;
        const gap = idx > 0 ? ` <span class="gap">+${((k.killTick - h.kills[idx - 1].killTick) / tr).toFixed(1)}s</span>` : "";
        row.innerHTML = `${idx + 1}. ${window.modifierIcons(k)}${window.weaponIcon(k.weapon)}${k.headshot ? window.headshotIcon() : ""} <span class="a">${esc(k.victim.name)}</span>` +
          (k.distM != null ? ` <span class="muted">· ${k.distM}m</span>` : "") + heightStr(k) + shotStr(k) + gap;
        kl.appendChild(row);
      });
      card.appendChild(kl);
    }

    const meta = el("div", "meta");
    const bits = [];
    if (h.demoName) bits.push(`${h.mapName} · ${h.demoName.replace(/\.dem$/i, "")}`);
    { const dt = hlDate(h); if (dt) bits.push(fmtDate(dt)); }
    if (h.type === "movement") {
      const m = h.movement;
      // the kill (if any) is shown in the header now; here we just show the movement metrics
      if (h.tags.includes("flashboost")) bits.push(`flashboost → ${m.maxSpeed} u/s`, `+${m.boost} u/s spike`);
      else if (h.tags.includes("surf")) bits.push(`surf · max ${m.maxSpeed} u/s`, `${m.durSec}s`, `${m.distUnits}u`);
      else if (m.maxSpeed != null) bits.push(`max ${m.maxSpeed} u/s`, `avg ${m.avgSpeed}`, `${m.jumps} jumps`, `${m.airPct}% air`, `${m.durSec}s`);
      else if (m.fallVel != null) bits.push(`saved ~${m.dmgSaved} dmg (${m.fallVel} u/s fall)`);
      if (h.round != null) bits.push(`round ${h.round + 1}`);
      bits.push(`watch tick ${h.watchTick}`);
      for (const b of bits) meta.appendChild(el("span", null, b));
      card.appendChild(meta);
      const act = el("div", "actions");
      const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => openPreview(h); act.appendChild(pv);
      const cs = el("button", "mini ghost", "Open in CS:GO"); cs.onclick = () => openInCsgo(h); act.appendChild(cs);
      if (victimName(h)) { const en = el("button", "mini ghost", "▶ enemy"); en.title = "Open in CS:GO spectating the player who got killed"; en.onclick = () => openInCsgo(h, "victim"); act.appendChild(en); }
      { const gb = el("button", "mini ghost", "⇱ 3D"); gb.title = "Export this clip to glTF (.glb) for Blender / UE4-5"; gb.onclick = () => openExportDialog(h); act.appendChild(gb); }
      act.appendChild(favBtn(h));
      card.appendChild(act);

      box.appendChild(card);
      return;
    }
    bits.push(`round ${h.round + 1}`);
    if (n > 1) {
      const tr = h.tickrate || current.tickrate || 64;
      bits.push(`span ${((h.kills[n - 1].killTick - h.kills[0].killTick) / tr).toFixed(2)}s`);
    }
    const t0 = h.kills[0].telemetry;
    if (n === 1) {
      const k0 = h.kills[0];
      if (t0.airborneAtKill) bits.push(`airborne @${t0.speedAtKill}u/s`);
      if (t0.flickDeg >= 25) bits.push(`flick ${t0.flickDeg}°`);
      if (k0.penetrated > 0) bits.push(`${k0.penetrated} wall`);
      if (k0.shotsBeforeKill != null) bits.push(k0.shotsBeforeKill <= 1 ? "1 tap" : `${k0.shotsBeforeKill} shots · ${k0.shotsBeforeKill - 1} miss`);
      if (k0.shot && k0.shot.from && k0.shot.to && k0.shot.from.z != null && k0.shot.to.z != null) { const dz = Math.round(k0.shot.from.z - k0.shot.to.z); if (Math.abs(dz) >= 60) bits.push(dz > 0 ? `${dz}u above target` : `${-dz}u below target`); }
      if (k0.hitChance != null && (h.tags.includes("rng") || h.tags.includes("off_height"))) bits.push(`~${Math.round(k0.hitChance * 100)}% odds`);
      if (h.tags.includes("outnumbered") && k0.nearbyEnemies) bits.push(`${k0.nearbyEnemies} enemies close`);
    }
    bits.push(`watch tick ${h.watchTick} · kill ${h.killTick}`);
    for (const b of bits) meta.appendChild(el("span", null, b));
    card.appendChild(meta);

    const act = el("div", "actions");
    const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => openPreview(h); act.appendChild(pv);
    const cs = el("button", "mini ghost", "Open in CS:GO"); cs.onclick = () => openInCsgo(h); act.appendChild(cs);
    if (victimName(h)) { const en = el("button", "mini ghost", "▶ enemy"); en.title = "Open in CS:GO spectating the player who got killed"; en.onclick = () => openInCsgo(h, "victim"); act.appendChild(en); }
    { const gb = el("button", "mini ghost", "⇱ 3D"); gb.title = "Export this clip to glTF (.glb) for Blender / UE4-5 — configure in Settings ▸ 3D export"; gb.onclick = () => openExportDialog(h); act.appendChild(gb); }
    act.appendChild(favBtn(h));
    card.appendChild(act);

    box.appendChild(card);
  }
}

// ---------- preview (2D radar / 3D map) ----------
let anim = null, view = null, is3d = false, geoReady = false, previewMap = null;

// Pull the map's stripped geometry (main strips it from the .bsp on first use and
// caches it). Returns true when the 3D view is usable for this map.
async function prepare3d(mapName) {
  geoReady = false;
  if (!mapName || !window.Preview3D) return false;
  if (!window.Preview3D.init($("#preview3dCanvas"), $("#preview3dOverlay"))) return false;
  const known = window.Preview3D.has(mapName);
  if (!known) showStatus(`Generating 3D preview — reading ${mapName}.bsp geometry (cached after the first time)…`);
  try { geoReady = await window.Preview3D.load(mapName); } catch { geoReady = false; }
  if (!known) { if (geoReady) hideStatus(); else showStatus("No 3D geometry: " + (window.Preview3D.error() || "map not found")); }
  return geoReady;
}

function setViewMode(three) {
  is3d = !!three && geoReady;
  $("#btnView2d").classList.toggle("on", !is3d);
  $("#btnView3d").classList.toggle("on", is3d);
  $("#previewCanvas").style.display = is3d ? "none" : "block";
  $("#stage3d").style.display = is3d ? "block" : "none";
  $("#cam3dBar").style.display = is3d ? "flex" : "none";
  if (is3d) {
    const b = window.Preview3D.bounds();
    const um = window.Preview3D.usedMap ? window.Preview3D.usedMap(previewMap) : null;
    $("#geoInfo").textContent = `${window.Preview3D.triCount().toLocaleString()} tris` +
      (b ? ` · ${Math.round(b.maxZ - b.minZ)}u tall` : "") + (um ? ` · geometry from ${um}.bsp` : "");
    document.querySelectorAll("#cam3dBar .cam").forEach((b2) => b2.classList.toggle("on", b2.dataset.cam === window.Preview3D.mode()));
  } else if (window.Preview3D) window.Preview3D.clearOverlay();
  if (view) drawFrame(+$("#scrub").value || 0);
}

async function openPreview(h) {
  // aggregate highlights carry no frames — reload them from the cached parse
  if ((!h.preview || !h.preview.frames || !h.preview.frames.length) && h.demPath) {
    showStatus("Loading preview…");
    try {
      // fast path: slice frames straight from the cached raw (no re-classify)
      const pv = await window.api.getFrames(h.demPath, h.watchTick, h.endTick, (settings && settings.maxPreviewSec) || 25, h.round);
      if (pv && pv.frames && pv.frames.length) h.preview = pv;
      hideStatus();
    } catch (e) { showStatus("Couldn't load preview: " + e.message); return; }
  }
  if (!h.preview || !h.preview.frames || !h.preview.frames.length) { showStatus("No preview data."); return; }
  const mapName = h.mapName || current.mapName;
  previewMap = mapName;
  const radar = await getRadar(mapName);
  view = buildView(h, radar);
  // strip the geometry up front only if 3D is the default view; otherwise just check
  // that we *could* (cheap) and leave the work until the 3D button is clicked
  let can3d = false;
  geoReady = false;
  if (settings.prefer3d !== false) { can3d = await prepare3d(mapName); if (can3d) window.Preview3D.attach(view); }
  else { try { can3d = !!(await window.api.hasMapGeo(mapName)); } catch { can3d = false; } }
  $("#btnView3d").disabled = !can3d;
  $("#btnView3d").title = can3d ? "Real map geometry, stripped out of the .bsp" : "No .bsp found for " + mapName;
  // CS:S / favorite clips carry no kill list, so they hand us a ready-made label
  const label = h.label ? esc(h.label)
    : h.type === "movement" ? (h.tags[0] === "edgebug" ? "edgebug" : h.tags[0] === "jumpbug" ? "jumpbug" : "bhop run")
    : h.kills.length > 1 ? h.kills.length + "K"
    : h.kills[0] ? esc(h.kills[0].weapon) : "clip";
  // a ready-made label already spells the clip out, so don't repeat it in brackets
  const tagTxt = h.label ? "" : (h.tags || []).map((t) => tagLabel(t, h)).filter(Boolean).join(", ");
  $("#previewTitle").innerHTML = `${esc(h.attacker.name)} ${label}` +
    (tagTxt ? ` <span class="muted">[${tagTxt}]</span>` : "");
  $("#previewCsgo").textContent = h.css || (current && current.css) ? "Open in CS:S" : "Open in CS:GO";
  $("#scrub").max = view.frames.length - 1; $("#scrub").value = 0;
  $("#soloView").checked = !!settings.soloView;
  $("#previewCsgo").onclick = () => openInCsgo(h);
  // launch buttons stay hidden in the preview (they live on the cards) — keep handlers wired
  // in case they're re-enabled, but never show them here
  { const en = $("#previewEnemy"); en.onclick = () => openInCsgo(h, "victim"); }
  // in-preview follow toggle: point the camera (3D POV/chase and the 2D highlight) at the
  // victim instead of the killer, without leaving the app
  {
    const fb = $("#btnFollow");
    const killerUid = h.attacker.uid;
    // resolve the victim's uid from the kill, falling back to a name lookup in the frames.
    // It must be a DIFFERENT player than the killer, else "follow: victim" showed the same POV.
    let victimUid = null;
    const k = (h.kills && (h.kills[h.kills.length - 1] || h.kills[0])) || null;
    if (k && k.victim) {
      if (k.victim.uid != null && k.victim.uid !== killerUid) victimUid = k.victim.uid;
      if (victimUid == null && k.victim.name) {
        for (const f of view.frames) {
          const p = f.players.find((q) => q.name === k.victim.name && q.uid !== killerUid);
          if (p) { victimUid = p.uid; break; }
        }
      }
    }
    if (victimUid === killerUid) victimUid = null; // never offer a no-op toggle
    fb.style.display = victimUid != null ? "" : "none";
    fb.textContent = "follow: killer";
    fb.onclick = () => {
      const onKiller = view.attackerUid === killerUid;
      view.attackerUid = onKiller ? victimUid : killerUid;
      fb.textContent = onKiller ? "follow: victim" : "follow: killer";
      if (window.Preview3D && window.Preview3D.attach) window.Preview3D.attach(view); // re-bind the camera target
      drawFrame(+$("#scrub").value || 0);
    };
  }
  $("#previewReveal").onclick = () => window.api.showItem(h.demPath || current.demPath);
  // a borrowed radar (old CS:S map version) is close but not exact — say so
  const approx = radar && radar.usedMap ? `  (radar: ${radar.usedMap} — closest match for ${mapName})` : "";
  $("#previewMeta").textContent = !h.kills.length && h.type !== "movement"
    ? `watch tick ${h.watchTick} → ${h.endTick}` + (radar ? approx : "  (no radar — auto-fit)")
    : h.type === "movement"
    ? (h.movement.maxSpeed != null
        ? `max ${h.movement.maxSpeed} u/s · avg ${h.movement.avgSpeed} · ${h.movement.jumps} jumps · ${h.movement.airPct}% air · ${h.movement.durSec}s · watch tick ${h.watchTick}`
        : `saved ~${h.movement.dmgSaved} dmg (${h.movement.fallVel} u/s fall)${h.movement.killAfter ? " → kill" : ""} · watch tick ${h.watchTick}`)
    : `Round ${h.round + 1} · watch tick ${h.watchTick}, first kill ${h.killTick}` + (radar ? approx : "  (no radar — auto-fit)");
  $("#previewModal").style.display = "flex";
  if (can3d) {
    const cut = settings.cutRoofs !== false;
    $("#cutRoofs").checked = cut;
    $("#show3dNames").checked = true;
    window.Preview3D.setRoofs(!cut);
    window.Preview3D.setNames(true);
    window.Preview3D.setMode(settings.cam3d || "chase");
  }
  setViewMode(can3d && settings.prefer3d !== false);
  drawFrame(0); play();
}
function closePreview() { stopAnim(); $("#previewModal").style.display = "none"; }

async function getRadar(map) {
  if (map in radarCache) return radarCache[map];
  const r = await window.api.getRadar(map);
  if (!r) { radarCache[map] = null; return null; }
  const img = new Image(); img.src = r.dataUrl;
  await new Promise((res) => { img.onload = res; img.onerror = res; });
  if (!img.complete || !img.naturalWidth) { radarCache[map] = null; return null; } // load failed -> auto-fit
  radarCache[map] = { img, cal: r.cal, usedMap: r.usedMap || null };
  return radarCache[map];
}

// POV demos only network entities near the recorder, so a far-away player's position (and
// even their alive flag) can be stale — they show up frozen, often inside geometry. Anyone
// who never moved a unit during the whole clip AND stayed far from the action is that.
function staleUids(frames, attackerUid) {
  const stale = new Set();
  if (!frames || frames.length < 16) return stale;
  const first = {}, moved = {}, near = {};
  for (const f of frames) {
    const a = f.players.find((p) => p.uid === attackerUid);
    for (const p of f.players) {
      if (p.uid === attackerUid) continue;
      if (!first[p.uid]) { first[p.uid] = p; moved[p.uid] = 0; near[p.uid] = Infinity; }
      const f0 = first[p.uid];
      moved[p.uid] = Math.max(moved[p.uid], Math.hypot(p.x - f0.x, p.y - f0.y, (p.z || 0) - (f0.z || 0)));
      if (a) near[p.uid] = Math.min(near[p.uid], Math.hypot(p.x - a.x, p.y - a.y));
    }
  }
  for (const uid in moved) if (moved[uid] < 2 && near[uid] > 1200) stale.add(+uid);
  return stale;
}

function buildView(h, radar) {
  // drop the SourceTV/GOTV camera — it's networked like a player (has a userinfo entry) so it
  // leaks into the frames as a ghost dot in a random spot. Filter it out of every frame.
  const isGhost = (p) => !p.name || p.name === "GOTV" || /^GOTV\b/i.test(p.name);
  const frames = h.preview.frames.map((f) => ({ ...f, players: f.players.filter((p) => !isGhost(p)) }));
  // which uids get killed in this clip — so the 2D view can flag the victim, not just the killer
  const victimUids = new Set();
  const byName = {};
  for (const f of frames) for (const p of f.players) if (p.name) byName[p.name] = p.uid;
  for (const k of h.kills) { if (!k.victim) continue; const u = k.victim.uid != null ? k.victim.uid : byName[k.victim.name]; if (u != null) victimUids.add(u); }
  let b = null;
  if (!radar) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const c = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
    for (const f of frames) for (const p of f.players) c(p.x, p.y);
    for (const k of h.kills) { if (k.shot?.from) c(k.shot.from.x, k.shot.from.y); if (k.shot?.to) c(k.shot.to.x, k.shot.to.y); }
    const pad = 120; b = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }
  // get_frames doesn't send a tickrate; without it play() divides by undefined -> NaN and the
  // clip freezes on one frame. Fall back to the highlight's / match tickrate (default 64).
  const tickrate = h.preview.tickrate || h.tickrate || (current && current.tickrate) || 64;
  return { frames, stale: staleUids(frames, h.attacker.uid), kills: h.kills, tickrate, radar, bounds: b, attackerUid: h.attacker.uid, victimUids, attacker: h.attacker,
    isMovement: h.type === "movement", utils: h.preview.utils || [], solo: !!(settings && settings.soloView) };
}

function w2c(x, y, W, H) {
  if (view.radar) {
    const c = view.radar.cal;
    const px = (x - c.pos_x) / c.scale, py = (c.pos_y - y) / c.scale;
    return [px / c.size * W, py / c.size * H];
  }
  const b = view.bounds, sx = W / (b.maxX - b.minX), sy = H / (b.maxY - b.minY), s = Math.min(sx, sy);
  const ox = (W - (b.maxX - b.minX) * s) / 2, oy = (H - (b.maxY - b.minY) * s) / 2;
  return [ox + (x - b.minX) * s, H - (oy + (y - b.minY) * s)];
}

// one entry point for both views — the scrubber, tick label and killfeed are shared
// idx may be fractional: the 3D view interpolates between ticks for smooth playback,
// while the 2D radar and the scrubber stick to whole frames.
function drawFrame(idx) {
  if (!view) return;
  const i = Math.max(0, Math.min(view.frames.length - 1, Math.floor(idx)));
  const f = view.frames[i];
  if (!f) return;
  $("#scrub").value = i;
  $("#tickLabel").textContent = `tick ${f.tick}`;
  if (is3d && window.Preview3D.ready()) window.Preview3D.draw(idx); else draw2D(i);
  updateKillFeed(f.tick);
}

function draw2D(idx) {
  const cv = $("#previewCanvas"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0d10"; ctx.fillRect(0, 0, W, H);
  if (view.radar && view.radar.img.naturalWidth) {
    try { ctx.globalAlpha = 0.85; ctx.drawImage(view.radar.img, 0, 0, W, H); } catch {} finally { ctx.globalAlpha = 1; }
  }

  const f = view.frames[idx];
  const tick = f.tick;

  // utility (smokes / mollies / flashes / HE / decoy) active at this tick
  const upx = (units) => units * (view.radar ? (W / view.radar.cal.size / view.radar.cal.scale) : (W / (view.bounds.maxX - view.bounds.minX)));
  for (const u of view.utils) {
    if (tick < u.tick || tick > u.endTick) continue;
    const [ux, uy] = w2c(u.x, u.y, W, H);
    if (u.kind === "smoke") { ctx.fillStyle = "rgba(210,210,210,.5)"; ctx.beginPath(); ctx.arc(ux, uy, Math.max(6, upx(144)), 0, 7); ctx.fill(); }
    else if (u.kind === "fire") { ctx.fillStyle = "rgba(230,110,40,.5)"; ctx.beginPath(); ctx.arc(ux, uy, Math.max(5, upx(120)), 0, 7); ctx.fill(); }
    else if (u.kind === "decoy") { ctx.strokeStyle = "rgba(180,180,180,.7)"; ctx.beginPath(); ctx.arc(ux, uy, 4, 0, 7); ctx.stroke(); }
    else if (u.kind === "flash") { ctx.fillStyle = "rgba(255,255,255," + (0.7 * (1 - (tick - u.tick) / (u.endTick - u.tick + 1))) + ")"; ctx.beginPath(); ctx.arc(ux, uy, 8, 0, 7); ctx.fill(); }
    else if (u.kind === "he") { ctx.fillStyle = "rgba(230,90,80," + (0.7 * (1 - (tick - u.tick) / (u.endTick - u.tick + 1))) + ")"; ctx.beginPath(); ctx.arc(ux, uy, 7, 0, 7); ctx.fill(); }
  }

  // movement: trace the mover's path up to the current frame
  if (view.isMovement) {
    ctx.strokeStyle = "rgba(217,164,65,.7)"; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    for (let i = 0; i <= idx; i++) {
      const mp = view.frames[i].players.find((p) => p.uid === view.attackerUid);
      if (!mp) continue;
      const [px, py] = w2c(mp.x, mp.y, W, H);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // shot lines for kills that just happened (within ~1.2s)
  const fade = view.tickrate * 1.2;
  for (const k of view.kills) {
    if (tick >= k.killTick && tick - k.killTick <= fade && k.shot?.from && k.shot?.to) {
      const [ax, ay] = w2c(k.shot.from.x, k.shot.from.y, W, H), [vx, vy] = w2c(k.shot.to.x, k.shot.to.y, W, H);
      ctx.globalAlpha = 1 - (tick - k.killTick) / fade;
      ctx.strokeStyle = "#e0605e"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(vx, vy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  const solo = settings && settings.soloView;
  const attP = f.players.find((p) => p.uid === view.attackerUid);
  const refZ = attP && attP.z != null ? attP.z : null; // heights shown relative to the watched player
  const corpseFade = (view.tickrate || 64) * 1.5;
  for (const p of f.players) {
    const isAtt = p.uid === view.attackerUid;
    if (solo && !isAtt) continue;
    if (view.stale && view.stale.has(p.uid)) continue;   // frozen, never-updated entity
    // dead players keep getting sampled in the timeline (corpse/spectator position), so
    // show a fading × for a moment and then stop drawing them
    if (p.dead != null) {
      const age = tick - p.dead;
      if (age > corpseFade) continue;
      const [dx, dy] = w2c(p.x, p.y, W, H);
      ctx.globalAlpha = Math.max(0, 1 - age / corpseFade) * 0.8;
      ctx.strokeStyle = p.team === 3 ? "#5b9bd5" : "#e0a53b"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx - 4, dy - 4); ctx.lineTo(dx + 4, dy + 4); ctx.moveTo(dx + 4, dy - 4); ctx.lineTo(dx - 4, dy + 4); ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    const [cx, cy] = w2c(p.x, p.y, W, H);
    // elevation vs the watched player: a vertical stick + label (needs z — newly parsed demos)
    if (!isAtt && refZ != null && p.z != null) {
      const dz = p.z - refZ;
      if (Math.abs(dz) >= 80) {
        const len = Math.max(-46, Math.min(46, -dz / 8));
        ctx.strokeStyle = dz > 0 ? "rgba(111,211,255,.65)" : "rgba(255,157,111,.65)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + len); ctx.stroke();
        ctx.fillStyle = dz > 0 ? "#6fd3ff" : "#ff9d6f"; ctx.font = "9px Segoe UI";
        ctx.fillText((dz > 0 ? "+" : "") + Math.round(dz), cx + 4, cy + len + (dz > 0 ? -2 : 8));
      }
    }
    if (p.yaw != null) {
      const rad = p.yaw * Math.PI / 180;
      if (isAtt) {
        // the watched player: a bright, long aim line + view cone so you see where they look
        const spread = 0.32;
        for (const a of [rad - spread, rad + spread]) {
          const [ex, ey] = w2c(p.x + Math.cos(a) * 130, p.y + Math.sin(a) * 130, W, H);
          ctx.strokeStyle = "rgba(217,164,65,.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
        }
        const [ex, ey] = w2c(p.x + Math.cos(rad) * 150, p.y + Math.sin(rad) * 150, W, H);
        ctx.strokeStyle = "#ffd766"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      } else {
        const [ex, ey] = w2c(p.x + Math.cos(rad) * 60, p.y + Math.sin(rad) * 60, W, H);
        ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }
    const isVictim = view.victimUids && view.victimUids.has(p.uid);
    ctx.beginPath(); ctx.arc(cx, cy, isAtt ? 7 : 5, 0, 7);
    // 3 = CT (blue), 2 = T (yellow), anything else = unassigned/spectator (gray, not misleading)
    ctx.fillStyle = p.team === 3 ? "#5b9bd5" : p.team === 2 ? "#e0a53b" : "#8a94a0"; ctx.fill();
    if (isAtt) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
    else if (isVictim) { // ring the player(s) who get killed in this clip so they're easy to spot
      ctx.strokeStyle = "#e0605e"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = "rgba(223,230,238,.9)"; ctx.font = "10px Segoe UI";
    ctx.fillText((p.name || "").slice(0, 12), cx + 8, cy - 6);
  }
}

function updateKillFeed(tick) {
  const box = $("#killFeed"); box.innerHTML = "";
  const shown = view.kills.filter((k) => k.killTick <= tick).slice(-6);
  const aCls = teamCls(view.attacker.team);
  for (const k of shown) {
    const hs = k.headshot ? window.headshotIcon() : "";
    const row = el("div", "kf");
    row.innerHTML = `<span class="a ${aCls}">${esc(view.attacker.name)}</span>${window.modifierIcons(k)}${window.weaponIcon(k.weapon)}${hs}<span class="v ${teamCls(k.victim.team)}">${esc(k.victim.name)}</span>`;
    box.appendChild(row);
  }
}

function play() {
  stopAnim(); $("#playBtn").textContent = "⏸";
  let startIdx = +$("#scrub").value || 0;
  if (startIdx >= view.frames.length - 1) startIdx = 0; // at the end -> restart
  const startTick = view.frames[startIdx].tick, t0 = performance.now(), tickms = 1000 / view.tickrate;
  function step(now) {
    const elapsed = (now - t0) / tickms;
    let idx = startIdx;
    while (idx < view.frames.length - 1 && view.frames[idx + 1].tick - startTick <= elapsed) idx++;
    // sub-tick fraction so the 3D view can run at display rate instead of 64 Hz
    let frac = 0;
    if (idx < view.frames.length - 1) {
      const span = view.frames[idx + 1].tick - view.frames[idx].tick;
      if (span > 0) frac = Math.min(1, (elapsed - (view.frames[idx].tick - startTick)) / span);
    }
    drawFrame(idx + frac);
    if (idx >= view.frames.length - 1) { stopAnim(); return; }
    anim = requestAnimationFrame(step);
  }
  anim = requestAnimationFrame(step);
}
function togglePlay() { if (anim) stopAnim(); else play(); } // play() resumes from the scrub position
function stopAnim() { if (anim) cancelAnimationFrame(anim); anim = null; $("#playBtn").textContent = "▶"; }

// ---------- CS:GO / VDM ----------
// the player killed in this clip — used by the "Open on enemy" button
function victimName(h) {
  const k = (h.kills && (h.kills[h.kills.length - 1] || h.kills[0])) || null;
  return k && k.victim ? k.victim.name : null;
}
let lastOpenedDemo = null; // so a second clip in the SAME demo can seek instead of reloading

// `who` = "attacker" (default) or "victim": which player CS:GO spectates.

// ---------- 3D export dialog: trim the clip before exporting ----------
// Video-editor style: the bar spans the whole round, kills are marked on it, and the two
// handles set in/out. Everything else (map, players, markers) is a checkbox right here, so
// you can see the length you're actually exporting before committing.
let expH = null, expLo = 0, expHi = 0, expIn = 0, expOut = 0, expWholeDemo = false;
let expFrames = null, expPlay = null, expPos = 0; // preview frames + playhead

function openExportDialog(h) {
  expH = h;
  const s = settings || {};
  const tr = h.tickrate || (current && current.tickrate) || 64;
  // default span: the round if we know it, else the clip padded by the configured seconds
  const pre = (s.gltfPreSec != null ? s.gltfPreSec : 3) * tr;
  const post = (s.gltfPostSec != null ? s.gltfPostSec : 3) * tr;
  const w = h.watchTick || 0, e = h.endTick || h.killTick || w;
  expLo = Math.max(0, w - tr * 20);           // ~20s of lead-in = plenty of round context
  expHi = e + tr * 20;
  expIn = Math.max(expLo, w - pre);
  expOut = Math.min(expHi, e + post);
  expWholeDemo = false;

  $("#expMap").checked = !!s.gltfIncludeMap;
  $("#expPlayers").checked = s.gltfPlayers !== false;
  $("#expModels").checked = s.gltfModels !== false;
  $("#expKillsChk").checked = s.gltfKills !== false;
  $("#expOnlyInv").checked = !!s.gltfOnlyInvolved;
  $("#expTitle").textContent = "3D export — " + (h.attacker ? h.attacker.name : "clip");
  $("#expInfo").textContent = `${h.mapName || "?"} · ${(h.demoName || h.demPath || "").split(/[\/]/).pop()}`;
  syncExpRange();
  $("#exportModal").style.display = "flex";
  loadExpPreview(h);
}

// Pull the position frames for the trim window so the dialog can actually SHOW the action.
// Reuses the same get_frames the 2D preview uses, so it costs one decode (cached after).
async function loadExpPreview(h) {
  expFrames = null; expPos = 0;
  drawExpPreview();
  try {
    const pv = await window.api.getFrames(h.demPath || (current && current.demPath), expLo, expHi);
    expFrames = (pv && pv.frames && pv.frames.length) ? pv.frames : null;
  } catch { expFrames = null; }
  drawExpPreview();
}

// top-down view of the clip, auto-fitted — enough to see who moves where while trimming
function drawExpPreview() {
  const cv = $("#expPrev"); if (!cv) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#0a0d10"; ctx.fillRect(0, 0, W, H);
  if (!expFrames) {
    ctx.fillStyle = "#8b97a6"; ctx.font = "13px Segoe UI"; ctx.textAlign = "center";
    ctx.fillText("loading preview…", W / 2, H / 2); ctx.textAlign = "left";
    return;
  }
  // fit all positions in the window
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const f of expFrames) for (const p of f.players) {
    if (p.x < mnx) mnx = p.x; if (p.y < mny) mny = p.y;
    if (p.x > mxx) mxx = p.x; if (p.y > mxy) mxy = p.y;
  }
  if (!isFinite(mnx)) return;
  const pad = 120; mnx -= pad; mny -= pad; mxx += pad; mxy += pad;
  const sc = Math.min(W / (mxx - mnx), H / (mxy - mny));
  const ox = (W - (mxx - mnx) * sc) / 2, oy = (H - (mxy - mny) * sc) / 2;
  const X = (x) => ox + (x - mnx) * sc, Y = (y) => H - (oy + (y - mny) * sc);

  // faint trail of the whole window, so you see the shape of the play
  ctx.strokeStyle = "rgba(139,151,166,.18)"; ctx.lineWidth = 1;
  const byUid = {};
  for (const f of expFrames) for (const p of f.players) (byUid[p.uid] = byUid[p.uid] || []).push(p);
  for (const uid in byUid) {
    const tr2 = byUid[uid]; ctx.beginPath();
    tr2.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
  }
  // current frame
  const idx = Math.max(0, Math.min(expFrames.length - 1, Math.round(expPos * (expFrames.length - 1))));
  const fr = expFrames[idx];
  const inRange = fr && fr.tick >= expIn && fr.tick <= expOut;
  for (const p of (fr ? fr.players : [])) {
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, 7);
    ctx.fillStyle = p.team === 3 ? "#5b9bd5" : p.team === 2 ? "#e0a53b" : "#8a94a0";
    ctx.globalAlpha = inRange ? 1 : 0.35; ctx.fill(); ctx.globalAlpha = 1;
    if (p.yaw != null) {
      const r = p.yaw * Math.PI / 180;
      ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.beginPath();
      ctx.moveTo(X(p.x), Y(p.y)); ctx.lineTo(X(p.x + Math.cos(r) * 90), Y(p.y + Math.sin(r) * 90)); ctx.stroke();
    }
    ctx.fillStyle = "rgba(223,230,238,.9)"; ctx.font = "10px Segoe UI";
    ctx.fillText(String(p.name || "").slice(0, 12), X(p.x) + 7, Y(p.y) - 6);
  }
  if (fr) $("#expTickLbl").textContent = "tick " + fr.tick + (inRange ? "" : "  (outside clip)");
}

function tickToPct(t) { return expHi > expLo ? ((t - expLo) / (expHi - expLo)) * 1000 : 0; }
function pctToTick(p) { return Math.round(expLo + (p / 1000) * (expHi - expLo)); }

function syncExpRange() {
  $("#expIn").value = tickToPct(expIn);
  $("#expOut").value = tickToPct(expOut);
  drawExpTrack();
  drawExpPreview();
}

function drawExpTrack() {
  const cv = $("#expTrack"); if (!cv) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  const tr = (expH && expH.tickrate) || (current && current.tickrate) || 64;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0c0f13"; ctx.fillRect(0, 0, W, H);
  const x = (t) => ((t - expLo) / Math.max(1, expHi - expLo)) * W;

  // selected span
  ctx.fillStyle = "rgba(217,164,65,.20)";
  ctx.fillRect(x(expIn), 0, Math.max(2, x(expOut) - x(expIn)), H);
  ctx.strokeStyle = "var(--accent)"; ctx.strokeStyle = "#d9a441"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(expIn), 0); ctx.lineTo(x(expIn), H);
  ctx.moveTo(x(expOut), 0); ctx.lineTo(x(expOut), H); ctx.stroke();

  // second ticks
  ctx.strokeStyle = "#222a33"; ctx.lineWidth = 1;
  for (let t = expLo; t <= expHi; t += tr * 5) {
    ctx.beginPath(); ctx.moveTo(x(t), H - 8); ctx.lineTo(x(t), H); ctx.stroke();
  }
  // kills in this clip
  for (const k of (expH && expH.kills) || []) {
    if (k.killTick == null) continue;
    const kx = x(k.killTick);
    ctx.fillStyle = "#e0605e";
    ctx.beginPath(); ctx.arc(kx, H / 2, 4, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(223,230,238,.85)"; ctx.font = "10px Segoe UI";
    const nm = (k.victim && k.victim.name) || "";
    ctx.fillText(nm.slice(0, 10), Math.min(W - 60, kx + 6), H / 2 - 6);
  }
  const dur = ((expOut - expIn) / tr);
  $("#expDur").textContent = dur.toFixed(1) + "s";
  $("#expInLbl").textContent = "in " + expIn;
  $("#expOutLbl").textContent = "out " + expOut;
}

function stopExpPlay() { if (expPlay) cancelAnimationFrame(expPlay); expPlay = null; const b = $("#expPlayBtn"); if (b) b.textContent = "▶"; }

function wireExportDialog() {
  const io = $("#expIn"), oo = $("#expOut");
  if (!io) return;
  io.oninput = () => { expIn = Math.min(pctToTick(+io.value), expOut - 8); expWholeDemo = false; syncExpRange(); };
  oo.oninput = () => { expOut = Math.max(pctToTick(+oo.value), expIn + 8); expWholeDemo = false; syncExpRange(); };
  $("#expClose").onclick = () => { stopExpPlay(); $("#exportModal").style.display = "none"; };
  $("#expWhole").onclick = () => { expIn = expLo; expOut = expHi; expWholeDemo = false; syncExpRange(); };
  $("#expKillOnly").onclick = () => {
    const tr = (expH && expH.tickrate) || 64;
    const w = expH.watchTick || 0, e = expH.endTick || expH.killTick || w;
    expIn = Math.max(expLo, w - tr * 3); expOut = Math.min(expHi, e + tr * 3);
    expWholeDemo = false; syncExpRange();
  };
  $("#expWholeDemo").onclick = () => { expWholeDemo = true; $("#expDur").textContent = "entire demo"; };
  $("#expScrub").oninput = () => { expPos = +$("#expScrub").value / 1000; stopExpPlay(); drawExpPreview(); };
  $("#expPlayBtn").onclick = () => {
    if (expPlay) return stopExpPlay();
    $("#expPlayBtn").textContent = "⏸";
    // REAL-TIME playback: advance by wall-clock seconds mapped onto the tick range, not a
    // fixed step per animation frame (that ran at whatever speed the range/refresh happened
    // to give). Now 1 second on screen == 1 second of demo time on any monitor.
    const tr = (expH && expH.tickrate) || (current && current.tickrate) || 64;
    const spanSec = Math.max(0.001, (expHi - expLo) / tr);
    let last = performance.now();
    const step = (now) => {
      if (!expFrames) return stopExpPlay();
      const dt = (now - last) / 1000; last = now;
      const lo = (expIn - expLo) / Math.max(1, expHi - expLo);
      const hi = (expOut - expLo) / Math.max(1, expHi - expLo);
      // loop the trimmed span only — you preview exactly what gets exported
      expPos = (expPos < lo || expPos >= hi) ? lo : expPos + dt / spanSec;
      $("#expScrub").value = expPos * 1000;
      drawExpPreview();
      expPlay = requestAnimationFrame(step);
    };
    expPlay = requestAnimationFrame(step);
  };
  $("#expOpenDir").onclick = () => window.api.openGltfDir();
  $("#expGo").onclick = async () => {
    $("#exportModal").style.display = "none";
    await exportClipGltf(expH, {
      fromTick: expIn, toTick: expOut, wholeDemo: expWholeDemo,
      includeMap: $("#expMap").checked, includePlayers: $("#expPlayers").checked,
      includeKills: $("#expKillsChk").checked, onlyInvolved: $("#expOnlyInv").checked,
      includeModels: $("#expModels").checked,
    });
  };
}

// A saved favourite carries the same facts as a highlight, under slightly different keys.
function mapFromName(n) {
  const m = String(n || "").toLowerCase().match(/(de_|cs_|ar_|dz_|gd_|aim_|awp_|fy_|surf_|bhop_|kz_|koth_|cp_|pl_)[a-z0-9_]+/);
  return m ? m[0] : "";
}
function favToHighlight(e) {
  return {
    demPath: e.demoPath, mapName: e.mapName && e.mapName !== "?" ? e.mapName : mapFromName(e.demoName || e.demoPath), watchTick: e.tick, killTick: e.killTick,
    endTick: e.endTick, tickrate: e.tickrate, round: e.round, tags: e.tags || [],
    attacker: { name: e.player, uid: e.uid != null ? e.uid : null, team: e.team },
    kills: (e.killData || []).map((k) => ({ ...k })),
  };
}

// Export one clip to .glb using the Settings ▸ 3D export options.
async function exportClipGltf(h, o) {
  const s = settings || {};
  o = o || {};
  const uids = [];
  if (o.onlyInvolved != null ? o.onlyInvolved : s.gltfOnlyInvolved) {
    if (h.attacker && h.attacker.uid != null) uids.push(h.attacker.uid);
    for (const k of (h.kills || [])) if (k.victim && k.victim.uid != null) uids.push(k.victim.uid);
  }
  const label = [h.attacker && h.attacker.name, h.mapName, (h.tags || [])[0], "tick" + h.watchTick]
    .filter(Boolean).join("_");
  const tr = h.tickrate || (current && current.tickrate) || 64;
  showStatus("Exporting 3D clip…");
  try {
    // the dialog hands us absolute in/out ticks; translate them into the pre/post the
    // backend expects by anchoring on watchTick
    const w = h.watchTick || 0, e = h.endTick || h.killTick || w;
    const preSec = o.fromTick != null ? Math.max(0, (w - o.fromTick) / tr) : (s.gltfPreSec != null ? s.gltfPreSec : 3);
    const postSec = o.toTick != null ? Math.max(0, (o.toTick - e) / tr) : (s.gltfPostSec != null ? s.gltfPostSec : 3);
    const r = await window.api.exportGltf({
      demPath: h.demPath || (current && current.demPath),
      watchTick: w, endTick: e, tickrate: tr,
      mapName: h.mapName || (current && current.mapName) || "",
      preSec, postSec,
      includeMap: o.includeMap != null ? o.includeMap : !!s.gltfIncludeMap,
      includePlayers: o.includePlayers != null ? o.includePlayers : s.gltfPlayers !== false,
      includeModels: o.includeModels != null ? o.includeModels : s.gltfModels !== false,
      includeKills: o.includeKills != null ? o.includeKills : s.gltfKills !== false,
      onlyUids: uids,
      wholeDemo: o.wholeDemo != null ? o.wholeDemo : !!s.gltfWholeDemo,
      label,
    });
    showStatus(r && r.ok ? "Wrote " + r.file : "3D export failed: " + ((r && r.error) || "?"));
  } catch (e2) { showStatus("3D export failed: " + e2.message); }
}

async function openInCsgo(h, who) {
  const demPath = h.demPath || current.demPath;
  const pause = !(settings && settings.pauseOnOpen === false); // default on: pause at the clip start
  const spec = who === "victim" ? (victimName(h) || h.attacker.name) : h.attacker.name;
  const css = !!(h.css || (current && current.css && demPath === current.demPath));
  const game = css ? "CS:S" : "CS:GO";
  // Same demo already loaded → just seek + re-spec instead of reloading the whole demo.
  if (demPath === lastOpenedDemo) {
    try {
      const g = await window.api.gotoTick(h.watchTick || 0, spec, css, pause);
      if (g && g.jumped) { showStatus(`${game}: jumped to tick ${h.watchTick} on ${spec}${pause ? " (paused)" : ""}`); return; }
    } catch {}
  }
  if (/\.bz2$/i.test(demPath)) showStatus("Extracting compressed demo… (first time only)");
  // write the VDM so playdemo auto-jumps; spec the requested player (clone h with that name)
  const hv = who === "victim" ? { ...h, attacker: { ...h.attacker, name: spec } } : h;
  await window.api.writeVdm(demPath, [hv], { pause });
  const r = css ? await window.api.launchCss(demPath) : await window.api.launchCsgo(demPath);
  if (r.ok) lastOpenedDemo = demPath;
  showStatus(r.ok ? `Launching ${game}… jumps to tick ${h.watchTick} on ${spec}${pause ? " (paused — press play / demo_resume)" : ""}`
    : (r.error || `Set the ${game} exe in Settings`) + "  (VDM written next to the demo.)");
}
async function exportVdm() {
  if (current.aggregate) { showStatus("Open a single demo to export its VDM (best-of spans many demos)."); return; }
  const p = await window.api.writeVdm(current.demPath, current.highlights, {});
  showStatus("Wrote " + p);
}

// ---------- cssff_settings.ini (the rulebook) ----------
let cssffInfo = null;
async function loadCssff() {
  try { cssffInfo = await window.api.getCssffConfig(); } catch { cssffInfo = null; }
  return cssffInfo;
}
// the ini's own value for a key, category section first, then [General]
function iniVal(key, section, fallback) {
  const c = cssffInfo;
  if (!c || !c.ok) return fallback;
  if (section && c.sections && c.sections[section] && c.sections[section][key] !== undefined) return c.sections[section][key];
  if (c.general && c.general[key] !== undefined) return c.general[key];
  return fallback;
}
// Frag rule fields mirror the ini and are read-only: the file is the source of truth, so
// showing editable boxes that get ignored would be a lie.
async function showCssffRules(s) {
  await loadCssff();
  const fg = s.frag || {};
  const set = (id, v) => { const el2 = $(id); el2.value = v; el2.disabled = !!(cssffInfo && cssffInfo.ok); el2.title = cssffInfo && cssffInfo.ok ? "from cssff_settings.ini" : "cssff_settings.ini not found — using built-in defaults"; };
  set("#fNsAwp", iniVal("noscope_min_distance", "Snipers", fg.noscopeAwp ?? FRAG_DEF.noscopeAwp));
  set("#fNsScout", iniVal("noscope_min_distance", "Scout", fg.noscopeScout ?? FRAG_DEF.noscopeScout));
  set("#fNsAuto", iniVal("noscope_min_distance", "AutoSnipers", fg.noscopeAuto ?? FRAG_DEF.noscopeAuto));
  set("#fJump", iniVal("jumpshot_min_distance", null, fg.jumpDist ?? FRAG_DEF.jumpDist));
  set("#fJumpSn", iniVal("jumpshot_min_distance", "Snipers", fg.jumpSnipers ?? FRAG_DEF.jumpSnipers));
  set("#fFlick", iniVal("flickshot_min_distance", null, fg.flickDist ?? FRAG_DEF.flickDist));
  set("#fM3", iniVal("3k_max_time", null, fg.multi3 ?? FRAG_DEF.multi3));
  set("#fM3R", iniVal("3k_max_time", "Rifles", fg.multi3Rifles ?? FRAG_DEF.multi3Rifles));
  set("#fM3S", iniVal("3k_max_time", "Snipers", fg.multi3Snipers ?? FRAG_DEF.multi3Snipers));
  set("#fM4", iniVal("4k_max_time", null, fg.multi4 ?? FRAG_DEF.multi4));
  set("#fM5", iniVal("5k_max_time", null, fg.multi5 ?? FRAG_DEF.multi5));
  // these two aren't cssff concepts, so they stay editable
  $("#fScoped").value = fg.scopedDist ?? FRAG_DEF.scopedDist; $("#fScoped").disabled = false;
  $("#fLong").value = fg.longRangeUnits ?? FRAG_DEF.longRangeUnits; $("#fLong").disabled = false;
  const st = $("#cssffState");
  if (cssffInfo && cssffInfo.ok) {
    const extras = [];
    if (iniVal("3k_special_kill_extra_max_time", null, 0)) extras.push(`3k +${iniVal("3k_special_kill_extra_max_time", null, 0)}s per special kill`);
    if (iniVal("tick_slow_stationary_5ks", null, 0)) extras.push(`slow 5k allowed within ${iniVal("slow_5k_max_range", null, 0)}u`);
    if (!iniVal("tick_frags_vs_bots", null, 1)) extras.push("frags vs bots are OFF");
    if (!iniVal("tick_wallbangs", null, 1)) extras.push("wallbangs off except snipers");
    st.innerHTML = `Loaded ${esc(cssffInfo.file)} — these values are read from it${extras.length ? ". Also active: " + esc(extras.join(", ")) : ""}. Edit the file, then re-scan.`;
  } else st.textContent = "cssff_settings.ini not found — falling back to the built-in rules. " + ((cssffInfo && cssffInfo.error) || "");
}

// ---------- settings ----------
async function openSettings() {
  const s = await window.api.getSettings();
  $("#setCsgo").value = s.csgoExe || ""; $("#setHlae").value = s.hlaeExe || ""; $("#setCss").value = s.cssExe || ""; $("#setNetcon").value = s.csgoNetconPort || "";
  $("#setDemos").value = s.demosDir || ""; $("#setPreroll").value = s.prerollSec; $("#setConc").value = s.scanConcurrency;
  $("#setMaps").value = s.mapsDir || ""; $("#setMaps2").value = s.mapsDir2 || ""; $("#setPrefer3d").checked = s.prefer3d !== false;
  $("#setBroaden").checked = !!s.broadenSearch;
  $("#setPauseOnOpen").checked = s.pauseOnOpen !== false;
  $("#setGap").value = s.multikillGapSec ?? 8; $("#setClutchMax").value = s.clutchMaxSec ?? 45; $("#setClutchGap").value = s.clutchMaxGapSec ?? 20;
  $("#setFocus").checked = s.focusNamedTick !== false; $("#setFocusWin").value = s.focusWindowSec ?? 15; $("#setFocusScore").value = s.focusKeepScore ?? 85;
  $("#setFlick").value = s.flickMinDeg;
  $("#setRunJumps").value = s.runMinJumps; $("#setRunPeak").value = s.runMinPeak; $("#setRunAir").value = s.runMinAir; $("#setRunMax").value = s.runMaxSec;
  $("#setNearby").value = s.nearbyRadius; $("#setMaxPrev").value = s.maxPreviewSec;
  $("#setDelBz2").checked = !!s.deleteBz2;
  $("#setGltfDir").value = s.gltfDir || "";
  $("#setGameDir").value = s.gameDir || "";
  $("#setGltfPre").value = s.gltfPreSec != null ? s.gltfPreSec : 3;
  $("#setGltfPost").value = s.gltfPostSec != null ? s.gltfPostSec : 3;
  $("#setGltfMap").checked = !!s.gltfIncludeMap;
  $("#setGltfPlayers").checked = s.gltfPlayers !== false;
  $("#setGltfKills").checked = s.gltfKills !== false;
  $("#setGltfOnlyMe").checked = !!s.gltfOnlyInvolved;
  $("#setGltfWhole").checked = !!s.gltfWholeDemo;
  await showCssffRules(s);
  const disabled = new Set(s.disabledCats || []);
  const cont = $("#catToggles"); cont.innerHTML = "";
  for (const c of CAT_DEFS) {
    const lab = el("label", "cat");
    lab.innerHTML = `<input type="checkbox" data-cat="${c.key}" ${disabled.has(c.key) ? "" : "checked"}/> ${c.label}`;
    cont.appendChild(lab);
  }
  $("#catAll").onclick = () => cont.querySelectorAll("input").forEach((c) => (c.checked = true));
  $("#catNone").onclick = () => cont.querySelectorAll("input").forEach((c) => (c.checked = false));
  $("#settingsModal").style.display = "flex";
}
async function saveSettings() {
  const prev = settings;
  const disabledCats = [...document.querySelectorAll("#catToggles input:not(:checked)")].map((c) => c.dataset.cat);
  settings = await window.api.setSettings({
    csgoExe: $("#setCsgo").value.trim(), hlaeExe: $("#setHlae").value.trim(), cssExe: $("#setCss").value.trim(), csgoNetconPort: $("#setNetcon").value.trim(), demosDir: $("#setDemos").value.trim(),
    prerollSec: parseFloat($("#setPreroll").value) || 1, flickMinDeg: parseInt($("#setFlick").value) || 22,
    deleteBz2: $("#setDelBz2").checked, disabledCats,
    gltfDir: $("#setGltfDir").value.trim(),
    gameDir: $("#setGameDir").value.trim(),
    gltfPreSec: parseFloat($("#setGltfPre").value) || 0,
    gltfPostSec: parseFloat($("#setGltfPost").value) || 0,
    gltfIncludeMap: $("#setGltfMap").checked,
    gltfPlayers: $("#setGltfPlayers").checked,
    gltfKills: $("#setGltfKills").checked,
    gltfOnlyInvolved: $("#setGltfOnlyMe").checked,
    gltfWholeDemo: $("#setGltfWhole").checked,
    mapsDir: $("#setMaps").value.trim(), mapsDir2: $("#setMaps2").value.trim(), prefer3d: $("#setPrefer3d").checked, broadenSearch: $("#setBroaden").checked, pauseOnOpen: $("#setPauseOnOpen").checked,
    multikillGapSec: Math.max(0.5, parseFloat($("#setGap").value) || 8), clutchMaxSec: Math.max(5, parseInt($("#setClutchMax").value) || 45),
    clutchMaxGapSec: Math.max(1, parseInt($("#setClutchGap").value) || 20),
    focusNamedTick: $("#setFocus").checked, focusWindowSec: Math.max(1, parseInt($("#setFocusWin").value) || 15),
    focusKeepScore: Math.max(0, parseInt($("#setFocusScore").value) || 85),
    scanConcurrency: Math.max(1, Math.min(parseInt($("#setConc").value) || 6, 32)),
    runMinJumps: parseInt($("#setRunJumps").value) || 5, runMinPeak: parseInt($("#setRunPeak").value) || 300,
    runMinAir: parseInt($("#setRunAir").value) || 45, runMaxSec: parseInt($("#setRunMax").value) || 12, nearbyRadius: parseInt($("#setNearby").value) || 1000,
    maxPreviewSec: parseInt($("#setMaxPrev").value) || 25,
    // frag rules come from cssff_settings.ini now; only the two knobs it doesn't cover
    // are still editable here (the rest are kept as a fallback for a missing ini)
    frag: {
      ...(prev.frag || {}),
      scopedDist: +$("#fScoped").value || FRAG_DEF.scopedDist,
      longRangeUnits: +$("#fLong").value || FRAG_DEF.longRangeUnits,
    },
  });
  $("#settingsModal").style.display = "none";
  // Only re-tag if a DETECTION setting changed. Category toggles, paths, and the view
  // filters are applied client-side (instant) — no need to re-read 1600 demo caches.
  const sig = (s) => JSON.stringify({ p: s.prerollSec, l: s.longRangeM, f: s.flickMinDeg, b: s.bhopMinSpeed, g: s.multikillGapSec, r: s.rngMaxChance,
    rj: s.runMinJumps, rp: s.runMinPeak, ra: s.runMinAir, rm: s.runMaxSec, n: s.nearbyRadius, e: s.edgebugMinDmg, mp: s.maxPreviewSec, w: s.weights, fr: s.frag });
  const detectionChanged = sig(prev) !== sig(settings);
  // NEVER kick off a re-scan while one is running — a second scanFolder() races the first
  // (both mutate the same aggregate + progress state) and parsing dies. Thread-count and
  // filter changes are picked up live by the running scan anyway.
  if (scanning) {
    showProgress("Settings saved — applied to the running scan" + (detectionChanged ? " (re-scan when it finishes to re-tag)" : ""), 0, true);
    return;
  }
  if (detectionChanged) {
    if (current && current.aggregate) scanFolder(true);   // tagging changed -> re-extract (saved store is stale)
    else if (current) parseAndShow(current.demPath);
  } else if (current) {
    populateFilters(); renderHighlights();                // just filters/paths -> instant
  }
  if (settings.demosDir && settings.demosDir !== prev.demosDir) loadFolder(settings.demosDir);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
function showStatus(t) { $("#statusText").textContent = t; $("#pbar").style.display = "none"; $("#scanCtls").style.display = "none"; $("#status").style.display = "block"; }
// `ctls` shows the Pause/Stop buttons (only meaningful during a folder scan)
function showProgress(t, frac, ctls) { $("#statusText").textContent = t; $("#pbar").style.display = "block"; $("#pbarFill").style.width = Math.round((frac || 0) * 100) + "%"; $("#scanCtls").style.display = ctls ? "flex" : "none"; $("#status").style.display = "block"; }
function hideStatus() { $("#status").style.display = "none"; $("#scanCtls").style.display = "none"; }
