# Probes

A probe is a small live experiment that re-tests one fact we have written down
(a note in `docs/field-notes.md`) against prod. It exports
`{ question, world, run(ctx) }`; `run` drives one or more of our own avatars
(`ctx.avatar(role)`, named `wa-probe-<role>`) and returns what it observed plus a
verdict: `confirms`, `contradicts` or `new`. Run one with

    node world-port/probes/run.mjs <probe> [--world "<world key>"]

With no arguments it prints usage. The runner records the traffic (raw
recordings go to the git-ignored `world-port/recordings/`), prints the question,
the observed values and the verdict, and closes every avatar even if the probe
fails. Exit status is 0 on a verdict, 1 if the probe could not run (for example
no connection), 2 on bad arguments. Probes report on our avatars and the map
only, never other players' names.

## Results

| Probe | World | Date | Verdict | Note |
|---|---|---|---|---|
| `version-hash` | afrolabs open space | 2026-10-10 | confirms | Prod accepts `23c8eb8c` and turns away `05489a87` with a new-version error. |
| `spawn` | afrolabs open space | 2026-10-10 | confirms | `.wam` start area "Spawn Point" {x:1895,y:2099,w:169,h:119,isDefault:true}; B saw A at (1961,2136); Tiled start layer sample (2192,1520), so the layer is not where avatars appear. Now in `worlds/afrolabs-open-space.json` as `startArea`. |
| `spawn` | the academy | 2026-10-10 | new | No `.wam` start area: A spawned at (976,2928), the Tiled start layer. Nothing to put in the facts file (do not invent one); the spawn row skips. |
| `landmarks` (wall walk) | afrolabs open space | 2026-10-10 | confirms | `wa-probe-walls` walked to 4 obstacle tiles near the spawn, stopped on the open side facing each, and stood on 1 open tile; campey watched in a browser and emoted 👍 for all 5. Tiles (px): solid (1904,2224), (1872,2064), (2032,2064), (2192,2064); open (2128,2192). In `landmarks`; `walls.feature` 5/5 on fake and live. |
| `landmarks` | the academy | NOT YET RUN | - | Same, including one `.wam` furniture piece (campus furniture gaps link #92). |
| `voice-signalling` | afrolabs open space | 2026-10-10 | confirms | Proximity pair saw WEBRTC signalling (A: `{kind:"webrtc",with:null}`, B: `{kind:"webrtc",with:"wa-probe-a"}`), no LiveKit invitation. Area-meeting half skipped (no meeting area was confirmed at the time; `meeting-area` now has one). |
| `voice-signalling` | the academy | 2026-10-10 | confirms | Same as afrolabs: A `{kind:"webrtc",with:null}`, B `{kind:"webrtc",with:"wa-probe-a"}`, no LiveKit invitation. Area-meeting half not exercised (the probe does not yet drive into a meeting area). |
| `meeting-area` | afrolabs open space | 2026-10-10 | confirms | 7 `livekitRoomProperty` areas listed; walking A into "Yellowish-Brownish Table" {x:1759,y:1264,w:202,h:140} joined space `9ida9r-5ee315f5-2eb0-4ded-8c6b-c8100ab5b852`. In `meetingAreas`. |
| `meeting-area` | the academy | 2026-10-10 | confirms | 3 areas listed ("(unnamed)", "Lean Coffee Table 1", "Carte Blanche"). Walking into "(unnamed)" {1632,1728,192,224} joined `7e67gt-46769bf1-e571-4237-860a-eec29068035b`; with `--at "Lean Coffee Table 1"` {535,2680,207,160} joined `7e67gt-5cd72740-d3d0-4d90-8d17-172ad53300cc`. "Lean Coffee Table 1" is in `meetingAreas`; the unnamed one is not (no stable name). |
| `meeting-availability` | afrolabs open space | 2026-10-10 | new | campey walked their browser avatar into "Fire Pit" (a `livekitRoomProperty` meeting area) and out. The browser client sent `availabilityStatus` **LIVEKIT (11)** on entering and **ONLINE (1)** on leaving (via `setPlayerDetailsMessage`, relayed as `playerDetailsUpdatedMessage`). Our client always reports ONLINE: likely why our proximity bubble persisted through the firepit (gap 3). |
| `firepit-meeting` | afrolabs open space | 2026-10-10 | new | campey and `wa-probe-a` shared the "Fire Pit" meeting area, `wa-probe-a` sending LIVEKIT on entering and ONLINE on leaving like a browser. Five steps (campey in, we in, campey out, campey back, we out), all answered 👍: one meeting, no proximity bubble, clean leave. We joined and left space `9ida9r-fire-pit`. The Fire Pit's centre is solid (the fire), so walking to the centre stops beside it. |

### Raw observations (2026-10-10 13:05 UTC, run by the controller)

- `spawn`, afrolabs open space: `startAreas` [{name:"Spawn Point", x:1895, y:2099, w:169, h:119, isDefault:true}]; `aAsSeenByB` {x:1961, y:2136}; `insideStartArea` true; `tiledStartLayerSample` [2192,1520]; verdict confirms.
- `spawn`, the academy: `startAreas` []; `aAsSeenByB` {x:976, y:2928}; `insideStartArea` false; `tiledStartLayerSample` [976,2928]; verdict new. A's position equals the Tiled start-layer sample, which is what supports "spawned on the Tiled start layer".
- `version-hash`: `23c8eb8c` joined; `05489a87` rejected with NEW_VERSION ("A new version of WorkAdventure is available"); verdict confirms.
- `voice-signalling`, afrolabs: proximity `aSaw` [{kind:"webrtc",with:null}], `bSaw` [{kind:"webrtc",with:"wa-probe-a"}]; area meeting skipped; verdict confirms.
- `voice-signalling`, the academy (later run, 2026-10-10): proximity `aSaw` [{kind:"webrtc",with:null}], `bSaw` [{kind:"webrtc",with:"wa-probe-a"}]; areaMeeting "not implemented: confirmed meeting areas exist but this probe does not yet drive into one"; verdict confirms.

Whole-suite result, `WORLD=live NODE_USE_ENV_PROXY=1 npm run scenarios`, 2026-10-10 (after the follow-ups): 17 scenarios, 14 passed, 3 skipped (two `@fake`, the academy spawn row), 0 failed.

After the meeting-area availability work (gap 3), twice in a row: 23 scenarios, 20 passed, 3 skipped (same three), 0 failed; 137 steps, 119 passed, 18 skipped (7m40s and 7m47s, since avatars now walk). Fake: 23 scenarios, 22 passed, 1 skipped.

## Gaps found

1. **Invite before the server announced the peer** (first live run, 2026-10-10).
   `invites.feature` passed on the fake and failed live at "When avatar A invites
   avatar B" with `unknown player "wa-probe-b"`. Cause: the fake's `players()` and name
   lookup read shared server state, so the fake knew every avatar at once; live an
   avatar knows another only once told (`playerJoined`). Resolution (test-first,
   `test/world-port-fake-known-players.test.mjs`): the fake now keeps what each avatar
   was told, announces joins one event-loop turn after the join, and drops on
   `playerLeft`. The scenario got the precondition `avatar A sees avatar B arrive`;
   without it the scenario fails on the fake with the same error (proving the fake
   models the gap), with it it passes on fake and live. The live adapter needed no change.
2. **The academy has no `.wam` start area** (probe `spawn`, verdict `new`). Spawn falls
   back to the Tiled start layer. The spawn row for the academy skips; documented in
   `spawn.feature` and `docs/field-notes.md`.

3. **Our proximity bubble persisted through the Fire Pit; "same meeting" failed twice in one live run, then passed** (2026-10-10).
   campey saw our two avatars' proximity bubble persist while they walked through the Fire
   Pit, where a browser player's meeting area takes over. `meeting-availability` found the
   likely cause: a browser client sends `availabilityStatus` LIVEKIT (11) on entering a
   meeting area and ONLINE (1) on leaving; ours always said ONLINE. `firepit-meeting` had
   `wa-probe-a` do the same and a person saw all five steps right.
   **Resolved (2026-10-10), test-first:** the wa-1.34 adapter has
   `meeting.areaAvailabilityStatus: 11`; the client sends it when the dwell timer joins an
   area meeting and ONLINE when the linger timer leaves (unit tests in
   `test/wa-area-meeting-debounce.test.mjs`). New scenario "A proximity pair walking into a
   meeting area leaves its bubble for the area meeting" (`meetings.feature`, Fire Pit row):
   it failed on the fake before the fake kept an avatar in an area meeting out of proximity
   bubbles. Live it passed (`meetings.feature:31`, 2m10s). The control confirms the cause:
   with `areaAvailabilityStatus` removed the same live scenario **fails** at "have left the
   proximity meeting" (the pair's bubble was never dissolved after both joined the Fire Pit).
   So the live server does dissolve the bubble when we send LIVEKIT, and not otherwise.
   The Fire Pit is in `meetingAreas` (`confirmedBy: "probe firepit-meeting, 2026-10-10"`).
   Also changed: scenario movement. `LiveWorld.moveTo` now walks with the client's
   pathfinding (`navTo`, `stopWithin: 16`; a position update only without a collision
   map), and steps that moved by fixed offsets go to `openSpotNear` (live: nearest open tile
   centre outside every meeting area plus a 32 px margin; fake: the point unchanged).
   The intermittent "same meeting" failure did **not** recur in two full live runs (20
   passed, 3 skipped each, 0 failed); its cause is still unexplained, but those runs had no
   person near the spawn. Keep watching.

A `contradicts` verdict means correcting the matching note in `docs/field-notes.md`.

## Asking the person watching (👍 / 😂)

Some checks only a person can make, like "did the avatar stop at the wall?" (the
server never enforces collisions). `human-check.mjs` handles these: the avatar shows the
question in a speech bubble, and the person watching in a browser answers with an
emote, 👍 for good and 😂 for wrong. Nothing moves on until someone answers. A probe
that needs a person starts with the same handshake ("👍 when you can see me, 😂 to
cancel") instead of a timed wait. `wall-walk` is the first probe built this way:

    NODE_USE_ENV_PROXY=1 node world-port/probes/run.mjs wall-walk --world "the academy"

## Confirming landmarks

`worlds/*.json` hold facts the scenarios assert: `startArea` (`x,y,w,h,confirmedBy`)
and `landmarks` (`name,x,y,solid,confirmedBy`). Nothing goes in unconfirmed; both
files hold the start area / meeting areas the probes confirmed (2026-10-10) and
`"landmarks": []`, so the academy's `@needs-start-area` spawn row skips ("no confirmed
start area") and the walls outline has no rows. Meeting areas come from the
`meeting-area` probe (`--at "<area name>"` picks one) and carry the joined `space`.

1. List candidates (at least 2 solid and 2 open per world, one `.wam` furniture piece on
   the campus, the afrolabs fire):
   `node world-port/probes/run.mjs landmarks --world "the academy" --at "desk:x,y" --at "floor:x,y"`
2. A person opens the room in a browser and walks into each point. Keep the ones where
   the browser agrees, with `"confirmedBy": "campey, browser, <date>"`; drop the rest.
   A start area comes from the `spawn` probe, confirmed the same way.
3. Add a walls row per landmark. A row that fails live is a gap to report here, not a
   row to delete.
