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
| `landmarks` | afrolabs open space | NOT YET RUN | - | Which candidate points does the adapter's collision map call solid? Needs candidates and campey's browser check. |
| `landmarks` | the academy | NOT YET RUN | - | Same, including one `.wam` furniture piece (campus furniture gaps link #92). |
| `voice-signalling` | afrolabs open space | 2026-10-10 | confirms | Proximity pair saw WEBRTC signalling (A: `{kind:"webrtc",with:null}`, B: `{kind:"webrtc",with:"wa-probe-a"}`), no LiveKit invitation. Area-meeting half skipped (no meeting area was confirmed at the time; `meeting-area` now has one). |
| `voice-signalling` | the academy | NOT YET RUN | - | Same, second world. |
| `meeting-area` | afrolabs open space | 2026-10-10 | confirms | 7 `livekitRoomProperty` areas listed; walking A into "Yellowish-Brownish Table" {x:1759,y:1264,w:202,h:140} joined space `9ida9r-5ee315f5-2eb0-4ded-8c6b-c8100ab5b852`. In `meetingAreas`. |
| `meeting-area` | the academy | 2026-10-10 | confirms | 3 areas listed ("(unnamed)", "Lean Coffee Table 1", "Carte Blanche"). Walking into "(unnamed)" {1632,1728,192,224} joined `7e67gt-46769bf1-e571-4237-860a-eec29068035b`; with `--at "Lean Coffee Table 1"` {535,2680,207,160} joined `7e67gt-5cd72740-d3d0-4d90-8d17-172ad53300cc`. "Lean Coffee Table 1" is in `meetingAreas`; the unnamed one is not (no stable name). |

### Raw observations (2026-10-10 13:05 UTC, run by the controller)

- `spawn`, afrolabs open space: `startAreas` [{name:"Spawn Point", x:1895, y:2099, w:169, h:119, isDefault:true}]; `aAsSeenByB` {x:1961, y:2136}; `insideStartArea` true; `tiledStartLayerSample` [2192,1520]; verdict confirms.
- `spawn`, the academy: `startAreas` []; `aAsSeenByB` {x:976, y:2928}; `insideStartArea` false; `tiledStartLayerSample` [976,2928]; verdict new. A's position equals the Tiled start-layer sample, which is what supports "spawned on the Tiled start layer".
- `version-hash`: `23c8eb8c` joined; `05489a87` rejected with NEW_VERSION ("A new version of WorkAdventure is available"); verdict confirms.
- `voice-signalling`, afrolabs: proximity `aSaw` [{kind:"webrtc",with:null}], `bSaw` [{kind:"webrtc",with:"wa-probe-a"}]; area meeting skipped; verdict confirms.

Whole-suite result, `WORLD=live NODE_USE_ENV_PROXY=1 npm run scenarios`, 2026-10-10 (after the follow-ups): 17 scenarios, 14 passed, 3 skipped (two `@fake`, the academy spawn row), 0 failed.

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

A `contradicts` verdict means correcting the matching note in `docs/field-notes.md`.

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
