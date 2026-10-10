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

A `contradicts` verdict means correcting the matching note in `docs/field-notes.md`.
