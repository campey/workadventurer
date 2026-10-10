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
| `version-hash` | afrolabs open space | 2026-10-10 | NOT YET RUN — network policy blocked prod on 2026-10-10 | Does prod accept `23c8eb8c` and turn away `05489a87` with a new-version error? |
| `spawn` | afrolabs open space | 2026-10-10 | NOT YET RUN — network policy blocked prod on 2026-10-10 | Where does an avatar appear: `.wam` start area or Tiled `start` layer? |
| `spawn` | the academy | 2026-10-10 | NOT YET RUN — network policy blocked prod on 2026-10-10 | Same question, second world. |
| `landmarks` | afrolabs open space | 2026-10-10 | NOT YET RUN — network policy blocked prod on 2026-10-10 | Which candidate points does the adapter's collision map call solid? |
| `landmarks` | the academy | 2026-10-10 | NOT YET RUN — network policy blocked prod on 2026-10-10 | Same, including one `.wam` furniture piece (campus furniture gaps link #92). |

A `contradicts` verdict means correcting the matching note in `docs/field-notes.md`.

## Confirming landmarks

`worlds/*.json` hold facts the scenarios assert: `startArea` (`x,y,w,h,confirmedBy`)
and `landmarks` (`name,x,y,solid,confirmedBy`). Nothing goes in unconfirmed; both
files are currently `{ "landmarks": [] }`, so the `@needs-start-area` spawn scenarios
skip ("no confirmed start area") and the walls outline has no rows.

1. List candidates (at least 2 solid and 2 open per world, one `.wam` furniture piece on
   the campus, the afrolabs fire):
   `node world-port/probes/run.mjs landmarks --world "the academy" --at "desk:x,y" --at "floor:x,y"`
2. A person opens the room in a browser and walks into each point. Keep the ones where
   the browser agrees, with `"confirmedBy": "campey, browser, <date>"`; drop the rest.
   A start area comes from the `spawn` probe, confirmed the same way.
3. Add a walls row per landmark. A row that fails live is a gap to report here, not a
   row to delete.
