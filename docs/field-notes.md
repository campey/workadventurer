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

## `#10` — the red mic, mic-state propagation

**Symptom:** a peer renders our mic red ("microphone is on, but I'm receiving
no audio"). It clears the instant any RTP arrives and stays clear until the
next silent gap.

**Cause:** we advertise `microphoneState: true` (join re-announces,
`initSpaceUsersMessage`, `_setSpeaking`), but `WaAudio` only writes RTP
*during* a clip. Between clips a real browser mic still streams Opus; we send
nothing, so peers flag the mic.

**Fix (`_primeMic`, PR #26):** on `pc connected`, play one ~0.4 s silence
clip (`silenceOpusFile()` — cached ffmpeg `anullsrc`) through the normal
`play()` path, with `{ indicator: false }` so it re-asserts mic-on without
lighting the speaking ring, and fires *immediately* on connect, not on a
delay. Bounded burst → nothing to leak.

**Do NOT replace this with a continuous keepalive stream.** Tried and
abandoned — it OOMs the daemon in ~2 minutes. See below.

**Also:** firing RTP within ~1 s of `pc connected` can transiently leave the
browser peer with no media tile (recovers on reconnect). 0.4 s is late
enough that this is rare; a longer clip fired instantly on connect is
riskier.

**`client.micOn` is the single source of truth — every mic-announcing path
respects it; none hardcode `true`.** The STT `listen` mode (issue #23)
reintroduced #10 in a new form: a listener that ignored `micOn` and ran the
full talker announce schedule anyway would race its own explicit "mic off"
on connect, last-writer-wins. Fixed by making every path — the daemon's
`WorkAdventureClient` construction, `_joinSpace`'s re-announce schedule,
`_setSpeaking`, and the `pc connected` handler's prime-vs-honest-false
branch — read `client.micOn` instead of assuming a role. This also makes the
mic path forward-compatible with a persona that both listens and talks: no
special-casing on `listen` anywhere in the mic-state code.

Two related gaps closed alongside it: `_primeMic` now retries once and falls
back to an honest `setSpaceMicState(false)` on repeated failure (a missing
ffmpeg or a corrupt cached clip used to leave the mic claimed-on with nothing
ever sent — the failure-recovery version of the same bug); a corrupt/empty
cache entry (`transcode.mjs`'s `invalidateCache()`) is deleted on detection
instead of poisoning that cache key forever; `play()` claims its `_play`
in-flight guard synchronously at function entry, before its own awaits, so
two near-simultaneous calls (a prime racing a real clip, or two peers
connecting a few ms apart) can't both slip past the guard and corrupt each
other; and `_leaveSpace` clears any pending `micReannounceMs` timers so a
fast leave→rejoin (routine with the area-meeting dwell/linger debounce)
can't have a stale timer fire against a later membership.

---

## werift constraints

### Two (or more) headless daemons can talk to each other

Two `WaAudio` instances (e.g. a "claudetest" talker + a "scribe" listener),
each properly joined to the same real WA room with its own name/port, **do**
negotiate and pass real audio — clean 1:1, reproducibly, with the sender's
`writeRtp` reporting zero errors and the receiver actually decoding correct
text out the other end. (An *isolated* pair of bare clients with no real
room/signaling infra doesn't connect — that's a different, narrower claim than
"werift can't do werift".)

What used to not hold up: **3+ peers connecting around the same time** (e.g.
two headless avatars *and* a real user, all in one bubble) could produce an
answer SDP with **zero ICE candidates** for one specific connection while
sibling connections in the same session negotiated fine — `pc connected`
still fired (ICE/DTLS/datachannel all "succeed") but no media ever arrived
(`buflen=0` forever on the receive side). **Root-caused and fixed 2026-09-12
(issue #32).** The earlier hypothesis here ("a race under concurrent
`_iceComplete`/gathering") was wrong — `_iceComplete()` is largely a no-op,
since `setLocalDescription` already awaits gathering internally, and it can't
even detect the failure: werift's ICE gathering (`ice/src/ice.js`
`Connection.gatherCandidates`) *always* reports `"complete"`, wrapping
everything in `Promise.allSettled` and unconditionally calling
`setState("completed")` even when every candidate type (host bind, STUN
srflx, TURN allocate) individually failed.

The real mechanism: `_loadIce()` used to only start on the client's
`spaceJoined` event — which fires *after* `_joinSpace` has already sent
`addSpaceFilterMessage`, and it's that message which makes the back start
setting up peer connections. Any `RTCPeerConnection` built in that window got
werift's constructor-default STUN-only list (`{urls:
"stun:stun.l.google.com:19302"}`, no TURN) — werift snapshots `iceServers`
synchronously at construction and never re-reads it; there's no
`pc.setConfiguration()` anywhere. Confirmed live before the fix: one
connection's offer was sent at `T+0s` while the real ICE list only arrived at
`T+89s` — that connection was permanently on STUN-only, no TURN, while a
sibling that started after the list arrived worked fine. WorkAdventure's own
front-end (`IceServersManager.ts` + `SimplePeer.ts`) avoids this by the same
shape of fix we landed: a memoized ICE-servers promise, fetched eagerly right
after `roomJoinedMessage` (not gated on any later join event), that every
peer construction `await`s before building its `RTCPeerConnection` —
confirms this is the correct mechanism, independently arrived at.

Fix (`WaAudio`, `src/wa-audio.mjs`): `_iceReady` is now a memoized promise
kicked off eagerly in the constructor; `_peer()`/`_buildPeer()` reserves a
`connectionId → Promise<peer>` slot synchronously (so two near-simultaneous
calls for the same id share one construction) and awaits `_iceReady` before
constructing the `RTCPeerConnection`. Defensively, `_makeOffer()` and the
offer branch of `_onSignal()` now count `a=candidate:` lines in the local
SDP after `_iceComplete()` and tear the connection down instead of shipping
a guaranteed-dead offer/answer if it's zero — belt-and-suspenders given
werift can't be trusted to report gathering failure any other way. A bounded
`_closedConnIds` set stops a late signal from resurrecting a connection
that's already been torn down (failed/closed/superseded), and the supersede
check (a fresh connectionId retiring an old one for the same user) now
checks in-flight connections too, not just fully-built ones — a real gap the
async refactor itself would otherwise have introduced. `SDP_DEBUG=<dir>` env
var on `wa-audio.mjs` dumps every offer/answer to
`<dir>/<seq>-<connId>-<label>.sdp` (a monotonic `<seq>` now, so
renegotiations/retries on one connection don't overwrite each other's dumps).

Verified live: a 3-headless-daemon session that reliably showed the
zero-candidate failure pre-fix ran clean post-fix — every offer/answer in a
4-way bubble (3 daemons + a real browser participant) carried real ICE
candidates, and a real clip played from one daemon reached the others.

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

**Update 2, found chasing #8 with V8 CPU profiling of a live reproduction**:
a *third*, independently-confirmed cause producing this exact
CPU-pinned/RSS-ballooned/HTTP-dead symptom, with no werift or peer-connection
code anywhere in the hot path — `_navTo`'s tight-loop spin near a crowded or
jittery `getTarget()` (see the LiveKit section below). The "3–4
proximity-bubble/invite cycles → 106% CPU, HTTP dead" case in the original
symptom table above reads identically to this mechanism. Doesn't rule out a
residual werift leak, but means this issue's symptom table now has *three*
confirmed-independent causes, not one — worth re-testing what's left of #29
with the `_navTo` fix in place before spending more effort chasing werift.

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

## LiveKit transport (issue #8)

Past WA's P2P-mesh size threshold, a meeting escalates from proximity WEBRTC
to a LiveKit SFU: `switchMessage`/`finalizeSwitchMessage{strategy:"LIVEKIT"}`
are informational only — the actual trigger to connect is
`livekitInvitationMessage{token, serverUrl}`, and it isn't guaranteed to
arrive in any particular order relative to the switch messages. Don't gate
connecting on the switch messages; gate it on the invitation.

**Library: `@livekit/rtc-node`**, not `livekit-client` (browser-only) or
`livekit-server-sdk` (admin/token-only, no media). Native napi-rs bindings
(`@livekit/rtc-ffi-bindings-darwin-arm64` etc., prebuilt) — this project's
first native dependency. The public API was verified against the installed
package's own `.d.ts`/`.cjs` and README before writing any integration code,
not assumed from docs alone — worth doing again if this package majors.

- **Publish needs raw PCM, not Opus.** `AudioSource(sampleRate, channels)` →
  `LocalAudioTrack.createAudioTrack(name, source)` →
  `room.localParticipant.publishTrack(track, opts)` (`opts.source =
  TrackSource.SOURCE_MICROPHONE`) → `source.captureFrame(new
  AudioFrame(int16Samples, sampleRate, channels, samplesPerChannel))` per
  chunk. `src/transcode.mjs`'s `ensurePcm()` is the sibling to `ensureOpus()`
  for this — `ffmpeg -f s16le`, same mtime+size cache pattern.
- **`captureFrame()` does not self-pace, and that's fine — don't pace it
  yourself either.** Reading the actual implementation (not just the types)
  shows it only awaits the FFI round-trip that confirms the frame was
  *accepted* into the native jitter buffer, not real playback time. It's
  tempting to read that as "so I must pace my own calls to real-time" (the
  WEBRTC/RTP path does exactly that, since raw RTP has no buffer of its
  own) — but `AudioSource` already has its own internal jitter buffer
  (`queueSize`, default 1000ms — bump it if a clip is longer than that) and
  paces *actual playout* itself. `_playLiveKit()` feeds 20ms chunks
  back-to-back with no pacing of its own; `captureFrame()`'s own await is
  throttling enough. (An external wall-clock pacer was tried first, on the
  theory that skipping it would starve the buffer — that theory was wrong;
  see the `.slice()` bug below for what the buzz it seemed to explain
  actually was.)
- **The `.slice()`-vs-`.subarray()` footgun is worse than LiveKit's own docs
  make it sound — it silently corrupts data, not just risks a crash.**
  `AudioFrame.protoInfo()` (inside `@livekit/rtc-node` itself) hands the
  native FFI side `this.data.buffer` directly, ignoring the typed array's
  own `byteOffset`/`length` entirely. Chunk a longer buffer with
  `.subarray()` and every chunk's data pointer resolves to byte 0 of the
  *whole original buffer*, regardless of which chunk you meant — not a
  crash, not an exception, just silently wrong audio. For repeated 20ms
  playback chunks, that means every single frame sent is actually the
  clip's first 20ms, over and over: a perfectly periodic artifact at the
  frame rate (50 times/second → an audible ~50Hz buzz, confirmed live —
  its suspiciously exact frequency was the tell). `.slice()` on a plain
  `Int16Array` copies into a fresh, independent, zero-offset buffer, which
  is what this FFI binding actually needs. This is the *reverse* of the
  usual `Buffer` advice below (there, `.slice()` is the view/footgun and
  `.subarray()` the safe copy-avoiding choice) — the direction flips
  because `Buffer.prototype.slice` is a Node-specific override, while a
  plain `Int16Array`'s `.slice()`/`.subarray()` follow the standard
  ECMAScript TypedArray contract (`.slice()` copies, `.subarray()` views).
  Don't assume the convention carries over just because the method names
  match.
- **Buffer alignment footgun** (separate issue, same neighborhood): a
  `Buffer` from `fs.readFile()` is a view into Node's shared buffer pool and
  its `byteOffset` is not guaranteed even. Constructing an `Int16Array`
  directly over `buffer.buffer` can throw ("start offset ... must be a
  multiple of 2") or silently read garbage depending on the offset you
  happened to get. The robust fix used here: `new Int16Array(new
  Uint8Array(buffer).buffer)` — the `Uint8Array` constructor copies when
  given an existing typed array, landing you on a fresh, zero-offset
  `ArrayBuffer` before you reinterpret it. (This one was correct from the
  start and never the cause of the buzz above — the two bugs just live in
  adjacent lines of the same function, easy to conflate.)
- **`dispose()` is process-global, one-shot — not per-room.** It releases
  the shared FFI runtime for the whole process. Call it once at daemon
  shutdown (`disposeLiveKitRuntime()` in `wa-daemon.mjs`'s SIGINT/SIGTERM
  path), never inside a per-`livekitDisconnectMessage` handler — a meeting
  can de-escalate and re-escalate LiveKit more than once in one daemon's
  lifetime, and disposing the runtime mid-session would break every
  subsequent connect attempt. `WaAudio` tracks module-level "was LiveKit
  ever used this process" so the shutdown call is a no-op for the (common)
  case of a daemon that never escalates.
- **Scope, deliberately.** This pass is connect + publish only. Not done:
  subscribing to others' LiveKit audio (would let STT work over LiveKit too
  — and would actually be *simpler* than the current WEBRTC route, since
  `AudioStream` hands you PCM directly instead of Opus RTP that needs muxing
  to Ogg and ffmpeg-decoding); robust switch-back-to-WEBRTC if a meeting
  shrinks back below the threshold mid-session.

### Live status: resolved — publish confirmed audible and correct

Connect + publish is verified at the SDK/protocol level (correct token
claims, correct track kind, clean `publishTrack()`/`play()` results — see
the bullets above) *and*, after fixing the two bugs below, confirmed
audible and correct by a human listener, on two separate physical
machines/headphones, for both a short clip (`chime`) and real speech
(`claude_intro`, 4.24s).

Getting there took two unrelated bugs, both found live against a real
escalated meeting with several real participants:

1. **The daemon kept crashing on approach, well before LiveKit even entered
   the picture.** CPU to 100–300%+, RSS to 1GB+, unresponsive to SIGTERM.
   V8 CPU profiling of two live reproductions showed the hot path was
   entirely `_navTo`/`findPath`/`walkTo`/protobuf-encode/`ws`-send — no
   werift, no LiveKit anywhere in it. Root cause and fix are in
   `_navTo`, `src/wa-client.mjs` (see the commit fixing it) — a jittery
   `getTarget()` (e.g. `frontOf()` re-resolving against a player moving
   inside a crowded cluster of avatars, exactly the LiveKit-threshold
   scenario) let `walkTo()` report "arrived" on its very first internal
   check, before it ever took a step or hit its own per-step sleep —
   discarding that result and blindly re-looping turned into an
   unthrottled spin. **This is very likely the real explanation for a
   good chunk of #29's original symptom table too** (the "3–4
   proximity-bubble/invite cycles → 106% CPU, HTTP dead" case in
   particular reads identically) — #29's werift/`_closePeer`-await
   theory was never disproven, but this is a second, independently
   confirmed mechanism that produces the exact same externally-visible
   symptom without touching WEBRTC at all. An earlier live-testing note
   this same session, attributing the crash to a "2 agents + 1 human"
   composition, was a coincidental correlation, not a compositional
   trigger — crowded scenes simply made the jitter (and thus the spin)
   more likely, regardless of whether the crowd was agents or humans.
2. **Once approach was stable, publish itself produced a periodic ~50Hz
   buzz on any clip longer than one frame** — see the `.slice()`-vs-
   `.subarray()` bullet above. Diagnosed by elimination: token/metadata/
   permissions all independently confirmed correct; resampling math
   confirmed exact; a single giant `captureFrame()` call (no chunking)
   played clean, which is what pointed at the chunking step itself rather
   than the network or the room/SFU.

**Distinct gotcha found while investigating, worth keeping in mind for the
still-pending subscribe follow-up**: a throwaway diagnostic that set
`autoSubscribe: true` and read a few `RemoteTrack`s via `AudioStream` (to
check whether the room routes media to us at all) reliably crashed the
daemon — CPU to 300%+, RSS to 1GB+ within about a minute — until it was
rewritten to call `stream.getReader()` + an explicit `reader.cancel()` in a
`finally` block; merely `break`-ing out of a `for await` loop early was not
enough to stop the native side from continuing to push frames into an
unconsumed queue. With that explicit cancel it worked cleanly (confirmed
receiving real, non-silent human audio — 301 frames, RMS in the
hundreds-to-thousands range). The diagnostic itself was never shipped
(reverted after confirming it), but whoever builds the real subscribe path
should call `reader.cancel()` explicitly, every time, not rely on
early-break cleanup.

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
- **A second (or third) headless daemon instance is a legitimate live-test
  participant** now that daemon↔daemon audio is proven (see werift
  constraints above) — spin up named instances (`WA_NAME`/`WA_DAEMON_PORT`
  per instance, same room) for anything that needs real peers without a
  human. 3+ concurrent connections used to be #32 territory (fixed
  2026-09-12) — no longer a reason to cap it at 2, though `SDP_DEBUG=<dir>`
  is still worth turning on for anything touching the peer-connect path.
- **Media-tile / red-mic / "does it sound right" behaviour** still needs a
  human watching a real browser — that side of it can't be automated.
- The `workadventure` subagent drives repeated live scenarios (join, walk to
  a player, invite, monitor RSS/HTTP). Watch its RSS trace — a steady climb
  past ~300 MB or an HTTP timeout means #29 is biting; `pkill -9` and restart.
