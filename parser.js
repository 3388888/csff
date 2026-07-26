/*
 * parser.js — core engine (v3, split decode/classify).
 *
 *   parseRaw(demPath, {onProgress}) -> Promise<raw>
 *       decodes the demo ONCE: all kills + telemetry, movement runs, tricks,
 *       a whole-match position timeline, player stats. No tags/scores/filters.
 *   classify(raw, cfg) -> result { header, mapName, tickrate, score, players, roundWinners, highlights }
 *       turns raw into tagged/scored/filtered highlights. Cheap — re-run this on
 *       every settings change instead of re-decoding. Weights live in cfg.weights.
 *   parseDemo(demPath, cfg) = parseRaw + classify (convenience / CLI).
 *
 * Source 1 / CS:GO only (demofile). Team 2 = T, 3 = CT.
 */

const fs = require("fs");
const { DemoFile } = require("demofile");

const DEFAULTS = {
  prerollSec: 1.0, postSec: 1.0, previewFps: 32,
  longRangeM: 25, flickMinDeg: 22,
  bhopMinSpeed: 260, boostVz: 250, streakForSmokeBlind: 3,
  multikillGapSec: 8, rngMaxChance: 0.25,
  runContinueSpeed: 200, runMinJumps: 5, runMinPeak: 300, runMinAir: 45,
  edgebugMinDmg: 20, nearbyRadius: 1000, maxPreviewSec: 25, maxHighlights: 80,
  weights: null, // {tag: number} overrides for TAGW
};

// default point weights per tag (user-tunable via cfg.weights)
const TAGW = {
  ace: 100, quad: 70, triple: 45, clutch: 85,
  jump_noscope: 90, noscope: 65, jumpshot: 55, bhop: 50, airborne: 15, boosted: 12,
  flick_hs: 55, flick: 35, spin: 55, long_range: 25, wallbang: 45, airshot: 22, collateral: 45,
  smoke_kill: 30, blind_kill: 40, smoke_streak: 20, blind_streak: 25, rng: 55, off_height: 45, outnumbered: 35,
  bhop_run: 22, fast: 12, long_chain: 20, edgebug: 55, jumpbug: 45, into_kill: 45,
};
const SNIPERS = new Set(["awp", "ssg08", "scar20", "g3sg1"]);
// weapon categories + cssff-derived frag thresholds (source units / seconds)
const WPCAT = { ak47: "Rifles", m4a1: "Rifles", m4a1_silencer: "Rifles", sg556: "Rifles", aug: "Rifles", famas: "Rifles", galilar: "Rifles",
  awp: "Snipers", g3sg1: "AutoSnipers", scar20: "AutoSnipers", ssg08: "Scout",
  glock: "Pistols", hkp2000: "Pistols", p2000: "Pistols", usp_silencer: "Pistols", p250: "Pistols", tec9: "Pistols", cz75a: "Pistols", fiveseven: "Pistols", elite: "Pistols",
  deagle: "Deagle", revolver: "Deagle",
  mp9: "Smgs", mac10: "Smgs", mp7: "Smgs", ump45: "Smgs", p90: "Smgs", bizon: "Smgs", mp5sd: "Smgs",
  nova: "Shotguns", xm1014: "Shotguns", mag7: "Shotguns", sawedoff: "Shotguns" };
const wcat = (w) => WPCAT[(w || "").toLowerCase()] || "Rifles";
const FRAG = {
  noscopeDist: { Snipers: 2000, Scout: 8000, AutoSnipers: 2000 }, noscopeHsMod: { Snipers: 0.5, Scout: 0.375, AutoSnipers: 0.666 },
  jumpDist: { default: 800, Snipers: 0, Scout: 1000, AutoSnipers: 2000 }, jumpHsMod: 0.65,
  flickDist: { default: 120, Rifles: 160 },
  multiMax: { 3: { default: 2, Rifles: 0.8, Snipers: 4, AutoSnipers: 1.6, Pistols: 1.2, Deagle: 3, Shotguns: 3, Knife: 4 }, 4: { default: 6.5, Snipers: 10, Shotguns: 15, Knife: 15 }, 5: { default: 13, Snipers: 15, Scout: 15, Shotguns: 15, Knife: 60 } },
  multiExtra: { 3: 0.5, 4: 1, 5: 3 }, // per special kill in the burst
};
const SPECIAL_TAGS = new Set(["noscope", "jump_noscope", "jumpshot", "flick", "flick_hs", "wallbang", "smoke_kill", "blind_kill", "spin"]);
const WBASE = { awp: .95, ssg08: .92, scar20: .85, g3sg1: .85, ak47: .72, m4a1: .75, m4a1_silencer: .78, sg556: .7, aug: .74, famas: .66, galilar: .64,
  deagle: .6, revolver: .55, glock: .66, hkp2000: .7, usp_silencer: .72, p250: .68, tec9: .62, cz75a: .6, fiveseven: .7, elite: .58,
  mp9: .66, mac10: .6, mp7: .66, ump45: .66, p90: .64, bizon: .62, mp5sd: .68, nova: .5, xm1014: .48, mag7: .5, sawedoff: .45, m249: .55, negev: .5 };

// single-shot hit-chance (0..1). No-scopes are EASY up close, hard far — distance
// is what makes them cool. Recomputed in classify so it's tunable without re-decode.
function computeHitChance(k) {
  const t = k.telemetry, w = k.weapon, distM = k.distM || 0, sniper = SNIPERS.has(w);
  let c;
  if (sniper && k.noscope) c = 0.92 - distM * 0.021;            // 5m≈0.81, 25m≈0.4, 42m≈0.03
  else { c = WBASE[w] != null ? WBASE[w] : 0.6; if (distM) c *= Math.max(0.2, 1 - Math.max(0, distM - 15) / 60); }
  if (t.airborneAtKill) c *= (sniper && k.noscope ? 0.55 : 0.16);
  else if (t.speedAtKill > 130) c *= (1 - Math.min((t.speedAtKill - 130) / 250, 0.6));
  return Math.max(0.02, Math.min(0.98, c));
}

const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
const hyp = (x, y) => Math.hypot(x || 0, y || 0);
const r1 = (n) => (n == null ? 0 : Math.round(n * 10) / 10);
const safe = (fn) => { try { return fn(); } catch { return undefined; } };
const dist3 = (a, b) => (a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)) : null);
const multiTag = (n) => (n >= 5 ? "ace" : n === 4 ? "quad" : n === 3 ? "triple" : null);

// =====================================================================
//  parseRaw — decode the demo once
// =====================================================================
function parseRaw(demPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const demo = new DemoFile();
    let header = null, tickrate = 64, telWin = 64, previewStep = 2, maxTick = 1e9, runGapTicks = 26;

    const players = new Map();  // steamId -> stats
    const buffers = new Map();  // uid -> fine per-tick ring buffer (telemetry)
    const fireBuf = new Map();  // uid -> recent weapon_fire ticks
    const runState = new Map(), movementRuns = [];
    const trickPrev = new Map(), tricks = [];
    const roster = {};          // uid -> {name, team}
    const timeline = [];
    let lastTL = -1e9, lastProg = 0, lastAcceptTick = 0;
    let roundNum = 0, tScore = 0, ctScore = 0;
    const roundWinners = [];
    const RING = () => Math.round(tickrate * 1.6) + 8;

    function rec(steamId, name) {
      if (!steamId) steamId = "BOT:" + name;
      let p = players.get(steamId);
      if (!p) { p = { steamId, name, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, mvps: 0, team: 0 }; players.set(steamId, p); }
      if (name) p.name = name;
      return p;
    }
    function fineSample(pl) {
      const v = safe(() => pl.velocity) || { x: 0, y: 0, z: 0 };
      const pos = safe(() => pl.position) || { x: 0, y: 0, z: 0 };
      const flags = safe(() => pl.getProp("DT_BasePlayer", "m_fFlags")) || 0;
      const yaw = safe(() => pl.getProp("DT_CSPlayer", "m_angEyeAngles[1]"));
      return { tick: demo.currentTick, x: pos.x, y: pos.y, z: pos.z, yaw: yaw == null ? null : yaw,
        spd: Math.round(hyp(v.x, v.y)), vz: Math.round(v.z || 0), onGround: !!(flags & 1) };
    }

    demo.on("start", () => {
      header = demo.header;
      tickrate = header.playbackTime > 0 ? Math.round(header.playbackTicks / header.playbackTime) : 64;
      if (![64, 128].includes(tickrate)) tickrate = tickrate > 96 ? 128 : 64;
      telWin = tickrate; previewStep = Math.max(1, Math.round(tickrate / 32));
      maxTick = header.playbackTicks + 2 * tickrate;
      runGapTicks = Math.round(tickrate * 0.45);
    });

    function trackRun(pl, s) {
      const uid = pl.userId, ct = demo.currentTick;
      let r = runState.get(uid); if (!r) { r = { active: false, prevGround: true }; runState.set(uid, r); }
      const fast = s.spd >= 200;
      const jumped = r.prevGround && !s.onGround;
      if (fast) {
        if (!r.active) Object.assign(r, { active: true, startTick: ct, jumps: 0, maxSpeed: 0, sumSpeed: 0, n: 0, airN: 0, slow: 0, startPos: { x: s.x, y: s.y }, endPos: { x: s.x, y: s.y } });
        r.endTick = ct; r.slow = 0; r.maxSpeed = Math.max(r.maxSpeed, s.spd); r.sumSpeed += s.spd; r.n++;
        if (!s.onGround) r.airN++; if (jumped) r.jumps++;
        r.endPos = { x: s.x, y: s.y }; r.name = pl.name; r.steamId = pl.steamId || null; r.team = pl.teamNumber;
      } else if (r.active && ++r.slow > runGapTicks) closeRun(uid, r);
      r.prevGround = s.onGround;
    }
    function closeRun(uid, r) {
      r.active = false;
      if (r.jumps >= 3 && r.maxSpeed >= 250) { // permissive gate; real thresholds applied in classify
        movementRuns.push({ uid, name: r.name, steamId: r.steamId, team: r.team, startTick: r.startTick, endTick: r.endTick,
          jumps: r.jumps, maxSpeed: r.maxSpeed, avgSpeed: Math.round(r.sumSpeed / Math.max(r.n, 1)),
          airPct: Math.round((r.airN / Math.max(r.n, 1)) * 100),
          distUnits: Math.round(Math.hypot(r.endPos.x - r.startPos.x, r.endPos.y - r.startPos.y)),
          durSec: +((r.endTick - r.startTick) / tickrate).toFixed(1) });
      }
    }
    function trackTricks(pl, s) {
      const uid = pl.userId, ct = demo.currentTick;
      let p = trickPrev.get(uid); if (!p) { p = {}; trickPrev.set(uid, p); }
      if (p.vz != null && s.spd > 120) {
        if (p.vz < -350 && s.vz > -45 && !s.onGround && p.onGround === false)
          tricks.push({ uid, name: pl.name, steamId: pl.steamId || null, team: pl.teamNumber, tick: ct, kind: "edgebug", fallVel: Math.abs(Math.round(p.vz)), spd: s.spd });
        if (p.vz < -300 && p.onGround === false && s.onGround === true) p.jb = { tick: ct, fallVel: Math.abs(Math.round(p.vz)), spd: p.spd };
        else if (p.jb && !s.onGround && ct - p.jb.tick <= 3 && s.spd > p.jb.spd * 0.85) { tricks.push({ uid, name: pl.name, steamId: pl.steamId || null, team: pl.teamNumber, tick: p.jb.tick, kind: "jumpbug", fallVel: p.jb.fallVel, spd: s.spd }); p.jb = null; }
        else if (p.jb && ct - p.jb.tick > 3) p.jb = null;
      }
      p.vz = s.vz; p.onGround = s.onGround; p.spd = s.spd;
    }

    demo.on("tickend", () => {
      const ringLen = RING(), ct = demo.currentTick;
      if (opts.onProgress && ct >= 0) {
        if (ct + 5 * tickrate < lastAcceptTick) { lastAcceptTick = ct; lastProg = 0; }
        else if (ct > lastAcceptTick) lastAcceptTick = ct;
        if (ct <= maxTick) { const f = Math.min(0.99, ct / maxTick); if (f > lastProg + 0.01) { lastProg = f; opts.onProgress(f); } }
      }
      const valid = ct >= 0 && ct <= maxTick;
      const doTimeline = valid && (ct - lastTL >= previewStep || ct < lastTL);
      let frame = null;
      if (doTimeline) { frame = { t: ct, p: [] }; lastTL = ct; }
      for (const pl of demo.players) {
        if (!pl || !pl.isAlive) continue;
        const s = fineSample(pl); const uid = pl.userId;
        roster[uid] = { name: pl.name, team: pl.teamNumber };
        let buf = buffers.get(uid); if (!buf) { buf = []; buffers.set(uid, buf); }
        buf.push(s); if (buf.length > ringLen) buf.shift();
        trackRun(pl, s); trackTricks(pl, s);
        if (frame) frame.p.push([uid, r1(s.x), r1(s.y), s.yaw == null ? null : Math.round(s.yaw), pl.teamNumber]);
      }
      if (frame) timeline.push(frame);
    });

    demo.gameEvents.on("player_hurt", (e) => {
      const a = demo.entities.getByUserId(e.attacker), v = demo.entities.getByUserId(e.userid);
      if (!a || !v || a.teamNumber === v.teamNumber) return;
      if (a.steamId && v.steamId && a.steamId === v.steamId) return;
      rec(a.steamId, a.name).damage += Math.min(e.dmg_health, 100);
    });
    demo.gameEvents.on("weapon_fire", (e) => { const pl = demo.entities.getByUserId(e.userid); if (!pl) return; let b = fireBuf.get(pl.userId); if (!b) { b = []; fireBuf.set(pl.userId, b); } b.push(demo.currentTick); if (b.length > 64) b.shift(); });
    demo.gameEvents.on("round_mvp", (e) => { const pl = demo.entities.getByUserId(e.userid); if (pl) rec(pl.steamId, pl.name).mvps++; });
    demo.gameEvents.on("round_end", (e) => { roundWinners[roundNum] = e.winner; });
    demo.gameEvents.on("round_officially_ended", () => roundNum++);

    // grenades / utility, to draw on the radar during previews
    const utils = [];
    const addUtil = (kind, e, durSec) => utils.push({ kind, x: r1(e.x), y: r1(e.y), tick: demo.currentTick, endTick: demo.currentTick + Math.round(tickrate * durSec) });
    demo.gameEvents.on("smokegrenade_detonate", (e) => addUtil("smoke", e, 17.5));
    demo.gameEvents.on("inferno_startburn", (e) => addUtil("fire", e, 7));
    demo.gameEvents.on("hegrenade_detonate", (e) => addUtil("he", e, 0.4));
    demo.gameEvents.on("flashbang_detonate", (e) => addUtil("flash", e, 0.4));
    demo.gameEvents.on("decoy_started", (e) => addUtil("decoy", e, 15));

    function infoOf(userid) { if (userid == null) return null; const e = demo.entities.getByUserId(userid); if (!e) return null; return { name: e.name, steamId: e.steamId || null, team: e.teamNumber, uid: e.userId, pos: safe(() => e.position) || null }; }

    function hitChance(weapon, tele, distM, noscope) {
      const sniper = SNIPERS.has(weapon);
      let c = WBASE[weapon] != null ? WBASE[weapon] : 0.6;
      if (sniper && noscope) c = 0.22;
      if (tele.airborneAtKill) c *= 0.16;
      else if (tele.speedAtKill > 130) c *= (1 - Math.min((tele.speedAtKill - 130) / 250, 0.6));
      if (distM != null) c *= Math.max(0.2, 1 - Math.max(0, distM - 15) / 60);
      return Math.max(0.01, Math.min(0.99, c));
    }
    function shotsNear(uid, killTick) { const b = fireBuf.get(uid) || []; return b.filter((t) => t >= killTick - tickrate && t <= killTick + 4).length; }
    function telemetry(uid, killTick) {
      const buf = buffers.get(uid) || [];
      const at = (t) => { let best = null, bd = Infinity; for (const s of buf) { const d = Math.abs(s.tick - t); if (d < bd) { bd = d; best = s; } } return best; };
      const now = at(killTick);
      let flickDeg = 0, maxYawRate = 0;
      if (now && now.yaw != null) for (const w of [0.08, 0.12, 0.16, 0.2, 0.26]) { const past = at(killTick - Math.round(tickrate * w)); if (past && past.yaw != null) { const d = Math.abs(angleDiff(now.yaw, past.yaw)); if (d > flickDeg) flickDeg = d; } }
      const win = buf.filter((s) => s.tick <= killTick && s.tick >= killTick - telWin);
      let prev = null, airStreak = 0, maxAirStreak = 0, maxAirSpeed = 0, maxVz = 0, maxSpeed = 0;
      for (const s of win) {
        if (prev && s.yaw != null && prev.yaw != null) { const r = Math.abs(angleDiff(s.yaw, prev.yaw)); if (r > maxYawRate) maxYawRate = r; }
        if (!s.onGround) { airStreak++; if (s.spd > maxAirSpeed) maxAirSpeed = s.spd; } else airStreak = 0;
        if (airStreak > maxAirStreak) maxAirStreak = airStreak;
        if (s.vz > maxVz) maxVz = s.vz; if (s.spd > maxSpeed) maxSpeed = s.spd; prev = s;
      }
      return { airborneAtKill: now ? !now.onGround : false, speedAtKill: now ? now.spd : 0, vzAtKill: now ? now.vz : 0,
        flickDeg: Math.round(flickDeg), maxYawRate: Math.round(maxYawRate), maxAirStreakTicks: maxAirStreak, maxAirSpeed, maxVz, maxSpeed };
    }

    const kills = [];
    demo.gameEvents.on("player_death", (e) => {
      const V = infoOf(e.userid), A = infoOf(e.attacker), As = infoOf(e.assister);
      const teamKill = A && V && A.team === V.team;
      const suicide = A && V && A.steamId && V.steamId && A.steamId === V.steamId;
      if (V) { const pv = rec(V.steamId, V.name); if (V.team) pv.team = V.team; pv.deaths++; }
      if (A && V && !suicide) { const p = rec(A.steamId, A.name); if (A.team) p.team = A.team; if (teamKill) p.kills--; else { p.kills++; if (e.headshot) p.headshots++; } }
      if (As) rec(As.steamId, As.name).assists++;
      if (!A || !V || suicide || teamKill) return;

      const killTick = demo.currentTick, distUnits = dist3(A.pos, V.pos);
      const alive = { 2: 0, 3: 0 }, enemyTeam = A.team === 2 ? 3 : 2; const enemyDists = [];
      for (const pl of demo.players) {
        if (!pl || !pl.isAlive || pl.userId === V.uid || (pl.teamNumber !== 2 && pl.teamNumber !== 3)) continue;
        alive[pl.teamNumber]++;
        if (pl.teamNumber === enemyTeam && A.pos) { const pp = safe(() => pl.position); if (pp) enemyDists.push(Math.round(Math.hypot(pp.x - A.pos.x, pp.y - A.pos.y, pp.z - A.pos.z))); }
      }
      const tele = telemetry(A.uid, killTick);
      kills.push({
        round: roundNum, killTick, time: +demo.currentTime.toFixed(2), weapon: e.weapon,
        headshot: !!e.headshot, penetrated: e.penetrated | 0,
        noscope: !!e.noscopekill, smoke: !!e.smokekill, blind: !!e.blindkill, airshot: !!e.airshotkill,
        distUnits, distM: distUnits != null ? Math.round(distUnits / 52.49) : null,
        teamAlive: alive[A.team], enemyAliveAfter: alive[enemyTeam], enemyDists,
        hitChance: +hitChance(e.weapon, tele, distUnits != null ? Math.round(distUnits / 52.49) : null, !!e.noscopekill).toFixed(3),
        shotsBeforeKill: shotsNear(A.uid, killTick),
        attacker: { name: A.name, steamId: A.steamId, team: A.team, uid: A.uid },
        victim: { name: V.name, steamId: V.steamId, team: V.team, uid: V.uid },
        telemetry: tele,
        shot: { from: A.pos && { x: r1(A.pos.x), y: r1(A.pos.y) }, to: V.pos && { x: r1(V.pos.x), y: r1(V.pos.y) } },
      });
    });

    demo.on("error", (err) => reject(err));
    demo.on("end", (ev) => {
      if (ev.error) return reject(ev.error);
      try { for (const t of demo.teams) { if (t.teamNumber === 2) tScore = t.score; if (t.teamNumber === 3) ctScore = t.score; } } catch {}
      try { for (const pl of demo.players) if (pl && pl.steamId) { const p = players.get(pl.steamId); if (p) p.team = pl.teamNumber; } } catch {}
      for (const [uid, r] of runState) if (r.active) closeRun(uid, r);
      const rounds = Math.max(roundNum, ctScore + tScore, 1);
      resolve({
        header, mapName: header.mapName, tickrate, previewStep,
        score: { ct: ctScore, t: tScore, rounds },
        players: [...players.values()], roundWinners: roundWinners.slice(0, rounds),
        kills, movementRuns, tricks, timeline, roster, utils,
      });
    });

    fs.readFile(demPath, (err, buf) => {
      if (err) return reject(err);
      if (buf.length < 1072 || buf.toString("latin1", 0, 7) !== "HL2DEMO") return reject(new Error("Not a Source demo file"));
      const demoProto = buf.readInt32LE(8);
      const gameDir = buf.toString("latin1", 796, Math.max(796, buf.indexOf(0, 796)));
      if (demoProto !== 4 || !/csgo/i.test(gameDir)) return reject(new Error(`Unsupported demo (${gameDir.trim() || "?"}, protocol ${demoProto}) — only CS:GO Source 1 demos are supported`));
      demo.parse(buf);
    });
  });
}

// =====================================================================
//  classify — raw -> tagged/scored/filtered highlights (cheap, tunable)
// =====================================================================
function classify(raw, cfg = {}) {
  cfg = { ...DEFAULTS, ...cfg };
  const W = { ...TAGW, ...(cfg.weights || {}) };
  // effective frag config (cssff-style), overridable from Settings via cfg.frag
  const fc = cfg.frag || {};
  const F = {
    noscopeDist: { Snipers: fc.noscopeAwp ?? FRAG.noscopeDist.Snipers, Scout: fc.noscopeScout ?? FRAG.noscopeDist.Scout, AutoSnipers: fc.noscopeAuto ?? FRAG.noscopeDist.AutoSnipers },
    noscopeHsMod: FRAG.noscopeHsMod,
    jumpDist: { default: fc.jumpDist ?? FRAG.jumpDist.default, Snipers: fc.jumpSnipers ?? FRAG.jumpDist.Snipers, Scout: FRAG.jumpDist.Scout, AutoSnipers: FRAG.jumpDist.AutoSnipers },
    jumpHsMod: FRAG.jumpHsMod,
    flickDist: { default: fc.flickDist ?? FRAG.flickDist.default, Rifles: FRAG.flickDist.Rifles },
    multiMax: {
      3: { ...FRAG.multiMax[3], default: fc.multi3 ?? FRAG.multiMax[3].default, Rifles: fc.multi3Rifles ?? FRAG.multiMax[3].Rifles, Snipers: fc.multi3Snipers ?? FRAG.multiMax[3].Snipers },
      4: { ...FRAG.multiMax[4], default: fc.multi4 ?? FRAG.multiMax[4].default },
      5: { ...FRAG.multiMax[5], default: fc.multi5 ?? FRAG.multiMax[5].default },
    },
    multiExtra: FRAG.multiExtra,
  };
  const tickrate = raw.tickrate, rounds = raw.score.rounds;
  const prerollTicks = Math.round(tickrate * cfg.prerollSec);
  const postTicks = Math.round(tickrate * cfg.postSec);
  const previewStep = raw.previewStep || Math.max(1, Math.round(tickrate / (cfg.previewFps || 32)));
  const gapTicks = Math.round((cfg.multikillGapSec ?? 8) * tickrate);

  // position/yaw lookup per player from the timeline (for AFK-victim + spin detection)
  const posByUid = {};
  for (const f of raw.timeline) for (const q of f.p) (posByUid[q[0]] = posByUid[q[0]] || []).push({ t: f.t, x: q[1], y: q[2], yaw: q[3] });
  function movedInWindow(uid, a, b) { const arr = posByUid[uid]; if (!arr) return 999; let d = 0, prev = null; for (const p of arr) { if (p.t < a || p.t > b) continue; if (prev) d += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; } return prev ? d : 999; }
  function spinInWindow(uid, a, b) { const arr = posByUid[uid]; if (!arr) return 0; let s = 0, prev = null; for (const p of arr) { if (p.t < a || p.t > b || p.yaw == null) continue; if (prev != null) s += Math.abs(angleDiff(p.yaw, prev)); prev = p.yaw; } return Math.round(s); }

  // rounds where a victim died 2+ times = warmup / DM refragging (less impressive)
  const rvd = {}; for (const k of raw.kills) { const v = k.victim.steamId || k.victim.name; ((rvd[k.round] = rvd[k.round] || {})[v] = (rvd[k.round][v] || 0) + 1); }
  const refragRound = {}; for (const r in rvd) refragRound[r] = Object.values(rvd[r]).some((c) => c >= 2);

  // enrich every kill (recompute hit-chance with the new model; flag afk/spin/warmup)
  for (const k of raw.kills) {
    k.hitChance = +computeHitChance(k).toFixed(3);
    k._afkMoved = movedInWindow(k.victim.uid, k.killTick - tickrate * 3, k.killTick);
    k._spin = spinInWindow(k.attacker.uid, k.killTick - tickrate, k.killTick);
    k._refrag = !!refragRound[k.round];
  }

  function sliceFrames(a, b) {
    const out = [];
    for (const f of raw.timeline) {
      if (f.t < a || f.t > b) continue;
      out.push({ tick: f.t, players: f.p.map((q) => ({ uid: q[0], x: q[1], y: q[2], yaw: q[3], team: q[4], name: (raw.roster[q[0]] || {}).name || "" })) });
    }
    return out;
  }
  function trickTags(k, roundTotal) {
    const t = k.telemetry, tags = [], cat = wcat(k.weapon), sniper = SNIPERS.has(k.weapon), d = k.distUnits || 0;
    // NO-SCOPE (snipers): must be at real distance (cssff). HS lowers the bar.
    if (k.noscope && sniper) {
      const minD = (F.noscopeDist[cat] ?? 2000) * (k.headshot ? (F.noscopeHsMod[cat] ?? 0.5) : 1);
      if (d >= minD) tags.push(t.airborneAtKill ? "jump_noscope" : "noscope");
    }
    // JUMPSHOT: airborne kill at distance (snipers any distance). Not double-counted with jump_noscope.
    if (t.airborneAtKill && !(k.noscope && sniper)) {
      const minJ = (F.jumpDist[cat] ?? F.jumpDist.default) * (k.headshot ? F.jumpHsMod : 1);
      if (d >= minJ) tags.push("jumpshot");
    }
    // FLICK: fast wide turn onto a target at distance
    if (t.flickDeg >= cfg.flickMinDeg && d >= (F.flickDist[cat] ?? F.flickDist.default)) tags.push(k.headshot ? "flick_hs" : "flick");
    if (k._spin >= 300) tags.push("spin");
    if (k.penetrated > 0 && k.headshot) tags.push("wallbang"); // HS wallbangs only (cssff)
    if (k.smoke) tags.push("smoke_kill");
    if (k.blind) tags.push("blind_kill");
    if (k.airshot) tags.push("airshot");
    if (k.distM != null && k.distM >= cfg.longRangeM && !(sniper && !k.noscope)) tags.push("long_range");
    if (t.airborneAtKill && t.vzAtKill < -180 && k.noscope) tags.push("off_height"); // noscope while dropping off height
    k._nearby = (k.enemyDists || []).filter((dd) => dd <= cfg.nearbyRadius).length;
    if (k._nearby >= 3 && k.teamAlive <= k.enemyAliveAfter) tags.push("outnumbered");
    k._special = tags.some((tg) => SPECIAL_TAGS.has(tg));
    return tags;
  }

  const highlights = []; let hid = 0;
  function makeHighlight(ks, tags, extra = {}) {
    const first = ks[0], last = ks[ks.length - 1];
    const watchTick = Math.max(0, first.killTick - prerollTicks);
    const endTick = last.killTick + postTicks;
    let score = 0; for (const t of tags) score += W[t] || 10;
    score += ks.filter((k) => k.headshot).length * 5;
    if (tags.includes("long_range")) score += Math.min(Math.max(...ks.map((k) => k.distM || 0)), 30);
    if (extra.clutchX) score += (extra.clutchX - 1) * 15;
    for (const k of ks) if (k.hitChance != null && k.hitChance < 0.35) score += Math.round((1 - k.hitChance) * 40) + (k.shotsBeforeKill <= 1 ? 10 : 0);
    const risky = tags.some((t) => ["rng", "off_height", "outnumbered", "jump_noscope"].includes(t));
    if (risky && raw.roundWinners[first.round] && raw.roundWinners[first.round] !== first.attacker.team) score += 25;
    // penalties from the user's feedback: AFK victims, and warmup/DM refrag rounds
    if (ks.every((k) => k._afkMoved < 120)) score *= 0.25;   // killed a barely-moving (AFK) player
    if (ks.every((k) => k._refrag)) score *= 0.55;           // warmup / deathmatch refragging
    score = Math.round(score);
    return {
      id: hid++, round: first.round, attacker: first.attacker, tags, coolScore: score, clutchX: extra.clutchX || null,
      afk: ks.every((k) => k._afkMoved < 120), warmup: ks.every((k) => k._refrag), spin: Math.max(...ks.map((k) => k._spin || 0)),
      watchTick, killTick: first.killTick, endTick,
      kills: ks.map((k) => ({ killTick: k.killTick, weapon: k.weapon, headshot: k.headshot, penetrated: k.penetrated,
        noscope: k.noscope, smoke: k.smoke, blind: k.blind, airshot: k.airshot, distM: k.distM, distUnits: k.distUnits,
        hitChance: k.hitChance, shotsBeforeKill: k.shotsBeforeKill, teamAlive: k.teamAlive, enemyAliveAfter: k.enemyAliveAfter, nearbyEnemies: k._nearby,
        victim: k.victim, telemetry: k.telemetry, shot: k.shot, tags: k._tags })),
    };
  }

  // group kills by round + attacker
  const groups = new Map();
  for (const k of raw.kills) { const key = k.round + "|" + (k.attacker.steamId || k.attacker.name); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k); }
  for (const grp of groups.values()) {
    grp.sort((a, b) => a.killTick - b.killTick);
    for (const k of grp) k._tags = trickTags(k, grp.length);
    const used = new Set();
    const solo = grp.filter((k) => k.teamAlive === 1);
    if (solo.length >= 2 && solo[solo.length - 1].enemyAliveAfter === 0) {
      const x = solo[0].enemyAliveAfter + 1; const tagSet = new Set(["clutch"]); // a clutch is a clutch (1vX) regardless of timing
      for (const k of solo) { for (const t of k._tags) tagSet.add(t); used.add(k); }
      highlights.push(makeHighlight(solo, [...tagSet], { clutchX: x }));
    }
    const rest = grp.filter((k) => !used.has(k));
    // group into candidate bursts (kills chained within a loose link), then a burst only
    // "ticks" as a 3k/4k/5k if its span fits the tight, weapon-specific max time (+ special extends)
    let chain = [];
    const flush = () => {
      if (chain.length >= 3) {
        const n = Math.min(chain.length, 5);
        const cat = chain.map((k) => wcat(k.weapon)).reduce((a, b) => ((F.multiMax[n][b] ?? F.multiMax[n].default) > (F.multiMax[n][a] ?? F.multiMax[n].default) ? b : a));
        const specials = chain.filter((k) => k._special).length;
        const maxT = (F.multiMax[n][cat] ?? F.multiMax[n].default) + specials * (F.multiExtra[n] || 0);
        const span = (chain[chain.length - 1].killTick - chain[0].killTick) / tickrate;
        const hs = chain.filter((k) => k.headshot).length;
        const minHs = (cat === "Snipers" || cat === "Scout" || cat === "AutoSnipers") ? 0 : (n === 3 ? 2 : 0);
        if (span <= maxT && (hs >= minHs || specials > 0)) { // needs HS unless it contains a special kill
          const tagSet = new Set([multiTag(chain.length)]);
          for (const k of chain) { for (const t of k._tags) tagSet.add(t); used.add(k); }
          highlights.push(makeHighlight(chain.slice(), [...tagSet]));
        }
      }
      chain = [];
    };
    for (const k of rest) { if (chain.length && (k.killTick - chain[chain.length - 1].killTick) / tickrate > 5) flush(); chain.push(k); }
    flush();
    const byTick = new Map();
    for (const k of grp) { if (used.has(k)) continue; if (!byTick.has(k.killTick)) byTick.set(k.killTick, []); byTick.get(k.killTick).push(k); }
    for (const [, arr] of byTick) if (arr.length >= 2 && arr.some((k) => k.penetrated > 0)) { const tagSet = new Set(["collateral"]); for (const k of arr) { for (const t of k._tags) tagSet.add(t); used.add(k); } highlights.push(makeHighlight(arr, [...tagSet])); }
    for (const k of grp) { if (used.has(k)) continue; if (k._tags.length) highlights.push(makeHighlight([k], k._tags)); }
  }

  // movement (bhop) runs — ONLY keep a run that ends in a kill (a pure run isn't a frag)
  for (const run of raw.movementRuns) {
    if (run.jumps < cfg.runMinJumps || run.maxSpeed < cfg.runMinPeak || run.airPct < cfg.runMinAir) continue;
    const fk = raw.kills.find((k) => (k.attacker.steamId === run.steamId || k.attacker.name === run.name) && k.killTick >= run.startTick && k.killTick <= run.endTick + tickrate);
    if (!fk) continue; // no kill during/after the run -> skip entirely
    const tags = ["bhop_run", "into_kill"]; if (run.maxSpeed >= 400) tags.push("fast"); if (run.jumps >= 12) tags.push("long_chain");
    let score = 0; for (const t of tags) score += W[t] || 10;
    score += Math.round(Math.min(run.maxSpeed, 500) - 250 + run.jumps * 6 + run.durSec * 2);
    highlights.push({ id: hid++, type: "movement", round: fk ? fk.round : 0, attacker: { name: run.name, steamId: run.steamId, team: run.team, uid: run.uid },
      tags, coolScore: score, clutchX: null, watchTick: Math.max(0, run.startTick - prerollTicks), killTick: run.startTick, endTick: (fk ? fk.killTick : run.endTick),
      movement: { maxSpeed: run.maxSpeed, avgSpeed: run.avgSpeed, jumps: run.jumps, airPct: run.airPct, distUnits: run.distUnits, durSec: run.durSec, killAfter: !!fk },
      kills: fk ? [{ killTick: fk.killTick, weapon: fk.weapon, headshot: fk.headshot, victim: fk.victim, telemetry: fk.telemetry, shot: fk.shot, tags: [] }] : [] });
  }

  // edgebug / jumpbug — ship only if enough fall damage saved OR a kill right after
  const fallDmg = (v) => Math.max(0, Math.round((v - 580) * 0.1333));
  const killWin = Math.round(tickrate * 4);
  raw.tricks.sort((a, b) => a.tick - b.tick);
  const lastTrick = {};
  for (const tr of raw.tricks) {
    const key = tr.uid + "|" + tr.kind; if (lastTrick[key] && tr.tick - lastTrick[key] < tickrate) continue; lastTrick[key] = tr.tick;
    const dmgSaved = fallDmg(tr.fallVel);
    const fk = raw.kills.find((k) => (k.attacker.steamId === tr.steamId || k.attacker.name === tr.name) && k.killTick >= tr.tick && k.killTick <= tr.tick + killWin);
    if (dmgSaved < cfg.edgebugMinDmg && !fk) continue;
    const tags = fk ? [tr.kind, "into_kill"] : [tr.kind];
    let score = 0; for (const t of tags) score += W[t] || 10; score += dmgSaved;
    highlights.push({ id: hid++, type: "movement", round: fk ? fk.round : 0, attacker: { name: tr.name, steamId: tr.steamId, team: tr.team, uid: tr.uid },
      tags, coolScore: score, clutchX: null, watchTick: Math.max(0, tr.tick - prerollTicks), killTick: tr.tick, endTick: (fk ? fk.killTick : tr.tick) + postTicks,
      movement: { fallVel: tr.fallVel, spd: tr.spd, dmgSaved, killAfter: !!fk },
      kills: fk ? [{ killTick: fk.killTick, weapon: fk.weapon, headshot: fk.headshot, victim: fk.victim, telemetry: fk.telemetry, shot: fk.shot, tags: [] }] : [] });
  }

  highlights.sort((a, b) => b.coolScore - a.coolScore || a.watchTick - b.watchTick);
  const capped = highlights.slice(0, cfg.maxHighlights || 80);
  const maxPrev = Math.round(tickrate * (cfg.maxPreviewSec || 25));
  const rawUtils = raw.utils || [];
  for (const h of capped) {
    h.tickrate = tickrate;
    const end = Math.min(h.endTick, h.watchTick + maxPrev); // cap every clip length
    const activeUtils = rawUtils.filter((u) => u.endTick >= h.watchTick && u.tick <= end);
    h.preview = { tickrate, watchTick: h.watchTick, endTick: end, frames: sliceFrames(h.watchTick, end), utils: activeUtils };
  }

  // scoreboard: per-round kills + derived stats
  const perRound = new Map(), perRoundHs = new Map();
  for (const k of raw.kills) { const id = k.attacker.steamId || "BOT:" + k.attacker.name; const r = Math.min(k.round, rounds - 1);
    if (!perRound.has(id)) { perRound.set(id, new Array(rounds).fill(0)); perRoundHs.set(id, new Array(rounds).fill(0)); }
    perRound.get(id)[r]++; if (k.headshot) perRoundHs.get(id)[r]++; }
  const players = raw.players.filter((p) => p.kills || p.deaths || p.assists)
    .map((p) => ({ ...p, hs: p.kills > 0 ? Math.round((p.headshots / p.kills) * 100) : 0, adr: Math.round(p.damage / rounds), kd: +(p.kills / Math.max(p.deaths, 1)).toFixed(2), roundKills: perRound.get(p.steamId) || new Array(rounds).fill(0), roundHs: perRoundHs.get(p.steamId) || new Array(rounds).fill(0) }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

  return { header: raw.header, mapName: raw.mapName, tickrate, score: raw.score, roundWinners: raw.roundWinners, players, highlights };
}

function parseDemo(demPath, cfg = {}) { return parseRaw(demPath, cfg).then((raw) => classify(raw, cfg)); }

module.exports = { parseRaw, classify, parseDemo, DEFAULTS, TAGW };
