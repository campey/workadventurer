# workadventurer

A **headless WorkAdventure client** — no browser, no game engine. A Node process
speaks the pusher `/ws/room` WebSocket + protobuf protocol directly, so it has a
real avatar with presence in a room: it appears on the map, walks around, sees
other players, and can talk.

Built to answer "log into the afrolabs open-space as `claude` and walk over to
find `:David`" — which it does (`src/find-david.mjs`).

```
node src/find-david.mjs            # find & follow a player called "David"
node src/find-david.mjs Alice      # ... or someone else
```

Ctrl-C to leave the room.

## Layout

| File | Purpose |
|---|---|
| `src/wa-client.mjs` | `WorkAdventureClient` — connection, protocol, world model, `walkTo()` / `say()` |
| `src/find-david.mjs` | driver: connect → locate target → walk over → say hi → follow |
| `proto/messages.proto` | vendored from `workadventure` tag `v1.33.5` (the deployed version) |

Deps: `ws`, `protobufjs` (runtime `.load()`, no codegen step).

---

## The protocol, as reverse-engineered

Target: `https://play.workadventu.re` (hosted SaaS), room
`/@/afrolabs/afrolabs/open-space`, server build **v1.33.5**
(`window.env.SENTRY_RELEASE` in the room HTML).

Sources cross-referenced: `play/src/front/Connection/RoomConnection.ts`,
`play/src/pusher/controllers/IoSocketController.ts`,
`play/src/pusher/models/PositionDispatcher.ts`.

### 1. Endpoints

`window.env` (inline in the room HTML) gives the service URLs. The important one:

```
PUSHER_URL = https://pusher.workadventu.re     # NOT same-origin as play.
DISABLE_ANONYMOUS = false
```

`GET https://pusher.workadventu.re/map?playUri=<room>` →
`authenticationMandatory: false` for this room, so anonymous can join.

`GET https://pusher.workadventu.re/woka/list?roomUrl=<room>` (with
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

#### `apiVersionHash`

The server rejects any mismatch (`IoSocketController`: `if (version !==
apiVersionHash)` → upgrade only to push a "new version" screen, then close). It
is **not** published anywhere, but it is reproducible: `messages/package.json`
computes it as

```
sha1( sha1sum(protos/messages.proto ../libs/messages/src/JsonMessages/*) )   → first 8 hex chars
```

Run against tag `v1.33.5` (17 `JsonMessages/*.ts` files + `messages.proto`, from
the `messages/` dir so the paths read `protos/...` and
`../libs/messages/src/JsonMessages/...`) this yields **`bfd20fc4`**, which the
live server accepts. Recompute if the deployed version changes.

### 4. The outer envelope (undocumented)

**Every frame in both directions is wrapped in an envelope that no public proto
defines:**

```
Envelope {
  1: uint  seq          // increasing counter; starts at 1
  2: bytes payload       // a ServerToClientMessage / ClientToServerMessage,
}                        // repeatable — several inner messages per frame
```

On the wire the first server frame is `08 01 12 04 1a 02 6a 00` =
`{1: 1, 2: <ServerToClientMessage{ roomConnectedMessage:{ editMapCommandsArrayMessage:{} } }>}`.

`wa-client.mjs` handles this with a hand-rolled `_wrap()` / `_unwrap()` (trivial
varint framing — no proto needed for the envelope itself). **This was the single
biggest blocker**: without it, decoding the inner message as a bare
`ServerToClientMessage` fails and the server closes the socket `1003 Invalid
message format` when you send an unwrapped `ClientToServerMessage`.

### 5. Join sequence

```
open socket
← ServerToClientMessage { roomConnectedMessage: { editMapCommandsArrayMessage: {} } }   (unprompted)
→ ClientToServerMessage {
    joinRoomFrontMessage: {
      name: "claude",
      positionMessage:  { x, y, direction, moving:false },   // direction: UP0 RIGHT1 DOWN2 LEFT3
      viewportMessage:  { left, top, right, bottom },
      availabilityStatus: 1                                    // ONLINE
    }
  }
← ServerToClientMessage { roomJoinedMessage: { currentUserId, userRoomToken, ... } }
```

No user list arrives in `roomJoinedMessage` (the fields are commented out in the
proto). Other players come as batched sub-messages once you're subscribed to
their zones.

### 6. Movement and seeing players — the viewport trap

Movement:

```
→ ClientToServerMessage {
    userMovesMessage: {
      position: { x, y, direction, moving:true },
      viewport: { left, top, right, bottom }
    }
  }
```

Movement is **client-authoritative** — the server rebroadcasts whatever position
you send, with no collision check.

The server streams `userJoinedMessage` / `userMovedMessage` / `userLeftMessage`
(inside `batchMessage`) only for players in **zones your viewport overlaps**.
Zones are 320×320 px. The catch (`PositionDispatcher.ts`):

> `MAX_ZONES_PER_VIEWPORT = 1600`. If your viewport covers more, the server
> **crops it to a 1600-zone box centred on the viewport's own centre** — not on
> your avatar.

So a "just send a huge viewport to see everyone" approach backfires: you get
subscribed to zones nowhere near yourself and see nobody. The viewport must be a
**normal-sized window centred on your current position** (this client uses
±1920 × ±1080). Getting this right is what made `:David` show up.

### 7. Talking

```
→ ClientToServerMessage { setPlayerDetailsMessage: { sayMessage: { message, type: 0 } } }
```

`type` 0 = speech bubble, 1 = thinking cloud.

### 8. Pings

No application-level `pingMessage` was observed from the deployed server —
WebSocket protocol-level ping/pong (handled by the `ws` library automatically)
appears to be all that's needed to stay connected.

---

## Known gaps / next steps

- **Player list without walking near people.** Proximity visibility (zones)
  works. WorkAdventure also has a "Space" system — `WORLD_SPACE_NAME =
  "allWorldUser"` — joined via `queryMessage{ joinSpaceQuery }` +
  `addSpaceFilterMessage`, delivering `initSpaceUsersMessage` /
  `addSpaceUserMessage` with names but **not room positions**. Not implemented;
  not needed for "walk to a visible player".
- **Pathfinding.** `walkTo()` moves in a straight line and will visually clip
  through walls. Real routing needs the Tiled map
  (`https://afrolabs-16156.map-storage.workadventu.re/open-space.wam` → `.tmj`
  collision layer) and A*.
- **Spawn position** is hard-coded; the map's `start` layer is not read.
- `apiVersionHash` and the vendored proto are pinned to `v1.33.5` and will need
  refreshing when the SaaS updates.
