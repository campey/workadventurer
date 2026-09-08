# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  navigates over, greets them, and follows.
- `README.md`: the reverse-engineered protocol write-up.

[Unreleased]: https://github.com/campey/workadventurer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/campey/workadventurer/releases/tag/v0.1.0
