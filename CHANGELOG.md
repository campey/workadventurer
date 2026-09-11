# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Live speech-to-text (prototype, `WA_STT=1`).** The avatar can listen:
  `sendrecv` on the audio transceiver, a peer's Opus RTP is muxed to Ogg
  (`src/ogg-opus-mux.mjs`), decoded by a persistent `ffmpeg`, and streamed to
  a resident-model worker (`scripts/stt_worker.py`, `mlx_whisper`) over a Unix
  socket. Live sliding-window transcription — the terminal line redraws in
  place as later context corrects it, locking in on a silence gap. Guarded
  against WA's peer-connect churn (a cap + a single-fire guard, after it once
  spiked the daemon) and against MLX's Metal backend, which crashes on
  concurrent `transcribe()` calls (now serialized). Verify standalone with
  `node scripts/stt-selfcheck.mjs`. `WorkAdventureClient.spaceUserName()`
  resolves a peer's `spaceUserId` to their room name for the speaker label.
- **Stand in the player's eyeline.** `wa to` / `greet` / invite walks now aim
  `frontOf()` the target — ~30 px in the direction they're *facing*, not behind
  or beside them — and turn to face them on arrival. Players' `direction` is
  tracked; `/state` reports each player's `facing`.
- **Spawn at the real spawn point.** The client now spawns at the `.wam`
  map-editor "Start area" (`{ type: "start" }`, `isDefault` preferred) instead
  of the `.tmj` `start` tile layer, which on shared template maps is often a
  stale default elsewhere.
- **Mic prime.** On `pc connected` the client plays one ~0.4 s silence clip so
  the peer sees a live stream and clears the "mic on, receiving nothing" red
  indicator (#10) — no chime needed. Bounded burst; a continuous keepalive
  stream OOMs the daemon (werift's un-awaited send fan-out).
- **Respond to "invite over."** WorkAdventure's *invite to discussion* on the
  woka now auto-accepts and walks the avatar to the sender (`inviteReceived`
  event → `acceptMeetingInvitation` → `walkToPlayer`). `/state.lastInvite`.
- **Version-target adapters.** `src/adapters/` — one adapter per WorkAdventure
  `major.minor` (`wa-1.33` for prod, `wa-master` for staging) carrying its
  `apiVersionHash` set, proto path, endpoints and behavioural quirks. The client
  auto-detects the target from the server's landing page (override with
  `--target` / `WA_TARGET`), falling back to a host allowlist then a warned
  default. `wa status` and `GET /state` report the resolved target.
  `wa selfcheck [--target <id>]` smoke-tests a target; the prod run is the merge
  gate. `scripts/vendor-proto.mjs <ref>` vendors a WA proto + prints its
  `apiVersionHash`. `proto/messages.proto` moved to `proto/wa-1.33/messages.proto`.
- **Per-room collision maps.** `map/<org>/<world>/<room>/collision.json`
  (`build-collision.mjs <roomUrl>`); staging `tcm/workadventure/wa-village`
  baked.
- **`docs/field-notes.md`** — failure modes and non-obvious mechanics (spawn,
  `#10`, werift constraints, area-meeting debounce, staging specifics).

- **`wa wait-emote [player]`** (`POST /wait-emote`) — long-poll that blocks
  until a player emotes; `--emote 👍,👏` matches any of a list. The client now
  surfaces `emoteEventMessage` as an `emote` event. Plus `scripts/intro-sequence.sh`
  + `scripts/typewriter.mjs`: an emote-gated scripted intro that plays a sequence
  of voice clips, streaming each transcript to the terminal, advancing on 👍
  (👏 skips to the end, ❤️ jumps to a marked clip). `wa to <player>` now walks
  *into* the player's map area if they're in one, so the meeting actually forms.
- **Join `livekitRoomProperty` map-area meetings.** On maps that disable
  spontaneous proximity meetings (people talk only via map areas), the client
  now derives the area meeting's space name the way the front-end does
  (`slugify(shortHash(roomUrl) + "-" + areaId)`) and proactively joins/leaves it
  on `areaEnter` / `areaLeave`. A 2-person such meeting runs on WEBRTC, so
  `wa sound` works there today. Closes #13 for the common case; LiveKit
  transport for larger area meetings is still #8. Verified live in a
  `wam-preset-university` "coffee table" area.
- **Map-area awareness.** On connect the client fetches the room's `.wam`; on
  every move it emits `areaEnter` / `areaLeave` with the area's properties
  (`silent`, `jitsiRoomProperty`, `livekitRoomProperty`, megaphone, …). `/state`
  gains `areas`; `wa status` shows them. `WA_DEBUG=1` now logs every inbound
  message kind, and the daemon survives a stray throw in a timer / unawaited
  promise.
- **`wa sound` accepts any format** — non-Opus files (mp3/wav/m4a/…) are
  transcoded once via `ffmpeg` and cached in the temp dir (`src/transcode.mjs`);
  Opus-in-Ogg still plays with no transcode. Closes #9.
- **`wa sound <name|file>`** (`POST /sound`) — play an audio clip into the
  WorkAdventure **proximity voice chat**. The avatar joins the meeting as a real
  mic participant: answers the P2P WebRTC offer with
  [werift](https://github.com/shinyoshiaki/werift-webrtc) (one peer per
  `connectionId`), then streams a pre-encoded Ogg/Opus clip out as RTP. New
  `src/wa-audio.mjs` + dependency-free `src/ogg-opus.mjs`; bundled clips in
  `sounds/`. `wa-client.mjs` gained the Space/meeting layer (query round-trips,
  `joinSpaceQuery` + `addSpaceFilterMessage`, `spaceEvent` plumbing) and a
  `micOn` option. First step toward agent speech (issue #2).
- **`wa clear-bubble`** (`POST /clear-bubble`, `WaClient.clearBubble()`) —
  dismiss whatever speech or thought bubble is showing. WorkAdventure clears the
  bubble on an empty `SayMessage`. Closes #1.
- **`/state` now reports `facing`** (`up`/`right`/`down`/`left`) and `audio`
  (`{peers, connected, inMeeting}`); `wa status` shows `facing` inline.

### Changed

- **Walking over to a player (`wa to`, `wa greet`) now stops close and turns to
  face them**, instead of halting up to ~130px off still facing its travel
  direction. `navTo()` gained a `face` option; the daemon aims via a shared
  `walkToPlayer()`. Closes #4. (Later refined to stand in the player's eyeline
  — see Added.)

### Fixed

- **Area-meeting join/leave is debounced.** `_handleAreaMeeting` fired
  `_joinSpace` / `_leaveSpace` on every `livekitRoomProperty` boundary crossing;
  walking through an area-dense map (staging `wa-village`) churned WebRTC peers
  up/down and OOM'd the daemon / crashed the browser. Now: join after 1.5 s
  dwell, linger 2.5 s after leaving. Walking through is a no-op.
- **`walkToPlayer` aborts when the target leaves view** instead of marching to
  their stale last-known position for the full timeout (which wedged the event
  loop against audio teardown). 3 s grace, then bail.
- **Audio: handle the offer-initiator role.** The server assigns each WebRTC
  connection's initiator per `webRtcStartMessage`; we only knew how to answer,
  so connections where the server made *us* the initiator hung at "connecting".
  Now we send the offer when told to.
- Audio: re-assert `microphoneState` while a clip plays, to shrink the window
  where other clients show a phantom muted-mic icon (#10; not a full fix).

### Known issues

- **#29 — daemon leaks memory across peer-connection cycles.** Repeated
  proximity-bubble / invite create→connect→close balloons RSS and pins CPU
  after ~3–6 cycles (werift `RTCPeerConnection`s not fully released on
  `.close()`). Restart the daemon periodically.

## [0.2.0] - 2026-09-08

A `wa` CLI, a control daemon, and a Claude Code plugin, so the avatar can be
driven from a shell — or ambiently by a Claude Code session (quiet while Claude
works, back at your side when it's done).

### Added

- **`wa` CLI** (`bin/wa.mjs`, `npm i -g workadventurer`): `join`, `leave`,
  `status`, `to`, `follow`, `unfollow`, `quiet`, `resume`, `greet`,
  `speech-bubble`, `thought-bubble`, `goto`. Auto-starts the daemon on demand;
  `--if-running` makes any command a no-op when no daemon is up.
- **`src/wa-daemon.mjs`** — long-running presence: holds the socket, answers
  pings, runs the follow loop, reconnects (bounded retries) on a socket drop.
  HTTP control API on `127.0.0.1:8787`. Advertises itself at
  `$TMPDIR/wa-daemon.json` and `~/.workadventurer/daemon.json`; detached, it
  logs to `~/.workadventurer/daemon.log`.
- **`wa quiet` / `wa resume`** — pause the follow and walk to the nearest empty
  named area; then walk back and resume. `MapNav.nearestEmptyArea()` /
  `areaAt()`.
- **`wa follow`** searches the map (a short wander sweep) for a player who isn't
  in view yet, instead of failing.
- **`src/config.mjs`** — config resolution: flags → env
  (`WA_ROOM`/`WA_NAME`/`WA_DAEMON_PORT`/…) → `~/.config/workadventurer/config.json`
  → built-in defaults.
- **Claude Code plugin** (`plugin/`): `UserPromptSubmit` → `wa quiet` and
  `Stop` → `wa resume` hooks (no-op when no daemon), a `/wa` command, a
  `workadventure` skill, and the `workadventure` subagent. A root
  `.claude-plugin/marketplace.json` for `claude plugin install`.
- Spawn on the map's `start` layer when no `spawn` is given; `map/collision.json`
  carries the `start` tiles and named `.wam` areas; `MapNav` gains
  `randomSpawnPx()`, `roomAt()`, `pointOutsideRoom()`.
- `WorkAdventureClient.follow(getTarget)` — continuous ~100 ms control loop for
  smooth tracking; room-aware `followPoint()` waits just outside an enclosed
  room rather than following in.

### Changed

- Package is publishable: `bin`, `files`, `engines`, `"private"` removed.
- Renamed `src/find-david.mjs` → `src/find-player.mjs` (npm script
  `find-player`); it was already generic over the target name.
- The follow subject survives `wa quiet` (paused) and is dropped only by
  `wa unfollow` — no separate "target" concept.
- The subagent/agent drives the `wa` CLI instead of raw `curl`.

### Breaking

- Text-bubble action renamed `say` → `speech-bubble` / `thought-bubble`:
  `WorkAdventureClient.say()` → `speechBubble()` + `thoughtBubble()`; daemon
  `POST /say` → `POST /speech-bubble` + `POST /thought-bubble`. `say` is
  reserved for a future voice feature.

## [0.1.0] - 2026-09-08

First working version: a headless client that holds a real avatar in the
afrolabs open-space, walks to a named player, and follows them.

### Added

- `WorkAdventureClient` (`src/wa-client.mjs`):
  - anonymous login (`POST /anonymLogin`), JWT passed as the WebSocket
    subprotocol
  - `/ws/room` handshake with the full query string, including the `tabId`
    parameter the deployed server requires
  - `apiVersionHash` (`bfd20fc4`) reproduced from the `v1.33.5` tag
  - the undocumented outer frame envelope `{ 1: seq, 2: payload }`, wrapped on
    send and unwrapped on receive (repeatable field 2)
  - `roomConnected` → `joinRoomFront` → `roomJoined` join sequence
  - world model from `userJoinedMessage` / `userMovedMessage` /
    `userLeftMessage`; `listPlayers()` / `findPlayer()`
  - `walkTo()` — client-authoritative straight-line movement with a
    position-centred viewport (works around the pusher's 1600-zone viewport
    crop that otherwise hides every nearby player)
  - `say()` — speech-bubble / thinking-cloud messages
- `MapNav` (`src/map-nav.mjs`): A\* on the 8-connected tile grid (octile
  heuristic, no corner-cutting) plus line-of-sight path smoothing.
- `navTo()` on the client: follows the smoothed A\* route, re-plans every ~2 s
  to track a moving target, falls back to `walkTo()` when no route exists.
- `scripts/build-collision.mjs`: bakes `map/collision.json` from the live
  `open-space.wam` and its `.tmj` (collisions layer + tileset `collides` flags +
  `.wam` furniture entities).
- `src/find-david.mjs`: driver that connects as `claude`, finds a named player,
  navigates over, greets them, and follows. (Renamed to `find-player.mjs` in
  Unreleased.)
- `README.md`: the reverse-engineered protocol write-up.

[Unreleased]: https://github.com/campey/workadventurer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/campey/workadventurer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/campey/workadventurer/releases/tag/v0.1.0
