# workadventurer

A **headless [WorkAdventure](https://workadventu.re) client** — no browser, no
game engine. A small Node process speaks the pusher `/ws/room` WebSocket +
protobuf protocol directly, so it holds a real avatar with presence in a room:
it appears on the map, walks around (with pathfinding), sees other players, and
can talk.

It started as a one-liner request — *"log into the afrolabs open-space as
`claude` and walk over to find `:David`"* — and turned into a small
reverse-engineering exercise. The [protocol notes](#the-protocol) below are the
main takeaway.

> [!NOTE]
> This talks to a hosted third-party service over an **undocumented** protocol
> and logs in anonymously. It's pinned to one server build and one map; expect
> it to break when either changes. Point it at spaces you're allowed to be in,
> and don't be a nuisance to the people already there.

## Install

```sh
npm i -g workadventurer     # gives you the `wa` command
# or run it ad-hoc:  npx workadventurer wa <…>
```

Needs Node 18+ (built-in `fetch`). Runtime deps are `ws` and `protobufjs`
(protobuf is loaded at runtime — no codegen step).

## The `wa` CLI

`wa` talks to a small background **daemon** that holds the WebSocket connection;
`wa join` starts it, other commands are picked up in the same session, and any
command auto-starts the daemon if it isn't running.

```sh
wa join --detach --follow David   # join the room as "claude", start following David
wa status                         # where am I, who's around, am I following anyone
wa quiet                          # step away to the nearest empty area (pauses the follow)
wa resume                         # walk back and resume following
wa greet Alice                    # walk over to Alice + a "hi Alice" speech bubble
wa speech-bubble "brb"            # text over the avatar's head
wa leave                          # disconnect and stop the daemon
```

| Command | Does |
|---|---|
| `wa join [--detach] [--follow <player>]` | join the room (runs the daemon) |
| `wa leave` | leave and stop the daemon |
| `wa status [--json]` | position, area, follow state, visible players |
| `wa to <player>` | walk next to a player, no follow |
| `wa follow <player>` | follow continuously (wanders the map to find them if needed) |
| `wa unfollow` | stop and forget |
| `wa quiet` / `wa resume` | pause the follow and sit in an empty area / walk back and resume |
| `wa greet <player>` | walk over + "hi" speech bubble (no state change) |
| `wa speech-bubble <text>` / `wa thought-bubble <text>` | text bubble |
| `wa clear-bubble` | dismiss whatever bubble is showing |
| `wa sound <name\|file>` | play a clip into the proximity voice chat (see [Voice](#9-voice)) |
| `wa goto <x> <y>` | walk to raw coordinates |

`--if-running` makes any command a silent no-op when no daemon is up (used by
the plugin hooks). Config precedence: flags > env (`WA_ROOM`, `WA_NAME`,
`WA_DAEMON_PORT`, …) > `~/.config/workadventurer/config.json` > built-in
defaults. The detached daemon logs to `~/.workadventurer/daemon.log`.

## Claude Code plugin

`plugin/` is a Claude Code plugin that wires the avatar to your session's
rhythm: while Claude is working the avatar goes and sits somewhere quiet, and
when Claude finishes it walks back to whoever it was following.

```sh
claude --plugin-dir ./plugin        # load it from a checkout
# or, from the marketplace in this repo:
claude plugin install workadventure@campey/workadventurer
```

Then, in a session, opt in with `wa join --detach --follow <yourName>`. Two
hooks do the rest — `UserPromptSubmit` → `wa quiet`, `Stop` → `wa resume` —
and both no-op instantly when no daemon is running, so a plain session pays
nothing. The plugin also ships:

- **`/wa <args>`** — a passthrough to the CLI
- **the `workadventure` skill** — natural-language steering ("follow David",
  "who's in the room", "go quiet")
- **the `workadventure` subagent** — for a long back-and-forth steered session
  you drive with `SendMessage`

## Using the client directly

```js
import { WorkAdventureClient } from "./src/wa-client.mjs";

const wa = new WorkAdventureClient({ name: "claude" });
wa.on("playerJoined", (p) => console.log("saw", p.name, "at", p.x, p.y));
await wa.connect();                         // anon login + handshake + join

await wa.navTo(2378, 1340);                 // A* route around obstacles
await wa.walkTo(2378, 1340);                // straight line, ignores walls
await wa.follow(() => wa.players.get(id));  // fluid continuous follow, room-aware
wa.speechBubble("hello");                   // text over the avatar (also: thoughtBubble)
console.log(wa.listPlayers());              // [{ userId, name, uuid, x, y }]
wa.close();
```

`new WorkAdventureClient(opts)` — `name`, `roomUrl`, `pusherUrl`, `version`
(apiVersionHash), `wokaId`, `spawn`, `nav` all have defaults for the afrolabs
open-space. With no `spawn`, the client picks a random tile from the map's
`start` layer.

`node src/find-player.mjs [name]` is a standalone one-shot: connect, find the
named player (default `David`), walk over, greet, follow.

## Daemon API (reference)

The `wa` CLI is a thin client of this. `src/wa-daemon.mjs` serves it on
`http://127.0.0.1:8787` (`WA_DAEMON_PORT` to change); it advertises itself at
`$TMPDIR/wa-daemon.json` and `~/.workadventurer/daemon.json`.

| Call | Effect |
|---|---|
| `GET /state` | `{ name, pos, facing, area, areas:[{name,props}], audio:{…}|null, following:…, players:[…] }` |
| `POST /goto` `{x,y}` or `{player}` | walk there (cancels any follow) |
| `POST /follow` `{player}` | approach + follow (searches the map if not in view) |
| `POST /unfollow` | stop and forget |
| `POST /quiet` / `POST /resume` | pause follow + go to an empty area / walk back and resume |
| `POST /greet` `{player}` | walk over + "hi" speech bubble |
| `POST /speech-bubble` `{text}` / `POST /thought-bubble` `{text}` | text bubble |
| `POST /clear-bubble` | dismiss whatever bubble is showing |
| `POST /sound` `{name}` | play a clip into the proximity voice chat |
| `POST /leave` | disconnect and exit |

The daemon answers WebSocket pings, keeps the follow loop running, and
reconnects (bounded retries) if the socket drops.

## Project layout

| Path | What |
|---|---|
| `bin/wa.mjs` | the `wa` CLI |
| `src/wa-client.mjs` | `WorkAdventureClient` — connection, protocol, world model, `navTo()` / `walkTo()` / `follow()` / `speechBubble()` |
| `src/map-nav.mjs` | `MapNav` — A\* over the tile grid + line-of-sight smoothing, spawn tiles, named areas, `nearestEmptyArea()` |
| `src/wa-daemon.mjs` | long-running presence + localhost HTTP control API |
| `src/wa-audio.mjs` | `WaAudio` — P2P WebRTC (werift) into proximity meetings; publishes Opus |
| `src/ogg-opus.mjs` | dependency-free Ogg demuxer — Opus packets out of `.ogg`/`.opus` |
| `src/transcode.mjs` | `wa sound` format bridge — non-Opus files → Ogg/Opus via `ffmpeg`, cached |
| `sounds/` | bundled Ogg/Opus clips for `wa sound` (credits in `sounds/ATTRIBUTION.md`) |
| `src/config.mjs` | config resolution (flags → env → `~/.config` → defaults) |
| `src/find-player.mjs` | standalone one-shot: connect → locate → walk over → greet → follow |
| `plugin/` | Claude Code plugin — hooks, `/wa` command, skill, subagent |
| `.claude-plugin/marketplace.json` | single-plugin marketplace for `claude plugin install` |
| `scripts/build-collision.mjs` | regenerates `map/collision.json` from the live `.wam` / `.tmj` |
| `map/collision.json` | baked collision grid + spawn tiles + named areas |
| `proto/messages.proto` | vendored from `workadventure` tag `v1.33.5` |

## Regenerating the pinned artifacts

Three things are pinned to the current server build / map and will need a refresh
when WorkAdventure updates:

- **`proto/messages.proto`** — copy from the [`workadventure`
  repo](https://github.com/workadventure/workadventure) at the tag matching the
  deployed build (see `SENTRY_RELEASE` in the room HTML's `window.env`).
- **`version`** (apiVersionHash) in `wa-client.mjs` — see
  [§ apiVersionHash](#apiversionhash) for how to recompute it.
- **`map/collision.json`** — `node scripts/build-collision.mjs` (fetches the
  live map and rebuilds the grid).

---

## The protocol

As reverse-engineered against `https://play.workadventu.re` (hosted SaaS), room
`/@/afrolabs/afrolabs/open-space`, server build **v1.33.5**
(`window.env.SENTRY_RELEASE` in the room HTML).

Cross-referenced with `play/src/front/Connection/RoomConnection.ts`,
`play/src/pusher/controllers/IoSocketController.ts`, and
`play/src/pusher/models/PositionDispatcher.ts` in the WorkAdventure source.

### 1. Endpoints

`window.env`, inlined in the room HTML, holds the service URLs:

```
PUSHER_URL = https://pusher.workadventu.re     # not same-origin as play.workadventu.re
DISABLE_ANONYMOUS = false
```

- `GET https://pusher.workadventu.re/map?playUri=<room>` →
  `authenticationMandatory: false` for this room, so anonymous can join.
- `GET https://pusher.workadventu.re/woka/list?roomUrl=<room>` (header
  `Authorization: <token>`) → catalogue of valid character-texture ids, e.g.
  `506a3a64-47a9-4587-b19b-2d1eb13f9790` ("Bob").

### 2. Anonymous login

```
POST https://pusher.workadventu.re/anonymLogin   body {}
  → { authToken: "<JWT>", userUuid: "<uuid>" }
```

The JWT payload is just `{ identifier, exp }` — no name. The avatar name is set
later, in the join message.

### 3. WebSocket handshake

```
wss://pusher.workadventu.re/ws/room
  ?roomId=<full room URL>
  &characterTextureIds=<woka id>          (repeatable)
  &version=<apiVersionHash>
  &roomName=&cameraState=false&microphoneState=false&screenSharingState=false&chatID=
  &tabId=<random>                         (REQUIRED by the deployed server —
                                           the v1.33.5 proto doesn't list it)
```

The **JWT is passed as the WebSocket subprotocol**, not a header or query param:
`new WebSocket(url, [authToken])`.

#### apiVersionHash

The server rejects any mismatch (`IoSocketController`: `if (version !==
apiVersionHash)` → upgrades only to push a "new version" screen, then closes).
It isn't published anywhere, but it's reproducible — `messages/package.json`
computes it as:

```
sha1( sha1sum(protos/messages.proto ../libs/messages/src/JsonMessages/*) )   → first 8 hex chars
```

Run against tag `v1.33.5` (17 `JsonMessages/*.ts` files + `messages.proto`, from
the `messages/` dir so paths read `protos/...` and
`../libs/messages/src/JsonMessages/...`) this yields **`bfd20fc4`**, which the
live server accepts.

### 4. The outer envelope (undocumented)

**Every frame, both directions, is wrapped in an envelope that no public proto
defines:**

```
Envelope {
  1: uint  seq          // increasing counter; starts at 1
  2: bytes payload       // a ServerToClientMessage / ClientToServerMessage;
}                        // repeatable — several inner messages per frame
```

On the wire the first server frame is `08 01 12 04 1a 02 6a 00` =
`{1: 1, 2: <ServerToClientMessage{ roomConnectedMessage:{ editMapCommandsArrayMessage:{} } }>}`.

`wa-client.mjs` handles this with a hand-rolled `_wrap()` / `_unwrap()` (trivial
varint framing — no proto needed for the envelope itself). **This was the single
biggest blocker**: without it, decoding the inner message as a bare
`ServerToClientMessage` fails, and the server closes the socket with `1003
Invalid message format` when you send an unwrapped `ClientToServerMessage`.

### 5. Join sequence

```
open socket
← ServerToClientMessage { roomConnectedMessage: { editMapCommandsArrayMessage: {} } }   (unprompted)
→ ClientToServerMessage {
    joinRoomFrontMessage: {
      name: "claude",
      positionMessage:  { x, y, direction, moving: false },   // direction: UP 0, RIGHT 1, DOWN 2, LEFT 3
      viewportMessage:  { left, top, right, bottom },
      availabilityStatus: 1                                    // ONLINE
    }
  }
← ServerToClientMessage { roomJoinedMessage: { currentUserId, userRoomToken, ... } }
```

No user list arrives in `roomJoinedMessage` (those fields are commented out in
the proto). Other players come as batched sub-messages once you're subscribed to
their zones.

### 6. Movement, and the viewport trap

```
→ ClientToServerMessage {
    userMovesMessage: {
      position: { x, y, direction, moving: true },
      viewport: { left, top, right, bottom }
    }
  }
```

Movement is **client-authoritative** — the server rebroadcasts whatever position
you send, with no collision check.

The server streams `userJoinedMessage` / `userMovedMessage` / `userLeftMessage`
(inside `batchMessage`) only for players in **zones your viewport overlaps**.
Zones are 320×320 px. The catch, from `PositionDispatcher.ts`:

> `MAX_ZONES_PER_VIEWPORT = 1600`. If your viewport covers more, the server
> **crops it to a 1600-zone box centred on the viewport's own centre** — not on
> your avatar.

So "send a huge viewport to see everyone" backfires: you get subscribed to zones
nowhere near yourself and see nobody. The viewport must be a **normal-sized
window centred on your current position** (this client uses ±1920 × ±1080).
Getting this right is what made `:David` show up.

### 7. Text bubbles

```
→ ClientToServerMessage { setPlayerDetailsMessage: { sayMessage: { message, type: 0 } } }
```

`type` 0 = speech bubble, 1 = thinking cloud. (The client methods are
`speechBubble()` / `thoughtBubble()` — the wire field is named `sayMessage` but
this is text over the avatar, not voice.)

### 8. Pings

No application-level `pingMessage` was seen from the deployed server —
WebSocket protocol-level ping/pong (handled by the `ws` library automatically)
is enough to stay connected.

### 9. Voice

`wa sound <name>` plays an audio clip into the proximity voice chat — the same
channel real users talk on. The avatar is a genuine mic participant, not a
special case. The path (`src/wa-audio.mjs`, `src/ogg-opus.mjs`):

1. Connect with `microphoneState=true`.
2. On entering a bubble the server sends `joinSpaceRequestMessage`. Answer with
   a `joinSpaceQuery`, then **`addSpaceFilterMessage`** to *watch* the Space —
   without the watch the back never sets up peer connections.
3. The server picks a transport: `switchMessage { strategy: "WEBRTC" }` for
   small bubbles (P2P mesh), LiveKit once a meeting grows past its threshold.
4. Each other member's client sends a WebRTC **offer** (simple-peer `SignalData`
   JSON — SDP + trickle ICE) via `PrivateSpaceEvent.webRtcSignal`. We answer
   with [werift](https://github.com/shinyoshiaki/werift-webrtc), one peer
   connection per `connectionId`. A data channel is negotiated too — simple-peer
   only reports "connected" once it opens.
   Each connection's initiator role is server-assigned per `webRtcStartMessage`
   — we send the offer or wait for one accordingly.
5. `wa sound` streams Opus packets straight out as RTP (WebRTC audio is Opus).
   Opus-in-Ogg plays as-is; any other format (mp3/wav/…) is transcoded once via
   `ffmpeg` and cached (`src/transcode.mjs`). Bundled clips live in `sounds/`; a
   path argument plays any local file.

LiveKit escalation is detected and logged but not yet implemented — audio stops
publishing when a meeting switches away from WEBRTC.

### 10. Map areas

On connect the client fetches `{pusherUrl}/map?playUri={roomUrl}` → the room's
`.wam` → its `areas` (name, bounds, properties). Each move recomputes which area
rectangles the avatar is inside and emits `areaEnter` / `areaLeave`; `/state`
reports `areas`.

Some maps disable spontaneous proximity meetings — talk happens only through
map areas. On entering a **`livekitRoomProperty`** area the client derives that
meeting's space name the same way the front-end does —
`slugify(shortHash(roomUrl) + "-" + (prop.roomName || prop.id))` — and
**proactively joins the space** (the server never invites a headless client to
an area meeting). It then leaves on `areaLeave`. A 2-person `livekitRoomProperty`
meeting runs on WEBRTC, so `wa sound` works there today; a larger one would need
LiveKit transport (issue #8).

Maps that define areas only in the `.tmj` object layers (older style) aren't
read. `jitsiRoomProperty` areas are detected but not joined (no Jitsi client).

---

## Pathfinding

`navTo(x, y)` routes around walls and furniture. The collision grid is baked
offline by `scripts/build-collision.mjs`, which fetches `open-space.wam` → its
`.tmj` and marks a tile blocked if it is:

1. non-zero in the dedicated `collisions` tile layer (819 cells), or
2. a tile flagged `collides: true` in a tileset (2 on this map), or
3. under a `.wam` furniture entity (chairs/stools → 1 tile, larger props → 3×3).

`MapNav.findPath()` is A\* on the 8-connected grid (octile heuristic, no
corner-cutting) followed by line-of-sight smoothing, so the route is a few long
diagonals rather than a tile-center staircase. `navTo()` re-plans every ~2 s to
track a moving target and falls back to `walkTo()` (straight line) when no route
is found. Verified: across a full cross-map route, 0 of 98 emitted positions
landed in a blocked cell.

It's cosmetic — the server doesn't check collisions — it just makes the avatar
*look* like it's walking the corridors.

### Following

`follow(getTarget)` runs a continuous control loop: small steps every ~100 ms
along a route that's re-planned a few times a second, easing to a stop at
`followPoint()`. `followPoint()` returns a spot one `spacing` short of the
target — *unless* the target is inside an enclosed room (an area whose name
matches `/board\s*room/i`) and the follower isn't, in which case it returns the
nearest reachable free tile just outside that room. Named areas and the room
test both come from `map/collision.json`.

## Limitations / ideas

- **Roster only covers nearby players.** Proximity (zone) visibility works.
  WorkAdventure also has a "Space" system — `WORLD_SPACE_NAME = "allWorldUser"`,
  joined via `queryMessage{ joinSpaceQuery }` + `addSpaceFilterMessage`,
  delivering `initSpaceUsersMessage` / `addSpaceUserMessage` with names but
  **not** room positions. Not implemented; not needed for "walk to a visible
  player".
- **Collision-grid fidelity.** If something still clips, that obstacle probably
  lives in a map layer `build-collision.mjs` doesn't scan (e.g. a furniture tile
  layer); inspect the `.tmj` and widen the script.
- **`followPoint()` "outside the room"** picks the nearest free tile outside the
  room rectangle by straight-line distance to the target, filtered to ones that
  are reachable at all — not the shortest *walk*. Usually lands near the door;
  can pick a wrong-side spot on oddly shaped rooms.
- **Room detection** is name-based (`/board\s*room/i` over the `.wam` areas), not
  geometric.
- Everything server-/map-specific (`version`, `proto/messages.proto`,
  `map/collision.json`) is pinned and needs refreshing on a WorkAdventure or map
  update.

## Contributing

Issues and PRs welcome — especially protocol corrections for newer WorkAdventure
builds, the Space-channel roster, and real map-`start` spawn handling.

## License

[MIT](LICENSE).

`proto/messages.proto` is vendored from
[workadventure/workadventure](https://github.com/workadventure/workadventure)
(also MIT) and remains under its original license. WorkAdventure is a trademark
of its owners; this project is unaffiliated.
