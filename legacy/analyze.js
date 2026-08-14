#!/usr/bin/env node
// CLI harness for parser.js — prints scoreboard + ranked cool kills.
// Usage: node analyze.js "match.dem" [--json out.json]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDemo } = require("./parser");

const args = process.argv.slice(2);
if (!args[0]) { console.error('Usage: node analyze.js "match.dem[.bz2]" [--json out.json]'); process.exit(1); }
let input = args[0];
const ji = args.indexOf("--json");
const jsonOut = ji !== -1 ? args[ji + 1] : null;

if (input.toLowerCase().endsWith(".bz2")) {
  const out = input.slice(0, -4);
  if (!fs.existsSync(out)) { console.error("Extracting..."); execFileSync("bzip2", ["-dk", input]); }
  input = out;
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); };
const padl = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };

(async () => {
  console.error("Parsing " + path.basename(input) + " ...");
  const r = await parseDemo(input);
  console.log("\n============================================================");
  console.log("  Map:    " + r.header.mapName + "   (" + r.tickrate + " tick)");
  console.log("  Server: " + r.header.serverName);
  console.log("  Rounds: " + r.score.rounds + "     CT " + r.score.ct + " : " + r.score.t + " T");
  console.log("============================================================\n");
  const head = pad("PLAYER", 22) + padl("K", 4) + padl("D", 4) + padl("A", 4) + padl("HS%", 6) + padl("ADR", 6) + padl("K/D", 6) + padl("MVP", 5);
  console.log(head); console.log("-".repeat(head.length));
  for (const p of r.players) console.log(pad(p.name, 22) + padl(p.kills, 4) + padl(p.deaths, 4) + padl(p.assists, 4) + padl(p.hs + "%", 6) + padl(p.adr, 6) + padl(p.kd, 6) + padl(p.mvps, 5));

  console.log("\n===================== HIGHLIGHTS (" + r.highlights.length + ") =====================\n");
  for (const h of r.highlights.slice(0, 25)) {
    const n = h.kills.length;
    console.log(
      "R" + padl(h.round + 1, 2) + "  score " + padl(h.coolScore, 3) + "  " +
      pad(h.attacker.name, 18) + " " + (n > 1 ? n + "K" : pad(h.kills[0].weapon, 12) + " -> " + h.kills[0].victim.name) +
      "  [" + h.tags.join(",") + "]" +
      "\n        watch tick " + h.watchTick + "  (kills @ " + h.kills.map((k) => k.killTick).join(", ") + ")"
    );
  }
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(r, null, 2)); console.log("\nWrote " + jsonOut); }
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
