# workadventure-app — Android client: design spec

Brainstormed with superpowers:brainstorming (architectural path). Design approved
in chat 2026-10-05.

## Context

The `wa` CLI has reverse-engineered enough of the WorkAdventure protocol to hold
a real avatar: anonymous login → pusher WebSocket/protobuf, live players,
pathfinding/follow, Space join for bubbles/meeting areas, audio over the P2P
WEBRTC mesh and LiveKit. The goal is a **native Android client** for use on the go.

**Why not WA's mobile web client:** background presence (screen off / pocketed,
like a call), notifications, voice-first UX. Longer term: a hands-free,
blind-accessible UX (one tap/hold button for a voice prompt, simple mute,
Bluetooth media buttons: play/pause = mute, skip ± overloaded). Design for this
now; don't build it in v1.

**Prior art (GitHub, 2026-09-30):** no native/mobile WA client exists. Official
mobile = responsive web with a tail of open mobile bugs (#6332, #1197, #5502,
#2218). Accessibility is an open upstream gap (workadventure/workadventure#1055).
The only other headless client, `rllola/wa-bot`, is a stale Node bot pinned to WA v1.15.

## Scope

**v1 = presence core + voice.** Anonymous login; join a room; stay present in a
foreground service; live list of players + meeting areas; follow a player, or walk
to a player or area; two-way voice in proximity bubbles (WEBRTC mesh) and LiveKit
meetings; mute. Target: prod `play.workadventu.re` via the wa-1.33 adapter.

**Out of v1 (later sub-projects, each its own spec):** notifications (arrivals,
approach, invites); full hands-free/voice-prompt UX; map rendering + joystick;
video; account/OIDC login; staging/wa-master adapter; chat.

## Repo & graduation rules

- Prototype in `android/` in this repo. `android/CLAUDE.md` states these rules.
- **Isolation:** nothing in `android/` references the repo outside `android/`,
  except Gradle reading `../proto/`. No reaching into `src/`.
- **Graduation:** once G4 passes, move to its own `workadventure-app` repo
  (`git filter-repo` on `android/`). Shared protocol assets (`proto/`, adapter
  version hashes, wire-behaviour field notes) then move to a shared core repo
  consumed by both the CLI and the app.

## Approach

Native Kotlin: Compose, OkHttp WebSocket, Wire-generated protobuf,
livekit-android. Rejected: nodejs-mobile (werift / `@livekit/rtc-node` have no
Android builds); a remote control for the daemon (audio wouldn't be on the
phone); KMP (speculative reuse); Flutter/RN (foreground audio, MediaSession and
TalkBack are native concerns anyway).

## Architecture (hypothesis: "build to learn", revisable at each gate)

- **`:protocol`** (pure JVM): Wire classes from `../proto/wa-1.33/messages.proto`;
  adapter model ported from `src/adapters/` (version, `apiVersionHash`,
  endpoints); `PusherConnection` (OkHttp WS, keepalive, query/answer
  correlation as in `WorkAdventureClient.query`); `RoomState` reducing messages
  into StateFlows (players, areas, Spaces, my position). Reference:
  `src/wa-client.mjs` (`_anonymLogin`, `_wsUrl`, `connect`, `_handle`,
  `_handleSub`, `_joinSpace`, `setSpaceMicState`, `_wamSpawnPoint`).
- **`:nav`** (pure JVM): port of `src/map-nav.mjs` plus the follow/frontOf maths
  from `wa-client.mjs` (`walkTo`, `navTo`, `followPoint`, `frontOf`, `follow`).
- **`:voice`** (Android): livekit-android for the SFU *and* its bundled
  libwebrtc `PeerConnectionFactory` for the P2P mesh, i.e. one native stack, with
  hardware AEC/NS. Signalling mirrors `src/wa-audio.mjs`: `webRtcStartMessage
  {initiator}`, `webRtcSignal` (simple-peer JSON, non-trickle SDP),
  `webRtcDisconnectMessage`, `iceServersQuery`, `livekitInvitationMessage
  {token, serverUrl}` / `livekitDisconnectMessage`, `setSpaceMicState` (#10).
  **New vs the CLI:** the phone must also be the *initiator* (offerer).
- **`:app`**: Compose UI plus `PresenceService` (foreground service, type
  `microphone`) owning `WaSession { state: StateFlow<SessionState>;
  dispatch(Command) }`. `Command` is a sealed class: `Join`, `Leave`,
  `Follow`, `WalkToPlayer`, `WalkToArea`, `StopMoving`, `SetMuted`. The UI only
  renders state and dispatches. `MediaSession` (play/pause = mute) is a second
  dispatch caller from v1, proving the seam for the future hands-free UX.

Read `docs/field-notes.md` and `docs/livekit.md` before G3/G4. Several bugs
there (codec negotiation, connect race, mic prime, `reader.cancel()`) will
have Android analogues.

## Build order: learning gates

Each gate ends with a **live check** and a findings write-up in
`android/docs/field-notes.md`. Don't advance until the gate's question is
answered. If the answer contradicts the hypothesis, revise this spec first.

| Gate | Question | Build | Live check |
|---|---|---|---|
| G0 | Does a Kotlin client get past the pusher? | `:protocol` as a JVM CLI on the Mac | Avatar (named after worktree) appears in afrolabs; player list prints |
| G1 | Does presence survive on a phone? | `:app` + `PresenceService` + Compose players/areas list | Screen locked about 10 min while a browser avatar moves; list stays live, avatar never drops |
| G2 | Can it move? | `:nav` port; follow / walk-to | Phone avatar follows browser avatar across the map |
| G3 | Mesh audio with browser peers? (riskiest) | `:voice` P2P, both joiner and initiator roles, mute, mic state | Two-way talk phone ↔ browser, no red mic. **Fallback:** Stream `webrtc-android` for the mesh |
| G4 | LiveKit escalation? | Join SFU on invitation, publish + subscribe, switch back on shrink | 4+ person meeting, then shrink back to the mesh |
| G5 | Hands-free seam? | MediaSession play/pause → mute; TalkBack labels | Pocket test with BT earbuds |

Graduation to its own repo happens once G4 passes. G5 can land before or
after the move.

## Testing

- `:protocol`, `:nav`: JVM unit tests. Reducer tests use recorded protobuf
  frames. Nav paths are compared against the Node `map-nav.mjs` output on the
  `map/*/collision.json` fixtures.
- Voice and presence: verified live, per gate (as `scripts/selfcheck.mjs` does
  for the CLI). Unit tests don't count as proof for wire or audio behaviour (see
  the field-notes "Testing approach").
- Hygiene (CLAUDE.md): avatar named after the worktree; a test daemon for the
  browser-side peer gets its own port; `wa leave` when done.

## G2 decisions (2026-10-05, added after G0/G1)

Made while planning G2 (`docs/superpowers/plans/2026-10-05-android-client-g2-nav.md`);
the spec above left these open.

- **Collision maps are built on the phone at runtime**, from the room's `.wam` +
  `.tmj` (user decision), not bundled. The app accepts any room URL, and bundling
  would cover only the three rooms the Node client ever baked. The baked
  `map/**/collision.json` files are test fixtures and a live parity target, never
  read at runtime. `android/` stays self-contained, so the later move to its own
  repo is still a move, not an untangling.
- **The grid loads in the background after the join.** The `.tmj` is ~1.5 MB
  (afrolabs); it must not delay joining. Until it arrives, and permanently if it
  fails, movement is straight-line. The `.tmj` is cached on disk (24 h TTL; a stale
  cache is used if a refetch fails).
- **`:nav` is pure JVM and independent of `:protocol`** (`:protocol` depends on
  `:nav`, not the reverse). It owns the grid, A\*, steering, the collision builder,
  and a coroutine `Navigator` that drives a `MovementSink`; `PusherConnection`
  implements the sink. Cancellation replaces the Node client's `AbortSignal`.
- **Movement semantics differ from Node on purpose:** one final "stopped"
  message per movement, not one per waypoint (which makes other players' avatars
  stutter); a minimum per-iteration delay as an explicit anti-spin guard (Node hit a
  live CPU/RSS spin-crash).
- **Out of G2:** the enclosed-room heuristic in `followPoint` (`roomAt` /
  `pointOutsideRoom` / `nearestEmptyArea`, a hard-coded `board room` regex for one
  map), joining a bubble on entering an area (G3), joystick and map rendering.
- **Finding that changes the testing note above:** Node-parity is checked on
  pathfinding with *exact* path equality (a straight port, including the binary
  heap's tie-breaking); the runtime builder is checked against the baked maps by a
  live parity command (`wa-cli collision --baked`), since the `.tmj` files are too
  large to keep as fixtures.
