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
  jumpshot: "jumpshot", smoke_kill: "smoke kill", blind_kill: "flashed kill",
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
const TYPE_SHORT = { ace: "ace", quad: "4k", triple: "3k", clutch: "clutch", jump_noscope: "jns", noscope: "ns", jumpshot: "jump", flick_hs: "flick", flick: "flick", spin: "360", wallbang: "wb", collateral: "collat", airshot: "airshot", smoke_kill: "smoke", blind_kill: "flashed", bhop_run: "bhop", edgebug: "edgebug", jumpbug: "jumpbug", surf: "surf", flashboost: "flashboost", troll: "troll", rng: "rng", off_height: "offheight", outnumbered: "clutch", long_range: "longrange" };
function favTypeShort(h) { if (h.clutchX) return "clutch1v" + h.clutchX; for (const t of (h.tags || [])) if (TYPE_SHORT[t]) return TYPE_SHORT[t]; return (h.tags && h.tags[0]) || "kill"; }
function favDemoName(h) { return h.demoName || ((h.demPath || (current && current.demPath) || "").split(/[\\/]/).pop()) || "demo"; }
function favKey(h) { return `${favDemoName(h)}|${h.killTick}|${h.attacker.name}|${h.type || "kill"}`; }
function favEntry(h) {
  return { demoPath: h.demPath || (current && current.demPath) || "", demoName: favDemoName(h),
    player: h.attacker.name, tick: h.watchTick, killTick: h.killTick, endTick: h.endTick,
    type: favTypeShort(h), tags: h.tags || [], score: h.coolScore || 0,
    // enough to rebuild a card and a preview later, without the demo being loaded
    mapName: hMap(h) || null, round: h.round != null ? h.round : null, kills: (h.kills || []).length,
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
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, (e.mapName || "?") + " · " + String(e.demoName).replace(/\.dem$/i, "")));
    if (e.round != null) meta.appendChild(el("span", null, "round " + (e.round + 1)));
    meta.appendChild(el("span", null, `watch tick ${e.tick}`));
    card.appendChild(meta);
    const act = el("div", "actions");
    const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => previewFavorite(e); act.appendChild(pv);
    const cs = el("button", "mini ghost", e.css ? "Open in CS:S" : "Open in CS:GO"); cs.onclick = () => openFavInGame(e); act.appendChild(cs);
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
    attacker: { name: e.player, uid, team: e.team }, kills: [], preview: pv,
    css: !!e.css, label: e.label || null,
    movement: { maxSpeed: null, dmgSaved: 0, fallVel: 0 } };
  await openPreview(h);
}
async function openFavInGame(e) {
  await window.api.writeVdm(e.demoPath, [{ watchTick: e.tick, killTick: e.killTick, endTick: e.endTick, attacker: { name: e.player }, tags: e.tags || [] }], {});
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
  return {
    prerollSec: s.prerollSec, longRangeM: s.longRangeM, flickMinDeg: s.flickMinDeg, bhopMinSpeed: s.bhopMinSpeed,
    multikillGapSec: s.multikillGapSec, clutchMaxSec: s.clutchMaxSec, clutchMaxGapSec: s.clutchMaxGapSec, rngMaxChance: s.rngMaxChance, runMinJumps: s.runMinJumps, runMinPeak: s.runMinPeak,
    focusNamedTick: s.focusNamedTick, focusWindowSec: s.focusWindowSec, focusKeepScore: s.focusKeepScore,
    runMinAir: s.runMinAir, runMaxSec: s.runMaxSec, nearbyRadius: s.nearbyRadius, edgebugMinDmg: s.edgebugMinDmg, maxPreviewSec: s.maxPreviewSec,
    weights: s.weights || {}, frag: s.frag || {}, deleteBz2: s.deleteBz2,
  };
}
let parseProgress = { name: "", prefix: "" };
(async () => {
  settings = await window.api.getSettings();
  try { const ic = await window.api.getIcons(); if (ic) window.ICONS = ic; } catch {}
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
  $("#coolSearch").oninput = () => renderHighlights();
  $("#coolClear").onclick = () => { $("#coolSearch").value = ""; for (const id of ["filterMap", "filterWeapon", "filterType", "filterDist", "filterFav"]) $("#" + id).value = ""; $("#filterFocus").value = "focus"; renderHighlights(); };
  for (const id of ["filterMap", "filterWeapon", "filterType", "filterFav", "filterFocus"]) $("#" + id).onchange = () => renderHighlights();
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
const CLASSIFY_VERSION = "5"; // bump when classify logic changes so the persistent store re-extracts
function classifySig() {
  const s = settings;
  return CLASSIFY_VERSION + JSON.stringify({ p: s.prerollSec, l: s.longRangeM, f: s.flickMinDeg, b: s.bhopMinSpeed, g: s.multikillGapSec, r: s.rngMaxChance,
    rj: s.runMinJumps, rp: s.runMinPeak, ra: s.runMinAir, rm: s.runMaxSec, n: s.nearbyRadius, e: s.edgebugMinDmg, mp: s.maxPreviewSec, w: s.weights, fr: s.frag,
    cm: s.clutchMaxSec, cg: s.clutchMaxGapSec, ft: s.focusNamedTick, fw: s.focusWindowSec, fk: s.focusKeepScore,
    ini: cssffInfo ? cssffInfo.mtime : 0 });   // editing cssff_settings.ini re-extracts
}

let scanning = false;
// force=true re-scans every demo (e.g. after changing detection settings)
async function scanFolder(force = false) {
  if (!settings.demosDir) { const d = await window.api.pickFolder(); if (!d) return; await window.api.setSettings({ demosDir: d }); settings.demosDir = d; }
  const demos = await window.api.listDemos(settings.demosDir);
  if (!demos.length) { showStatus("No demos in this folder."); return; }
  const opts = classifyOpts();
  const sig = classifySig();

  // load the saved store; reuse it unless detection settings changed or caller forced a rescan
  let saved = force ? null : await window.api.loadAggregate();
  if (saved && (saved.sig !== sig || saved.dir !== settings.demosDir)) saved = null;
  const scanned = new Set((saved && saved.scanned) || []);   // demo paths already extracted
  let all = (saved && saved.highlights) || [];

  const toScan = demos.filter((d) => !scanned.has(d.path));
  if (!toScan.length && all.length) {
    // everything already saved — instant, no cache reads
    current = { aggregate: true, demoCount: scanned.size, skipped: 0, highlights: all };
    renderAggregate(); hideStatus();
    showStatus(`Loaded ${all.length} highlights from ${scanned.size} demos (saved). ${demos.length} demos in folder.`);
    return;
  }

  // use ALL cores by default (decode is CPU-bound). Respect an explicit non-default setting.
  const cores = navigator.hardwareConcurrency || 6;
  const wantN = (settings.scanConcurrency && settings.scanConcurrency !== 6) ? settings.scanConcurrency : cores;
  const N = Math.max(1, Math.min(wantN, 32, toScan.length));
  let idx = 0, done = 0, ok = 0, skipped = 0;
  const t0 = performance.now();
  scanning = true;
  const fresh = [];
  showProgress(`Parsing ${toScan.length} new demo(s) — 0/${toScan.length} (×${N})${all.length ? ` · ${all.length} already saved` : ""}`, 0);
  async function worker() {
    while (idx < toScan.length) {
      const d = toScan[idx++];
      try {
        const r = await window.api.parseDemo(d.path, opts);
        if (r.css) { skipped++; done++; scanned.add(d.path); continue; }
        const demPath = r.demPath || d.path;
        for (const h of r.highlights.slice(0, 30)) fresh.push({ ...h, preview: null, demPath, mapName: r.mapName, demoName: d.name });
        scanned.add(d.path); ok++;
      } catch (e) { console.warn("skip", d.name, e.message); skipped++; }
      done++;
      const eta = ((performance.now() - t0) / done) * (toScan.length - done) / 1000;
      showProgress(`Parsing ${toScan.length} new demo(s) — ${done}/${toScan.length} (×${N})${done < toScan.length ? " · ~" + Math.ceil(eta) + "s left" : ""}`, done / toScan.length);
    }
  }
  await Promise.all(Array.from({ length: N }, worker));
  scanning = false;
  all = all.concat(fresh);
  all.sort((a, b) => b.coolScore - a.coolScore || a.watchTick - b.watchTick);
  // persist so the next open / filter never re-reads demo caches
  await window.api.saveAggregate({ sig, dir: settings.demosDir, scanned: [...scanned], highlights: all });
  current = { aggregate: true, demoCount: scanned.size, skipped, highlights: all };
  renderAggregate(); hideStatus();
  if (fresh.length) showStatus(`Added ${fresh.length} highlights from ${ok} new demo(s). Total ${all.length} — saved.`);
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
  const h = current.header, hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", current.mapName));
  const sc = el("div", "score"); sc.innerHTML = `<span class="ct">CT ${current.score.ct}</span> : <span class="t">${current.score.t} T</span>`;
  hd.appendChild(sc);
  hd.appendChild(el("div", "sub", `${current.score.rounds} rounds · ${current.tickrate} tick`));
  if (current.tickHints && current.tickHints.length) {
    const s = el("div", "sub focus-note", `◎ named tick ${current.tickHints.join(", ")} — showing that moment (switch the last filter to “everything” for the rest)`);
    hd.appendChild(s);
  }
  hd.appendChild(el("div", "sub", h.serverName));
  renderScoreboard(); renderRoundBreakdown(); populateFilters(); renderHighlights();
}

function renderRoundBreakdown() {
  const box = $("#roundView"); box.innerHTML = "";
  const rounds = current.score.rounds;
  const winners = current.roundWinners || [];
  const t = el("table", "rounds");
  // header: round numbers
  let head = "<tr><th class='pname'></th>";
  for (let r = 0; r < rounds; r++) head += `<th title='round ${r + 1}'>${r + 1}</th>`;
  head += "<th class='tot'>K</th></tr>";
  // winner row
  let win = "<tr class='winrow'><td class='pname'>winner</td>";
  for (let r = 0; r < rounds; r++) { const w = winners[r]; const c = w === 3 ? "ct" : w === 2 ? "t" : ""; win += `<td class='wc ${c}' title='${w === 3 ? "CT" : w === 2 ? "T" : "?"}'></td>`; }
  win += "<td></td></tr>";
  let body = "";
  for (const p of current.players) {
    const rk = p.roundKills || [], rh = p.roundHs || [];
    body += `<tr><td class='pname clickable' data-name='${esc(p.name)}'>${esc(p.name)}</td>`;
    for (let r = 0; r < rounds; r++) {
      const k = rk[r] || 0, hs = rh[r] || 0;
      const cls = k >= 3 ? "k3" : k === 2 ? "k2" : k === 1 ? "k1" : "";
      body += `<td class='kc ${cls}' title='round ${r + 1}: ${k} kill${k !== 1 ? "s" : ""}${hs ? ", " + hs + " HS" : ""}'>${k || ""}</td>`;
    }
    body += `<td class='tot'>${p.kills}</td></tr>`;
  }
  t.innerHTML = head + win + body;
  box.appendChild(t);
  box.querySelectorAll(".pname.clickable").forEach((c) => { c.onclick = () => { $("#coolSearch").value = c.dataset.name; renderHighlights(); }; });
}

// CS:S game version by network protocol (what the demo was recorded on)
const CSS_VER = { 7: "v34", 8: "v34", 14: "v77", 15: "v77", 24: "v93/v94" };

function renderCss() {
  $("#empty").style.display = "none"; $("#favView").style.display = "none"; $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "none";
  const hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", current.mapName || "CS:S demo"));
  const np = current.netProtocol;
  const via = (np ? `CS:S ${CSS_VER[np] || "protocol " + np} · protocol ${np}` : "CS:S (via cssff)") +
    (current.hasPositions ? " · positions decoded" : np ? " · no positions on this protocol yet" : "");
  hd.appendChild(el("div", "sub", `${current.frags.length} frags · ${via}`));
  if (current.header && current.header.serverName) hd.appendChild(el("div", "sub", current.header.serverName));
  $("#coolCount").textContent = "(" + current.frags.length + ")";
  const box = $("#coolList"); box.innerHTML = "";
  if (!current.frags.length) { box.appendChild(el("div", "muted", "No frags found in this demo.")); return; }
  const tr = current.tickrate || 66;
  current.frags.forEach((f, i) => {
    const card = el("div", "ck");
    const top = el("div", "top");
    top.appendChild(el("div", "rank", "#" + (i + 1)));
    const who = el("div", "who");
    const icons = (f.weapon || "").split("/").filter(Boolean).map((w) => window.weaponIcon(w)).join("");
    who.innerHTML = `<span class="${teamCls(f.team)}">${esc(f.player)}</span> ${icons} <span class="vic">${esc(f.desc)}</span>`;
    top.appendChild(who);
    if (f.kills >= 3) top.appendChild(el("div", "stars", "★".repeat(Math.min(5, f.kills))));
    card.appendChild(top);
    const tags = el("div", "tags");
    if (f.kills) tags.appendChild(el("span", "chip" + (f.kills >= 4 ? " hot" : ""), f.kills + "K"));
    if (f.headshots) tags.appendChild(el("span", "chip", f.headshots + " HS"));
    if (f.spanSec) tags.appendChild(el("span", "chip", f.spanSec + "s"));
    if (tags.children.length) card.appendChild(tags);
    const meta = el("div", "meta");
    if (f.round != null) meta.appendChild(el("span", null, "round " + (f.round + 1)));
    meta.appendChild(el("span", null, `tick ${f.tick}` + (f.endTick && f.endTick !== f.tick ? ` → ${f.endTick}` : "")));
    meta.appendChild(el("span", null, `${Math.floor(f.tick / tr / 60)}:${String(Math.floor((f.tick / tr) % 60)).padStart(2, "0")}`));
    card.appendChild(meta);
    const act = el("div", "actions");
    if (current.hasPositions) {
      const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => previewCssFrag(f); act.appendChild(pv);
    }
    const cs = el("button", "mini" + (current.hasPositions ? " ghost" : ""), "Open in CS:S"); cs.onclick = () => openCssFrag(f); act.appendChild(cs);
    const rv = el("button", "mini ghost", "Show demo file"); rv.onclick = () => window.api.showItem(current.demPath); act.appendChild(rv);
    act.appendChild(favBtn(cssFragH(f))); // CS:S clips can go in the demopack too
    card.appendChild(act); box.appendChild(card);
  });
}
// A cssfast frag in the shape the rest of the app speaks (preview, favorites, VDM).
// There's no per-kill list on this side, so `label` carries cssff's own description.
function cssFragH(f) {
  const tr = current.tickrate || 66;
  const pre = Math.round(tr * ((settings && settings.prerollSec) || 1.5));
  return {
    mapName: current.mapName, demPath: current.demPath, type: "kill", round: f.round || 0,
    watchTick: Math.max(0, f.tick - pre), killTick: f.tick, endTick: (f.endTick || f.tick) + tr * 3,
    coolScore: (f.kills || 0) * 10 + (f.headshots || 0) * 5, tickrate: tr, css: true,
    tags: f.kills >= 5 ? ["ace"] : f.kills === 4 ? ["quad"] : f.kills === 3 ? ["triple"] : [],
    label: (f.desc || (f.kills ? f.kills + "K" : "clip")).slice(0, 70),
    attacker: { name: f.player, uid: null, team: f.team }, kills: [],
  };
}
// CS:S clips play back through the same 2D radar / 3D view as CS:GO — the positions come
// out of the demo's entity stream and are cached in the same shape.
async function previewCssFrag(f) {
  const h = cssFragH(f);
  showStatus("Loading preview…");
  const pv = await window.api.getFrames(current.demPath, h.watchTick, h.endTick, (settings && settings.maxPreviewSec) || 25, f.round);
  if (!pv || !pv.frames || !pv.frames.length) { showStatus("No position data for this clip."); return; }
  hideStatus();
  // the radar/3D camera follows by uid, and cssfast keys players by userID
  for (const [uid, r] of Object.entries(pv.roster || {})) if (r && r.name === f.player) { h.attacker.uid = +uid; break; }
  if (h.attacker.uid == null) {
    for (const fr of pv.frames) { const p = fr.players.find((q) => q.name === f.player); if (p) { h.attacker.uid = p.uid; break; } }
  }
  h.preview = pv;
  await openPreview(h);
}

async function openCssFrag(f) {
  const tr = current.tickrate || 66;
  const pre = Math.round(tr * ((settings && settings.prerollSec) || 1.5));
  const end = (f.endTick || f.tick) + tr * 3;
  await window.api.writeVdm(current.demPath, [{ watchTick: Math.max(0, f.tick - pre), killTick: f.tick, endTick: end, attacker: { name: f.player }, tags: [f.desc] }], {});
  const r = await window.api.launchCss(current.demPath);
  showStatus(r.ok ? "Launching CS:S… jumps to tick " + f.tick : (r.error || "Set CS:S exe in Settings") + "  (VDM written next to the demo.)");
}

function renderScoreboard() {
  const box = $("#scoreboard"); box.innerHTML = "";
  const t = el("table", "sb");
  t.innerHTML = `<tr><th class="name">Player</th><th>K</th><th>D</th><th>A</th><th>HS%</th><th>ADR</th><th>K/D</th><th>MVP</th></tr>`;
  for (const [tn, label] of [[3, "CT"], [2, "T"]]) {
    const ps = current.players.filter((p) => p.team === tn);
    if (!ps.length) continue;
    const hr = el("tr", "teamhdr"); const td = el("td", null, label); td.colSpan = 8; hr.appendChild(td); t.appendChild(hr);
    for (const p of ps) {
      const tr = el("tr", TEAM[tn]);
      tr.innerHTML = `<td class="name clickable">${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${p.hs}%</td><td>${p.adr}</td><td>${p.kd}</td><td>${p.mvps}</td>`;
      tr.querySelector(".name").onclick = () => { $("#coolSearch").value = p.name; renderHighlights(); };
      t.appendChild(tr);
    }
  }
  box.appendChild(t);
}

function stars(score) { const n = score >= 100 ? 5 : score >= 70 ? 4 : score >= 50 ? 3 : score >= 35 ? 2 : 1; return "★".repeat(n) + "☆".repeat(5 - n); }
function teamCls(tn) { return tn === 3 ? "ct" : "t"; }

function hMap(h) { return h.mapName || (current && current.mapName) || ""; }
function hWeapons(h) { return (h.kills || []).map((k) => k.weapon).filter(Boolean); }
function hMaxDistM(h) { return Math.max(0, ...(h.kills || []).map((k) => k.distM || 0)); }

function highlightVisible(h, f) {
  if (f.search) {
    const inAttacker = h.attacker.name.toLowerCase().includes(f.search);
    const inVictim = h.kills.some((k) => k.victim && k.victim.name.toLowerCase().includes(f.search));
    const inTag = h.tags.some((t) => t.replace(/_/g, " ").includes(f.search) || (TAG_LABEL[t] || "").toLowerCase().includes(f.search));
    if (!inAttacker && !inVictim && !inTag) return false;
  }
  if (!h.tags.some((t) => !f.disabled.has(tagToCat[t] || t))) return false;
  if (f.map && hMap(h) !== f.map) return false;
  if (f.weapon && !hWeapons(h).includes(f.weapon)) return false;
  if (f.type && !h.tags.includes(f.type)) return false;
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
    focus: $("#filterFocus") ? $("#filterFocus").value === "focus" : true,
  };
}

function renderHighlights() {
  const f = currentFilters();
  const list = current.highlights.filter((h) => highlightVisible(h, f));
  $("#coolCount").textContent = "(" + list.length + (list.length !== current.highlights.length ? " of " + current.highlights.length : "") + ")";
  const box = $("#coolList"); box.innerHTML = "";
  if (!list.length) { box.appendChild(el("div", "muted", "No highlights match the filter.")); return; }
  // only render the top N cards — a 35k-kill aggregate would choke the DOM otherwise.
  // they're sorted by score, so the best are always shown; filter/search narrows further.
  const RENDER_CAP = 300;
  const shown = list.slice(0, RENDER_CAP);
  if (list.length > RENDER_CAP) box.appendChild(el("div", "muted", `Showing the top ${RENDER_CAP} of ${list.length}. Use the filter or a category toggle to narrow down.`));
  shown.forEach((h, i) => {
    const card = el("div", "ck");
    const top = el("div", "top");
    top.appendChild(el("div", "rank", "#" + (i + 1)));
    const who = el("div", "who");
    const n = h.kills.length;
    if (h.type === "movement") {
      const ml = h.tags.includes("edgebug") ? "edgebug" : h.tags.includes("jumpbug") ? "jumpbug" : h.tags.includes("surf") ? "surf" : h.tags.includes("flashboost") ? "flashboost" : "bhop run";
      who.innerHTML = `${esc(h.attacker.name)} <span class="vic">— ${ml}</span>`;
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
    if (h.type === "movement") {
      const m = h.movement;
      if (h.tags.includes("flashboost")) { bits.push(`flashboost → ${m.maxSpeed} u/s`, `+${m.boost} u/s spike`); if (m.killAfter && h.kills[0]) bits.push(`→ ${h.kills[0].weapon} kill`); }
      else if (h.tags.includes("surf")) { bits.push(`surf · max ${m.maxSpeed} u/s`, `${m.durSec}s`, `${m.distUnits}u`); if (m.killAfter && h.kills[0]) bits.push(`→ ${h.kills[0].weapon} kill`); }
      else if (m.maxSpeed != null) bits.push(`max ${m.maxSpeed} u/s`, `avg ${m.avgSpeed}`, `${m.jumps} jumps`, `${m.airPct}% air`, `${m.durSec}s`);
      else if (m.fallVel != null) { bits.push(`saved ~${m.dmgSaved} dmg (${m.fallVel} u/s fall)`); if (m.killAfter && h.kills[0]) bits.push(`→ ${h.kills[0].weapon} kill`); }
      bits.push(`watch tick ${h.watchTick}`);
      for (const b of bits) meta.appendChild(el("span", null, b));
      card.appendChild(meta);
      const act = el("div", "actions");
      const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => openPreview(h); act.appendChild(pv);
      const cs = el("button", "mini ghost", "Open in CS:GO"); cs.onclick = () => openInCsgo(h); act.appendChild(cs);
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
    act.appendChild(favBtn(h));
    card.appendChild(act);

    box.appendChild(card);
  });
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
  if (!known) showStatus(`Stripping 3D geometry from ${mapName}.bsp …`);
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
  const frames = h.preview.frames;
  let b = null;
  if (!radar) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const c = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
    for (const f of frames) for (const p of f.players) c(p.x, p.y);
    for (const k of h.kills) { if (k.shot?.from) c(k.shot.from.x, k.shot.from.y); if (k.shot?.to) c(k.shot.to.x, k.shot.to.y); }
    const pad = 120; b = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }
  return { frames, stale: staleUids(frames, h.attacker.uid), kills: h.kills, tickrate: h.preview.tickrate, radar, bounds: b, attackerUid: h.attacker.uid, attacker: h.attacker,
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
    ctx.beginPath(); ctx.arc(cx, cy, isAtt ? 7 : 5, 0, 7);
    ctx.fillStyle = p.team === 3 ? "#5b9bd5" : "#e0a53b"; ctx.fill();
    if (isAtt) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
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
async function openInCsgo(h) {
  const demPath = h.demPath || current.demPath;
  await window.api.writeVdm(demPath, [h], {});
  // a CS:S demo has to go to CS:S — the VDM is the same, only the exe differs
  const css = !!(h.css || (current && current.css && demPath === current.demPath));
  const r = css ? await window.api.launchCss(demPath) : await window.api.launchCsgo(demPath);
  const game = css ? "CS:S" : "CS:GO";
  showStatus(r.ok ? `Launching ${game}… jumps to tick ${h.watchTick}`
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
  $("#setGap").value = s.multikillGapSec ?? 8; $("#setClutchMax").value = s.clutchMaxSec ?? 45; $("#setClutchGap").value = s.clutchMaxGapSec ?? 20;
  $("#setFocus").checked = s.focusNamedTick !== false; $("#setFocusWin").value = s.focusWindowSec ?? 15; $("#setFocusScore").value = s.focusKeepScore ?? 85;
  $("#setFlick").value = s.flickMinDeg;
  $("#setRunJumps").value = s.runMinJumps; $("#setRunPeak").value = s.runMinPeak; $("#setRunAir").value = s.runMinAir; $("#setRunMax").value = s.runMaxSec;
  $("#setNearby").value = s.nearbyRadius; $("#setMaxPrev").value = s.maxPreviewSec;
  $("#setDelBz2").checked = !!s.deleteBz2;
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
    mapsDir: $("#setMaps").value.trim(), mapsDir2: $("#setMaps2").value.trim(), prefer3d: $("#setPrefer3d").checked,
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
  if (detectionChanged) {
    if (current && current.aggregate) scanFolder(true);   // tagging changed -> re-extract (saved store is stale)
    else if (current) parseAndShow(current.demPath);
  } else if (current) {
    populateFilters(); renderHighlights();                // just filters/paths -> instant
  }
  if (settings.demosDir && settings.demosDir !== prev.demosDir) loadFolder(settings.demosDir);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
function showStatus(t) { $("#statusText").textContent = t; $("#pbar").style.display = "none"; $("#status").style.display = "block"; }
function showProgress(t, frac) { $("#statusText").textContent = t; $("#pbar").style.display = "block"; $("#pbarFill").style.width = Math.round((frac || 0) * 100) + "%"; $("#status").style.display = "block"; }
function hideStatus() { $("#status").style.display = "none"; }
