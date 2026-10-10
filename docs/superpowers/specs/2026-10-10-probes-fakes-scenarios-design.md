# Probes, recorder, fake world and BDD scenarios

**Status:** design written from the 2026-10-10 brainstorm, awaiting campey's approval. Nothing is built until it's approved.
**Issue:** #125 (part of #124, the World Port epic)
**Sketch:** `assets/2026-10-10-ports-and-adapters-sketch.png`, the right-hand half (Fake World Adapter, Recording Mock Client, check, Fake Validator, Probes to Live).

Labels used below: **[campey]** = decided by campey in the brainstorm; **[my call]** = Claude's default, open to override.

## Intent: why this exists

The deployed WorkAdventure changes underneath us. Today it's mostly the version number, sometimes the protos, and we have to **expect the unexpected** [campey]. When it changes, the CLI and the APK break until someone works out what changed and ships new code (#55: prod v1.33.8 → v1.34.0).

The epic (#124) turns the clients into stable hosts that download a per-version adapter. This piece is the foundation for that: a set of **human-readable scenarios that describe, in tested fact, how a WorkAdventure world behaves**, and a **fake world that passes them**. Everything else in the epic stands on them:

- Day-to-day tests run fast against the fake instead of a live server.
- A new adapter is accepted when it passes the scenarios live (the gate in #127).
- A cron reruns them live to catch behaviour changes that come without a version change.
- They are the requirements for the hoped-for API (#129).
- You can read them to reason about the adapter's design: they say what the fake's behaviour implies a real adapter must do [campey].

The goal is **stability**, not discovery [campey]. There are no open surprises right now.

## The loop [campey]

1. **Probe.** A small test that asks a running system one question about its behaviour. It's a development tool: you use it to learn or confirm how prod behaves.
2. **Recorder.** While a probe runs, the recorder captures everything that crosses the adapter's **driven ports** (the side facing the WorkAdventure server), so we can reason about what came back. The live server is the system under test. It isn't a mock: it's just a recorder, from the adapter's point of view [campey].
3. **Scenario.** What the probe established, written as a BDD scenario.
4. **Fake World Adapter.** Built **test-first** to pass the scenario.
5. **Gap.** When a scenario passes on the fake but fails live, our understanding has a gap. Probe the gap, update the scenario and the fake.

**Probes are not the gate** [campey]. The gate is the scenarios run live against an adapter (the "live test"). A probe answers one question while we develop. A live test exercises the whole adapter.

## Goals

- **Only re-tested fact.** The first job is to **probe to confirm what the notes already say** (`docs/field-notes.md`, `android/docs/field-notes.md`, the `verified` lists in `src/adapters/`), so the scenarios hold only facts re-tested against the live server [campey]. A note the probe contradicts gets corrected.
- A scenario suite that runs against **the fake or a live adapter, chosen by one switch** [my call: an environment variable such as `WORLD=fake|live`].
- A Fake World Adapter that passes the whole suite offline.
- A recorder on the driven ports that any probe or live run can turn on.
- A doc: **"How we use fakes with probes for ports & adapters"** [campey]. It explains the loop above for future sessions.

## Non-goals

- **Staging.** Prod first; staging follows once prod is right [campey].
- The version-check Actions and auto-merge (#127), the downloadable adapter and catalog (#126), releases (#128), the API (#129).
- Changing how existing client behaviour works. This piece describes and tests; it doesn't fix. *Adding* abilities a scenario needs is allowed (see below).
- Automating "does it look/sound right" checks: rendered bubbles, the media tile, audible audio. They stay manual, as `docs/field-notes.md` "Testing approach" already says [my call].

## Anti-goals: failure even if it technically works

- **A fake that simulates behaviour nobody has probed.** Each fake behaviour must trace to a scenario, and each scenario to a probe.
- **Scenarios pinned to wire details or exact timings.** They assert outcomes ("Ana invites me; I accept and end up in her meeting"), not "frame 7 within 1.5 s". A new adapter only has to behave **at least similarly at the level of the BDD spec** [campey].
- **Flaky live runs that people learn to ignore.** A live failure has to mean something, or the gate and the drift cron are worthless.
- **Committing other people's data.** Recordings in a live world capture other people's names and chat; they are redacted before they're committed, or not committed.

## Where it runs [campey]

Both **prod** worlds, chosen because they mark walls differently:

| world | URL | how walls are marked |
|---|---|---|
| afrolabs open space | `https://play.workadventu.re/@/afrolabs/afrolabs/open-space` | tile layer in the Tiled map *(my reading of the notes)* |
| the academy (the lean-iterator campus) [campey] | `https://play.workadventu.re/@/levelup-npc/lean-iterator/campus` | `.wam` furniture, solid only where each prefab's `collisionGrid` says (`android/docs/field-notes.md`, "Maps") |

**Robot avatars in these live worlds while people are there are fine.** It's what we always do [campey]. Naming and daemon ports follow `CLAUDE.md` (never the bare `claude`, never port 8787).

## What the scenarios cover

**Voice is in scope**: its signalling, and anything else of voice that crosses the World Port [campey]. There's no separate voice epic for now.

First-round areas, each to be confirmed by a probe before it becomes a scenario. Sources in brackets.

- **Connecting.** Our version hash is accepted. A stale hash gets the "new version" error screen ("When prod bumps", #56). This is the scenario that failed in #55.
- **Joining and spawn.** The world tells me where its start area is: the `.wam` start area, not the Tiled `start` layer, which on afrolabs sits about 600 px off ("Spawn point" in `docs/field-notes.md`). I appear inside it. Spawn is chosen client-side [campey: one of the past surprises].
- **Walls.** The world tells me what is solid, by either marking method: tile layer or `.wam` furniture [campey: the other past surprise]. The scenarios name landmarks a person can check, for example "the fire in the afrolabs open space is solid" or "this corridor on the campus is open" *(my guess at the form)*. *Note:* the CLI's map baker still uses an older approximation for furniture (#92), so a furniture scenario may fail through today's code. That's the loop working, not a reason to drop the scenario.

  The server never checks collisions, and spawn is chosen client-side. So live, **a second avatar of ours watches** where the first one appears (a position the server relays), rather than the avatar trusting its own idea of where it is.
- **Presence.** I see other players arrive, move and leave.
- **Areas and area meetings.** Entering a meeting area puts me in its meeting, with the dwell debounce ("Map areas: dwell debounce").
- **Proximity meetings.** Walking up to another avatar puts us in the same group.
- **Invites.** "Invite over": accept, and end up in the inviter's meeting ("Invite over").
- **Chat.** A space chat message arrives with its exact text and sender ("Chat").
- **Bubbles and emotes.** The server accepts them and the connection stays healthy. Whether they render is a manual check.
- **Mic state.** Turning my mic on is seen by the other participant (#10 "red mic").
- **Voice signalling.** Proximity WEBRTC and LiveKit invitations are set up between two of our avatars ("werift constraints", `docs/livekit.md`).

Two-avatar scenarios use two of our own headless instances, which the notes already treat as legitimate live-test participants.

## Decided parts of the how

- **The adapter tells the client what is where; the client reasons about it** [campey]. Reading the world (where the walls, the start area and the map areas are) is part of a world, so it lives inside the adapter: WorkAdventure's map formats (Tiled, `.wam`, entity collections) can change with a version like anything else. **Pathfinding stays in the client** [campey], which plans routes over what the adapter reports. The fake doesn't read maps at all (next point).
- **The live adapter may gain abilities the current client lacks** [campey], as additions that go through the `selfcheck` gate. Known so far: **sending** a meeting invitation (the Android client already has `sendInvite`; the Node client can only accept), and **reading other users' mic state** (the Node client only announces its own). Two of our own avatars can then run the invite and mic scenarios without a human.

- **Scenarios are written in Gherkin (`.feature` files, Given/When/Then), run with cucumber-js in Node** [my call]. When #126 lands, the APK will run the same JavaScript adapter, so Node is the one place the suite needs to run.
- **Scenarios drive a minimal World Port defined here** [my call]. The port doesn't exist yet (#126 formalises it), but the steps need something to drive. So the step definitions talk to a small interface with two implementations: a **live adapter** that wraps today's `WorkAdventureClient` without changing it, and the **fake**. #126 then grows this interface into the real World Port. That means the scenarios come first and #126 inherits them, which is the order #124 wants.
- **The recorder wraps the driven ports**, the WebSocket and HTTP traffic the adapter exchanges with the server. Its output is for people (and Claude) to read when reasoning about a probe, not an input the tests replay [campey: it's a recorder, not a mock].
- **A small injection seam in `src/` is allowed for the recorder** [my call]. `WorkAdventureClient` creates its own `WebSocket` and calls global `fetch`. Letting a caller pass them in is additive, doesn't change behaviour, and is far less brittle than patching globals. Like any `src/` change, it goes through the `selfcheck` merge gate.
- **The recorder covers the pusher WebSocket and HTTP only** [my call]. Voice *signalling* travels over the pusher WebSocket, so it is recorded. The media connections that werift and LiveKit open themselves are not.
- **The sketch's "check / Fake Validator" is the scenario suite run against the fake** [my call]. Nothing replays recordings.
- **The fake is lightweight and doesn't read maps** [campey], to keep tests fast. It holds the few facts the scenarios need as plain data: the start area, and the landmarks the wall scenarios name as solid or open. Live, the adapter has to derive those same facts from WorkAdventure's map files, so the scenarios still test the adapter's map reading; the fake just states the answer.
- **Each fake behaviour names the scenario that requires it, and each scenario names the probe that established it** (a comment or tag is enough) [my call].
- **Where things live** [my call, following the earlier decision to prototype in this repo next to `proto/`]: `world-port/features/` (scenarios), `world-port/probes/`, `world-port/fake/`, `world-port/recordings/` (redacted, optional); the doc goes in `docs/`.

## Left to the builder

- The exact step vocabulary and payload shapes of the minimal port.
- The recorder's output format.
- How a probe is packaged (one script per question is the expected shape).
- How to redact recordings.
- Whether `scripts/selfcheck.mjs` is folded into the suite or kept alongside until #127.
- Ordering within the first round. Suggested start: the version hash, then spawn, then walls, since those are the ones that bit us.

## Known facts a builder needs

- `node scripts/selfcheck.mjs` is today's live smoke test and the merge gate for anything touching `src/` ("Testing approach").
- `npm test` covers pure logic only. Live checks are their own step and need network access to `play.workadventu.re` and `pusher.workadventu.re`.
- Prod is v1.34 (`wa-1.34`, hash `23c8eb8c`). Staging shares that hash as of 2026-10-07 but has its own pusher and character catalogue.
- Several voice bugs in `docs/livekit.md` look plausible-but-wrong on first read. Read it before writing voice probes.
