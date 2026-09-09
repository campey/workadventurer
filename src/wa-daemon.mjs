// Long-running WorkAdventure presence with a localhost HTTP control API.
//
// The `wa` CLI (and anything else that can POST JSON) drives the avatar through
// this; the daemon is what actually stays connected — answering pings, running
// the follow loop, reconnecting after a drop — between commands.
//
//   node src/wa-daemon.mjs                 # foreground
//   WA_DAEMON_PORT=8787 WA_NAME=claude node src/wa-daemon.mjs
//
// Control API (http://127.0.0.1:<port>, JSON bodies):
//   GET  /state                    -> { name, pos, facing, area, following:{name,paused}|null, players }
//   POST /goto           {x,y}|{player}  -> walk there (cancels any follow)
//   POST /follow         {player}        -> approach + follow continuously
//   POST /unfollow                       -> stop and forget the follow subject
//   POST /quiet                          -> step away to the nearest empty area; pause (remember) the follow
//   POST /resume                         -> walk back to the follow subject and resume
//   POST /greet          {player}        -> walk over + "hi" speech bubble (no state change)
//   POST /speech-bubble  {text}          -> speech bubble over the avatar
//   POST /thought-bubble {text}          -> thinking cloud over the avatar
//   POST /clear-bubble                   -> dismiss whatever bubble is showing
//   POST /sound          {name}          -> play a clip into the proximity voice chat
//   POST /leave                          -> disconnect and exit
//
// Advertises itself at $TMPDIR/wa-daemon.json and ~/.workadventurer/daemon.json.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkAdventureClient } from "./wa-client.mjs";
import { WaAudio } from "./wa-audio.mjs";
import { resolveConfig } from "./config.mjs";

const cfg = resolveConfig();
const PORT = cfg.port;
const QUIET_EXCLUDE = /board\s*room|podium|audience/i;

const INFO_FILES = [
  path.join(os.tmpdir(), "wa-daemon.json"),
  path.join(os.homedir(), ".workadventurer", "daemon.json"),
];

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

const SOUNDS_DIR = fileURLToPath(new URL("../sounds/", import.meta.url));

let wa;
let audio; // WaAudio, bound to the current client
let follow = null; // { name, userId, controller, paused }
let deliberateShutdown = false;
let reconnecting = false;

// Resolve a `wa sound` argument: a bare name -> sounds/<name>.ogg, otherwise a
// path (absolute, or relative to the caller's cwd passed as `cwd`).
function resolveClip(nameOrPath, cwd) {
  if (/[/\\]|\.(ogg|opus)$/i.test(nameOrPath)) {
    return path.resolve(cwd || process.cwd(), nameOrPath);
  }
  return path.join(SOUNDS_DIR, `${nameOrPath}.ogg`);
}

function attachAudio(client) {
  audio = new WaAudio(client);
  audio.on("log", (m) => log("audio ·", m));
  audio.on("peerConnected", ({ remoteUserId }) => log("audio: peer connected", remoteUserId));
  return audio;
}

const findByName = (needle) => wa.findPlayer(needle);
const liveById = (id) => wa.players.get(id) || null;
const liveFollowTarget = () => (follow ? liveById(follow.userId) : null);

function wireClient(client) {
  client.on("log", (m) => log("·", m));
  client.on("error", (e) => log("!!", e.message));
  client.on("areaEnter", (a) => log(`area enter: "${a.name}" [${Object.keys(a.props || {}).join(", ")}]`));
  client.on("areaLeave", (a) => log(`area leave: "${a.name}"`));
  client.on("close", (c) => {
    log("socket closed", c.code, c.reason || "");
    if (deliberateShutdown) return shutdown(0);
    attemptReconnect().catch((e) => {
      log("reconnect gave up:", e.message);
      shutdown(1);
    });
  });
}

function stopFollow() {
  if (follow) {
    follow.controller.abort();
    follow = null;
  }
}

/** Start (or restart) the approach + continuous-follow task for `follow`. */
function runFollowTask() {
  if (!follow) return;
  const { controller, userId, name } = follow;
  (async () => {
    const t = liveById(userId);
    if (t) {
      await wa.navTo(t.x, t.y, {
        stopWithin: 96,
        getTarget: () => liveById(userId),
        timeoutMs: 90_000,
      });
    }
    if (controller.signal.aborted) return;
    await wa.follow(() => liveById(userId), { spacing: 80, signal: controller.signal });
    if (follow && follow.controller === controller) follow = null;
  })().catch((e) => log(`follow task error (${name}):`, e.message));
}

// A short wander sweep so we can pick up a player who isn't in view yet.
const SEARCH_SPOTS = [
  [1600, 1520], [2400, 1000], [1900, 1800], [900, 1600], [1300, 900], [2200, 1500],
];
async function searchFor(nameNeedle, signal) {
  for (const [x, y] of SEARCH_SPOTS) {
    if (signal?.aborted) return null;
    const hit = findByName(nameNeedle);
    if (hit) return hit;
    await wa.navTo(x, y, { stopWithin: 80, timeoutMs: 12_000 });
  }
  return findByName(nameNeedle);
}

async function startFollow(nameNeedle) {
  stopFollow();
  const controller = new AbortController();
  follow = { name: nameNeedle, userId: -1, controller, paused: false, searching: true };

  let p = findByName(nameNeedle);
  if (!p) {
    log(`"${nameNeedle}" not visible — searching…`);
    p = await searchFor(nameNeedle, controller.signal);
  }
  if (controller.signal.aborted) return { ok: false, error: "cancelled" };
  if (!p) {
    follow = null;
    return { ok: false, error: `could not find a player matching "${nameNeedle}"` };
  }
  if (follow?.controller !== controller) return { ok: false, error: "superseded" };
  follow = { name: p.name, userId: p.userId, controller, paused: false };
  runFollowTask();
  return { ok: true, following: p.name };
}

async function quiet() {
  if (follow && !follow.paused) {
    follow.controller.abort();
    follow.paused = true;
  }
  const players = wa.listPlayers();
  const here = wa.nav?.areaAt(wa.pos.x, wa.pos.y);
  if (
    here &&
    !QUIET_EXCLUDE.test(here.name) &&
    players.every((pl) => !wa.nav._rectContains(here, pl.x, pl.y, 48))
  ) {
    return { ok: true, quietSpot: here.name, alreadyQuiet: true, followPaused: follow?.paused ?? false };
  }
  const area = wa.nav?.nearestEmptyArea(wa.pos.x, wa.pos.y, players, { excludeRe: QUIET_EXCLUDE });
  if (!area) return { ok: true, quietSpot: null, followPaused: follow?.paused ?? false };
  wa.navTo(area.x, area.y, { stopWithin: 64, timeoutMs: 60_000 }).then((r) =>
    log(`quiet -> "${area.name}"`, JSON.stringify(r))
  );
  return { ok: true, quietSpot: area.name, followPaused: follow?.paused ?? false };
}

function resume() {
  if (!follow) return { ok: true, nothingToResume: true };
  if (!follow.paused) return { ok: true, following: follow.name, alreadyFollowing: true };
  const name = follow.name;
  startFollow(name).then((r) => log("resume:", JSON.stringify(r)));
  return { ok: true, resuming: name };
}

// How far to stand from a player when we deliberately walk over to them
// (`wa to`, `greet`) — plus navTo's ~16px stop tolerance, so ~40-56px in
// practice. Close enough to read as "next to them", not crowding.
const STAND_GAP = 40;

// Walk over next to a player: aim at a spot STAND_GAP px short of them
// (re-derived each tick from their live position, so it tracks if they drift),
// stop close to that spot, and finish facing them.
async function walkToPlayer(p, timeoutMs = 60_000) {
  const live = () => liveById(p.userId);
  return wa.navTo(p.x, p.y, {
    stopWithin: 16,
    getTarget: () => {
      const lp = live();
      return lp ? wa.followPoint(lp, STAND_GAP) : { x: p.x, y: p.y };
    },
    face: () => live() ?? p,
    timeoutMs,
  });
}

async function greet(nameNeedle) {
  const p = findByName(nameNeedle);
  if (!p) return { ok: false, error: `no player matching "${nameNeedle}"` };
  await walkToPlayer(p);
  wa.speechBubble(`hi ${p.name}`);
  return { ok: true, greeted: p.name };
}

function state() {
  const t = liveFollowTarget();
  return {
    name: cfg.name,
    room: wa.cfg.roomUrl,
    connected: wa.ws?.readyState === 1,
    reconnecting,
    myUserId: wa.myUserId,
    pos: { x: Math.round(wa.pos.x), y: Math.round(wa.pos.y) },
    facing: ["up", "right", "down", "left"][wa.pos.direction] ?? null,
    area: wa.nav?.areaAt(wa.pos.x, wa.pos.y)?.name ?? null,
    areas: [...(wa.currentAreas ?? [])].map((key) => {
      const a = (wa.areas ?? []).find((z) => (z.id ?? z.name) === key);
      return { name: a?.name ?? key, props: a ? Object.keys(a.props) : [] };
    }),
    audio: audio
      ? { peers: audio.peers.size, connected: audio.connected, inMeeting: wa.spaces.size > 0 }
      : null,
    following: follow
      ? {
          name: follow.name,
          paused: follow.paused,
          pos: t ? { x: t.x | 0, y: t.y | 0 } : null,
          area: t ? wa.nav?.areaAt(t.x, t.y)?.name ?? null : null,
        }
      : null,
    players: wa.listPlayers().map((p) => ({
      name: p.name,
      userId: p.userId,
      pos: { x: p.x | 0, y: p.y | 0 },
      area: wa.nav?.areaAt(p.x, p.y)?.name ?? null,
    })),
  };
}

async function attemptReconnect() {
  reconnecting = true;
  const prevFollow = follow ? { name: follow.name, paused: follow.paused } : null;
  const delays = [2000, 5000, 10000, 20000, 30000];
  for (let i = 0; i < delays.length; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    log(`reconnect attempt ${i + 1}/${delays.length}…`);
    const client = new WorkAdventureClient({
      name: cfg.name,
      roomUrl: cfg.roomUrl,
      pusherUrl: cfg.pusherUrl,
      version: cfg.version,
      wokaId: cfg.wokaId,
      micOn: true,
    });
    wireClient(client);
    try {
      await client.connect();
      wa = client;
      attachAudio(wa);
      reconnecting = false;
      log(`reconnected as userId ${wa.myUserId}`);
      follow = null;
      if (prevFollow && !prevFollow.paused) {
        startFollow(prevFollow.name).then((r) => log("post-reconnect follow:", JSON.stringify(r)));
      } else if (prevFollow) {
        follow = { name: prevFollow.name, userId: -1, controller: new AbortController(), paused: true };
      }
      return;
    } catch (e) {
      log(`  attempt ${i + 1} failed: ${e.message}`);
      try { client.close(); } catch {}
    }
  }
  throw new Error("exhausted reconnect attempts");
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj, null, 2));
  };
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/state") return send(200, state());

    if (req.method === "POST") {
      const body = await readBody(req);
      switch (url.pathname) {
        case "/goto": {
          stopFollow();
          let gx = body.x;
          let gy = body.y;
          if (body.player) {
            const p = findByName(body.player);
            if (!p) return send(404, { ok: false, error: `no player matching "${body.player}"` });
            walkToPlayer(p, 90_000).then((r) => log("goto (player) result", JSON.stringify(r)));
            return send(202, { ok: true, goingTo: { player: p.name } });
          }
          if (typeof gx !== "number" || typeof gy !== "number")
            return send(400, { ok: false, error: "need {x,y} or {player}" });
          wa.navTo(gx, gy, { stopWithin: body.stopWithin ?? 48, timeoutMs: 90_000 }).then((r) =>
            log("goto result", JSON.stringify(r))
          );
          return send(202, { ok: true, goingTo: { x: Math.round(gx), y: Math.round(gy) } });
        }
        case "/follow": {
          if (!body.player) return send(400, { ok: false, error: "need {player}" });
          startFollow(body.player).then((r) => log("follow:", JSON.stringify(r)));
          return send(202, { ok: true, following: body.player, note: "approaching (searching if not yet visible)" });
        }
        case "/unfollow":
          stopFollow();
          return send(200, { ok: true, following: null });
        case "/quiet":
          return send(200, await quiet());
        case "/resume":
          return send(200, resume());
        case "/greet": {
          const r = await greet(body.player);
          return send(r.ok ? 200 : 404, r);
        }
        case "/speech-bubble":
          if (!body.text) return send(400, { ok: false, error: "need {text}" });
          wa.speechBubble(String(body.text));
          return send(200, { ok: true, speechBubble: String(body.text) });
        case "/thought-bubble":
          if (!body.text) return send(400, { ok: false, error: "need {text}" });
          wa.thoughtBubble(String(body.text));
          return send(200, { ok: true, thoughtBubble: String(body.text) });
        case "/clear-bubble":
          wa.clearBubble();
          return send(200, { ok: true, bubble: null });
        case "/sound": {
          if (!body.name) return send(400, { ok: false, error: "need {name}" });
          if (!audio) return send(503, { ok: false, error: "audio not ready" });
          const clip = resolveClip(String(body.name), body.cwd);
          if (!fs.existsSync(clip))
            return send(404, { ok: false, error: `no clip at ${clip}` });
          if (!audio.connected)
            return send(409, { ok: false, error: "no one in the bubble to hear it" });
          try {
            const r = await audio.play(clip);
            log(
              `sound "${body.name}": ${r.packetsSent} pkts to ${r.peers} peer(s)` +
                ` [${(r.peerStates || []).join(",")}]` +
                (r.writeErrors ? `, ${r.writeErrors} write errors` : "")
            );
            return send(r.played ? 200 : 409, { ok: r.played, sound: body.name, ...r });
          } catch (e) {
            return send(400, { ok: false, error: e.message });
          }
        }
        case "/leave":
          send(200, { ok: true, leaving: true });
          return shutdown(0);
      }
    }
    send(404, { ok: false, error: "unknown route" });
  } catch (e) {
    send(500, { ok: false, error: e.message });
  }
});

function shutdown(code) {
  deliberateShutdown = true;
  for (const f of INFO_FILES) { try { fs.unlinkSync(f); } catch {} }
  try { server.close(); } catch {}
  try { wa?.close(); } catch {}
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// Don't let a stray throw in a timer / unawaited promise take the daemon down.
process.on("uncaughtException", (e) => log("uncaughtException:", e.stack || e.message));
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.stack || String(e)));

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} in use — a daemon is probably already running (see ${INFO_FILES[0]})`);
    process.exit(3);
  }
  throw e;
});

log(`connecting to WorkAdventure as "${cfg.name}"…`);
wa = new WorkAdventureClient({
  name: cfg.name,
  roomUrl: cfg.roomUrl,
  pusherUrl: cfg.pusherUrl,
  version: cfg.version,
  wokaId: cfg.wokaId,
  micOn: true,
});
wireClient(wa);
await wa.connect();
attachAudio(wa);
log(`joined as userId ${wa.myUserId}; spawn (${wa.pos.x | 0},${wa.pos.y | 0})`);

if (process.env.WA_FOLLOW) {
  startFollow(process.env.WA_FOLLOW).then((r) => log("join --follow:", JSON.stringify(r)));
}

server.listen(PORT, "127.0.0.1", () => {
  const info = JSON.stringify({
    pid: process.pid,
    port: PORT,
    room: wa.cfg.roomUrl,
    name: cfg.name,
    startedAt: new Date().toISOString(),
  });
  for (const f of INFO_FILES) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, info);
    } catch (e) {
      log(`could not write ${f}: ${e.message}`);
    }
  }
  log(`control API on http://127.0.0.1:${PORT}`);
});
