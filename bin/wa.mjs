#!/usr/bin/env node
// `wa` — command-line control for a WorkAdventure presence.
//
// Talks to the local daemon (src/wa-daemon.mjs) over HTTP and starts it on
// demand. Run `wa` with no args for the command list.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, configToEnv } from "../src/config.mjs";

const DAEMON = fileURLToPath(new URL("../src/wa-daemon.mjs", import.meta.url));
const INFO_FILES = [
  path.join(os.tmpdir(), "wa-daemon.json"),
  path.join(os.homedir(), ".workadventurer", "daemon.json"),
];

const USAGE = `wa — WorkAdventure presence control

  wa join [--detach] [--follow <player>] [--room U] [--name N] [--port P]
  wa leave
  wa status [--json]
  wa goto <x> <y>
  wa to <player>              walk next to a player (no follow)
  wa follow <player>          follow a player continuously
  wa unfollow
  wa quiet                    step away to the nearest empty area (pauses follow)
  wa resume                   walk back and resume following
  wa greet <player>           walk over + "hi" speech bubble
  wa speech-bubble <text…>
  wa thought-bubble <text…>
  wa clear-bubble             dismiss whatever bubble is showing
  wa sound <name|file>        play a clip into the proximity voice chat
  wa wait-emote [player]      block until a player emotes  [--emote <match>] [--timeout <ms>]

  global: --json  --if-running (no-op if the daemon isn't up)  --port <P>
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    "if-running": { type: "boolean", default: false },
    detach: { type: "boolean", default: false },
    follow: { type: "string" },
    port: { type: "string" },
    room: { type: "string" },
    name: { type: "string" },
    emote: { type: "string" },
    timeout: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const [cmd, ...args] = positionals;
if (!cmd || flags.help) {
  process.stdout.write(USAGE);
  process.exit(cmd ? 0 : 2);
}

const cfg = resolveConfig({ port: flags.port, roomUrl: flags.room, name: flags.name });
const die = (msg, code = 1) => { process.stderr.write(`wa: ${msg}\n`); process.exit(code); };
const note = (msg) => { if (!flags.json) process.stderr.write(`wa: ${msg}\n`); };

function readInfoPort() {
  for (const f of INFO_FILES) {
    try {
      const p = Number(JSON.parse(fs.readFileSync(f, "utf8")).port);
      if (p) return p;
    } catch {}
  }
  return null;
}

const PORT = Number(flags.port) || readInfoPort() || cfg.port;
const base = `http://127.0.0.1:${PORT}`;

async function api(method, route, body, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base + route, {
      method,
      signal: ac.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    if (e.name === "AbortError") die(`daemon didn't respond within ${timeoutMs}ms (${route})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function daemonReachable() {
  try {
    const r = await api("GET", "/state", null, { timeoutMs: 600 });
    return r.ok;
  } catch {
    return false;
  }
}

export const DAEMON_LOG = path.join(os.homedir(), ".workadventurer", "daemon.log");

function spawnDaemon({ detached }) {
  const env = { ...process.env, ...configToEnv(cfg) };
  if (flags.follow) env.WA_FOLLOW = flags.follow;
  if (detached) {
    fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });
    const out = fs.openSync(DAEMON_LOG, "a");
    const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: ["ignore", out, out], env });
    child.unref();
    return null;
  }
  return spawn(process.execPath, [DAEMON], { stdio: "inherit", env });
}

async function waitForDaemon(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await daemonReachable()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function prettyStatus(s) {
  const L = [];
  L.push(`${s.name}  @ (${s.pos.x},${s.pos.y})${s.facing ? ` facing ${s.facing}` : ""}${s.area ? `  in ${s.area}` : ""}${s.connected ? "" : s.reconnecting ? "  [reconnecting]" : "  [disconnected]"}`);
  if (s.areas && s.areas.length) {
    L.push("in areas: " + s.areas.map((a) => `${a.name}${a.props.length ? ` [${a.props.join(", ")}]` : ""}`).join("; "));
  }
  if (s.following) {
    L.push(`following ${s.following.name}${s.following.paused ? " (paused — quiet)" : ""}` +
      (s.following.pos ? `  they're at (${s.following.pos.x},${s.following.pos.y})${s.following.area ? ` in ${s.following.area}` : ""}` : "  (not visible)"));
  } else {
    L.push("following nobody");
  }
  if (s.players.length) {
    L.push("visible players:");
    for (const p of s.players) L.push(`  ${p.name}  (${p.pos.x},${p.pos.y})${p.area ? `  ${p.area}` : ""}`);
  } else {
    L.push("no other players visible");
  }
  return L.join("\n");
}

function report(json) {
  if (flags.json) { process.stdout.write(JSON.stringify(json, null, 2) + "\n"); return; }
  if (json.raw) { process.stdout.write(String(json.raw).trim() + "\n"); return; }
  const bits = [];
  for (const k of ["following", "goingTo", "quietSpot", "greeted", "speechBubble", "thoughtBubble", "sound", "nothingToResume", "alreadyQuiet", "alreadyFollowing", "leaving"]) {
    if (json[k] !== undefined && json[k] !== null && json[k] !== false) bits.push(`${k}: ${typeof json[k] === "object" ? JSON.stringify(json[k]) : json[k]}`);
  }
  process.stdout.write((bits.length ? bits.join(", ") : "ok") + "\n");
}

// ---- commands -------------------------------------------------------------

async function needDaemon() {
  if (await daemonReachable()) return true;
  if (flags["if-running"]) process.exit(0); // silent no-op — the hook path
  note("daemon not running — starting it…");
  spawnDaemon({ detached: true });
  if (!(await waitForDaemon())) die("daemon did not come up in time");
  return true;
}

switch (cmd) {
  case "join": {
    if (await daemonReachable()) {
      if (flags.follow) { report((await api("POST", "/follow", { player: flags.follow })).json); }
      else note("already joined");
      process.exit(0);
    }
    if (flags.detach) {
      spawnDaemon({ detached: true });
      if (!(await waitForDaemon())) die("daemon did not come up in time");
      const s = (await api("GET", "/state")).json;
      process.stdout.write(flags.json ? JSON.stringify(s, null, 2) + "\n" : `joined as ${s.name}\n`);
    } else {
      const child = spawnDaemon({ detached: false });
      child.on("exit", (code) => process.exit(code ?? 0));
    }
    break;
  }
  case "leave": {
    if (!(await daemonReachable())) { note("not joined"); process.exit(0); }
    report((await api("POST", "/leave")).json);
    break;
  }
  case "status": {
    if (!(await daemonReachable())) {
      if (flags["if-running"]) process.exit(0);
      die("not joined (run `wa join`)");
    }
    const s = (await api("GET", "/state")).json;
    process.stdout.write((flags.json ? JSON.stringify(s, null, 2) : prettyStatus(s)) + "\n");
    break;
  }
  case "goto": {
    const [x, y] = args.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) die("usage: wa goto <x> <y>", 2);
    await needDaemon();
    report((await api("POST", "/goto", { x, y })).json);
    break;
  }
  case "to": {
    if (!args[0]) die("usage: wa to <player>", 2);
    await needDaemon();
    const r = await api("POST", "/goto", { player: args.join(" ") });
    if (!r.ok) die(r.json.error || `to failed (${r.status})`);
    report(r.json);
    break;
  }
  case "follow": {
    if (!args[0]) die("usage: wa follow <player>", 2);
    await needDaemon();
    const r = await api("POST", "/follow", { player: args.join(" ") });
    if (!r.ok) die(r.json.error || `follow failed (${r.status})`);
    report(r.json);
    break;
  }
  case "unfollow":
    await needDaemon();
    report((await api("POST", "/unfollow")).json);
    break;
  case "quiet":
    await needDaemon();
    report((await api("POST", "/quiet")).json);
    break;
  case "resume": {
    await needDaemon();
    const r = (await api("POST", "/resume")).json;
    if (r.nothingToResume) { note("nothing to resume"); process.exit(0); }
    report(r);
    break;
  }
  case "greet": {
    if (!args[0]) die("usage: wa greet <player>", 2);
    await needDaemon();
    const r = await api("POST", "/greet", { player: args.join(" ") });
    if (!r.ok) die(r.json.error || `greet failed (${r.status})`);
    report(r.json);
    break;
  }
  case "speech-bubble":
  case "thought-bubble": {
    const text = args.join(" ").trim();
    if (!text) die(`usage: wa ${cmd} <text>`, 2);
    await needDaemon();
    report((await api("POST", `/${cmd}`, { text })).json);
    break;
  }
  case "clear-bubble": {
    await needDaemon();
    report((await api("POST", "/clear-bubble", {})).json);
    break;
  }
  case "sound": {
    if (!args[0]) die("usage: wa sound <name|file>", 2);
    await needDaemon();
    const r = await api("POST", "/sound", { name: args.join(" "), cwd: process.cwd() });
    if (!r.ok) die(r.json.error || `sound failed (${r.status})`);
    report(r.json);
    break;
  }
  case "wait-emote": {
    await needDaemon();
    const timeoutMs = Number(flags.timeout) || 300_000;
    const r = await api(
      "POST",
      "/wait-emote",
      { player: args.join(" ") || undefined, emote: flags.emote, timeoutMs },
      { timeoutMs: timeoutMs + 5000 }
    );
    if (r.json.timedOut) die("timeout", 1);
    if (flags.json) { process.stdout.write(JSON.stringify(r.json, null, 2) + "\n"); break; }
    process.stdout.write(`${r.json.name || r.json.userId} emoted ${JSON.stringify(r.json.emote)}\n`);
    break;
  }
  default:
    die(`unknown command "${cmd}"\n\n${USAGE}`, 2);
}
