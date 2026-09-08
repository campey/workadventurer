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

## Requirements

- Node 18+ (uses the built-in `fetch`)
- `npm install` (`ws`, `protobufjs` — protobuf is loaded at runtime, no codegen)

## Quick start

```sh
npm install
node src/find-player.mjs            # join the room, find & follow a player called "David"
node src/find-player.mjs Alice      # ... or whoever
```

`Ctrl-C` to leave the room.

`find-player.mjs` connects anonymously as `claude`, spawns on the map's `start`
tile, waits for the roster, walks (routing around walls and furniture) to the
first player whose name contains the target string, pops a speech bubble, then
follows them continuously — stopping one "personal space" short, and waiting
just *outside* if the target steps into an enclosed room (a board room).

## Using the client directly

```js
import { WorkAdventureClient } from "./src/wa-client.mjs";

const wa = new WorkAdventureClient({ name: "claude" });
wa.on("playerJoined", (p) => console.log("saw", p.name, "at", p.x, p.y));
await wa.connect();                       // anon login + handshake + join

await wa.navTo(2378, 1340);                 // A* route around obstacles
await wa.walkTo(2378, 1340);                // straight line, ignores walls
await wa.follow(() => wa.players.get(id));  // fluid continuous follow, room-aware
wa.say("hello");                            // speech bubble
console.log(wa.listPlayers());              // [{ userId, name, uuid, x, y }]
wa.close();
```

`new WorkAdventureClient(opts)` — `name`, `roomUrl`, `pusherUrl`, `version`
(apiVersionHash), `wokaId`, `spawn`, `nav` all have defaults for the afrolabs
open-space. With no `spawn`, the client picks a random tile from the map's
`start` layer.

## Project layout

| Path | What |
|---|---|
| `src/wa-client.mjs` | `WorkAdventureClient` — connection, protocol, world model, `navTo()` / `walkTo()` / `say()` |
| `src/map-nav.mjs` | `MapNav` — A\* over the tile grid + line-of-sight smoothing |
| `src/find-player.mjs` | the driver: connect → locate target → walk over → say hi → follow |
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

### 7. Talking

```
→ ClientToServerMessage { setPlayerDetailsMessage: { sayMessage: { message, type: 0 } } }
```

`type` 0 = speech bubble, 1 = thinking cloud.

### 8. Pings

No application-level `pingMessage` was seen from the deployed server —
WebSocket protocol-level ping/pong (handled by the `ws` library automatically)
is enough to stay connected.

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
