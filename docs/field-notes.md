# Field notes

Hard-won knowledge from reverse-engineering and operating this client that
doesn't fit the README's reference style — failure modes, non-obvious
mechanics, and things that will bite a future session. The README's
`## The protocol` is the message-by-message reference; this is the "why is
it doing that" companion.

---

## Spawn point: `.wam` start area beats the `.tmj` `start` layer

WorkAdventure's real spawn is a **`.wam` area with a `{ type: "start" }`
property** (the map-editor "Start area"), `isDefault: true` preferred — *not*
the Tiled `.tmj`'s `start` tile layer. On shared template maps the `.tmj`
`start` layer is often a stale default in a completely different spot
(afrolabs: the tile layer sits ~600 px north of the actual "Spawn Point" by
the fire).

The client handles this in `connect()`: after `_loadAreas()` populates
`this.areas` from the live `.wam`, `_wamSpawnPoint()` picks a random point
inside the start area and sets `this.pos` before the join message goes out.
An explicit `spawn` opt still wins; the baked `start` tile layer is only a
last-resort fallback.

**`scripts/build-collision.mjs` still bakes only the `.tmj` tile layer** into
`collision.json`'s `start` field — that's the offline fallback used if the
`.wam` fetch fails at connect. Teaching the baker about `.wam` start areas is
an open follow-up.

---

## `#10` — the red mic, and why a bounded prime fixes it

**Symptom:** a peer renders our mic red ("microphone is on, but I'm receiving
no audio"). It clears the instant any RTP arrives and stays clear until the
next silent gap.

**Cause:** we advertise `microphoneState: true` continuously (join
re-announces, `initSpaceUsersMessage`, `_setSpeaking`), but `WaAudio` only
writes RTP *during* a clip. Between clips a real browser mic still streams
Opus; we send nothing, so peers flag the mic.

**Fix (`_primeMic`, PR #26):** on `pc connected`, play one ~0.4 s silence
clip (`silenceOpusFile()` — cached ffmpeg `anullsrc`) through the normal
`play()` path, with `{ indicator: false }` so it re-asserts mic-on without
lighting the speaking ring. Bounded burst → nothing to leak.

**Do NOT replace this with a continuous keepalive stream.** Tried and
abandoned — it OOMs the daemon in ~2 minutes. See below.

**Also:** firing RTP within ~1 s of `pc connected` can transiently leave the
browser peer with no media tile (recovers on reconnect). 0.4 s is late
enough that this is rare; a longer clip fired instantly on connect is
riskier.

---

## werift constraints

### Two headless clients can't complete ICE to each other

Running two `WaAudio` instances on one host and pointing them at each other
does **not** produce a connected peer — werift↔werift ICE through
STUN/TURN doesn't complete on a single NAT. So the connected send path can
only be exercised against a real browser peer. Unit tests use a fake peer
object (`{ pc: { connectionState: "connected" }, track: { writeRtp } }`);
anything touching a live socket is verified with `scripts/selfcheck.mjs` and
manual runs, not `node --test`.

### Un-awaited RTP send fan-out

`RTCRtpSender` subscribes to `track.onReceiveRtp` with an **async handler
that `Event.execute` calls without awaiting** (`werift/lib/common/src/event.js`).
Every `track.writeRtp()` fire-and-forgets an async `sendRtp` (SRTP encrypt →
`dtlsTransport.sendRtp`). When the transport keeps up they resolve fast; when
it's slow (staging, TURN relay) they accumulate unbounded.

- A **bounded** burst (a clip, the 21-packet prime) drains in the silent gaps
  — fine.
- A **continuous** 50 pkt/s stream never drains if the transport is even
  slightly slow → heap OOM in ~2 min. This is why the mic keepalive was
  abandoned.
- If a continuous stream is ever needed (real-time TTS), send via
  `await pc.getSenders()[0].sendRtp(pkt)` directly — that path is awaitable,
  giving natural backpressure — plus a per-send timeout and an RSS watchdog.

### Peer-connection lifecycle leak — issue #29 (open)

Repeated `RTCPeerConnection` create → connect → close (proximity bubbles,
invites) balloons the daemon RSS and pins CPU ~100% with the HTTP control API
dead, after ~3–6 cycles on staging (more on prod). `pkill -9` to recover.

werift's `close()` *looks* correct (it `completePeerEvents()`), so the leak is
subtler: `_closePeer` fires `pc.close()` without `await` (it's async — awaits
SCTP/DTLS teardown), and never stops the `MediaStreamTrack` / transceiver.
Needs `--inspect` + heap snapshots across N cycles — **do not keep
guess-fixing it live.** Workaround: restart the daemon every few cycles.

### Misc

- **simple-peer needs a data channel.** The browser side (simple-peer) only
  fires "connected" once a data channel opens, so werift must
  `pc.createDataChannel("simplepeer")` or the meeting hangs at "Connecting…".
- **Stable RTP identity per peer.** `ssrc` / `seq` / `ts` are set once at
  connection and advance monotonically like a real mic. Switching `ssrc`
  between clips makes the receiver latch the first source and drop later ones.
- **`pc.close()` is `async`** — `_closePeer` should `await` it (see #29).

---

## Map areas: dwell debounce

`_handleAreaMeeting` used to `_joinSpace` / `_leaveSpace` on **every**
`livekitRoomProperty` area boundary the avatar crossed. On an area-dense map
(staging `wa-village` has 73 areas, many overlapping) a single walk clips
through several — spinning a WebRTC peer up and straight back down per
crossing. That churn balloons werift (800 MB+, 100 % CPU) and floods the
browser with offer/answer negotiation (observed: Chrome crashed).

**Debounced (PR #28):** join only after **1.5 s continuously inside** (a real
dwell, not a walk-through), and linger **2.5 s** after leaving before tearing
down. Timers keyed by space name, cleared on `close()`. Walking through is now
a no-op; stopping in a meeting area still works.

`jitsiRoomProperty` areas are detected but not handled at all — the client has
no Jitsi transport. Walking into one is out of scope and has confused the
daemon in the past.

---

## Movement niceties

- **`frontOf(target, spacing)`** — stand in the direction the player is
  *facing* (their eyeline), not behind or beside them. Players' `direction`
  (0 = up, 1 = right, 2 = down, 3 = left) is tracked from position messages.
  Falls back to `followPoint` when facing is unknown or that spot is walled
  off. The daemon's `standPoint` (used by `wa to`, `greet`, invite walks)
  uses it; `STAND_GAP` is 30 px, `MIN_STAND` 24 px.
- **`walkToPlayer` aborts when the target leaves view.** It tracks the
  player's live position but, if they vanish, gives a 3 s grace then returns
  (`navTo` bails on a null target) instead of marching toward their stale
  last-known spot for the full timeout — which used to wedge the event loop
  against audio teardown.
- **Per-room collision maps.** `map/<org>/<world>/<room>/collision.json`,
  keyed by the path after `/@/`. `MapNav.loadForRoom(roomUrl)` resolves it;
  no baked file → `nav = null` → straight-line movement (still cosmetic —
  the server never checks collisions).

---

## Version targets (adapters)

`src/adapters/` — one adapter per WorkAdventure `major.minor`. See README
`## Version targets` for selection logic. Field notes:

- **Prod is one server.** `play.workadventu.re` hosts afrolabs, lean-iterator,
  tcm, … all on the tagged release (`v1.33.5` → `wa-1.33`).
- **Staging is rolling `master`**, untagged — `play.staging.workadventu.re`.
  Its commit sha *moves between sessions* (`7c5ff99b` → `7d628838` → …), and
  each move can shift the `apiVersionHash`. `wa-master` warns on sha drift;
  refresh it with `node scripts/vendor-proto.mjs master wa-master` (prints the
  recomputed hash — self-verified: `v1.33.5` → `bfd20fc4`).
- **Staging has its own everything.** Different pusher
  (`pusher.staging.workadventu.re`) and a **different woka catalogue** — a
  production woka id returns `invalid character texture`. Use a staging id
  (`62b0c71f-f396-432b-a4c8-4d369d73e766` = "Leo"). Set `WA_PUSHER_URL` +
  `WA_WOKA_ID` alongside `WA_ROOM`.
- Proto diff `v1.33.5` vs staging `master`: changes only in VideoQuality
  analytics messages — nothing in Space / SpaceUser / Emote / Sub. The
  behaviour is close; staging's problems (worse `#10`, flakier peers) are
  environmental, not protocol drift.

---

## "Invite over" (MeetingInvitation)

Clicking a woka → "invite to discussion" drives `MeetingInvitationRequest…`.
The headless client responds: `_handle` surfaces
`meetingInvitationRequestReceivedMessage` as an `inviteReceived` event; the
daemon auto-accepts (`acceptMeetingInvitation`), resolves the sender (by
`userId`, else `playerByUuid`), and `walkToPlayer()`s over — one-shot, same
stand-in-front as `wa to`, interrupts an active follow. Driven entirely from
the browser; no CLI command. `/state` reports `lastInvite`.

Rapid-fire invites (several in a few seconds) hit issue #29.

---

## Testing approach

- **`npm test`** (`node --test`) covers pure logic only: adapter resolution,
  the area-meeting debounce timers, invite message shapes, the mic-prime with
  a fake peer. No sockets.
- **`node scripts/selfcheck.mjs [--target <id>] [--room <url>]`** — ephemeral
  client, real join: connect / adapter match / move / bubble / area-meeting
  join / audio (SKIP without a second participant). The prod run is the merge
  gate for anything touching `src/`.
- **Live audio / media-tile / mic behaviour** needs a human in the room —
  automated runs can't see the browser and can't form a werift↔werift peer.
- The `workadventure` subagent drives repeated live scenarios (join, walk to
  a player, invite, monitor RSS/HTTP). Watch its RSS trace — a steady climb
  past ~300 MB or an HTTP timeout means #29 is biting; `pkill -9` and restart.
