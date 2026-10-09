// Long-running WorkAdventure presence with a localhost HTTP control API.
//
// The `wa` CLI (and anything else that can POST JSON) drives the avatar through
// this; the daemon is what actually stays connected — answering pings and
// reconnecting after a drop — between commands.
//
//   node src/wa-daemon.mjs                 # foreground
//   WA_DAEMON_PORT=8787 WA_NAME=claude node src/wa-daemon.mjs
//
// Control API (http://127.0.0.1:<port>, JSON bodies):
//   GET  /state                    -> { name, target, pos, facing, area, players }
//   POST /goto           {x,y}|{player}  -> walk there
//   POST /quiet                          -> step away to the nearest empty area (or stay if already quiet)
//   POST /greet          {player}        -> walk over + "hi" speech bubble (no state change)
//   POST /speech-bubble  {text}          -> speech bubble over the avatar
//   POST /thought-bubble {text}          -> thinking cloud over the avatar
//   POST /clear-bubble                   -> dismiss whatever bubble is showing
//   POST /sound          {name}          -> play a clip into the proximity voice chat
//   POST /chat           {text}          -> send a chat message to every Space we're
//                                            currently in (proximity bubble and/or
//                                            meeting-room area — #48, not Matrix)
//   POST /leave                          -> disconnect and exit
//
// Also: when another player invites the avatar over (WorkAdventure's "invite
// to discussion" on the woka), it auto-accepts and walks to them — no request.
//
// Advertises itself as daemon-<port>.json in $TMPDIR and ~/.workadventurer/ (#65).

import http from "node:http";
import fs from "node:fs";
import { WorkAdventureClient } from "./wa-client.mjs";
import { WaAudio, disposeLiveKitRuntime } from "./wa-audio.mjs";
import { resolveConfig } from "./config.mjs";
import { resolveClip } from "./resolve-clip.mjs";
import { makeSttRoomOutput } from "./stt-room-output.mjs";
import { makeTranscriptSink } from "./stt-transcript.mjs";
import { stopWorker } from "./wa-stt.mjs";
import { createRegistry } from "./daemon-registry.mjs";
import { goQuiet } from "./quiet.mjs";
import { createReconnector } from "./reconnect.mjs";
import { ServerRejectedError } from "./server-rejected.mjs";

const cfg = resolveConfig();
const PORT = cfg.port;
// One advertisement per port; we only ever remove our own (#65).
const registry = createRegistry();

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => {
  // Don't let a normal log line collide with an in-progress STT partial that
  // hasn't been newline-terminated yet.
  if (sttLineOpen) { process.stdout.write("\n"); sttLineOpen = false; }
  console.log(ts(), ...a);
};

let wa;
let audio; // WaAudio, bound to the current client
let deliberateShutdown = false;

let sttLineOpen = false; // a provisional partial line is currently on the terminal, unterminated

function attachAudio(client) {
  audio = new WaAudio(client, { listen: cfg.stt });
  audio.on("log", (m) => log("audio ·", m));
  audio.on("peerConnected", ({ remoteUserId }) => log("audio: peer connected", remoteUserId));
  if (cfg.stt) {
    // Redraw the provisional line in place as it's corrected; lock it in with
    // a newline once WA finalizes it (issue #23). The `\r\x1b[K` cursor
    // control only means anything on a real terminal — under `--detach`,
    // stdout is `daemon.log` (a plain file), so those bytes would just pile
    // up as garbled literal text and every final would get written twice
    // (once raw, once via `log()`). Detached mode instead logs one clean,
    // timestamped line per finalized utterance and drops partials entirely.
    // Room output (#41): thought-bubble partials, Space-chat finals. A send
    // failure must never break the console path below.
    const roomOutput = makeSttRoomOutput(client);
    audio.on("heard", (e) => {
      try { roomOutput(e); } catch (err) { log(`stt room output failed: ${err.message}`); }
    });
    // Transcript file (#64): one JSONL line per final, same speaker label as the console.
    if (cfg.transcript) {
      const transcript = makeTranscriptSink(cfg.transcript, { onError: (err) => log(`stt transcript write failed: ${err.message}`) });
      audio.on("heard", (e) => {
        transcript(e, wa.spaceUserName(e.remoteUserId) ?? String(e.remoteUserId).split("/").pop());
      });
    }
    audio.on("heard", ({ remoteUserId, text, final }) => {
      // Silence closing out a buffer that never had real speech transcribes
      // to "" — the worker skips sending these, but guard here too rather
      // than trust that on every code path.
      if (final && !text) return;
      const who = wa.spaceUserName(remoteUserId) ?? remoteUserId.split("/").pop() ?? remoteUserId;
      const line = `SCRIBE[${who}]: ${text}`;
      if (!process.stdout.isTTY) {
        if (final) log(line);
        return;
      }
      if (final) {
        process.stdout.write(`\r\x1b[K${line}\n`);
        sttLineOpen = false;
      } else {
        process.stdout.write(`\r\x1b[K${line}`);
        sttLineOpen = true;
      }
    });
  }
  return audio;
}

const findByName = (needle) => wa.findPlayer(needle);
const liveById = (id) => wa.players.get(id) || null;

let lastEmote = null; // { userId, name, emote, at }
let lastInvite = null; // { name, uuid, at, walking }
let lastChatMessage = null; // { spaceName, name, text, at } — most recently received (not sent)
const emoteWaiters = new Set(); // { player, emote, resolve, timer }

function wireClient(client) {
  client.on("log", (m) => log("·", m));
  client.on("error", (e) => log("!!", e.message));
  client.on("areaEnter", (a) => log(`area enter: "${a.name}" [${Object.keys(a.props || {}).join(", ")}]`));
  client.on("areaLeave", (a) => log(`area leave: "${a.name}"`));
  client.on("emote", (e) => {
    lastEmote = { ...e, at: Date.now() };
    log(`emote: ${e.name || e.userId} → ${JSON.stringify(e.emote)}`);
    for (const w of emoteWaiters) {
      if (w.player && !String(e.name).toLowerCase().includes(w.player.toLowerCase())) continue;
      // `emote` may be a comma-separated list of alternatives; match any.
      if (w.emote && !w.emote.split(",").some((x) => String(e.emote).includes(x.trim()))) continue;
      clearTimeout(w.timer);
      emoteWaiters.delete(w);
      w.resolve({ emote: e.emote, name: e.name, userId: e.userId });
    }
  });
  client.on("chatMessage", ({ spaceName, senderUserId, name, text }) => {
    const who = name || senderUserId;
    lastChatMessage = { spaceName, name: who, text, at: Date.now() };
    log(`chat[${spaceName}] ${who}: ${text}`);
  });
  client.on("inviteReceived", ({ uuid, name, userId }) => {
    // A player invited us over. Accept, then walk to them — one-shot, like `wa to`.
    client.acceptMeetingInvitation(uuid);
    const sender =
      (userId != null && liveById(userId)) || wa.playerByUuid(uuid) || null;
    lastInvite = { name: name || sender?.name || "(unknown)", uuid, at: Date.now(), walking: !!sender };
    if (!sender) {
      log(`invite from ${name || uuid} — accepted, but can't see them to walk over`);
      return;
    }
    log(`invite from ${sender.name} → walking over`);
    walkToPlayer(sender, 90_000).then((r) => log("invite walk:", JSON.stringify(r)));
  });
  client.on("close", (c) => log("socket closed", c.code, c.reason || ""));
}

// Reconnect-on-close belongs to the LIVE client only. Attempt clients made by
// the reconnector are wired with wireClient() alone: a rejected attempt closes
// its socket, and when that triggered a reconnect it started a new chain per
// attempt (~2^N connections — #56).
function watchLive(client) {
  client.on("close", () => {
    if (deliberateShutdown) return shutdown(0);
    if (client !== wa) return; // a stale client's close isn't a drop of the live one
    attemptReconnect().catch((e) => {
      log("reconnect gave up:", e.message);
      shutdown(1);
    });
  });
}

// How far to stand from a player when we deliberately walk over to them
// (`wa to`, `greet`) — plus navTo's ~16px stop tolerance, so ~14-46px in
// practice. Right next to them, in their eyeline (see standPoint / frontOf).
const STAND_GAP = 30;

// Walk over to a player and stand in their eyeline: aim STAND_GAP px in front
// of them (the direction they're facing), re-derived each tick from their live
// position + facing so it tracks if they turn or drift; stop close to that
// spot, finish facing them.
// If the player is standing inside a map area (a meeting table, a silent zone),
// the stand point must be *inside that area too* — otherwise we'd loiter on the
// perimeter and never join the area's meeting. Clamp into the player's area
// rectangle; if that clamp pulls us closer than MIN_STAND px to the player,
// push back out along the same axis so we don't end up standing on them.
const MIN_STAND = 24;
function standPoint(lp) {
  const goal = wa.frontOf(lp, STAND_GAP);
  const area = wa.areasAt(lp.x, lp.y)[0];
  if (!area) return goal;
  const m = 8;
  let x = Math.min(Math.max(goal.x, area.x + m), area.x + area.w - m);
  let y = Math.min(Math.max(goal.y, area.y + m), area.y + area.h - m);
  const dx = x - lp.x;
  const dy = y - lp.y;
  const d = Math.hypot(dx, dy);
  if (d > 0 && d < MIN_STAND) {
    x = lp.x + (dx / d) * MIN_STAND;
    y = lp.y + (dy / d) * MIN_STAND;
  }
  return { x, y };
}

async function walkToPlayer(p, timeoutMs = 60_000) {
  const live = () => liveById(p.userId);
  let lostAt = 0;
  return wa.navTo(p.x, p.y, {
    stopWithin: 16,
    getTarget: () => {
      const lp = live();
      if (lp) {
        lostAt = 0;
        return standPoint(lp);
      }
      // Player left view. Give them a few seconds to reappear, then abort
      // (navTo returns on a null target) rather than marching for the full
      // timeout toward their stale last-known spot.
      if (!lostAt) lostAt = Date.now();
      return Date.now() - lostAt > 3000 ? null : { x: p.x, y: p.y };
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
  return {
    name: cfg.name,
    room: wa.cfg.roomUrl,
    target: wa.adapter
      ? {
          id: wa.adapter.id,
          waVersion: wa.adapter.waVersion,
          stability: wa.adapter.stability,
          verified: wa.adapter.verified ?? null,
        }
      : null,
    connected: wa.ws?.readyState === 1,
    reconnecting: reconnector.active,
    myUserId: wa.myUserId,
    pos: { x: Math.round(wa.pos.x), y: Math.round(wa.pos.y) },
    facing: ["up", "right", "down", "left"][wa.pos.direction] ?? null,
    area: wa.nav?.areaAt(wa.pos.x, wa.pos.y)?.name ?? null,
    areas: [...(wa.currentAreas ?? [])].map((key) => {
      const a = (wa.areas ?? []).find((z) => (z.id ?? z.name) === key);
      return { name: a?.name ?? key, props: a ? Object.keys(a.props) : [] };
    }),
    audio: audio
      ? { peers: audio.remoteCount, connected: audio.connected, inMeeting: wa.spaces.size > 0 }
      : null,
    lastEmote,
    lastInvite,
    lastChatMessage,
    players: wa.listPlayers().map((p) => ({
      name: p.name,
      userId: p.userId,
      pos: { x: p.x | 0, y: p.y | 0 },
      facing: ["up", "right", "down", "left"][p.direction] ?? null,
      area: wa.nav?.areaAt(p.x, p.y)?.name ?? null,
    })),
  };
}

const newClient = () =>
  new WorkAdventureClient({
    name: cfg.name,
    roomUrl: cfg.roomUrl,
    pusherUrl: cfg.pusherUrl,
    target: cfg.target,
    version: cfg.version,
    wokaId: cfg.wokaId,
    // A listen-mode ("scribe") instance doesn't publish audio by default —
    // client.micOn is the single source of truth every mic-announce path
    // respects (#10). See wa-audio.mjs for the rest of that invariant.
    micOn: !cfg.stt,
  });

const reconnector = createReconnector({
  makeClient: () => {
    const client = newClient();
    wireClient(client);
    return client;
  },
  onConnected: (client) => {
    wa = client;
    watchLive(client);
    attachAudio(wa);
    log(`reconnected as userId ${wa.myUserId}`);
  },
  log,
  isStopped: () => deliberateShutdown,
});

const attemptReconnect = () => reconnector.start();

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
        case "/quiet":
          return send(200, await goQuiet(wa, { log }));
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
          // A named area escalates straight to LiveKit, and that connect can
          // still be in flight right after joining -- wait it out instead of
          // racing it (#8 follow-up).
          await audio.waitForLiveKit();
          if (!audio.connected)
            return send(409, { ok: false, error: "no one in the bubble to hear it" });
          // Fire and forget — play() streams the clip in real time, which can
          // be many seconds; don't hold the HTTP response open for it.
          audio
            .play(clip)
            .then((r) =>
              log(
                `sound "${body.name}": ${r.packetsSent ?? "?"} pkts to ${r.peers ?? 0} peer(s)` +
                  ` [${(r.peerStates || []).join(",")}]` +
                  (r.writeErrors ? `, ${r.writeErrors} write errors` : "") +
                  (r.played ? "" : ` — NOT played (${r.reason ?? "?"})`)
              )
            )
            .catch((e) => log(`sound "${body.name}" failed: ${e.message}`));
          return send(202, { ok: true, sound: body.name, playing: true });
        }
        case "/chat": {
          if (!body.text) return send(400, { ok: false, error: "need {text}" });
          const spaceNames = [...wa.spaces.keys()];
          if (!spaceNames.length)
            return send(409, { ok: false, error: "not in a chat with anyone nearby" });
          for (const sn of spaceNames) wa.sendChatMessage(sn, String(body.text));
          return send(200, { ok: true, chat: String(body.text), spaces: spaceNames.length });
        }
        case "/wait-emote": {
          // Long-poll: resolve when a matching emote arrives, or time out.
          const timeoutMs = Number(body.timeoutMs) || 300_000;
          const w = {
            player: body.player ? String(body.player) : null,
            emote: body.emote ? String(body.emote) : null,
            resolve: (r) => send(200, { ok: true, ...r }),
          };
          w.timer = setTimeout(() => {
            emoteWaiters.delete(w);
            send(200, { ok: true, timedOut: true });
          }, timeoutMs);
          emoteWaiters.add(w);
          return; // response sent later
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
  registry.withdraw(PORT);
  try { server.close(); } catch {}
  try { wa?.close(); } catch {}
  disposeLiveKitRuntime().catch(() => {}); // no-op unless a LiveKit room was ever created (#8)
  stopWorker().catch(() => {}); // SIGTERM to the STT worker, if one was started (#57); stdin EOF covers a hard exit
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// Don't let a stray throw in a timer / unawaited promise take the daemon down.
process.on("uncaughtException", (e) => log("uncaughtException:", e.stack || e.message));
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.stack || String(e)));

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${PORT} in use — a daemon is probably already running (try \`wa status --port ${PORT}\`)`);
    process.exit(3);
  }
  throw e;
});

log(`connecting to WorkAdventure as "${cfg.name}"…`);
wa = newClient();
wireClient(wa);
try {
  await wa.connect();
} catch (e) {
  // Nothing to keep alive yet and the control API isn't up: say why and exit
  // non-zero rather than limping on via uncaughtException (#56).
  log(e instanceof ServerRejectedError && !e.retryable
    ? `${e.message} — the server refuses this client; not retrying`
    : `initial connect failed: ${e.message}`);
  shutdown(1);
  await new Promise(() => {}); // shutdown() exits the process after cleanup
}
watchLive(wa);
attachAudio(wa);
log(`joined as userId ${wa.myUserId}; spawn (${wa.pos.x | 0},${wa.pos.y | 0})`);

server.listen(PORT, "127.0.0.1", () => {
  registry.advertise({ port: PORT, room: wa.cfg.roomUrl, name: cfg.name });
  log(`control API on http://127.0.0.1:${PORT}`);
});
