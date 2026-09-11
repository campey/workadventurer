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

### Two headless daemons *can* talk to each other — but not reliably at 3+

Two `WaAudio` instances (e.g. a "claudetest" talker + a "scribe" listener),
each properly joined to the same real WA room with its own name/port, **do**
negotiate and pass real audio — clean 1:1, reproducibly, with the sender's
`writeRtp` reporting zero errors and the receiver actually decoding correct
text out the other end. (An *isolated* pair of bare clients with no real
room/signaling infra doesn't connect — that's a different, narrower claim than
"werift can't do werift".)

What doesn't hold up: **3+ peers connecting around the same time** (e.g. two
headless avatars *and* a real user, all in one bubble) can produce an answer
SDP with **zero ICE candidates** for one specific connection while sibling
connections in the same session negotiate fine — `pc connected` still fires
(ICE/DTLS/datachannel all "succeed") but no media ever arrives
(`buflen=0` forever on the receive side). Looks like a race under concurrent
`_iceComplete`/gathering. See issue #32; not yet root-caused. `SDP_DEBUG=<dir>`
env var on `wa-audio.mjs` dumps every offer/answer to `<dir>/<connId>-<label>.sdp`
for exactly this kind of investigation.

Unit tests use a fake peer object (`{ pc: { connectionState: "connected" },
track: { writeRtp } }`) rather than a real connection either way — even a
working 1:1 handshake takes real network round-trips and a live WA room, too
slow/flaky for `node --test`. Anything touching a live socket is verified with
`scripts/selfcheck.mjs`, `scripts/stt-selfcheck.mjs`, and manual runs.

### MLX / Metal isn't safe for concurrent inference

Running two STT sessions' `mlx_whisper.transcribe()` calls at the same time
(two peers each on their own `asyncio.to_thread`) crashes the whole worker
process: `AGXG14GFamilyCommandBuffer ... failed assertion 'A command encoder
is already encoding to this command buffer'`. Serialize all inference calls
behind one `threading.Lock` in the worker — the async tick loops stay
concurrent for buffering/timing, only the actual GPU call queues
(`scripts/stt_worker.py`).

### `SttStream` has an unexplained startup race

Even in the simplest possible setup (`scripts/stt-selfcheck.mjs` — one
process, no WA, no daemon), the very first connection attempt occasionally
produces nothing at all: no `partial`, no `final`, no error, worker reports
"connected" but the socket never seems to move data. Not root-caused (ruled
out: socket-not-yet-listening — `asyncio.start_unix_server`'s `await`
guarantees the bind is done before the log line prints; ffmpeg buffering —
already forced `-f ogg`/`nobuffer`). `SttStream._start()` now has a cheap
mitigation: if no socket data arrives within 3 s of connecting, kill and retry
once. That has been enough in practice (multiple back-to-back clean runs after
adding it), but the underlying cause is still open — worth a proper look if it
resurfaces or starts happening more than once per session.

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

### Peer-connection lifecycle leak — issue #29 (open, milder than first thought)

Repeated `RTCPeerConnection` create → connect → close (proximity bubbles,
invites) can balloon the daemon RSS and pin CPU ~100% with the HTTP control
API dead. `pkill -9` to recover.

werift's `close()` *looks* correct (it `completePeerEvents()`), so if there's
a residual leak it's subtler: `_closePeer` fires `pc.close()` without `await`
(it's async — awaits SCTP/DTLS teardown), and never stops the
`MediaStreamTrack` / transceiver explicitly.

**Update:** two of the three big hangs that looked like this turned out to be
*other* bugs compounding ordinary peer churn, not the leak itself:
- one was the area-meeting walk-through churn — fixed by the dwell debounce
  (see below, PR #28)
- one was `walkToPlayer` marching toward a vanished player's stale position
  for the full 90s timeout, piling its tick load on top of teardown — fixed
  in the same PR

After both fixes, ~5 human-paced invite cycles from a fixed spot held RSS flat
(77–95 MB) with HTTP always 200, and later the STT work ran two headless
daemons through repeated connect/disconnect cycles with no issue either. The
`await`/track-stop gap above is still real and worth fixing, but proving a
*residual* leak now needs a long, deliberately aggressive run
(`--inspect` + heap snapshots) — the everyday-use severity is much lower than
it first appeared. Don't guess-fix it live.

Anything that spawns a real subprocess per peer connection (the STT worker's
`ffmpeg`, the mic prime — less so, it's bounded) needs an explicit guard
against this churn: a per-connection single-fire check (`onTrack` can in
principle fire more than once) and a hard cap on concurrent instances
(`MAX_STT_STREAMS` in `wa-audio.mjs`). Without both, a burst of peer-connect
churn spun up unbounded worker/ffmpeg pairs and spiked the daemon to 100%+
CPU before a single "pc connected" line had even printed.

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
  the area-meeting debounce timers, invite message shapes, the mic-prime and
  Ogg mux with a fake peer / no live socket.
- **`node scripts/selfcheck.mjs [--target <id>] [--room <url>]`** — ephemeral
  client, real join: connect / adapter match / move / bubble / area-meeting
  join / audio (SKIP without a second participant). The prod run is the merge
  gate for anything touching `src/`.
- **`node scripts/stt-selfcheck.mjs [clip.wav]`** — the STT pipeline
  standalone, no WA connection: streams a real clip's Opus packets through
  `SttStream` at real-time pace and checks a `partial` then a `final` land.
- **A second headless daemon instance is a legitimate live-test participant**
  now that daemon↔daemon audio is proven (see werift constraints above) — spin
  up two named instances (`WA_NAME`/`WA_DAEMON_PORT` per instance, same room)
  for anything that needs a real peer without a human. Keep it to **2** at a
  time; 3+ concurrent connections is the still-open #32 territory.
- **Media-tile / red-mic / "does it sound right" behaviour** still needs a
  human watching a real browser — that side of it can't be automated.
- The `workadventure` subagent drives repeated live scenarios (join, walk to
  a player, invite, monitor RSS/HTTP). Watch its RSS trace — a steady climb
  past ~300 MB or an HTTP timeout means #29 is biting; `pkill -9` and restart.
