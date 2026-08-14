// 3D preview — draws the real map geometry (stripped out of the .bsp by bspgeo.js)
// with the demo's players, aim, tracers and utility on top. WebGL2, no dependencies.
//
// The geometry arrives as a triangle soup: int16 world positions + one material byte
// per triangle. Normals are derived in the fragment shader (dFdx/dFdy), so flat
// brush faces shade correctly without shipping normals.
(function () {
  "use strict";

  // material palette — index matches MAT in bspgeo.js
  const PALETTE = [
    [0.62, 0.62, 0.63], // 0 default / concrete
    [0.68, 0.42, 0.32], // 1 brick
    [0.60, 0.44, 0.27], // 2 wood
    [0.55, 0.58, 0.63], // 3 metal
    [0.80, 0.70, 0.48], // 4 sand / dirt
    [0.42, 0.55, 0.32], // 5 grass
    [0.25, 0.45, 0.62], // 6 water
    [0.55, 0.72, 0.80], // 7 glass
    [0.58, 0.55, 0.50], // 8 rock
    [0.70, 0.68, 0.64], // 9 tile
    [0.76, 0.72, 0.64], // 10 plaster
    [0.52, 0.40, 0.40], // 11 fabric
    [0.86, 0.89, 0.93], // 12 snow
  ];
  const FOG = [0.055, 0.07, 0.086];
  const PAL = (() => { const a = new Float32Array(16 * 3); PALETTE.forEach((c, i) => a.set(c, i * 3)); return a; })();

  const MAP_VS = `#version 300 es
in vec3 aPos; in float aMat;
uniform mat4 uMVP;
out vec3 vW; flat out int vMat;
void main() { vW = aPos; vMat = int(aMat + 0.5); gl_Position = uMVP * vec4(aPos, 1.0); }`;

  const MAP_FS = `#version 300 es
precision highp float;
in vec3 vW; flat in int vMat;
uniform vec3 uPal[16];
uniform vec3 uCam, uFog;
uniform float uClipZ, uFogNear, uFogFar;
out vec4 o;
void main() {
  if (vW.z > uClipZ) discard;
  vec3 toCam = uCam - vW;
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (dot(n, toCam) < 0.0) n = -n;
  vec3 L = normalize(vec3(0.35, 0.42, 0.84));
  float lam = 0.32 + 0.68 * max(dot(n, L), 0.0);
  // gentle per-64u break-up so big flat brushes still read as surfaces
  float h = fract(sin(dot(floor(vW * 0.0625), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  vec3 c = uPal[vMat] * (lam * (0.93 + 0.14 * h));
  float fog = clamp((length(toCam) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  o = vec4(mix(c, uFog, fog * 0.9), 1.0);
}`;

  // one dynamic buffer for every player/weapon triangle in the frame: the models are
  // built on the CPU (a few hundred triangles), so the whole cast is a single draw call
  const MESH_VS = `#version 300 es
in vec3 aPos; in vec3 aCol;
uniform mat4 uMVP;
out vec3 vW; flat out vec3 vCol;
void main() { vW = aPos; vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;

  const MESH_FS = `#version 300 es
precision highp float;
in vec3 vW; flat in vec3 vCol;
uniform vec3 uCam;
out vec4 o;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (dot(n, uCam - vW) < 0.0) n = -n;
  float lam = 0.42 + 0.58 * max(dot(n, normalize(vec3(0.35, 0.42, 0.84))), 0.0);
  o = vec4(vCol * lam, 1.0);
}`;

  const LINE_VS = `#version 300 es
in vec3 aPos; in vec4 aCol;
uniform mat4 uMVP;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;

  const LINE_FS = `#version 300 es
precision highp float;
in vec4 vCol; out vec4 o;
void main() { o = vCol; }`;

  const SPRITE_VS = `#version 300 es
in vec3 aPos; in vec2 aUV; in vec4 aCol;
uniform mat4 uMVP;
out vec2 vUV; out vec4 vCol;
void main() { vUV = aUV; vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;

  const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec4 vCol; out vec4 o;
void main() {
  float d = length(vUV);
  if (d > 1.0) discard;
  o = vec4(vCol.rgb, vCol.a * smoothstep(1.0, 0.35, d));
}`;

  // ---------------------------------------------------------------- math
  const m4 = {
    // a * b, both column-major
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    lookAt(eye, at, up) {
      let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
      ]);
    },
    trs(x, y, z, yawDeg, sx, sy, sz) {
      const r = yawDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      return new Float32Array([c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
    },
    project(mvp, x, y, z) {
      const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (w <= 0.0001) return null;
      return [
        (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w,
        (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w,
      ];
    },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const dirFrom = (yawDeg, pitchDeg) => {
    const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180, cp = Math.cos(p);
    return [Math.cos(y) * cp, Math.sin(y) * cp, Math.sin(p)];
  };

  // ---------------------------------------------------------------- state
  const S = {
    gl: null, canvas: null, overlay: null, ovx: null, ready: false, err: null,
    prog: {}, vao: {}, buf: {}, geo: null, mapName: null, tris: 0,
    view: null, mode: "chase", roofs: false, names: true,
    orbit: { yaw: 0, pitch: 26, dist: 340 }, drag: null,
    cam: { eye: null, tgt: null, pitch: 0 }, mvp: null, lastIdx: 0,
    phase: {}, deaths: {},
  };

  function compile(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh); gl.deleteShader(sh);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
    // cache uniform + attribute locations once (they never change)
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const nm = info.name.replace(/\[0\]$/, ""); u[nm] = gl.getUniformLocation(p, nm); }
    const a = {};
    const an = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < an; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
    return { p, u, a };
  }

  function init(canvas, overlay) {
    if (S.gl) return true;
    S.canvas = canvas; S.overlay = overlay; S.ovx = overlay ? overlay.getContext("2d") : null;
    const gl = canvas.getContext("webgl2", { antialias: true, depth: true, alpha: false, powerPreference: "high-performance" });
    if (!gl) { S.err = "WebGL2 not available"; return false; }
    S.gl = gl;
    try {
      S.prog.map = compile(gl, MAP_VS, MAP_FS);
      S.prog.mesh = compile(gl, MESH_VS, MESH_FS);
      S.prog.line = compile(gl, LINE_VS, LINE_FS);
      S.prog.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    } catch (e) { S.err = e.message; S.gl = null; return false; }

    S.buf.mesh = gl.createBuffer();
    S.buf.line = gl.createBuffer();
    S.buf.sprite = gl.createBuffer();

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
    wireInput(canvas);
    return true;
  }

  function wireInput(canvas) {
    canvas.addEventListener("mousedown", (e) => { S.drag = { x: e.clientX, y: e.clientY }; canvas.style.cursor = "grabbing"; });
    window.addEventListener("mouseup", () => { S.drag = null; if (S.canvas) S.canvas.style.cursor = "grab"; });
    window.addEventListener("mousemove", (e) => {
      if (!S.drag) return;
      S.orbit.yaw -= (e.clientX - S.drag.x) * 0.35;
      S.orbit.pitch = Math.max(-80, Math.min(85, S.orbit.pitch + (e.clientY - S.drag.y) * 0.28));
      S.drag = { x: e.clientX, y: e.clientY };
      if (S.mode === "pov") S.mode = "chase";
      redraw();
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      S.orbit.dist = Math.max(60, Math.min(9000, S.orbit.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      redraw();
    }, { passive: false });
    canvas.addEventListener("dblclick", () => { S.orbit.yaw = 0; S.orbit.pitch = 26; S.orbit.dist = 340; redraw(); });
    canvas.style.cursor = "grab";
  }

  function redraw() { if (S.ready && S.view) draw(S.lastIdx); }

  // ---------------------------------------------------------------- geometry
  function parseGeo(u8) {
    const ab = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "CCG1") throw new Error("bad geometry blob");
    const tris = dv.getUint32(4, true);
    const rd = (o) => ({ minX: dv.getFloat32(o, true), minY: dv.getFloat32(o + 4, true), minZ: dv.getFloat32(o + 8, true), maxX: dv.getFloat32(o + 12, true), maxY: dv.getFloat32(o + 16, true), maxZ: dv.getFloat32(o + 20, true) });
    return { tris, bounds: rd(8), play: rd(32), pos: new Int16Array(ab, 64, tris * 9), mat: new Uint8Array(ab, 64 + tris * 18, tris) };
  }

  function upload(geo) {
    const gl = S.gl;
    if (S.buf.pos) gl.deleteBuffer(S.buf.pos);
    if (S.buf.mat) gl.deleteBuffer(S.buf.mat);
    S.buf.pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.pos);
    gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.STATIC_DRAW);
    // one material byte per triangle -> expand to per-vertex
    const mv = new Uint8Array(geo.tris * 3);
    for (let i = 0; i < geo.tris; i++) { mv[i * 3] = mv[i * 3 + 1] = mv[i * 3 + 2] = geo.mat[i]; }
    S.buf.mat = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.mat);
    gl.bufferData(gl.ARRAY_BUFFER, mv, gl.STATIC_DRAW);
    S.tris = geo.tris;
    // keep the triangle positions on the CPU too, for camera-collision ray tests.
    // int16 world units, 9 per triangle (3 verts × xyz). Skip on huge maps (perf).
    S.geo = { bounds: geo.bounds, play: geo.play, tris: geo.tris, pos: geo.tris <= 120000 ? geo.pos : null };
  }

  // Loads (and caches) the stripped geometry for a map. Returns false if we have none.
  const cache = new Map();
  const usedMaps = new Map();
  async function load(mapName) {
    if (!mapName) return false;
    const key = String(mapName).toLowerCase();
    if (S.mapName === key && S.ready) return true;
    let geo = cache.get(key);
    if (geo === undefined) {
      let res = null;
      try { res = await window.api.getMapGeo(key); } catch { res = null; }
      geo = res && res.ok && res.data ? parseGeo(res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data)) : null;
      // keep at most 3 maps' geometry in memory (a big map is a few MB)
      if (cache.size > 2) cache.delete(cache.keys().next().value);
      cache.set(key, geo);
      // the .bsp may be a renamed variant of this map (CS:S versions) — remember which
      usedMaps.set(key, (res && res.usedMap) || null);
      if (res && !res.ok) S.err = res.error || "no geometry";
    }
    if (!geo) { S.ready = false; return false; }
    upload(geo);
    S.mapName = key; S.ready = true; S.err = null;
    return true;
  }

  function has(mapName) { const g = cache.get(String(mapName || "").toLowerCase()); return !!g; }
  // which .bsp the geometry actually came from, when it isn't this map's own name
  function usedMap(mapName) { return usedMaps.get(String(mapName || "").toLowerCase()) || null; }

  // ---------------------------------------------------------------- frame state
  function playerAt(idx, uid) { const f = S.view.frames[idx]; return f && f.players.find((p) => p.uid === uid); }

  const shortAngle = (a, b) => { let d = ((b - a + 540) % 360) - 180; return a + d; };

  // Positions come one per tick (64/s). Interpolating between the two nearest frames
  // lets playback run at display rate instead of stepping, and gives us a speed to
  // drive the (very crude) walk cycle.
  function frameState(idxFloat) {
    const frames = S.view.frames;
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(idxFloat)));
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, idxFloat - i0));
    const f0 = frames[i0], f1 = frames[i1];
    const tick = Math.round(lerp(f0.tick, f1.tick, t));
    const dt = Math.max(1, (f1.tick - f0.tick)) / (S.view.tickrate || 64);
    const players = [];
    // Iterate the DESTINATION frame: only players still sampled at f1 are alive there.
    // A player present in f0 but gone from f1 has died/left, so they must NOT be drawn
    // (otherwise a corpse lingers frozen at the death spot — the "dead people shown" bug).
    for (const b of f1.players) {
      const a = f0.players.find((q) => q.uid === b.uid) || b;
      const x = lerp(a.x, b.x, t), y = lerp(a.y, b.y, t);
      const z = a.z == null || b.z == null ? (a.z != null ? a.z : b.z) : lerp(a.z, b.z, t);
      const yaw = a.yaw == null ? b.yaw : lerp(a.yaw, shortAngle(a.yaw, b.yaw == null ? a.yaw : b.yaw), t);
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
      // walk phase advances with distance travelled, so it never slides
      const phase = (S.phase[b.uid] = ((S.phase[b.uid] || 0) + speed * dt * t * 0.012) % 1);
      players.push({ uid: b.uid, name: b.name, team: b.team, x, y, z, yaw,
        step: phase, swing: Math.min(1, speed / 250) });
    }
    return { tick, players };
  }

  // the weapon used by the kill nearest this tick — picks the model (gun vs the knife)
  function currentWeapon(tick) {
    let best = null, bd = Infinity;
    for (const k of (S.view.kills || [])) {
      const d = Math.abs(tick - k.killTick);
      if (d < bd) { bd = d; best = k; }
    }
    return best ? best.weapon : null;
  }

  function deathTick(uid) { return S.deaths[uid] != null ? S.deaths[uid] : null; }

  // victims are named in the kill list but the frames are keyed by uid — resolve once
  function mapDeaths(view) {
    const byName = {};
    for (const f of view.frames) for (const p of f.players) if (p.name) byName[p.name] = p.uid;
    const out = {};
    for (const k of (view.kills || [])) {
      if (!k.victim) continue;
      const uid = k.victim.uid != null ? k.victim.uid : byName[k.victim.name];
      if (uid != null && (out[uid] == null || k.killTick < out[uid])) out[uid] = k.killTick;
    }
    return out;
  }

  // ---------------------------------------------------------------- camera
  function focusPoint(idx) {
    const f = S.view.frames[idx];
    const p = playerAt(idx, S.view.attackerUid);
    if (p) return [p.x, p.y, p.z == null ? groundGuess() : p.z];
    if (f && f.players.length) {
      let x = 0, y = 0, z = 0;
      for (const q of f.players) { x += q.x; y += q.y; z += q.z || 0; }
      return [x / f.players.length, y / f.players.length, z / f.players.length];
    }
    const b = S.geo.play;
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
  }
  function groundGuess() { const b = S.geo.play; return (b.minZ + b.maxZ) / 2; }

  // Camera collision: shoot a ray from the player (tgt) toward the desired eye and, if a
  // wall/ceiling is in the way, pull the eye in to just before it — so the chase/orbit cam
  // never ends up buried inside geometry. One ray per frame over the triangle soup
  // (Möller–Trumbore); returns the eye to actually use.
  function collideEye(tgt, eye) {
    const P = S.geo && S.geo.pos;
    if (!P) return eye;
    let dx = eye[0] - tgt[0], dy = eye[1] - tgt[1], dz = eye[2] - tgt[2];
    const want = Math.hypot(dx, dy, dz);
    if (want < 1e-3) return eye;
    dx /= want; dy /= want; dz /= want;
    const ox = tgt[0], oy = tgt[1], oz = tgt[2];
    let nearest = want;
    const EPS = 1e-6;
    for (let i = 0, n = P.length; i < n; i += 9) {
      const ax = P[i], ay = P[i + 1], az = P[i + 2];
      const e1x = P[i + 3] - ax, e1y = P[i + 4] - ay, e1z = P[i + 5] - az;
      const e2x = P[i + 6] - ax, e2y = P[i + 7] - ay, e2z = P[i + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -EPS && det < EPS) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 8 && t < nearest) nearest = t; // t>8: ignore the player's own footprint
    }
    if (nearest >= want) return eye;
    const d = Math.max(45, nearest - 16); // 16u skin so we sit just off the surface, 45u min
    return [ox + dx * d, oy + dy * d, oz + dz * d];
  }

  // aim pitch during a kill: point the POV cam at what was shot
  function aimPitch(idx, tick, p) {
    const kills = S.view.kills || [];
    let best = null, bd = Infinity;
    for (const k of kills) {
      const d = Math.abs(tick - k.killTick);
      if (d < bd && d <= S.view.tickrate * 1.5 && k.shot && k.shot.to) { bd = d; best = k; }
    }
    if (!best || !p) return 0;
    const t = best.shot.to;
    const dz = (t.z != null ? t.z : (p.z || 0) + 48) - ((p.z || 0) + 60);
    const dh = Math.hypot(t.x - p.x, t.y - p.y);
    return Math.max(-60, Math.min(60, Math.atan2(dz, Math.max(dh, 1)) * 180 / Math.PI));
  }

  function camera(idx, aspect, st) {
    const tick = st.tick;
    const p = st.players.find((q) => q.uid === S.view.attackerUid);
    const fp = p ? [p.x, p.y, p.z == null ? groundGuess() : p.z] : focusPoint(Math.floor(idx));
    const yaw = p && p.yaw != null ? p.yaw : 90;
    let eye, tgt, fov = 70;

    if (S.mode === "pov") {
      const pitch = aimPitch(idx, tick, p);
      S.cam.pitch = S.cam.pitch == null ? pitch : lerp(S.cam.pitch, pitch, 0.25);
      const d = dirFrom(yaw, S.cam.pitch);
      eye = [fp[0], fp[1], fp[2] + 62];
      tgt = [eye[0] + d[0] * 200, eye[1] + d[1] * 200, eye[2] + d[2] * 200];
      fov = 90;
    } else if (S.mode === "top") {
      const d = S.orbit.dist * 3;
      tgt = [fp[0], fp[1], fp[2] + 40];
      eye = [fp[0], fp[1] - 0.001, fp[2] + 40 + d];
      fov = 60;
    } else {
      // chase (follows the player's yaw) / orbit (fixed world yaw), both draggable
      const base = S.mode === "orbit" ? 90 : yaw + 180;
      const d = dirFrom(base + S.orbit.yaw, S.orbit.pitch);
      tgt = [fp[0], fp[1], fp[2] + 50];
      eye = [tgt[0] + d[0] * S.orbit.dist, tgt[1] + d[1] * S.orbit.dist, tgt[2] + d[2] * S.orbit.dist];
    }
    // keep the chase/orbit camera out of walls (POV is the eye itself; top-down relies on
    // the roof cut and wants to stay high, so neither of those collides)
    if (S.mode === "chase" || S.mode === "orbit") eye = collideEye(tgt, eye);
    // smooth so the camera doesn't jitter with per-tick positions
    if (S.cam.eye && Math.abs(idx - S.cam.frame) < 3) {
      const k = 0.35;
      eye = eye.map((v, i) => lerp(S.cam.eye[i], v, k));
      tgt = tgt.map((v, i) => lerp(S.cam.tgt[i], v, k));
    }
    S.cam.eye = eye; S.cam.tgt = tgt; S.cam.frame = idx;

    const proj = m4.perspective(fov * Math.PI / 180, aspect, 4, 24000);
    return { mvp: m4.mul(proj, m4.lookAt(eye, tgt, [0, 0, 1])), eye, tgt, focus: fp };
  }

  // ---------------------------------------------------------------- drawing
  function sizeCanvas() {
    const gl = S.gl, c = S.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.round(c.clientWidth * dpr)), h = Math.max(64, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (S.overlay && (S.overlay.width !== c.clientWidth || S.overlay.height !== c.clientHeight)) {
      S.overlay.width = Math.max(1, c.clientWidth); S.overlay.height = Math.max(1, c.clientHeight);
    }
    gl.viewport(0, 0, w, h);
    return w / h;
  }

  function drawMap(mvp, eye, clipZ) {
    const gl = S.gl, pr = S.prog.map;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uMVP, false, mvp);
    gl.uniform3fv(pr.u.uCam, eye);
    gl.uniform3fv(pr.u.uFog, FOG);
    gl.uniform1f(pr.u.uClipZ, clipZ);
    gl.uniform1f(pr.u.uFogNear, 1200);
    gl.uniform1f(pr.u.uFogFar, 7000);
    gl.uniform3fv(pr.u.uPal, PAL);
    const aPos = pr.a.aPos, aMat = pr.a.aMat;
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.pos);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.mat);
    gl.enableVertexAttribArray(aMat);
    gl.vertexAttribPointer(aMat, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, S.tris * 3);
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aMat);
  }

  // ---------------------------------------------------------------- crude models
  // Everything is built from boxes at runtime — no model files, no textures, nothing
  // added to the app's size. Deliberately blocky: enough to read who is where, which
  // way they face, what they're holding and who just fell over.
  const BOX = (() => {
    // unit box corners, then 6 quads as triangle pairs (local space: x fwd, y left, z up)
    const P = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]];
    const q = [[4, 5, 6, 7], [1, 0, 3, 2], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const out = [];
    for (const [a, b, c, d] of q) out.push(P[a], P[b], P[c], P[a], P[c], P[d]);
    return out;
  })();

  // A player-local frame: origin at the feet, +x along the view yaw, tipped over by
  // `tip` degrees (used when someone dies) around their own right axis.
  function limbFrame(px, py, pz, yawDeg, tipDeg) {
    const y = yawDeg * Math.PI / 180, cy = Math.cos(y), sy = Math.sin(y);
    const t = tipDeg * Math.PI / 180, ct = Math.cos(t), st = Math.sin(t);
    return (lx, ly, lz) => {
      // tip rotates in the forward/up plane
      const fx = lx * ct + lz * st, fz = -lx * st + lz * ct;
      return [px + fx * cy - ly * sy, py + fx * sy + ly * cy, pz + fz];
    };
  }

  function pushBox(out, f, cx, cy, cz, sx, sy, sz, col) {
    for (const p of BOX) {
      const w = f(cx + p[0] * sx, cy + p[1] * sy, cz + p[2] * sz);
      out.push(w[0], w[1], w[2], col[0], col[1], col[2]);
    }
  }

  const SKIN = [0.76, 0.62, 0.48], GUN = [0.16, 0.16, 0.18], BLADE = [0.82, 0.85, 0.9];
  const KNIVES = /knife|bayonet|karambit|daggers/i;

  // step is a 0..1 walk phase, swing scales with speed
  function buildPlayer(out, x, y, z, yaw, col, step, swing, tip, weapon, dead) {
    const f = limbFrame(x, y, z, yaw, tip);
    const s = Math.sin(step * Math.PI * 2) * swing;
    const dark = [col[0] * 0.72, col[1] * 0.72, col[2] * 0.72];
    // legs (swing fore/aft), hips, torso, head
    pushBox(out, f, s * 6, -5, 18, 7, 7, 36, dark);
    pushBox(out, f, -s * 6, 5, 18, 7, 7, 36, dark);
    pushBox(out, f, 0, 0, 40, 15, 17, 10, dark);
    pushBox(out, f, 0, 0, 54, 16, 18, 22, col);
    pushBox(out, f, 2, 0, 70, 10, 10, 10, SKIN);
    // arms out front holding the weapon
    pushBox(out, f, 8, -8, 58, 20, 5, 5, col);
    pushBox(out, f, 8, 8, 58, 20, 5, 5, col);
    if (dead) return;
    if (KNIVES.test(weapon || "")) {
      pushBox(out, f, 20, -8, 58, 4, 3, 3, GUN);
      pushBox(out, f, 30, -8, 58, 16, 1.5, 4, BLADE); // the one and only knife
    } else {
      pushBox(out, f, 22, 0, 57, 16, 4, 7, GUN);      // receiver
      pushBox(out, f, 36, 0, 58, 18, 2.5, 2.5, GUN);  // barrel
      pushBox(out, f, 18, 0, 51, 5, 3, 8, GUN);       // magazine
    }
  }

  // where the muzzle of that gun ends up, for the flash + tracer origin
  function muzzle(x, y, z, yaw) {
    const f = limbFrame(x, y, z, yaw, 0);
    return f(48, 0, 58);
  }

  function drawMesh(mvp, eye, verts) {
    if (!verts.length) return;
    const gl = S.gl, pr = S.prog.mesh;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uMVP, false, mvp);
    gl.uniform3fv(pr.u.uCam, eye);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.mesh);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(pr.a.aPos); gl.vertexAttribPointer(pr.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(pr.a.aCol); gl.vertexAttribPointer(pr.a.aCol, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 6);
    gl.disableVertexAttribArray(pr.a.aPos); gl.disableVertexAttribArray(pr.a.aCol);
  }

  function drawLines(mvp, verts) {
    if (!verts.length) return;
    const gl = S.gl, pr = S.prog.line;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uMVP, false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.line);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    const aPos = pr.a.aPos, aCol = pr.a.aCol;
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 28, 12);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, verts.length / 7);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aCol);
  }

  function drawSprites(mvp, eye, tgt, sprites) {
    if (!sprites.length) return;
    const gl = S.gl, pr = S.prog.sprite;
    // camera-facing basis
    let fx = tgt[0] - eye[0], fy = tgt[1] - eye[1], fz = tgt[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let rx = fy, ry = -fx, rz = 0;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    const v = [];
    for (const s of sprites) {
      const r = s.r;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const [cu, cv] of corners) {
        v.push(s.x + (rx * cu + ux * cv) * r, s.y + (ry * cu + uy * cv) * r, s.z + (rz * cu + uz * cv) * r, cu, cv, s.c[0], s.c[1], s.c[2], s.c[3]);
      }
    }
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uMVP, false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf.sprite);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    const aPos = pr.a.aPos, aUV = pr.a.aUV, aCol = pr.a.aCol;
    const stride = 36;
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, stride, 20);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, v.length / 9);
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aUV); gl.disableVertexAttribArray(aCol);
  }

  function draw(idx) {
    if (!S.ready || !S.view) return;
    S.lastIdx = idx;
    const gl = S.gl;
    const aspect = sizeCanvas();
    const st = frameState(idx);
    const cam = camera(idx, aspect, st);
    const tick = st.tick;
    const solo = S.view.solo;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const clipZ = (S.roofs || S.mode === "pov") ? 1e9 : cam.focus[2] + 270;
    drawMap(cam.mvp, cam.eye, clipZ);

    const lines = [];
    const push = (a, b, c) => lines.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]);
    const CT = [0.36, 0.61, 0.84], T = [0.88, 0.65, 0.23], ATT = [0.95, 0.78, 0.32];
    const mesh = [], labels = [], sprites = [];
    const tr = S.view.tickrate || 64;
    const weapon = currentWeapon(tick);

    for (const p of st.players) {
      const isAtt = p.uid === S.view.attackerUid;
      if (solo && !isAtt) continue;
      if (S.view.stale && S.view.stale.has(p.uid)) continue; // stale, never-updated entity
      const z = p.z == null ? cam.focus[2] : p.z;
      // frames carry the tick each player died on; drop them once the body has settled
      // (the timeline keeps sampling corpses, which used to leave them standing around)
      const dead = p.dead != null ? p.dead : deathTick(p.uid);
      if (dead != null && tick - dead > tr * 2.5) continue;
      const tip = dead != null && tick >= dead ? Math.min(90, (tick - dead) / tr * 260) : 0;
      const firstPerson = S.mode === "pov" && isAtt;
      if (!firstPerson) {
        buildPlayer(mesh, p.x, p.y, z, p.yaw || 0, isAtt ? ATT : (p.team === 3 ? CT : T),
          p.step, p.swing, tip, isAtt ? weapon : null, tip > 60);
      }
      if (p.yaw != null && !firstPerson && tip < 45) {
        const d = dirFrom(p.yaw, 0), len = isAtt ? 300 : 110;
        push([p.x, p.y, z + 58], [p.x + d[0] * len, p.y + d[1] * len, z + 58],
          isAtt ? [1, 0.84, 0.4, 0.8] : [1, 1, 1, 0.25]);
      }
      // a thin stick to the floor helps read height when a player is above/below
      push([p.x, p.y, z], [p.x, p.y, z - 4000], isAtt ? [1, 0.84, 0.4, 0.10] : [1, 1, 1, 0.06]);
      if (S.names && p.name && tip < 60) labels.push({ x: p.x, y: p.y, z: z + 96, text: p.name.slice(0, 14), att: isAtt, team: p.team });
    }

    // movement trail
    if (S.view.isMovement) {
      let prev = null;
      for (let i = 0; i <= Math.floor(idx); i++) {
        const mp = playerAt(i, S.view.attackerUid);
        if (!mp) continue;
        const cur = [mp.x, mp.y, (mp.z == null ? cam.focus[2] : mp.z) + 8];
        if (prev) push(prev, cur, [0.85, 0.64, 0.25, 0.8]);
        prev = cur;
      }
    }

    // tracers + a muzzle flash on the shooter, so it reads as "this is the kill"
    const fade = tr * 1.2;
    const att = st.players.find((q) => q.uid === S.view.attackerUid);
    for (const k of (S.view.kills || [])) {
      const age = tick - k.killTick;
      if (age < -1 || age > fade || !k.shot || !k.shot.from || !k.shot.to) continue;
      const a = 1 - age / fade;
      let from = [k.shot.from.x, k.shot.from.y, k.shot.from.z != null ? k.shot.from.z + 56 : cam.focus[2] + 56];
      if (att) from = muzzle(att.x, att.y, att.z == null ? cam.focus[2] : att.z, att.yaw || 0);
      const tz = k.shot.to.z != null ? k.shot.to.z + 48 : cam.focus[2] + 48;
      push(from, [k.shot.to.x, k.shot.to.y, tz], [1, 0.55, 0.3, a]);
      if (age >= 0 && age < tr * 0.12) sprites.push({ x: from[0], y: from[1], z: from[2], r: 26, c: [1, 0.85, 0.45, 0.85] });
    }
    drawLines(cam.mvp, lines);
    drawMesh(cam.mvp, cam.eye, mesh);

    // utility
    for (const u of (S.view.utils || [])) {
      if (tick < u.tick || tick > u.endTick) continue;
      const life = 1 - (tick - u.tick) / Math.max(1, u.endTick - u.tick);
      const z = u.z != null ? u.z : cam.focus[2];
      if (u.kind === "smoke") sprites.push({ x: u.x, y: u.y, z: z + 60, r: 150, c: [0.82, 0.84, 0.86, 0.45] });
      else if (u.kind === "fire") sprites.push({ x: u.x, y: u.y, z: z + 30, r: 130, c: [0.95, 0.45, 0.15, 0.42] });
      else if (u.kind === "flash") sprites.push({ x: u.x, y: u.y, z: z + 50, r: 90, c: [1, 1, 1, 0.7 * life] });
      else if (u.kind === "he") sprites.push({ x: u.x, y: u.y, z: z + 40, r: 100, c: [0.95, 0.35, 0.3, 0.7 * life] });
      else if (u.kind === "decoy") sprites.push({ x: u.x, y: u.y, z: z + 30, r: 40, c: [0.7, 0.7, 0.7, 0.4] });
    }
    // sort back-to-front so the translucent blobs layer correctly
    sprites.sort((a, b) => Math.hypot(b.x - cam.eye[0], b.y - cam.eye[1], b.z - cam.eye[2]) - Math.hypot(a.x - cam.eye[0], a.y - cam.eye[1], a.z - cam.eye[2]));
    drawSprites(cam.mvp, cam.eye, cam.tgt, sprites);

    drawOverlay(cam.mvp, labels);
    S.mvp = cam.mvp;
  }

  function drawOverlay(mvp, labels) {
    const ctx = S.ovx;
    if (!ctx) return;
    const W = S.overlay.width, H = S.overlay.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    for (const l of labels) {
      const p = m4.project(mvp, l.x, l.y, l.z);
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * W, sy = (1 - (p[1] * 0.5 + 0.5)) * H;
      if (sx < -60 || sx > W + 60 || sy < -20 || sy > H + 20) continue;
      ctx.fillStyle = "rgba(6,9,12,.55)";
      const w = ctx.measureText(l.text).width + 8;
      ctx.fillRect(sx - w / 2, sy - 12, w, 14);
      ctx.fillStyle = l.att ? "#ffd766" : (l.team === 3 ? "#8fbde8" : "#e6bd5f");
      ctx.fillText(l.text, sx, sy - 1);
    }
    ctx.textAlign = "left";
    const hint = `${S.mode} · drag to orbit · wheel to zoom · dbl-click to reset${S.roofs ? "" : " · roofs cut"}`;
    ctx.fillStyle = "rgba(6,9,12,.5)";
    ctx.fillRect(4, H - 20, ctx.measureText(hint).width + 10, 16);
    ctx.fillStyle = "rgba(180,192,206,.85)";
    ctx.fillText(hint, 9, H - 8);
  }

  // ---------------------------------------------------------------- api
  function attach(view) {
    S.view = view;
    S.cam = { eye: null, tgt: null, pitch: null };
    S.phase = {};
    S.deaths = mapDeaths(view);
    S.orbit.yaw = 0;
    if (S.orbit.dist < 120 || S.orbit.dist > 1800) S.orbit.dist = 340;
  }
  window.Preview3D = {
    init, load, attach, draw, has, usedMap,
    ready: () => S.ready,
    error: () => S.err,
    mode: () => S.mode,
    setMode(m) { S.mode = m; if (m === "pov") S.orbit.yaw = 0; S.cam.eye = null; redraw(); },
    setRoofs(v) { S.roofs = !!v; redraw(); },
    setSolo(v) { if (S.view) S.view.solo = !!v; redraw(); },
    setNames(v) { S.names = !!v; redraw(); },
    bounds: () => (S.geo ? S.geo.bounds : null),
    triCount: () => S.tris,
    resize: () => redraw(),
    clearOverlay() { if (S.ovx && S.overlay) S.ovx.clearRect(0, 0, S.overlay.width, S.overlay.height); },
  };
})();
