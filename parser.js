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
  jump_noscope: 90, noscope: 40, bhop: 55, airborne: 25, boosted: 30,
  flick_hs: 45, flick: 30, long_range: 25, wallbang: 30, airshot: 35, collateral: 40,
  smoke_streak: 20, blind_streak: 25, rng: 60, off_height: 55, outnumbered: 35,
  bhop_run: 40, fast: 15, long_chain: 25, edgebug: 55, jumpbug: 45, into_kill: 45,
};
const SNIPERS = new Set(["awp", "ssg08", "scar20", "g3sg1"]);
const WBASE = { awp: .95, ssg08: .92, scar20: .85, g3sg1: .85, ak47: .72, m4a1: .75, m4a1_silencer: .78, sg556: .7, aug: .74, famas: .66, galilar: .64,
  deagle: .6, revolver: .55, glock: .66, hkp2000: .7, usp_silencer: .72, p250: .68, tec9: .62, cz75a: .6, fiveseven: .7, elite: .58,
  mp9: .66, mac10: .6, mp7: .66, ump45: .66, p90: .64, bizon: .62, mp5sd: .68, nova: .5, xm1014: .48, mag7: .5, sawedoff: .45, m249: .55, negev: .5 };

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
  const tickrate = raw.tickrate, rounds = raw.score.rounds;
  const prerollTicks = Math.round(tickrate * cfg.prerollSec);
  const postTicks = Math.round(tickrate * cfg.postSec);
  const previewStep = raw.previewStep || Math.max(1, Math.round(tickrate / (cfg.previewFps || 32)));
  const gapTicks = Math.round((cfg.multikillGapSec ?? 8) * tickrate);

  function sliceFrames(a, b) {
    const out = [];
    for (const f of raw.timeline) {
      if (f.t < a || f.t > b) continue;
      out.push({ tick: f.t, players: f.p.map((q) => ({ uid: q[0], x: q[1], y: q[2], yaw: q[3], team: q[4], name: (raw.roster[q[0]] || {}).name || "" })) });
    }
    return out;
  }
  function trickTags(k, roundTotal) {
    const t = k.telemetry, tags = [];
    if (k.noscope && t.airborneAtKill) tags.push("jump_noscope"); else if (k.noscope) tags.push("noscope");
    if (t.airborneAtKill && t.speedAtKill >= cfg.bhopMinSpeed) tags.push("bhop");
    else if (t.airborneAtKill && t.maxAirStreakTicks >= Math.round(tickrate * 0.35)) tags.push("airborne");
    if (t.maxVz >= cfg.boostVz && t.airborneAtKill) tags.push("boosted");
    if (t.flickDeg >= cfg.flickMinDeg) tags.push(k.headshot ? "flick_hs" : "flick");
    const scopedSniper = SNIPERS.has(k.weapon) && !k.noscope;
    if (k.distM != null && k.distM >= cfg.longRangeM && !scopedSniper) tags.push("long_range");
    if (k.penetrated > 0) tags.push("wallbang");
    if (k.airshot) tags.push("airshot");
    if (k.smoke && roundTotal >= cfg.streakForSmokeBlind) tags.push("smoke_streak");
    if (k.blind && roundTotal >= cfg.streakForSmokeBlind) tags.push("blind_streak");
    const single = k.shotsBeforeKill <= 1;
    if (k.hitChance != null && k.hitChance <= cfg.rngMaxChance && single) tags.push("rng");
    if (t.airborneAtKill && t.vzAtKill < -180 && (k.noscope || single)) tags.push("off_height");
    k._nearby = (k.enemyDists || []).filter((d) => d <= cfg.nearbyRadius).length;
    if (k._nearby >= 3 && k.teamAlive <= k.enemyAliveAfter) tags.push("outnumbered");
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
    return {
      id: hid++, round: first.round, attacker: first.attacker, tags, coolScore: Math.round(score), clutchX: extra.clutchX || null,
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
      const x = solo[0].enemyAliveAfter + 1; const tagSet = new Set(["clutch"]); const m = multiTag(solo.length); if (m) tagSet.add(m);
      for (const k of solo) { for (const t of k._tags) tagSet.add(t); used.add(k); }
      highlights.push(makeHighlight(solo, [...tagSet], { clutchX: x }));
    }
    const rest = grp.filter((k) => !used.has(k));
    let burst = [];
    const flush = () => { if (burst.length >= 3) { const tagSet = new Set([multiTag(burst.length)]); for (const k of burst) { for (const t of k._tags) tagSet.add(t); used.add(k); } highlights.push(makeHighlight(burst.slice(), [...tagSet])); } burst = []; };
    for (const k of rest) { if (burst.length && k.killTick - burst[burst.length - 1].killTick > gapTicks) flush(); burst.push(k); }
    flush();
    const byTick = new Map();
    for (const k of grp) { if (used.has(k)) continue; if (!byTick.has(k.killTick)) byTick.set(k.killTick, []); byTick.get(k.killTick).push(k); }
    for (const [, arr] of byTick) if (arr.length >= 2 && arr.some((k) => k.penetrated > 0)) { const tagSet = new Set(["collateral"]); for (const k of arr) { for (const t of k._tags) tagSet.add(t); used.add(k); } highlights.push(makeHighlight(arr, [...tagSet])); }
    for (const k of grp) { if (used.has(k)) continue; if (k._tags.length) highlights.push(makeHighlight([k], k._tags)); }
  }

  // movement (bhop) runs — apply the tunable thresholds here
  for (const run of raw.movementRuns) {
    if (run.jumps < cfg.runMinJumps || run.maxSpeed < cfg.runMinPeak || run.airPct < cfg.runMinAir) continue;
    const tags = ["bhop_run"]; if (run.maxSpeed >= 400) tags.push("fast"); if (run.jumps >= 12) tags.push("long_chain");
    let score = 0; for (const t of tags) score += W[t] || 10;
    score += Math.round(Math.min(run.maxSpeed, 500) - 250 + run.jumps * 6 + run.durSec * 2);
    highlights.push({ id: hid++, type: "movement", round: 0, attacker: { name: run.name, steamId: run.steamId, team: run.team, uid: run.uid },
      tags, coolScore: score, clutchX: null, watchTick: Math.max(0, run.startTick - prerollTicks), killTick: run.startTick, endTick: run.endTick,
      movement: { maxSpeed: run.maxSpeed, avgSpeed: run.avgSpeed, jumps: run.jumps, airPct: run.airPct, distUnits: run.distUnits, durSec: run.durSec }, kills: [] });
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
