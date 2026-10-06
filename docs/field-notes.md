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

### whisper-tiny hallucinations: what works, with numbers (#61)

`node scripts/stt-eval.mjs [--repeat N]` streams every clip in
`test/fixtures/stt/` (synthetic: `say` + ffmpeg, regenerate with
`scripts/stt-corpus-gen.sh`) and, if present, a **local-only**
`test/fixtures/stt-real/` through the real `SttStream` path and scores WER,
spurious finals on must-be-empty clips, wrong-script output, and loops
(`expected.json`: `""` = nothing, `null` = no reference, only script/loop checks).
Real call audio is people's voices — never commit it. Capture some with
`STT_TEE_DIR=<dir> wa join --stt` (raw PCM + finals with byte offsets;
`scripts/stt-tee-list.mjs <dir> [--cut …]` lists/cuts spans). Offsets are
approximate (they lag the worker), so cut windows are loose and need a listen.

Findings, from 4+ minutes of a real meeting (7 "bad" spans, 2–3 passes):

- **Synthetic noise/silence/tone clips never hallucinate**; the live failures
  only reproduce on real faint background audio. Don't trust a synthetic-only
  corpus for this.
- **Decoding is random.** mlx_whisper's default temperature fallback samples, so
  the same clip gave different text each run (Cyrillic, Welsh `Mae'n yw'n…`,
  `dododo…`). `temperature=0` makes it repeatable and cut flagged rows nowhere on
  its own — but it makes comparisons possible.
- **Output the old guards missed:** hundreds of `U+FFFD` (incomplete byte-level
  tokens) and no-space loops (`kybbbb…`, `carecare…` ×800 chars) are one
  whitespace-delimited token, invisible to `collapse_repetition()`'s word scan.
- **Filler on background audio** (`Thank you. Thanks for watching!`): those buffers
  peak ≈0.05 RMS per 100 ms vs ≥0.12 for real speech, so a level gate separates them.
- **Wrong script/language** (Cyrillic, Japanese, Arabic, Welsh) on background
  audio is fixed only by pinning the language, so **`en` is now the default**
  (`STT_LANGUAGE=auto` to detect). Cost: ~+0.03 WER on real speech
  (0.119 → 0.149, 3 clips) — small sample.
- **Tightening mlx_whisper's gates made things worse** (`logprob -0.8`,
  `compression 2.0`, `no_speech 0.5`): new `�`/loop garbage, and it blanked ~half
  the bad clips. Not adopted.
- Serial vs parallel evals differ: five evals sharing the GPU delayed finals and
  inflated "empty" results. Compare configs run one at a time.

Result on the bad-clip set (14 rows): baseline 5 flagged → greedy+filler+loop
guard 4 flagged (all wrong-script) → plus `STT_LANGUAGE=en` 0 flagged.
Not tried: a larger model (`whisper-base`/`small`), since cheap options got there.

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
- **`RTCPeerConnection`'s `codecs` config needs a `video` entry too, even
  though this project never sends or reads video.** A real WA browser
  peer's SDP offer always includes an `m=video` section (camera off or
  not), and werift throws unconditionally on any media section with zero
  codec overlap against local config — it doesn't special-case "unsupported
  kind" vs. "no overlap". Since `m=video` sorts before `m=audio` in a real
  offer, an audio-only `codecs` config (`{ audio: [OPUS] }`) kills the
  *whole* connection, audio included, before the compatible audio section
  is ever reached. `WaAudio`'s config is `{ audio: [OPUS], video:
  [useVP8()] }` — matching werift's own `generateDefaultPeerConfig()`
  default, which an earlier audio-only override had silently dropped. Only
  hits the real-browser-answering path (`initiator=false`); two headless
  daemons never trip it, since neither side's offer includes video. Full
  writeup, plus a wrong-fix trap worth avoiding (stripping the SDP's
  `m=video` section breaks ICE candidate matching for that mid), in
  `docs/livekit.md`.

---

## LiveKit transport (issue #8)

Moved to its own doc, since it kept growing: **`docs/livekit.md`**. Covers
the transport model (escalation is by mesh size, not area type — a wrong
assumption about that cost real debugging time, see PR #45 vs. #46 there),
the publish path and its two live-found bugs (`.slice()`-vs-`.subarray()`
data corruption, the connect-race guard), and the subscribe path (STT over
LiveKit, PR #44) including the reader-cleanup gotcha that shaped it.

(PR #46, found while chasing the same LiveKit-shaped report as #45, turned
out to be pure WEBRTC, not LiveKit — its full writeup lives above, in this
section's `### Misc`. `docs/livekit.md` keeps only the short version of
that story: a reminder that a bug found near LiveKit isn't automatically a
LiveKit bug.)

The `_navTo` tight-loop spin mentioned in earlier versions of this section
is *not* LiveKit-specific — it lives in `src/wa-client.mjs` and is covered
under `### Peer-connection lifecycle leak — issue #29` above, since that's
where its symptom overlap (crowded-area crashes) actually matters.

(STT-over-LiveKit — the subscribe path this section used to call "still
pending" — landed in PR #44; see `docs/livekit.md`'s "Receive (subscribe)"
section for the writeup, not here, now that LiveKit content lives there.)

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
  tcm, … all on the tagged release (`v1.34.0` → `wa-1.34`; was `v1.33.x` → `wa-1.33` until 2026-10-05).
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
stand-in-front as `wa to`. Driven entirely from
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

### Reconnect and server error screens (#56)

- The pusher's `errorScreenMessage` fields are `google.protobuf.*Value`
  wrappers (`{value: …}`), so they must be unwrapped. `src/server-rejected.mjs`
  turns one into a `ServerRejectedError { code, retryable }`:
  `server error screen: Please refresh — A new version of WorkAdventure is available (NEW_VERSION)`.
- **Fatal rule, one table** (`FATAL_CODES` + `FATAL_TIME_TO_RETRY_S` in that
  file): `NEW_VERSION`, or a server `timeToRetry` ≥ 3600 s (WA sends 999999
  with `NEW_VERSION`), means don't auto-retry. The daemon exits 1 with the
  message — at initial connect, and for an established daemon via the
  reconnector. Unknown codes keep the bounded 5-attempt retry.
- **The exponential-chain lesson.** A rejected attempt makes the server close
  the socket. If the attempt client carries the "reconnect on close" handler,
  that close starts a *second* chain, and each of its attempts starts more:
  ~2^N connections, each a proto load + login + map fetch. Reconnect-on-close
  belongs to the live client only (`watchLive` in `wa-daemon.mjs`);
  `createReconnector` (`src/reconnect.mjs`) keeps a single chain in flight and
  checks `deliberateShutdown` every iteration. A log tell: `reconnect attempt
  1/5…` appearing repeatedly instead of `1/5`, `2/5`.
- **Repro without production traffic:** `node scripts/fake-pusher.mjs 8855
  [code] [timeToRetry]` (serves `anonymLogin`, `/map` and a `/ws/room` that
  sends one `errorScreenMessage` then closes 1000), then
  `WA_TARGET=wa-1.34 WA_PUSHER_URL=http://127.0.0.1:8855
  WA_ROOM=http://127.0.0.1:8855/@/a/b/c WA_DAEMON_PORT=88xx node src/wa-daemon.mjs`.
  The same server backs `test/helpers/fake-pusher.mjs`. Not covered: a daemon
  that was *joined* and is then rejected on reconnect (the fake only rejects) —
  that path is unit-tested through the reconnector only.

### When prod bumps

Prod moved from `v1.33.8` to `v1.34.0` without notice (2026-10-05) and every
client stopped connecting: the server answers a stale `apiVersionHash` with
`errorScreen NEW_VERSION` (the daemon now exits 1 saying exactly that, and
`selfcheck` prints `apiVersionHash accepted: FAIL`), and the resolver, finding no adapter for the new
minor, falls back to the old one *and its hash*. Issue #55. The procedure that
worked, in order:

1. `node scripts/vendor-proto.mjs --check vX.Y.Z` — prints the new hash. Appending
   it to the old adapter's `apiVersionHashes` is a fast stopgap that gets people
   connected (that's what #68 did), but it files the new release under the old
   adapter and proves nothing about compatibility.
2. `node scripts/vendor-proto.mjs vX.Y.Z wa-X.Y` — vendors `proto/wa-X.Y/` and its
   `SOURCE`.
3. `node scripts/proto-diff.mjs proto/wa-<old>/messages.proto proto/wa-X.Y/messages.proto`
   — structural wire diff. It flags removals/renumbers/retypes that `src/`
   references (`[USED by src/]`, exit 1). For 1.33.8 → 1.34.0 there were none:
   no field renumbered, retyped or renamed, 51 additive changes, and the only
   removals (recording queries, `userMessageReadMessage`, the admin/ban messages)
   aren't used by this client. A plain text `diff` of the protos is mostly comments
   and misleads.
4. Add `src/adapters/wa-X.Y.mjs` (spread the previous adapter, override hash and
   `protoPath`), register it in `index.mjs` as the newest release and as the
   `play.workadventu.re` allowlist target. `test/adapters.test.mjs` fails if an
   adapter's hash set drifts from its vendored `SOURCE`, or if the allowlist isn't
   on the newest release.
5. `node bin/wa.mjs selfcheck --target production` against the live server.

**What this process cannot see:** a behaviour change behind an unchanged message
shape. The adapter's `verified` record states what was exercised live and what
wasn't; treat `unexercised` as inherited on faith.

---

## Chat: one wire mechanism (Space chat) + one separate optional add-on (Matrix)

Worth stating precisely — an earlier pass through this (#39, #48) framed it
as "proximity chat vs. area chat," implying two different chat backends,
one of them inherently Matrix. That's a misnomer. The actual model, from the
vendored proto (`proto/wa-1.33/messages.proto`):

- **Space chat — the one chat mechanism the client protocol actually has.**
  A `SpaceMessage` sent as `PublicEventFrontToPusher{spaceName,
  spaceEvent:{spaceMessage:{message, characterTextures, name}}}`, received
  back as `PublicEvent` with the same shape. It works identically no matter
  *why* you're a member of that Space — an ambient proximity bubble (two
  players standing near each other) and a meeting-room area (the Fire Pit, a
  Board Room, any `livekitRoomProperty`/`jitsiRoomProperty` area) are both
  just Spaces, joined via the same `_joinSpace()` the client already has
  (`src/wa-client.mjs:355-450`). Not Matrix. No auth beyond the existing
  anonymous connection. **This is #48** — implemented: send via
  `WorkAdventureClient.sendChatMessage(spaceName, text)`
  (`src/wa-client.mjs`), receive via a `chatMessage` event, `wa chat <text>`
  CLI / `POST /chat` daemon endpoint. Covers both the proximity-bubble case
  and the meeting-room-area case with the same code, since they're the same
  underlying mechanism.
  - **A chat message's displayed name and avatar are fixed per connection —
    `SpaceMessage.name` / `characterTextures` are ignored.** (An earlier
    version of this note claimed the opposite, from reading only the
    receiving client's `addNewMessage()`; every live experiment contradicted
    it.) The server overwrites both: `back/src/Model/EventProcessorInit.ts`'s
    `spaceMessage` (and `spaceIsTyping`) processor relays
    `{message, characterTextures: sender.characterTextures, name:
    sender.name}` from the sender's server-side SpaceUser. A client also
    can't change them mid-session: the pusher's
    `CLIENT_UPDATABLE_SPACE_USER_FIELDS` (`play/src/pusher/models/Space.ts`)
    is only mic/camera/screen-share/megaphone/attendees/cpuLimited, because
    name etc. feed permission checks. The only place they're set is connect
    time: `joinRoomFrontMessage.name` and the WS `characterTextureIds`
    (validated against `/woka/list`).
    **Verified live:** `WA_WOKA_ID=<Steve id> wa join --name "David
    (scribed)"` shows that name and the Steve woka on the map, the video
    tile, and the Proximity Chat header/icon. So a scribe label needs its
    own connection (a second avatar), not a per-message field.
    Gotcha: each new bubble is a separate "discussion" room in the chat
    panel — a panel left open on an old discussion won't show the new one;
    back out and reopen Proximity Chat.
    This client still sends `name` (mirrors the real client); it has no effect.
  - **Timestamps are client-side, not carried on the wire.** `SpaceMessage`
    has no timestamp field; the real client's "05:50 PM" in the chat panel
    is stamped locally at receipt. `lastChatMessage.at` in this client's
    `/state` does the same (`Date.now()` on receipt) — nothing to send.
  - **Not implemented, sibling proto messages in the same `SpaceEvent`
    oneof:** `SpaceIsTyping` (typing indicator), `MuteAudioForEverybody`/
    `MuteVideoForEverybody`. Deliberately out of scope for #48; the client
    silently ignores them on receive (`_handleSub`'s `sub.publicEvent`
    branch only acts on `spaceMessage`).
- **Matrix — a separate, optional, persistent backend layered onto a
  specific area**, not a different chat mechanism and not what "area chat"
  means by default. An area gets Matrix *in addition to* its own Space chat
  by carrying a `matrixRoomPropertyData` property (a fixed room ID baked in
  at map-edit time via `POST /roomArea` →
  `matrixProvider.createRoomForArea()`) — `_loadAreas()`
  (`src/wa-client.mjs:174-193`) is where this client would see it, e.g.
  `matrixRoomId: "!QjtmHAhrGndEpKZWkS:chat.workadventu.re"`. **This is #39**,
  and it's a much deeper rabbit hole:

  - **Anonymous access is a dead end.** `GameManager.ts` only constructs a
    Matrix client if `userIsConnected` (OIDC); `ConnectionManager.
    anonymousLogin()` explicitly wipes Matrix credentials; `POST
    /anonymLogin` returns only `{authToken, userUuid}`. The only
    token-minting path is a live browser round-trip: OIDC login → Synapse
    SSO redirect → `GET /matrix-callback` → `client.login("m.login.token",
    {token})`. Entering an area's Matrix room also requires
    `socketData.chatID` (which `_wsUrl()` sets to `""` today) so the pusher
    can invite the client via `EnterChatRoomAreaQuery` — anonymous users
    have no `chatID` to invite.
  - **It's self-service, though — not admin-gated.** WA has three access
    tiers (`docs.workadventu.re/admin/manage-access/`): Anonymous (what
    this client uses), **Visitor** (self-service — register via the
    "Register" button or social login, no admin involved), and Member
    (admin-added only). A Visitor account is real/OIDC-backed and should
    satisfy `userIsConnected`. The earlier assumption that a Synapse-admin-
    provisioned bot was required was wrong — flagged here so it doesn't
    get re-assumed.
  - **Creating the account is not automatable by Claude, no exception** —
    account creation and entering a password are both prohibited actions
    regardless of user permission. A human has to do the one-time
    Visitor-register-and-login step in a real browser; after that the
    resulting `access_token`/`refresh_token` should be reusable headlessly
    against `chat.workadventu.re` directly, no browser needed for sending.
  - **As of 2026-09-30, no area on the map has Matrix enabled at all** — the
    Fire Pit's `matrixRoomPropertyData` was removed (it's a
    `livekitRoomProperty` area now, so it still has ordinary Space chat, just
    no Matrix persistence layered on top); a full re-scan of all 20 areas,
    including the northern cluster (Bench 1/2, Left/Right Board Room, Great
    Hall Podium, Audience — all Jitsi/megaphone, unrelated), turned up zero
    Matrix properties anywhere. Before this, the Fire Pit's room
    (`!QjtmHAhrGndEpKZWkS:chat.workadventu.re`) was independently diagnosed
    dead/orphaned (Synapse 404 "no known servers" — not a permissions
    issue, affects any identity including a real logged-in browser
    session). Net effect either way: #39 needs a live Matrix-enabled area
    on the map before it's testable, which it currently doesn't have.
