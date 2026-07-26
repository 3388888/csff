const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const TEAM = { 2: "t", 3: "ct" };
const TAG_LABEL = {
  ace: "ACE", quad: "4K", triple: "3K", clutch: "CLUTCH", jump_noscope: "jump noscope", noscope: "noscope",
  bhop: "bhop", airborne: "airborne", boosted: "boosted", flick_hs: "flick HS", flick: "flick",
  long_range: "long range", wallbang: "wallbang", collateral: "collateral", airshot: "airshot",
  smoke_streak: "smoke (streak)", blind_streak: "blind (streak)",
  rng: "RNG", off_height: "off height", outnumbered: "outnumbered", spin: "360 / spin",
  jumpshot: "jumpshot", smoke_kill: "smoke kill", blind_kill: "flashed kill",
  bhop_run: "bhop run", fast: "fast", long_chain: "long chain", edgebug: "edgebug", jumpbug: "jumpbug", into_kill: "→ kill",
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
const FRAG_DEF = { noscopeAwp: 2000, noscopeScout: 8000, noscopeAuto: 2000, jumpDist: 800, jumpSnipers: 0, flickDist: 120, multi3: 2, multi3Rifles: 0.8, multi3Snipers: 4, multi4: 6.5, multi5: 13 };


// all tunables sent to the engine's classify step (instant, no re-decode)
function classifyOpts() {
  const s = settings;
  return {
    prerollSec: s.prerollSec, longRangeM: s.longRangeM, flickMinDeg: s.flickMinDeg, bhopMinSpeed: s.bhopMinSpeed,
    multikillGapSec: s.multikillGapSec, rngMaxChance: s.rngMaxChance, runMinJumps: s.runMinJumps, runMinPeak: s.runMinPeak,
    runMinAir: s.runMinAir, nearbyRadius: s.nearbyRadius, edgebugMinDmg: s.edgebugMinDmg, maxPreviewSec: s.maxPreviewSec,
    weights: s.weights || {}, frag: s.frag || {}, deleteBz2: s.deleteBz2,
  };
}
let parseProgress = { name: "", prefix: "" };
(async () => {
  settings = await window.api.getSettings();
  try { const ic = await window.api.getIcons(); if (ic) window.ICONS = ic; } catch {}
  try { defaultWeights = await window.api.getDefaultWeights() || {}; } catch {}

  window.api.onParseProgress(({ frac }) => { if (!scanning && $("#status").style.display !== "none") showProgress("Parsing " + parseProgress.name + " — " + Math.round(frac * 100) + "%", frac); });
  if (settings.demosDir) loadFolder(settings.demosDir);
  wire();
})();

function wire() {
  $("#btnOpenDemos").onclick = async () => { const ps = await window.api.pickDemos(); if (ps.length) parseAndShow(ps[0]); };
  $("#btnOpenFolder").onclick = async () => { const d = await window.api.pickFolder(); if (d) { await window.api.setSettings({ demosDir: d }); settings.demosDir = d; loadFolder(d); } };
  $("#btnScanFolder").onclick = scanFolder;
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
  $("#soloView").onchange = (e) => { window.api.setSettings({ soloView: e.target.checked }); if (settings) settings.soloView = e.target.checked; if (view) drawFrame(+$("#scrub").value); };
  $("#btnVdm").onclick = exportVdm;
  $("#coolSearch").oninput = () => renderHighlights();
  $("#coolClear").onclick = () => { $("#coolSearch").value = ""; renderHighlights(); };
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

let scanning = false;
async function scanFolder() {
  if (!settings.demosDir) { const d = await window.api.pickFolder(); if (!d) return; await window.api.setSettings({ demosDir: d }); settings.demosDir = d; }
  const demos = await window.api.listDemos(settings.demosDir);
  if (!demos.length) { showStatus("No demos in this folder."); return; }
  const opts = classifyOpts();
  const all = [];
  const N = Math.max(1, Math.min(settings.scanConcurrency || 6, demos.length));
  let idx = 0, done = 0, ok = 0, skipped = 0;
  const t0 = performance.now();
  scanning = true;
  showProgress(`Parsing folder — 0/${demos.length} (×${N})`, 0);
  async function worker() {
    while (idx < demos.length) {
      const d = demos[idx++];
      try {
        const r = await window.api.parseDemo(d.path, opts);
        if (r.css) { skipped++; done++; continue; } // CS:S demos aren't part of the CS:GO best-of
        const demPath = r.demPath || d.path;
        // strip preview frames from the aggregate (reloaded from cache on Preview) — keeps memory small
        for (const h of r.highlights.slice(0, 30)) all.push({ ...h, preview: null, demPath, mapName: r.mapName, demoName: d.name });
        ok++;
      } catch (e) { console.warn("skip", d.name, e.message); skipped++; }
      done++;
      const eta = ((performance.now() - t0) / done) * (demos.length - done) / 1000;
      showProgress(`Parsing folder — ${done}/${demos.length} (×${N})${done < demos.length ? " · ~" + Math.ceil(eta) + "s left" : ""}`, done / demos.length);
    }
  }
  await Promise.all(Array.from({ length: N }, worker));
  scanning = false;
  all.sort((a, b) => b.coolScore - a.coolScore || a.watchTick - b.watchTick);
  current = { aggregate: true, demoCount: ok, skipped, highlights: all };
  renderAggregate(); hideStatus();
}

function renderAggregate() {
  $("#empty").style.display = "none";
  $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "none";
  const hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", "Best of folder"));
  hd.appendChild(el("div", "sub", `${current.demoCount} demos · ${current.highlights.length} highlights` + (current.skipped ? ` · ${current.skipped} skipped (unsupported)` : "")));
  renderHighlights();
}

function renderMatch() {
  $("#empty").style.display = "none";
  $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "";
  const h = current.header, hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", current.mapName));
  const sc = el("div", "score"); sc.innerHTML = `<span class="ct">CT ${current.score.ct}</span> : <span class="t">${current.score.t} T</span>`;
  hd.appendChild(sc);
  hd.appendChild(el("div", "sub", `${current.score.rounds} rounds · ${current.tickrate} tick`));
  hd.appendChild(el("div", "sub", h.serverName));
  renderScoreboard(); renderRoundBreakdown(); renderHighlights();
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

function renderCss() {
  $("#empty").style.display = "none"; $("#matchView").style.display = "block";
  document.querySelector(".col-left").style.display = "none";
  const hd = $("#matchHeader"); hd.innerHTML = "";
  hd.appendChild(el("div", "map", current.mapName || "CS:S demo"));
  hd.appendChild(el("div", "sub", `${current.frags.length} frags · CS:S (via cssff)`));
  if (current.header && current.header.serverName) hd.appendChild(el("div", "sub", current.header.serverName));
  $("#coolCount").textContent = "(" + current.frags.length + ")";
  const box = $("#coolList"); box.innerHTML = "";
  if (!current.frags.length) { box.appendChild(el("div", "muted", "No frags found by cssff (adjust cssff_settings.ini).")); return; }
  current.frags.forEach((f, i) => {
    const card = el("div", "ck");
    const top = el("div", "top");
    top.appendChild(el("div", "rank", "#" + (i + 1)));
    const who = el("div", "who"); who.innerHTML = `<span class="${teamCls(f.team)}">${esc(f.player)}</span> <span class="vic">${esc(f.desc)}</span>`; top.appendChild(who);
    card.appendChild(top);
    const meta = el("div", "meta"); meta.appendChild(el("span", null, "tick " + f.tick)); card.appendChild(meta);
    const act = el("div", "actions");
    const cs = el("button", "mini", "Open in CS:S"); cs.onclick = () => openCssFrag(f); act.appendChild(cs);
    card.appendChild(act); box.appendChild(card);
  });
}
async function openCssFrag(f) {
  const tr = current.tickrate || 66;
  await window.api.writeVdm(current.demPath, [{ watchTick: Math.max(0, f.tick - tr), killTick: f.tick, endTick: f.tick + tr * 3, attacker: { name: f.player }, tags: [f.desc] }], {});
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

function highlightVisible(h, search, disabled) {
  if (search) {
    const inAttacker = h.attacker.name.toLowerCase().includes(search);
    const inVictim = h.kills.some((k) => k.victim && k.victim.name.toLowerCase().includes(search));
    const inTag = h.tags.some((t) => t.replace(/_/g, " ").includes(search) || (TAG_LABEL[t] || "").toLowerCase().includes(search));
    if (!inAttacker && !inVictim && !inTag) return false;
  }
  if (!h.tags.some((t) => !disabled.has(tagToCat[t] || t))) return false;
  return true;
}

function renderHighlights() {
  const search = ($("#coolSearch").value || "").toLowerCase().trim();
  const disabled = new Set(settings.disabledCats || []);
  const list = current.highlights.filter((h) => highlightVisible(h, search, disabled));
  $("#coolCount").textContent = "(" + list.length + (list.length !== current.highlights.length ? " of " + current.highlights.length : "") + ")";
  const box = $("#coolList"); box.innerHTML = "";
  if (!list.length) { box.appendChild(el("div", "muted", "No highlights match the filter.")); return; }
  list.forEach((h, i) => {
    const card = el("div", "ck");
    const top = el("div", "top");
    top.appendChild(el("div", "rank", "#" + (i + 1)));
    const who = el("div", "who");
    const n = h.kills.length;
    if (h.type === "movement") {
      const ml = h.tags.includes("edgebug") ? "edgebug" : h.tags.includes("jumpbug") ? "jumpbug" : "bhop run";
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
          (k.distM != null ? ` <span class="muted">· ${k.distM}m</span>` : "") + gap;
        kl.appendChild(row);
      });
      card.appendChild(kl);
    }

    const meta = el("div", "meta");
    const bits = [];
    if (h.demoName) bits.push(`${h.mapName} · ${h.demoName.replace(/\.dem$/i, "")}`);
    if (h.type === "movement") {
      const m = h.movement;
      if (m.maxSpeed != null) bits.push(`max ${m.maxSpeed} u/s`, `avg ${m.avgSpeed}`, `${m.jumps} jumps`, `${m.airPct}% air`, `${m.durSec}s`);
      else if (m.fallVel != null) { bits.push(`saved ~${m.dmgSaved} dmg (${m.fallVel} u/s fall)`); if (m.killAfter && h.kills[0]) bits.push(`→ ${h.kills[0].weapon} kill`); }
      bits.push(`watch tick ${h.watchTick}`);
      for (const b of bits) meta.appendChild(el("span", null, b));
      card.appendChild(meta);
      const act = el("div", "actions");
      const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => openPreview(h); act.appendChild(pv);
      const cs = el("button", "mini ghost", "Open in CS:GO"); cs.onclick = () => openInCsgo(h); act.appendChild(cs);

      card.appendChild(act);

      box.appendChild(card);
      return;
    }
    bits.push(`round ${h.round + 1}`);
    const t0 = h.kills[0].telemetry;
    if (n === 1) {
      const k0 = h.kills[0];
      if (t0.airborneAtKill) bits.push(`airborne @${t0.speedAtKill}u/s`);
      if (t0.flickDeg >= 25) bits.push(`flick ${t0.flickDeg}°`);
      if (k0.penetrated > 0) bits.push(`${k0.penetrated} wall`);
      if (k0.hitChance != null && (h.tags.includes("rng") || h.tags.includes("off_height"))) bits.push(`~${Math.round(k0.hitChance * 100)}% shot${k0.shotsBeforeKill <= 1 ? " · 1 bullet" : ""}`);
      if (h.tags.includes("outnumbered") && k0.nearbyEnemies) bits.push(`${k0.nearbyEnemies} enemies close`);
    }
    bits.push(`watch tick ${h.watchTick} · kill ${h.killTick}`);
    for (const b of bits) meta.appendChild(el("span", null, b));
    card.appendChild(meta);

    const act = el("div", "actions");
    const pv = el("button", "mini", "▶ Preview"); pv.onclick = () => openPreview(h); act.appendChild(pv);
    const cs = el("button", "mini ghost", "Open in CS:GO"); cs.onclick = () => openInCsgo(h); act.appendChild(cs);

    card.appendChild(act);

    box.appendChild(card);
  });
}

// ---------- 2D preview ----------
let anim = null, view = null;
async function openPreview(h) {
  // aggregate highlights carry no frames — reload them from the cached parse
  if ((!h.preview || !h.preview.frames || !h.preview.frames.length) && h.demPath) {
    showStatus("Loading preview…");
    try {
      const r = await window.api.parseDemo(h.demPath, classifyOpts());
      const match = r.highlights.find((x) => x.killTick === h.killTick && x.type === h.type && x.attacker.name === h.attacker.name);
      if (match && match.preview) h.preview = match.preview;
      hideStatus();
    } catch (e) { showStatus("Couldn't load preview: " + e.message); return; }
  }
  if (!h.preview || !h.preview.frames || !h.preview.frames.length) { showStatus("No preview data."); return; }
  const radar = await getRadar(h.mapName || current.mapName);
  view = buildView(h, radar);
  const label = h.type === "movement" ? (h.tags[0] === "edgebug" ? "edgebug" : h.tags[0] === "jumpbug" ? "jumpbug" : "bhop run") : (h.kills.length > 1 ? h.kills.length + "K" : esc(h.kills[0].weapon));
  $("#previewTitle").innerHTML = `${esc(h.attacker.name)} ${label} <span class="muted">[${h.tags.map((t) => tagLabel(t, h)).join(", ")}]</span>`;
  $("#scrub").max = view.frames.length - 1; $("#scrub").value = 0;
  $("#soloView").checked = !!settings.soloView;
  $("#previewCsgo").onclick = () => openInCsgo(h);
  $("#previewReveal").onclick = () => window.api.showItem(h.demPath || current.demPath);
  $("#previewMeta").textContent = h.type === "movement"
    ? (h.movement.maxSpeed != null
        ? `max ${h.movement.maxSpeed} u/s · avg ${h.movement.avgSpeed} · ${h.movement.jumps} jumps · ${h.movement.airPct}% air · ${h.movement.durSec}s · watch tick ${h.watchTick}`
        : `saved ~${h.movement.dmgSaved} dmg (${h.movement.fallVel} u/s fall)${h.movement.killAfter ? " → kill" : ""} · watch tick ${h.watchTick}`)
    : `Round ${h.round + 1} · watch tick ${h.watchTick}, first kill ${h.killTick}` + (radar ? "" : "  (no radar — auto-fit)");
  $("#previewModal").style.display = "flex";
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
  radarCache[map] = { img, cal: r.cal };
  return radarCache[map];
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
  return { frames, kills: h.kills, tickrate: h.preview.tickrate, radar, bounds: b, attackerUid: h.attacker.uid, attacker: h.attacker, isMovement: h.type === "movement", utils: h.preview.utils || [] };
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

function drawFrame(idx) {
  const cv = $("#previewCanvas"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0d10"; ctx.fillRect(0, 0, W, H);
  if (view.radar && view.radar.img.naturalWidth) {
    try { ctx.globalAlpha = 0.85; ctx.drawImage(view.radar.img, 0, 0, W, H); } catch {} finally { ctx.globalAlpha = 1; }
  }

  const f = view.frames[idx]; $("#scrub").value = idx;
  const tick = f.tick;
  $("#tickLabel").textContent = `tick ${tick}`;

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
  for (const p of f.players) {
    const isAtt = p.uid === view.attackerUid;
    if (solo && !isAtt) continue;
    const [cx, cy] = w2c(p.x, p.y, W, H);
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
  updateKillFeed(tick);
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
    while (idx < view.frames.length - 1 && view.frames[idx].tick - startTick < elapsed) idx++;
    drawFrame(idx);
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
  const r = await window.api.launchCsgo(demPath);
  showStatus(r.ok ? "Launching CS:GO… jumps to tick " + h.watchTick : r.error + "  (VDM written next to the demo.)");
}
async function exportVdm() {
  if (current.aggregate) { showStatus("Open a single demo to export its VDM (best-of spans many demos)."); return; }
  const p = await window.api.writeVdm(current.demPath, current.highlights, {});
  showStatus("Wrote " + p);
}

// ---------- settings ----------
async function openSettings() {
  const s = await window.api.getSettings();
  $("#setCsgo").value = s.csgoExe || ""; $("#setHlae").value = s.hlaeExe || ""; $("#setCss").value = s.cssExe || "";
  $("#setDemos").value = s.demosDir || ""; $("#setPreroll").value = s.prerollSec; $("#setLong").value = s.longRangeM;
  $("#setGap").value = s.multikillGapSec; $("#setFlick").value = s.flickMinDeg; $("#setBhop").value = s.bhopMinSpeed; $("#setConc").value = s.scanConcurrency;
  $("#setRunJumps").value = s.runMinJumps; $("#setRunPeak").value = s.runMinPeak; $("#setRunAir").value = s.runMinAir;
  $("#setNearby").value = s.nearbyRadius; $("#setEdge").value = s.edgebugMinDmg; $("#setMaxPrev").value = s.maxPreviewSec;
  $("#setDelBz2").checked = !!s.deleteBz2;
  const fg = s.frag || {};
  $("#fNsAwp").value = fg.noscopeAwp ?? FRAG_DEF.noscopeAwp; $("#fNsScout").value = fg.noscopeScout ?? FRAG_DEF.noscopeScout; $("#fNsAuto").value = fg.noscopeAuto ?? FRAG_DEF.noscopeAuto;
  $("#fJump").value = fg.jumpDist ?? FRAG_DEF.jumpDist; $("#fJumpSn").value = fg.jumpSnipers ?? FRAG_DEF.jumpSnipers; $("#fFlick").value = fg.flickDist ?? FRAG_DEF.flickDist;
  $("#fM3").value = fg.multi3 ?? FRAG_DEF.multi3; $("#fM3R").value = fg.multi3Rifles ?? FRAG_DEF.multi3Rifles; $("#fM3S").value = fg.multi3Snipers ?? FRAG_DEF.multi3Snipers;
  $("#fM4").value = fg.multi4 ?? FRAG_DEF.multi4; $("#fM5").value = fg.multi5 ?? FRAG_DEF.multi5;
  const disabled = new Set(s.disabledCats || []);
  const cont = $("#catToggles"); cont.innerHTML = "";
  for (const c of CAT_DEFS) {
    const lab = el("label", "cat");
    lab.innerHTML = `<input type="checkbox" data-cat="${c.key}" ${disabled.has(c.key) ? "" : "checked"}/> ${c.label}`;
    cont.appendChild(lab);
  }
  $("#catAll").onclick = () => cont.querySelectorAll("input").forEach((c) => (c.checked = true));
  $("#catNone").onclick = () => cont.querySelectorAll("input").forEach((c) => (c.checked = false));
  // weight editor
  const we = $("#weightEditor"); we.innerHTML = "";
  const wOver = s.weights || {};
  for (const tag of Object.keys(defaultWeights)) {
    const row = el("label", "wrow");
    row.innerHTML = `<span>${TAG_LABEL[tag] || tag}</span><input type="number" data-w="${tag}" value="${wOver[tag] != null ? wOver[tag] : defaultWeights[tag]}" />`;
    we.appendChild(row);
  }
  $("#wReset").onclick = () => we.querySelectorAll("input").forEach((i) => (i.value = defaultWeights[i.dataset.w]));
  $("#settingsModal").style.display = "flex";
}
async function saveSettings() {
  const prev = settings;
  const disabledCats = [...document.querySelectorAll("#catToggles input:not(:checked)")].map((c) => c.dataset.cat);
  const weights = {};
  document.querySelectorAll("#weightEditor input").forEach((i) => { const v = parseInt(i.value); if (!isNaN(v) && v !== defaultWeights[i.dataset.w]) weights[i.dataset.w] = v; });
  settings = await window.api.setSettings({
    csgoExe: $("#setCsgo").value.trim(), hlaeExe: $("#setHlae").value.trim(), cssExe: $("#setCss").value.trim(), demosDir: $("#setDemos").value.trim(),
    prerollSec: parseFloat($("#setPreroll").value) || 1, longRangeM: parseInt($("#setLong").value) || 25,
    multikillGapSec: parseInt($("#setGap").value) || 8, flickMinDeg: parseInt($("#setFlick").value) || 22,
    bhopMinSpeed: parseInt($("#setBhop").value) || 260, deleteBz2: $("#setDelBz2").checked, disabledCats,
    scanConcurrency: Math.max(1, Math.min(parseInt($("#setConc").value) || 6, 32)),
    runMinJumps: parseInt($("#setRunJumps").value) || 5, runMinPeak: parseInt($("#setRunPeak").value) || 300,
    runMinAir: parseInt($("#setRunAir").value) || 45, nearbyRadius: parseInt($("#setNearby").value) || 1000,
    edgebugMinDmg: parseInt($("#setEdge").value) || 20, maxPreviewSec: parseInt($("#setMaxPrev").value) || 25, weights,
    frag: {
      noscopeAwp: +$("#fNsAwp").value || FRAG_DEF.noscopeAwp, noscopeScout: +$("#fNsScout").value || FRAG_DEF.noscopeScout, noscopeAuto: +$("#fNsAuto").value || FRAG_DEF.noscopeAuto,
      jumpDist: +$("#fJump").value || 0, jumpSnipers: +$("#fJumpSn").value || 0, flickDist: +$("#fFlick").value || FRAG_DEF.flickDist,
      multi3: +$("#fM3").value || FRAG_DEF.multi3, multi3Rifles: +$("#fM3R").value || FRAG_DEF.multi3Rifles, multi3Snipers: +$("#fM3S").value || FRAG_DEF.multi3Snipers,
      multi4: +$("#fM4").value || FRAG_DEF.multi4, multi5: +$("#fM5").value || FRAG_DEF.multi5,
    },
  });
  $("#settingsModal").style.display = "none";
  // classify is instant (raw is cached), so just re-run — thresholds & weights apply live
  if (current && current.aggregate) scanFolder();
  else if (current) parseAndShow(current.demPath);
  if (settings.demosDir && settings.demosDir !== prev.demosDir) loadFolder(settings.demosDir);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
function showStatus(t) { $("#statusText").textContent = t; $("#pbar").style.display = "none"; $("#status").style.display = "block"; }
function showProgress(t, frac) { $("#statusText").textContent = t; $("#pbar").style.display = "block"; $("#pbarFill").style.width = Math.round((frac || 0) * 100) + "%"; $("#status").style.display = "block"; }
function hideStatus() { $("#status").style.display = "none"; }
