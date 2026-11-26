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

Re-tested against prod with the `spawn` probe, 2026-10-10:

- **afrolabs** confirms: the `.wam` start area "Spawn Point" is
  {x:1895, y:2099, w:169, h:119, isDefault:true}; another avatar saw ours at
  (1961, 2136), inside it; the Tiled `start` layer sampled (2192, 1520).
- **the academy (lean-iterator campus) has no `.wam` start area**, so spawn
  falls back to the Tiled `start` layer: the avatar appeared at (976, 2928).
  The "`.wam` beats `.tmj`" rule only applies on maps that have a start area.

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

## `#177` — an avatar in a meeting area must not be grouped into a proximity bubble

**Symptom:** two bots sent to the same human (`wa to`) both stand in a
`livekitRoomProperty` area. The second one's arrival makes the server form a
proximity bubble from the two bots (`joinSpaceRequestMessage` for a `…#NNNN#…`
space). The first bot is told `meeting strategy → WEBRTC; leaving LiveKit`, the
second gets the area's LiveKit invitation and switches, and the first is left on
a P2P link to a peer that has gone: `wa status` says `audio.connected:false,
peers:0, inMeeting:true`, peers see a red mic, `wa sound` reaches nobody.

**Cause:** a real browser in a meeting area announces `availabilityStatus =
LIVEKIT` (11), and the server keeps such a player out of proximity groups. We
announced `ONLINE` (1) for the whole session. [live: humans in the area read 11,
our bots read 1; a human ~35px from a bot was never grouped, the two bots were.
That the server skips LIVEKIT players is inferred from this and borne out by the
fix below.]

**Fix:** `WorkAdventureClient._announceMeetingArea` sends
`setPlayerDetailsMessage{availabilityStatus: LIVEKIT}` on entering a meeting
area (immediately, not dwell-debounced: one small message) and `ONLINE` when the
last one is left; the join message uses the stored status. [live: two bots to
the same human stayed on the area's LiveKit with no proximity space for 100 s.]
Other players' status is now kept (`wa status --json` → `players[].availabilityStatus`).

**A meeting area is modal (#179).** The status is not the only guard: while we
stand in a `livekitRoomProperty` area `_handle` refuses any `joinSpaceRequestMessage`
for a space that isn't one of our area-meeting spaces, and entering an area leaves
any proximity space we were already in (`_ejectProximitySpaces`). Recovering after
the fact (re-joining the area's LiveKit when a bubble ends) was the alternative; it
isn't needed because we never hold the bubble. [live, prod: a bot in a bubble with
another walked into the area: `entered a meeting area → leaving proximity space`,
then the server tried a new bubble and got `in a meeting area → refusing proximity
space`; both ended on the area's LiveKit with 4 peers.] Leaving the area restores
normal proximity behaviour.

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

**A second cause exists, seen on the Android client:** if the link has no audio
line to send on at all (the browser joined muted, so its first offer had none),
announcing mic-on gives the same red mic until the browser re-offers. Not
reproduced yet; see `android/docs/field-notes.md` ("Protocol and behaviour
reference") and issue #97.

**The CLI also has the join-muted bug** (reported by the owner, 2026-10-08; issue
#104): `_onSignal` ignores `{type:"renegotiate"}` ("our track is static"), so as
the initiator it never re-offers when a browser that joined muted unmutes; the
Android client had exactly this bug and fixed it.

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
fast leave→rejoin (routine with the wa-1.33 area-meeting dwell/linger debounce)
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

**Debounced (PR #28), now adapter data:** the client reads `adapter.meeting.areaDwellMs` /
`areaLingerMs` (fallback 1500 / 2500). The frozen **wa-1.33** adapter keeps them explicitly:
join only after **1.5 s continuously inside** (a real dwell, not a walk-through), and linger
**2.5 s** after leaving before tearing down. Timers keyed by space name, cleared on `close()`.

**What a real browser does (probe `observe-humans`, 2026-10-11, two real players, 12 min):**
no dwell and no linger. It flips `LIVEKIT` and joins the meeting space at the same instant it
enters the area (118 to 336 ms before the first relayed position inside the rectangle; 6/6
entries), and sends `ONLINE` within 0 to 183 ms of the first position outside, the space leave
first or together. It flips even for a graze (passes of the "Blue table" lasted 0.8 s, 1.1 s and
under 0.1 s, each LIVEKIT then ONLINE). So **wa-1.34 sets `areaDwellMs: 0, areaLingerMs: 0`**:
join immediately on entering, leave immediately on leaving, no timers. The stuck-status guards
stay: the join's `.then` re-checks `currentAreas` and leaves the space if we have since left,
and `_leaveSpace` does the ONLINE bookkeeping. Scenario "A quick pass through a meeting area
joins and leaves its meeting". (The churn the debounce prevented, #28, was on a 73-area map with
werift peers; if it returns on wa-1.34, the fix belongs in the transport, not a dwell the
browser does not have.)

**Speed (same probe):** a real browser walks at a median **181 px/s** (1 s windows; steady laps
173 to 183) with a position update about every 200 ms; running (shift held) is about 420 to
520 px/s (12 windows from one stretch: low confidence, median about 460). Our `navTo` used 40 px
per 100 ms = 400 px/s. **Speed is client-side; the server does not enforce it.** wa-1.34 has
`movement: { walkPxPerS: 180, runPxPerS: 460 }`; `walkTo`/`navTo` take `pace: "walk" | "run"`
and then step `speed * 100 ms / 1000` per 100 ms tick. With no pace (the default) or an adapter
without the speed, nothing changes (40 px / 100 ms). `LiveWorld.moveTo` defaults to
`pace: "walk"`; `wa goto <x> <y> --walk|--run` opts in from the CLI.

`jitsiRoomProperty` areas are detected but not handled at all — the client has
no Jitsi transport. Walking into one is out of scope and has confused the
daemon in the past.

## Meeting areas and availability

A browser client sends `setPlayerDetailsMessage { availabilityStatus }` as it moves
through a `livekitRoomProperty` meeting area: **LIVEKIT (11)** on entering, **ONLINE (1)**
on leaving (probe `meeting-availability`, 2026-10-10, campey walking a browser avatar
into the "Fire Pit"; relayed to others as `playerDetailsUpdatedMessage`). Our client used
to say ONLINE always (set once at join), and campey saw our two avatars' proximity bubble
persist while they walked through the Fire Pit. Probe `firepit-meeting` (same day) had
`wa-probe-a` send LIVEKIT/ONLINE like a browser: all five steps looked right to a person
(one meeting, no bubble, clean exit).

Since then the **wa-1.34 adapter** defines `meeting.areaAvailabilityStatus: 11` and
`WorkAdventureClient` sends it when it actually joins an area meeting (after the dwell on wa-1.33,
at once on wa-1.34), and ONLINE when it leaves it (after the linger / at once) (ONLINE only once no area meeting remains). An
adapter without the value (the frozen wa-1.33) behaves as before. Live check, scenario
"A proximity pair walking into a meeting area leaves its bubble for the area meeting": it
passes with the status sent and fails with it removed (the bubble persists).

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
  tcm, … all on the tagged release (`v1.34.2` → `wa-1.34`, hash `62e25483`; `v1.34.1` was `b82fc568`, `v1.34.0` `23c8eb8c`; was `v1.33.x` → `wa-1.33` until 2026-10-05). Seen 2026-10-20: prod moved to v1.34.2 and answered `b82fc568` with `NEW_VERSION`. The re-vendored proto has 22 additive changes since v1.34.0 and nothing wire-breaking that `src/` uses (`proto-diff.mjs`); `selfcheck --target production` passes.
- **Staging is rolling `master`**, untagged — `play.staging.workadventu.re`.
  Its commit sha *moves between sessions* (`7c5ff99b` → `7d628838` → …), and
  each move can shift the `apiVersionHash`. `wa-master` warns on sha drift;
  refresh it with `node scripts/vendor-proto.mjs master wa-master` (prints the
  recomputed hash — self-verified: `v1.33.5` → `bfd20fc4`).
- **`wa-master` was refreshed to staging `master@d2e3ecfe` (2026-10-13, #145).** Staging
  had moved on and answered the old hash (`3fb30729`) with `errorScreen NEW_VERSION`, so
  the CLI could not join at all. Hash is now `b82fc568` (same as prod v1.34.1); the proto
  is wire-identical to `wa-1.34` (`proto-diff.mjs` reports nothing). `selfcheck --target
  wa-master` passes connect, move, bubble and area-meeting join (audio unexercised).
  `vendor-proto.mjs` vendors the proto and *prints* the hash but does not edit the
  adapter: set `trackedSha`, `apiVersionHashes` and `verifiedDate` by hand. The
  `test/adapters.test.mjs` sha tests read `trackedSha`, so a refresh doesn't break them.
- **Staging moved again (2026-10-20): `master@118dd84c`, hash `d2d82672`.** It rejected both `b82fc568` and prod's new
  `62e25483` with `NEW_VERSION` and accepted only master's own hash, so prod and staging no longer share one. A probe
  with the wrong pusher (prod's) answers `WORLD_NOT_FOUND`, which is *after* the hash check and so proves nothing:
  probe staging with `WA_PUSHER_URL=https://pusher.staging.workadventu.re` and a staging woka. `wa-master` is
  re-vendored and `selfcheck --target wa-master` passes; the Android app sends staging's hash for staging rooms
  (`WaStaging.API_VERSION_HASH`).
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

## Connecting and listening: quirks seen in live runs

Things that look like bugs (or like nothing happening) when you test a `wa`
avatar against a real room. Dates are when each was observed.

- **A listener hears nothing from a muted browser, and logs nothing either**
  (2026-10-08). The P2P link comes up (`pc connected`, `peer connected`) but a
  muted browser sends no RTP, so no remote track ever arrives, `SttStream` is
  never created and the worker is never spawned. There is no `stt:` line and
  no `SCRIBE` line, which is indistinguishable from "STT is broken". Check the
  speaker's mic before debugging. The worker (and the model warm-up, ~2–5 s)
  starts lazily on the first audio track, which is the cold-start case #58
  fixed.
- **Evidence for #104 (join-muted browser, CLI as initiator).** Same run: the
  browser joined muted, link `7e50be7d` came up at 18:49:25 with `initiator=true`
  and stayed up 1 min 42 s with no track (the owner says they were muted until
  just before the second round). It closed ("left bubble") at 18:51:07 and a
  fresh link `cde5500a` (again `initiator=true`) had its STT worker running
  within 2 s of connecting. So audio showed up on a *new* connection, not on
  the original muted one, which matches the analysis in #104 (we never
  re-offer on `renegotiate`). Caveats: the exact unmute time wasn't logged and
  why the bubble closed at 18:51:07 isn't known (the speaker may have
  re-entered it), so this is consistent with #104, not a clean reproduction.
- **`wa to <player>` returns at once** (`goingTo: {...}`), not on arrival. The
  walk itself is quick (about 8 s across the map on 2026-10-08); poll `wa
  status` for position rather than assuming it has arrived. Audio is a
  separate matter: it only flows once a voice link exists *and* the speaker is
  unmuted (see the first bullet), which on that run took minutes.
- **Name resolution is exact-then-substring, first match wins.**
  `findPlayer()` returns the first player whose name equals the needle, else
  the first that contains it. The same name can legitimately appear twice —
  two browsers (tabs or devices) of the same person were both visible as
  `:David` on 2026-10-06 — and `wa to` then walks to whichever the player map
  lists first, with no warning. Check `wa status` and use `wa goto <x> <y>`
  when it matters. `no player matching "<name>"` just means nobody by that
  name is visible yet.
- **Walking through the map joins and leaves things on the way.** Crossing
  meeting areas fires `area enter`/`area leave` pairs (the dwell debounce
  covers the Space side), and passing another avatar can set up and tear down
  a P2P link within the same second (`webRtcStart … initiator=false`, then
  `closed (left bubble)`). That churn is a side effect of the route taken, not
  a fault; #102 (routes that avoid walking through map areas) is the fix. #62
  is the related case of *standing* inside a meeting area.
- **`daemon-<port>.log` timestamps are UTC**, not local time (2026-10-08: log
  `18:49` was 20:49 for the owner). Match them against `date -u`.
- **Env vars on `wa join` reach the detached daemon** (`STT_TEE_DIR`,
  `STT_LANGUAGE`, `STT_FILLER_MAX_RMS`…): `spawnDaemon` passes the CLI's
  environment through, so set them on the `wa join` command itself.

---

## Testing approach

- **`npm test`** (`node --test`) covers pure logic only: adapter resolution,
  the area-meeting debounce timers, invite message shapes, the mic-prime and
  Ogg mux with a fake peer / no live socket.
- **`npm run scenarios`** (cucumber, `world-port/features/`) — behavioural
  scenarios against the offline fake world. `WORLD=live npm run scenarios`
  runs the same suite against prod (the gate for a new adapter; as of
  2026-10-10 it has **not been run**, prod was blocked from the cloud
  environment: see the Status section of `docs/fakes-with-probes.md`);
  `node world-port/probes/run.mjs <probe>` re-tests one note live. See
  `docs/fakes-with-probes.md`.
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
  reconnector. Unknown codes retry indefinitely (delays 2, 5, 10, 20, 30, then
  60 s repeating — #138; it used to give up after 5 attempts, which ended an
  overnight session on a flapping network).
- **The exponential-chain lesson.** A rejected attempt makes the server close
  the socket. If the attempt client carries the "reconnect on close" handler,
  that close starts a *second* chain, and each of its attempts starts more:
  ~2^N connections, each a proto load + login + map fetch. Reconnect-on-close
  belongs to the live client only (`watchLive` in `wa-daemon.mjs`);
  `createReconnector` (`src/reconnect.mjs`) keeps a single chain in flight and
  checks `deliberateShutdown` every iteration. A log tell: `reconnect attempt
  1 (down 0s)…` appearing repeatedly instead of counting up `1`, `2`, `3`.
- **Liveness watchdog (#138).** The client's only outbound traffic is a position
  re-broadcast every 5 s, and nothing checked that anything came back: in the
  2026-10-08 soak the server closed us with `4000 … did not send a pong in time`
  while we thought we were fine. `_startHeartbeat` (`wa-client.mjs`) sends a
  transport-level `ws.ping()` every 15 s (also keeps idle NAT/proxy entries warm)
  and terminates the socket after 45 s with no inbound frame or pong; the normal
  close → reconnect path takes over. Verified live that the production-style
  pusher (staging) answers ws pings (~150 ms). A tick that fires > 3 intervals
  late is logged as `system stalled/slept` and grants one fresh window rather than
  killing a socket that may be fine after a laptop wake. `socket closed` lines
  now carry `(up Ns, silent Ns)` to tell periodic idle drops from network loss.
- **Supervision: `wa join --keep-alive` (#138).** With the indefinite reconnect and
  the heartbeat, a network outage no longer ends the daemon; what is left is it
  being *killed* (OOM balloon #29, SIGKILL). `src/wa-supervisor.mjs` runs the
  daemon and restarts it (backoff 2, 5, 10, 20, 30, 60 s; reset after a 5-minute
  run) only when it dies from a signal or an unexpected code. Never restarted:
  exit 0 (`wa leave`, SIGINT/SIGTERM), exit 1 (it never connected, or any
  generic failure: "it was never alive"), exit 2/3 (usage / port), exit 4 (the
  server refuses this client, e.g. `NEW_VERSION`: restarting would just hammer
  it). Exit 4 is new; the daemon used to exit 1 for a refusal. Verified live:
  `kill -9` on the daemon → back in the room 2 s later under a new pid, and
  `wa leave` takes down both processes. Caveat: while the daemon is in the
  restart backoff the control API is down, so a bare `wa status` says "not
  joined" and a command that auto-starts a daemon (`needDaemon`) would race the
  supervisor for the port.
- **Repro without production traffic:** `node scripts/fake-pusher.mjs 8855
  [code] [timeToRetry]` (serves `anonymLogin`, `/map` and a `/ws/room` that
  sends one `errorScreenMessage` then closes 1000), then
  `WA_TARGET=wa-1.34 WA_PUSHER_URL=http://127.0.0.1:8855
  WA_ROOM=http://127.0.0.1:8855/@/a/b/c WA_DAEMON_PORT=88xx node src/wa-daemon.mjs`.
  The same server backs `test/helpers/fake-pusher.mjs`. Not covered: a daemon
  that was *joined* and is then rejected on reconnect (the fake only rejects) —
  that path is unit-tested through the reconnector only.

### navTo never finished: goal vs tile centre, and goals inside a solid (2026-10-12)

Reported from the afrolabs "Red Table" pocket: walking out to the north-east got stuck, in the CLI and the APK.
A route's waypoints are tile **centres**, so it ends up to about 22 px from the real goal.
- **Free goal, Node only**: with `stopWithin` 16 (what `LiveWorld.moveTo` uses) the walk stopped on the centre, never counted as arrived, and re-planned a zero-length route until its 120 s timeout. 3 of 6 test goals north-east of the pocket hit it. The Kotlin `Navigator` already walked the last step to the exact goal (`withExactGoal`); Node now does too.
- **Goal inside a solid, Node and Kotlin**: `findPath` snaps the goal to the nearest free tile, but the arrival test was against the original point, so the same spin. Both now finish on that tile (Node returns `{arrived: true, snapped: true}`).
- **Unreachable goals now fail (2026-10-13).** When `findPath` finds no route (a free tile on an island such as afrolabs' 942-tile east region), `navTo` used to fall back to a straight-line walk that crossed walls and reported arrival. From open floor (a start region of 50+ tiles) it now returns `{arrived: false, reason: "no-route"}` (Kotlin `Outcome.NO_ROUTE`) without moving. A start sealed in a tiny pocket keeps the straight-line escape: movement is client-authoritative and the map may be wrong about where we stand.
- **Spot choosers must pick reachable tiles (also 2026-10-12).** `LiveWorld.openSpotNear`/`openSpotInside` (the scenarios' "open floor outside the area") and `MapNav.nearestEmptyArea` (`wa quiet`) chose the nearest *free* tile, which can sit in a walled-off pocket or on the east island. They now filter by `MapNav.reachableFrom(pos)`, a flood fill with the same rules as `findPath`. The Android `WalkToArea` (and `wa-cli --walk-to-area`) now use `NavGrid.snapToReachable` for the same reason.
- Kotlin, verified 2026-10-13 with the full toolchain in the cloud container: `:nav` 50 tests pass (including `navToAGoalInsideASolidEndsOnTheNearestFreeTile`, which fails without the fix, and `snapToReachableNeverPicksAWalledOffPocket`), `:app` and `:wa-cli` compile with the `snapToReachable` call sites, and `testDebugUnitTest :nav:test :protocol:test :wa-cli:test` is 346 tests, 0 failed. See android/CLAUDE.md "Toolchain" for how the container was set up.

### When the watcher says needs attention (and a manual bump)

**With the catalog (#126).**

- **Android does the same** (#188): a typed NEW_VERSION refusal triggers one recovery attempt that applies the catalog adapter's hash
  and handshake query (nothing else), with an ask/auto/never setting and a Download / Don't ask again / Cancel dialog; see
  `android/docs/field-notes.md` "How the app recovers".

- **Candidate adapter from a file.** `--adapter-file <f>` (`wa join`, `wa selfcheck`,
  `scripts/selfcheck.mjs`), `WA_ADAPTER_FILE` (also used by `LiveWorld`, so
  `WORLD=live npm run scenarios` gates it) or the `adapterFile` config key loads an
  adapter file that is not in the catalog (`src/catalog/adapter-file.mjs`, same
  validation as the cache). It wins over cached catalog adapter, probe, allowlist and
  built-in hash matching, and skips the catalog pre-flight in `wa join`; only an
  explicit `--target`/`WA_TARGET` (not `auto`) still beats it, and `WA_VERSION`/`version`
  only pins the hash sent in the handshake; it does not displace the file (the file's
  behaviours stay). An unreadable or invalid file is a hard error (exit 2), never a
  fallback. The client gets it injected as `fileAdapter`, like `cachedFor`.
- **`wa join`.** It no longer just fails on a server hash it doesn't know. Unless
  something pins the adapter (`WA_VERSION` or `WA_TARGET`, or the `version` /
  `target` config file keys; `wa join` has no `--version` flag and does not pass
  `--target` on) it reads the hash from the server home page's
  `<meta name="wa-api-version">`. If no built-in adapter or loadable cached file has
  it, it looks the hash up in the catalog (`catalog/index.json` in this repo, fetched
  from raw.githubusercontent.com, with a 3 s timeout). A cached file that doesn't
  validate doesn't count as known and is overwritten by the download. Outcomes:
  `using adapter <id> (<hash>)` and the join goes ahead; or `wa join` exits **4**
  with `no adapter for this server version yet (<hash>)` (no catalog entry),
  `this server version isn't supported yet, it needs attention (<hash>)` (a
  placeholder entry; its `gate` text is shown with control characters stripped and
  capped at about 200 characters), or `an adapter for this server version (<hash>) is
  available but was not downloaded; ...` (declined, or `never`, each saying how to
  allow it). If the page or the catalog can't be read, `wa join` carries on as before, now saying why
  (`could not check the adapter catalog (<reason>); carrying on`; the daemon logs `adapter recovery: unavailable (<reason>)`;
  the reason is sanitised like a gate detail). The 3 s pre-flight timeout is one budget for the page, the index and the file
  (the time spent at the y/N prompt is not charged). A 3xx from the catalog is a failure by design and is never followed, but it
  names the new host (`the catalog moved (HTTP 301 to <host>)`), so a repo rename is diagnosable.
- **Which hash is sent (#185).** The handshake sends the hash the server announced when the chosen adapter lists it (first or
  not), else the adapter's first: after a rollback to v1.34.2 the server announces `62e25483`, which wa-1.34 lists second.
  `wa join` hands the hash it read to the daemon (`WA_PROBED_HASH`) so a failed second home-page GET cannot defeat a cached
  adapter. One `isBuiltinHash` (`src/adapters/index.mjs`) is the "is this built in" test; `recoverAdapter` takes it injected.
- **`selfcheck`** (`scripts/selfcheck.mjs`) runs the same pre-flight as `wa join` (skipped with `--adapter-file`, a non-auto `--target` or `WA_VERSION`), honouring `adapterUpdates`: default `ask` has no prompt in a script, so it says how to allow it and exits 4; `WA_ADAPTER_UPDATES=auto` applies and caches the adapter, so `selfcheck --target production` passes on a server newer than the built-ins.
- **Setting and consent.** The setting is `adapterUpdates` in the config file or
  `WA_ADAPTER_UPDATES`. `ask` (the default) prompts `[y/N/always]`; with no terminal
  (stdin or stderr not a TTY) the answer is no, never a silent download. `auto`
  downloads, `never` doesn't. `always` downloads, switches the session (and the daemon
  it starts) to `auto`, and writes `"adapterUpdates": "auto"` into the config file; it
  refuses (and says so) to touch a config file it cannot parse. The daemon recovers by
  itself only in `auto` mode, only when nothing pins or supplies the adapter (`WA_VERSION` /
  `WA_TARGET` pin it; an adapter file, `WA_ADAPTER_FILE`, supplies it: a refused candidate file is never
  replaced from the catalog and the daemon exits as above), after a `NEW_VERSION` refusal (once per give-up). Otherwise it logs
  how to allow it (run `wa join` again, or set `WA_ADAPTER_UPDATES=auto`) and exits
  as before; `wa join` is where the prompt happens.
- **Security limits.** A downloaded file is checked against the index's sha256 and a
  strict schema, then cached at `~/.workadventurer/adapters/<hash>.json`. The
  daemon reaches the cached adapter only after a successful home-page probe
  (`src/adapters/index.mjs`), so a start with the server unreachable doesn't use it.
  `WA_CATALOG_URL` replaces the index URL. Any HTTP redirect from the catalog host
  counts as a failure, so if the repository is ever renamed or transferred, installed
  CLIs fall back to "unavailable" until the default catalog URL is updated. The adapter
  file URL must be on the index's origin; size caps are 1 MiB for the index and
  64 KiB for an adapter file.
- **What an adapter contains.** Data only: the hash, `meeting.areaDwellMs` /
  `areaLingerMs` (0 to 10000 ms), `movement.walkPxPerS` / `runPxPerS` (50 to 1000) and
  optional extra handshake query parameters (at most 12, constant values or
  `{tabId}`/`{uuid}`, never `roomId`, `version`, `characterTextureIds` or `token`, in
  any letter case), laid over a built-in adapter family (`protoFamily`: `wa-1.33`,
  `wa-1.34` or `wa-master`). Built-in hashes always win; the cache and catalog are
  only consulted for a hash no built-in knows. `scripts/catalog-index.mjs` rebuilds
  the index from `catalog/adapters/*.json` and shows an adapter file's `waVersion`
  `1.34.4` as `v1.34.4` and `master-<sha>` as `master@<sha>`.
- **The watcher (#127) is built**; it is described in the next subsection. A manual bump
  (the numbered procedure further down) is now the fallback, for a hash the watcher cannot
  adapt on its own.

**The watcher says needs attention (#127).** `.github/workflows/adapter-watch.yml`
(workflow "Adapter watch", hourly at :17, plus manual runs and an optional
`repository_dispatch` `wa-release`, whose payload is never read) runs
`scripts/watch/run.mjs` for production and staging. For each server it reads the home
page's hash and version, skips a hash the catalog already holds as `ok`, otherwise builds a
candidate adapter (`candidate.mjs`: the newest `ok` entry for that server is the base for
`protoFamily` and the behaviour numbers; staging with no base falls back to `wa-master`),
and runs the gate. A pass opens and merges a PR adding `catalog/adapters/<hash>.json` and
the index entry, and closes the issue. A fail merges a `needs-attention` placeholder
into `catalog/index.json` and opens or updates an issue. Both go through branch
`adapter/<hash>`, touching only `catalog/` (`assertCatalogPaths`).

- **The issue.** Production: one issue per hash, titled `Server v1.34.5 needs attention
  (adapter <hash>)` (just `Server needs attention (adapter <hash>)` with no version).
  Staging: ONE issue, `Staging needs attention`, rewritten to name the newest failing hash
  and closed when a staging hash passes (staging's hash churns; per-hash issues would
  flood). The body holds the failing step as `name: detail` in a code fence, the candidate's
  `waVersion` and `protoFamily`, the run link, and a hidden marker
  `<!-- adapter-watch:<hash|staging> -->`. Label `adapter-watch`. **Adoption rule (marker spoofing):** the watcher edits or closes an
  open issue only if its body carries the marker AND it either carries the `adapter-watch`
  label (only people with triage rights can add it) or was authored by `github-actions[bot]`
  (`BOT_LOGIN`; `findIssues` returns the author login and label names). The marker alone is
  not enough: anyone can paste it into a lookalike issue, and that issue is never edited or
  closed. If the label is later removed, both targets still find their issue by title plus
  marker plus the bot author (the unlabelled fallback search), so no duplicate is opened
  (staging used to be label-only). If several open issues match, the oldest is updated and the rest are
  reported as warnings, never closed (a pass closes them all).
- **The placeholder** in `catalog/index.json`: `status: "needs-attention"`, `server`,
  `version`, `gate` (the issue's failing step, control characters stripped), `issue`
  (its number, or null) and `commit`. **`commit` is a code fingerprint, not a git commit**
  (rulings R11, R14): sha1 over the sorted `path\0sha\n` entries of `main`'s root tree limited to
  `bin`, `src`, `scripts`, `world-port`, `android`, `proto`, `package.json` and
  `package-lock.json` (`fingerprintOf` in `github-port.mjs`; the jobs compute the same value
  from `git ls-tree`). It changes when gate-relevant code changes, not when the watcher merges to
  `catalog/` or docs change; had it been main's commit, every publish would have looked like a code change
  and re-tested every placeholder. **Ownership (R13):** production and staging can show the same hash.
  A placeholder written by production is never re-gated or replaced from staging (staging skips it);
  production over a staging-written placeholder gates once and takes ownership; `publish.mjs` also
  refuses (stage `validate`) to replace a production `needs-attention` entry with a staging-origin one. `wa join` shows the placeholder's `gate` text to the
  user ("needs attention").
- **Reading the gate steps** (`scripts/watch/gate.mjs`; a failed step skips the rest, so the
  first `fail` is the answer):
  - `candidate` (not a gate step): no base adapter, or the version cannot be named, or the
    candidate failed schema validation.
  - `proto-diff`: the candidate's `messages.proto` against the family's vendored proto
    (a change `src/` uses fails) and against `wa-1.33` (a wire-breaking change fails only
    if some `android/**/*.kt` file mentions both the message and the field; additions
    always pass). The detail names the file set (`src/` or `android/`) and the change. Fix:
    a code or adapter change, then a manual bump.
  - `selfcheck`: `scripts/selfcheck.mjs --adapter-file` joins, moves, bubbles and
    enters an area (best-effort: with no `livekitRoomProperty` area on the map that step SKIPs, and a SKIP passes). It passes no `--target`, for production and staging alike: an explicit target beats an adapter file, so naming `wa-master` would test the built-in instead of the candidate. Staging adds `--room` plus `WA_PUSHER_URL` and `WA_WOKA_ID`.
    The detail is the first FAIL/error line of its output, so read the run log.
  - `scenarios`: the live scenario suite (`WORLD=live`, `WA_ADAPTER_FILE`). Production only;
    on staging the step is recorded as skipped ("production only") and counts as a pass,
    because the scenarios' world facts are production worlds.
  - `kotlin-smoke`: `:wa-cli:run --api-version <hash> --walk-to-area <word>` must print
    `walk ended: ARRIVED`. It validates only the hash (the app applies nothing else), so a
    server change in the `wa-1.33` proto must be caught by `proto-diff`, not here.
  A step also fails on a timeout (selfcheck 2 min, scenarios 15, smoke 10) or a crash.
  No fault of the watcher itself (server unreadable, proto fetch failed, publish failed)
  makes a verdict: the run exits 1 with `::error::` lines and the next hour tries again.
- **Retest rules.** A `needs-attention` hash is gated again only when (a) a manual run sets
  `force`, (b) the code fingerprint differs from the placeholder's `commit`, or (c) the
  server's version string differs from the placeholder's `version`. Never merely because
  an hour passed: each gate puts avatars on the live server. So a fix merged to `main`
  (any non-`catalog` change) retests every placeholder on the next run, and the
  issue closes itself when the gate then passes.
- **Forcing a retest.** Actions, "Adapter watch", Run workflow (`workflow_dispatch`),
  on `main`: `hash` (an adapter hash a server shows now; anything else is skipped),
  `version` (e.g. `v1.34.5`, narrows the same way), `force` (retest `needs-attention`
  entries), `dry_run` (everything except the PR, the merge and the issue writes; the only
  mode allowed from another ref, and it publishes nothing). Locally:
  `GITHUB_TOKEN=... GITHUB_REPOSITORY=... node scripts/watch/run.mjs --dry-run --force
  --target production` (add `NODE_USE_ENV_PROXY=1` in the cloud container).
- **Two jobs, and why** (ruling R12). `gate` runs third-party code (selfcheck, the live
  scenarios, Gradle) with `contents: read`, a checkout without credentials, no dependency
  caches (a cache saved by this job could be restored into a job with write access) and no
  write token. Its own read-only `GITHUB_TOKEN` is passed to the one step that runs the gate
  phase, only to lift the 60/hour unauthenticated API limit when fetching the candidate's
  upstream proto (public data); it adds nothing to the boundary because the job can write
  nothing, and the gate's child processes never receive it (`runChild` strips it). It uploads `verdicts/<server>.json`. `publish` is the only job with write
  permissions and runs no gate code (`npm ci --ignore-scripts`, no Gradle). It treats the
  artifact as untrusted: size caps, strict schema, `pass` recomputed from the steps, then
  re-reads the server and requires the same hash and version, re-decides, and REBUILDS the
  adapter itself, so adapter content never crosses the boundary. Residual risk: a
  compromised gate can flip pass/fail for a hash the server announces at that moment
  (a bad adapter published as `ok`, or a good one marked needing attention). It cannot
  publish any other hash, any other content, or write anything else. Only `main` publishes
  (the workflow and `run.mjs` both refuse other refs, except a dry run). Second residual: gate-job
  code running with sudo could in theory reach the runner's Actions cache token and poison a cache
  that `android-release.yml` (which has `contents: write`) restores; the gate job reads and writes
  no cache itself, but the runner-level token is out of this design's reach.
- **Go-live switch.** Scheduled and `repository_dispatch` runs (both jobs) only happen when the
  repository variable `ADAPTER_WATCH_ENABLED` is `true` (Settings, Secrets and variables,
  Actions, Variables). Default OFF; a manual `workflow_dispatch` always runs. Setting it is the
  go-live step, after the Task 8 dry run.
- **One hash on both servers (`seenOn`).** A hash can be `ok` in the catalog (published after
  gating on one server) and later be announced by the OTHER server (seen live 2026-11-26:
  production v1.35.0 announced `dcadccc6`, published from staging `master@621f2bf2`, gated on
  staging only, so with no live scenarios). `decide` used to skip it as "already ok". Now an `ok`
  hash that a server announces and that has no record for THAT server (not the entry's own
  `server`, no `seenOn` item for it) is gated there once, against the catalog's own adapter file
  (`buildCandidate` with `useExisting`: the bytes clients apply, nothing rebuilt); production
  includes the live scenarios. The outcome is written to the index entry ONLY, as the optional
  list `seenOn: [{ server, version, checked (ISO), gate: "passed" | failing step text, commit? }]`
  (`publish` with `seenOn`; the adapter file stays byte-identical, and `publish` still refuses to
  replace an existing adapter file). A failing record carries `commit`, the code fingerprint, so
  the code-change retest works like a placeholder's. A failed gate opens the normal issue for that
  server (production: `Server v1.35.0 needs attention (adapter <hash>)`) but does NOT demote the
  adapter: the entry stays `ok`, clients still apply it, and its own server may keep using it.
  Loop-free: once `seenOn` has the server, a pass is final (not even `force` re-gates it) and a
  failure is retested only on `force`, a code-fingerprint change or a version change, exactly like
  a placeholder. The "no verdict" stale-issue closer only closes an issue for a hash that is `ok`
  for that server (its own, or a passed `seenOn`), so a failed `seenOn` keeps its issue open. R13
  ownership of `needs-attention` placeholders is unchanged. Clients ignore `seenOn` (the CLI drops
  it from the parsed index; the Android parser ignores unknown fields).
- **`added` and staging pruning.** An `ok` index entry carries an optional `added` ISO instant:
  set by `rebuildIndex` the first time an entry is `ok` (a placeholder turning `ok` gets one),
  never rewritten for an existing entry, preserved across rebuilds together with `seenOn`. Clients keep
  it only when it parses as an instant (`isInstant`). The existing entries were backfilled once from
  the commit that added each adapter file: `node scripts/catalog-index.mjs --backfill-added` (no
  network; it names any date that is only a shallow-clone boundary commit, and skips files
  with no history; this repo's clone was shallow but the adapter files' own commits were present).
  **Pruning rule** (`scripts/watch/prune.mjs`, run by `publish` after a successful STAGING adapter
  publish, in the same PR and the same commit as the new adapter): rank the `ok` entries with
  `server: staging` by `added` (none counts as oldest), newest first, ties by higher hash newer,
  the entry being published always first; those beyond the newest five are deleted (file and
  index entry) unless protected. Never pruned: production entries (`server: production`, kept
  forever), built-in hashes (`isBuiltinHash`, i.e. in the `src/adapters` hash lists), an entry with
  any production `seenOn` record (production runs it), and the entry being published. Protected
  entries still occupy a rank, so more than five can remain. Staging `needs-attention`
  placeholders are dropped as soon as a new staging entry is `ok` (a placeholder has no date; the
  new entry is newer than every one); production placeholders stay. Only
  `catalog/adapters/<8 hex>.json` can be deleted: `assertCatalogDeletes` (the port's `commit` takes
  `deletes`, sent as null-sha tree entries) refuses the index and anything else, so the watcher
  still touches only `catalog/`. A failed merge puts the deleted files back locally.
- **Repo settings it needs.** Settings, Actions, General: "Allow GitHub Actions to create and
  approve pull requests" ticked; `main` requires a PR with 0 approvals but **no required status checks** (a
  PR opened with the default token starts no workflows, so a required check would never
  report); a plain merge commit allowed (the watcher merges with `merge`; this repo disallows squash merges: found on the first real run); label `adapter-watch`
  created. Permissions are per job in the workflow: `publish` has `contents`,
  `pull-requests` and `issues` write; there are no other secrets (the default
  `GITHUB_TOKEN` only). The token reaches the one `git fetch` that syncs the checkout
  between publishes through `GIT_CONFIG_*` environment variables, never argv or
  `.git/config`.
- **Adding an adapter by hand** (the fallback, or to replace a placeholder): write
  `catalog/adapters/<hash>.json` (see "What an adapter contains"), run
  `node scripts/catalog-index.mjs` to rebuild `catalog/index.json`, open a PR. A hash that
  has a placeholder is replaced by the real entry; close its issue by hand (the watcher
  closes it only after its own passing gate run).
- **Not verified live yet** (the first real runs may need a fix): the staging area word
  (`Meeting`, a one-word substring match; `ADAPTER_WATCH_STAGING_AREA` overrides), the
  production area word (`Fire`; `ADAPTER_WATCH_AREA`), the staging room, pusher and woka id (`STAGING_FACTS` in
  `scripts/watch/run.mjs`; the woka reaches selfcheck as `WA_WOKA_ID`; overridable with
  `ADAPTER_WATCH_STAGING_ROOM`, `_PUSHER` and `_WOKA`), `cache-disabled: true` on
  `gradle/actions/setup-gradle@v4` (the Gradle cache is meant to be neither read nor written),
  and the token-carrying `git fetch` through `GIT_CONFIG_*` in `createSyncCheckout` (only
  reached after a merge, so the first publish followed by a second target exercises it). The
  watcher also needs a dry run on a throwaway hash to confirm the repo settings above.
  Note the overrides `ADAPTER_WATCH_AREA`, `_STAGING_AREA`, `_STAGING_WOKA`, `_STAGING_ROOM` and
  `_STAGING_PUSHER` are NOT passed by the workflow: to change one, edit the defaults in `run.mjs` or
  add the variable to the gate job's step.

### The manual procedure (fallback)

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

**Patch releases move the hash too (v1.34.0 → v1.34.1, 2026-10-11).** The hash covers
`messages.proto` *and* `libs/messages/src/JsonMessages/*`; 1.34.1 changed only the analytics
JSON files, so `messages.proto` was byte-identical but the hash went `23c8eb8c` → `b82fc568` and
prod answered the old one with `NEW_VERSION`. Same-minor fix: add the new hash to the front of
the adapter's `apiVersionHashes`, bump `releaseTag`, refresh `proto/<name>/SOURCE`, run `selfcheck`
(no new adapter needed when the proto diff is empty). To compute the hash from a checkout (the
GitHub API can be blocked, a shallow `git clone --depth 1 --branch vX.Y.Z` works): from `messages/`,
`sha1sum protos/messages.proto ../libs/messages/src/JsonMessages/* | sha1sum | cut -c1-8`
(paths must be relative to `messages/`, or the result is wrong).

**Checked 2026-10-13:** upstream's newest tag is still v1.34.1 and prod accepts `b82fc568`. `master` (d2e3ecf, that day) hashes to the same `b82fc568`, so the staging `wa-master` adapter, which was pinned at 7d628838 / `3fb30729` from 2026-09-10, was refreshed (proto re-vendored; `proto-diff` reports no wire-breaking change referenced by `src/`; `selfcheck --target wa-master` passes against prod). The two `resolveAdapter` master tests now read the adapter's `trackedSha` instead of hardcoding it.

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

## `wa say` (issue #7)

- Interface: `python3 <huggingsesame>/src/say.py --pcm-out --quiet --backend modal -`
  with the text on **stdin**; stdout is raw 24 kHz mono s16le PCM. Config:
  `WA_TTS_PYTHON`, `WA_TTS_SAY`. All TTS work stays in that repo.
- WEBRTC mesh path: `src/say.mjs` pipes the PCM into one persistent
  `ffmpeg … -c:a libopus -frame_duration 20 -page_duration 20000 -flush_packets 1 -f ogg`.
  **`-page_duration 20000` is what keeps latency at one frame**; without it ffmpeg
  batches ~1 s per Ogg page. `src/ogg-stream.mjs` demuxes it incrementally and
  `WaAudio._pump` paces the packets as RTP.
- `_pump` with `prebuffer` > 0 (say only) holds 500 ms before the first packet and
  treats a packet more than 60 ms late as a new talkspurt (marker bit, RTP timestamp
  advanced over the gap, clock re-based). File playback keeps prebuffer 0.
- Teardown trap: a child's `close` event waits for all its stdio, so after an early
  stop `say.py`'s unread stdout kept it from ever firing. `speakWebrtc()` destroys the
  child streams before awaiting exit.
- `node --test` runs every file under `test/` as a test. A helper there that blocks
  (e.g. reads stdin) hangs the whole suite, so the say.py stand-in lives in
  `scripts/fake-say.mjs`.
- LiveKit transport (slice 1 of #7): `speakLiveKit()` resamples to 48 kHz and re-chunks
  into 20 ms `Int16Array` frames (each a copy in its own zero-offset buffer, see the
  `.slice()` note in #8); `WaAudio._pumpLiveKit` feeds `captureFrame` with no pacing of
  its own, since `AudioSource`'s 30 s queue paces playout. Because audio is queued
  ahead of playout, every stop (cancel, supersede, hang-up) calls `source.clearQueue()`,
  which also ends a pending `waitForPlayout()`; without it a cancel would keep playing
  the queued tail for seconds. To exercise it headlessly, force LiveKit with three
  avatars and `cpuLimited` (docs/livekit.md, "Forcing LiveKit").
  Verified live (2026-10-15, prod wa-1.34, stub say.py tone, three headless avatars, one
  listening on the LiveKit track): LiveKit up 0.5 s after the flag, both avatars
  connected by 2.2 s; a 3 s utterance = 150 frames, first audio 119 ms, the listener
  received 3.02 s at ~439 Hz (no buzz, correct pitch); a 20 s utterance cancelled after
  2.5 s went silent at the listener 0.23 s later.

Offline end-to-end (2026-10-13, stub `scripts/fake-say.mjs`, real browser peer, WEBRTC mesh):
8 s tone = 401 RTP packets, heard as a steady tone; supersede restarts cleanly (one
small blip at the cut-over, i.e. the old utterance ends abruptly); `wa say --cancel`
true while speaking, no-op when idle; `wa status` during speech 91-154 ms (mostly CLI
start-up); `wa leave` mid-sentence leaves no `say`/`ffmpeg`/`libopus` process; `wa sound
chime` unaffected. Stub audio arrives instantly, so first-audio times (~100 ms) say
nothing about the real cloud.

Live cloud (2026-10-13, real `say.py`, WEBRTC mesh, real browser peer, container warmed by `say.py --hello`):
cold start to the handshake line 58.5 s; warm first audio 6.1-6.7 s from `wa say`, first RTP
0.1-0.2 s after that (the 500 ms prebuffer fills as fast as the cloud produces); a 238-char
paragraph = 829 packets (~16.6 s) heard as a steady voice; supersede, `wa say --cancel` and
`wa leave` mid-sentence all stop within a packet or two and leave no `say.py`/`mimi_sidecar`/
`libopus` process. `say.py --hello` plays on the local speakers, not in the world.
Gotcha: `wa say` right after `wa join` returns 409 until the WEBRTC peer connects (~10 s).
