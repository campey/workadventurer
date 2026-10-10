# How we use fakes with probes for ports & adapters

Why: the deployed WorkAdventure changes underneath us (#55: prod v1.33.8 to
v1.34.0), and the epic (#124) turns the clients into hosts that download a
per-version adapter. For that we need a written, tested description of how a
world behaves, and a fake that passes it. This doc is the working method.
Design: `docs/superpowers/specs/2026-10-10-probes-fakes-scenarios-design.md`.
Issue: #125, part of #124.

The World Port (`world-port/port.mjs`) is the one surface scenarios talk to.
Two things implement it: the fake (`world-port/fake/`, offline) and the live
adapter (`world-port/live/live-world.mjs`, wraps the real client against prod).

## Status (2026-10-10)

The live side has **not been run**. The cloud environment's network policy
blocked play.workadventu.re. So:

- every probe is NOT YET RUN (see the table in `world-port/probes/README.md`);
- `world-port/worlds/*.json` are `{ "landmarks": [] }`: no confirmed facts yet;
- the `@needs-start-area` scenarios skip, the walls outline has no rows, and
  the voice scenarios wait for the `voice-signalling` probe.

Everything below describes the machinery as built. Nothing in it has been
checked against prod yet, so treat the fake as "passes the scenarios", not as
"matches prod".

## The loop

1. **Probe.** A small live experiment that asks prod one question. A
   development tool for learning or confirming behaviour.
2. **Recorder.** While the probe runs, it captures what crosses the client's
   driven ports (its `fetch` and `WebSocketImpl` options). The live server is
   the system under test; the recorder is not a mock, it only watches.
3. **Scenario.** What the probe established, as a Gherkin scenario in
   `world-port/features/`. Scenarios assert outcomes ("Ana invites me, I
   accept, I end up in her meeting"), not frames or timings.
4. **Fake, test-first.** Extend `world-port/fake/` just far enough to pass the
   scenario.
5. **Gap.** A scenario that passes on the fake but fails live means our
   understanding was wrong. Probe the gap, then fix the scenario and the fake.

**Probes are not the gate; the scenarios run live are.** A probe answers one
question while we develop. The suite run with `WORLD=live` exercises the whole
adapter, and that is what accepts a new adapter (#127).

The first job of the probes is to re-test what `docs/field-notes.md` already
says, so scenarios hold only re-tested fact. A `contradicts` verdict means
correcting the note.

## Rules for the fake

- **It does only what a scenario requires.** No behaviour nobody has probed.
  Each fake behaviour traces to a scenario, each scenario to a probe.
- **It states facts instead of computing them.** The fake does not run
  pathfinding, collision or spawn logic of its own. It reads the world facts
  (start area, which landmarks are solid) and answers from them. If it
  computed them, the fake and the scenario could agree on a wrong answer.
- **Facts need `confirmedBy`.** An entry goes into `world-port/worlds/*.json`
  only with `"confirmedBy": "<who>, <how>, <date>"` (e.g. `campey, browser,
  2026-10-12`): a person saw the browser agree with the probe. Unconfirmed
  facts stay out.
- **A missing fact skips, it does not fail.** Scenarios tagged
  `@needs-start-area` or `@needs-meeting-area` are skipped, with a logged
  reason, when the world has no such confirmed fact
  (`world-port/features/support/hooks.mjs`). `@fake` marks scenarios that rely
  on fake-only server behaviour; they are skipped under `WORLD=live`.

## Running each piece

Scenarios (fast, offline, against the fake):

    npm run scenarios

Same scenarios against prod (needs network; each avatar joins a real world):

    WORLD=live npm run scenarios

`WORLD` is `fake` (default) or `live`. `cucumber.mjs` picks up
`world-port/features/`.

A probe:

    node world-port/probes/run.mjs <probe> [--world "<name>"] [--at "name:x,y" ...]

Probes live in `world-port/probes/` (`version-hash`, `spawn`, `landmarks`,
`voice-signalling`). With no arguments the runner prints usage, the probe
names and the world names. `--at` is repeatable and only the `landmarks` probe
uses it. The probe prints its question, what it observed and a verdict:
`confirms`, `contradicts` or `new`. It never gives a verdict from inconclusive
evidence (a failed connect, an unexpected rejection): it exits 1 instead.
Exit 0 means a verdict, 2 bad arguments. Results are logged in the table in
`world-port/probes/README.md`; the landmark-confirming routine is there too.

Recording:

    RECORD=1 WORLD=live npm run scenarios

With `RECORD=1` the live world saves its traffic on `close()` into
`world-port/recordings/`, which is git-ignored (probe runs always record).
Raw recordings contain other people's names and chat. `redact()` in
`world-port/recorder.mjs` drops every WebSocket frame's bytes (keeping the
length) and scrubs tokens, JWTs and uuids and known names and chat text. Only
redacted output may be committed, and only into
`world-port/recordings/redacted/`.

## When the fake passes and live fails

That is the loop's step 5, and the useful outcome. Do not patch the fake to
make it match.

1. Write down the question the failure raises ("does prod put the avatar in
   the `.wam` start area, or on the Tiled `start` layer?").
2. Add or adjust a probe for exactly that question and run it live, recording.
3. If it `contradicts` a note in `docs/field-notes.md`, correct the note.
4. Fix the scenario to the probed fact, add or correct the confirmed entry in
   `worlds/*.json`, then fix the fake test-first so the scenario passes.
5. Rerun `WORLD=live npm run scenarios`. A live failure must mean something;
   a flaky scenario is a bug in the scenario, not something to ignore.
