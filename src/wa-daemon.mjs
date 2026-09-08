// Long-running WorkAdventure presence with a localhost HTTP control API.
//
// A subagent (or anything that can curl) drives the avatar through this; the
// daemon is what actually stays connected — answering pings, running the follow
// loop — between commands.
//
//   node src/wa-daemon.mjs                 # foreground
//   node src/wa-daemon.mjs &               # background
//   WA_DAEMON_PORT=8787 WA_NAME=claude node src/wa-daemon.mjs
//
// Control API (all on http://127.0.0.1:<port>, JSON bodies):
//   GET  /state                       -> { name, pos, room, following, players }
//   POST /goto     {x,y} | {player}   -> navigate there (cancels any follow)
//   POST /follow   {player, greet?}   -> approach + optionally greet + follow
//   POST /unfollow                    -> stop following, hold position
//   POST /say      {text}             -> speech bubble
//   POST /leave                       -> disconnect and exit the process
//
// A small file at $TMPDIR/wa-daemon.json advertises { pid, port, room, name }.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { WorkAdventureClient } from "./wa-client.mjs";

const PORT = Number(process.env.WA_DAEMON_PORT || 8787);
const NAME = process.env.WA_NAME || "claude";
const ROOM = process.env.WA_ROOM || undefined; // undefined -> client default
const INFO_FILE = path.join(os.tmpdir(), "wa-daemon.json");

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

const wa = new WorkAdventureClient({ name: NAME, ...(ROOM ? { roomUrl: ROOM } : {}) });
wa.on("log", (m) => log("·", m));
wa.on("error", (e) => log("!!", e.message));
wa.on("close", (c) => { log("socket closed", c.code, c.reason || ""); shutdown(c.code === 1000 ? 0 : 1); });

let follow = null; // { name, userId, controller, greet }

const findByName = (needle) => wa.findPlayer(needle);
const liveById = (id) => wa.players.get(id) || null;

function stopFollow() {
  if (follow) {
    follow.controller.abort();
    follow = null;
  }
}

async function startFollow(name, greet) {
  const p = findByName(name);
  if (!p) return { ok: false, error: `no player matching "${name}"` };
  stopFollow();
  const controller = new AbortController();
  follow = { name: p.name, userId: p.userId, controller, greet: !!greet };

  // approach, then hand off to the continuous follow loop
  (async () => {
    const t = liveById(p.userId) || p;
    await wa.navTo(t.x, t.y, { stopWithin: 96, getTarget: () => liveById(p.userId), timeoutMs: 90000 });
    if (controller.signal.aborted) return;
    if (greet) wa.say(`hi ${p.name}`);
    await wa.follow(() => liveById(p.userId), { spacing: 80, signal: controller.signal });
    if (follow && follow.controller === controller) follow = null;
  })().catch((e) => log("follow task error:", e.message));

  return { ok: true, following: follow.name };
}

function state() {
  const t = follow ? liveById(follow.userId) : null;
  return {
    name: NAME,
    room: wa.cfg.roomUrl,
    connected: wa.ws?.readyState === 1,
    myUserId: wa.myUserId,
    pos: { x: Math.round(wa.pos.x), y: Math.round(wa.pos.y) },
    area: wa.nav?.roomAt(wa.pos.x, wa.pos.y)?.name ?? null,
    following: follow
      ? { name: follow.name, userId: follow.userId, pos: t ? { x: t.x | 0, y: t.y | 0 } : null, targetRoom: t ? wa.nav?.roomAt(t.x, t.y)?.name ?? null : null }
      : null,
    players: wa.listPlayers().map((p) => ({
      name: p.name,
      userId: p.userId,
      pos: { x: p.x | 0, y: p.y | 0 },
      room: wa.nav?.roomAt(p.x, p.y)?.name ?? null,
    })),
  };
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
            gx = p.x;
            gy = p.y;
          }
          if (typeof gx !== "number" || typeof gy !== "number")
            return send(400, { ok: false, error: "need {x,y} or {player}" });
          wa.navTo(gx, gy, { stopWithin: body.stopWithin ?? 48, timeoutMs: 90000 })
            .then((r) => log("goto result", JSON.stringify(r)));
          return send(202, { ok: true, goingTo: { x: Math.round(gx), y: Math.round(gy) } });
        }
        case "/follow":
          return send(200, await startFollow(body.player, body.greet));
        case "/unfollow":
          stopFollow();
          return send(200, { ok: true, following: null });
        case "/say":
          if (!body.text) return send(400, { ok: false, error: "need {text}" });
          wa.say(String(body.text));
          return send(200, { ok: true, said: String(body.text) });
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
  try { fs.unlinkSync(INFO_FILE); } catch {}
  try { server.close(); } catch {}
  try { wa.close(); } catch {}
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} in use — a daemon is probably already running (see ${INFO_FILE})`);
    process.exit(3);
  }
  throw e;
});

log(`connecting to WorkAdventure as "${NAME}"…`);
await wa.connect();
log(`joined as userId ${wa.myUserId}; spawn (${wa.pos.x | 0},${wa.pos.y | 0})`);

server.listen(PORT, "127.0.0.1", () => {
  fs.writeFileSync(INFO_FILE, JSON.stringify({ pid: process.pid, port: PORT, room: wa.cfg.roomUrl, name: NAME, startedAt: new Date().toISOString() }));
  log(`control API on http://127.0.0.1:${PORT}  (info: ${INFO_FILE})`);
});
