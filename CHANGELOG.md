# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`wa clear-bubble`** (`POST /clear-bubble`, `WaClient.clearBubble()`) —
  dismiss whatever speech or thought bubble is showing. WorkAdventure clears the
  bubble on an empty `SayMessage`. Closes #1.
- **`/state` now reports `facing`** (`up`/`right`/`down`/`left`); `wa status`
  shows it inline.

### Changed

- **Walking over to a player (`wa to`, `wa greet`) now stops ~40px away and
  turns to face them**, instead of halting up to ~130px off still facing its
  travel direction. `navTo()` gained a `face` option; the daemon aims at a
  point `STAND_GAP` px short of the player (re-derived from their live position)
  via a shared `walkToPlayer()`. Closes #4.

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
