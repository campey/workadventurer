# Probes, Recorder, Fake World and BDD Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gherkin scenario suite describing, in re-tested fact, how the two prod WorkAdventure worlds behave. It runs against a lightweight fake world or a live adapter, chosen by one switch. It's backed by probes and a recorder, and documented as the project's "fakes with probes" practice.

**Architecture:** `world-port/` holds a minimal World Port (a JSDoc contract), two implementations of it — `fake/` (in-memory, no maps, no network) and `live/` (wraps today's `WorkAdventureClient`) — the `features/` suite run by cucumber-js, `probes/` (one script per question about prod) and a `recorder.mjs` that wraps the driven ports (`fetch` + `WebSocket`). Facts the fake needs (start area, wall landmarks) live as data in `world-port/worlds/*.json` and are only added after a probe or a person has confirmed them live.

**Tech Stack:** Node ≥18 ESM `.mjs`, `node:test` for unit tests, `@cucumber/cucumber` (new devDependency) for scenarios, existing `ws` and `protobufjs`.

**Spec:** `docs/superpowers/specs/2026-10-10-probes-fakes-scenarios-design.md` (issue #125, epic #124)

## Global Constraints

- Prod only: `https://play.workadventu.re/@/afrolabs/afrolabs/open-space` and `https://play.workadventu.re/@/levelup-npc/lean-iterator/campus` (the academy). Staging is out of scope.
- The switch is the env var `WORLD=fake|live`. `fake` is the default; `npm run scenarios` must pass offline with it.
- Live avatars are never named bare `claude`: use `wa-probe-<role>` (e.g. `wa-probe-a`, `wa-probe-b`). No daemon on port 8787. Every live connection is closed in an `After` hook.
- Scenarios assert outcomes, never wire frames or exact timings. Live waits use generous timeouts (default 15 s).
- The fake does not read map files and makes no network calls. Each fake behaviour carries a `// scenario: <feature>:<scenario name>` comment.
- A world fact (`world-port/worlds/*.json`) carries `"confirmedBy"` naming the probe or person that established it. Nothing unconfirmed goes in.
- `src/` changes are additive only (new options, methods, events). Existing behaviour and `npm test` stay unchanged, and `node scripts/selfcheck.mjs --target production` must still pass before merging any task that touches `src/`.
- Recordings can contain other people's names and chat: `world-port/recordings/` is git-ignored; only files passed through `redact()` may be committed, and only into `world-port/recordings/redacted/`.
- Rendering and audible audio are not automated (manual checks stay manual).

## Review Focus

1. **A live run that leaves avatars behind.** Expect every scenario to close its connections even when a step fails or times out. Task 1 adds the `After` hook and Task 2 tests that the live world's `close()` is idempotent.
2. **Other people in the live world.** Expect "a player arrives" style steps to match *our* avatar by name, not the first stranger who joins. Task 5's presence steps filter by name, and a fake scenario adds a stranger to prove it.
3. **A version rejection that arrives after join, not from `connect()`.** Expect the scenario to catch the late error screen too (selfcheck handles both paths). Task 1's fake can reject after join, and the step checks both.
4. **Recordings leaking names or tokens.** Expect redaction to strip `authToken`, uuids, names and chat text. Task 2's redaction test covers each.
5. **Two of our avatars spawning on top of each other.** Expect proximity scenarios to still be able to place one avatar *away* first. Task 5's proximity scenario moves avatar B out of range before the approach.

---

### Task 1: Scenario harness, minimal World Port, fake world, connecting scenarios

**Files:**
- Modify: `package.json` (devDependency `@cucumber/cucumber`, script `"scenarios": "cucumber-js"`)
- Create: `cucumber.mjs` (config: `paths: ["world-port/features/**/*.feature"]`, `import: ["world-port/features/support/**/*.mjs", "world-port/features/steps/**/*.mjs"]`)
- Create: `world-port/port.mjs`
- Create: `world-port/fake/fake-server.mjs`, `world-port/fake/fake-world.mjs`
- Create: `world-port/features/support/world.mjs`, `world-port/features/support/hooks.mjs`
- Create: `world-port/features/connecting.feature`, `world-port/features/steps/connecting.steps.mjs`
- Create: `world-port/worlds/index.mjs`

**Interfaces:**
- Produces, in `world-port/port.mjs`:
  - JSDoc `@typedef WorldPort` with: `connect(): Promise<void>` (rejects with `ServerRejectedError` from `src/server-rejected.mjs`); `close(): void` (idempotent); `self(): {userId:number, name:string, x:number, y:number}`; `players(): {userId:number, name:string, x:number, y:number}[]`; `moveTo(x:number, y:number): Promise<void>` (position update, no pathfinding); `on(event:string, fn:Function): void`; `once(...)`; `off(...)`.
  - `export const EVENTS = ["joined","rejected","playerJoined","playerMoved","playerLeft","areaEntered","areaLeft","meetingJoined","meetingLeft","inviteReceived","inviteAnswered","chatMessage","peerMic","emote"]`.
  - `export function waitFor(port, event, predicate = () => true, timeoutMs = 15000): Promise<any>`, which rejects with `Error("timed out waiting for <event>")`.
- Produces, in `world-port/fake/fake-server.mjs`: `export class FakeServer { constructor({ acceptedHashes = ["23c8eb8c"], rejectAfterJoin = false } = {}) ; join(world): number /* userId */; leave(userId): void; broadcast(fromUserId, event, payload): void }`, with one shared instance per scenario so two fake worlds see each other.
- Produces, in `world-port/fake/fake-world.mjs`: `export class FakeWorld extends EventEmitter /* implements WorldPort */ { constructor({ server, name, versionHash = "23c8eb8c", facts }) }`.
- Produces, in `world-port/features/support/world.mjs`: a cucumber World with `this.avatar(role: string, opts: { versionHash?: string } = {}): WorldPort` (creates on first use with `opts`; role `"A"` → name `wa-probe-a`), `this.worldId` (set by a step), and `this.kind` = `process.env.WORLD ?? "fake"`. For `live` it imports `world-port/live/live-world.mjs` (Task 2) lazily.
- Produces, in `world-port/worlds/index.mjs`: `export const WORLDS = { "afrolabs open space": { roomUrl, factsFile }, "the academy": { roomUrl, factsFile } }`, using the two URLs from Global Constraints. `factsFile` points at Task 4's JSON (not created yet: a missing file loads as `{}`).

- [ ] **Step 1: Write the failing scenarios** in `connecting.feature`:

```gherkin
Feature: Connecting
  Background:
    Given the world "afrolabs open space"

  Scenario: Our version is accepted
    When avatar A connects
    Then avatar A has joined the world

  Scenario: A stale version is turned away
    When avatar A connects with the stale version "05489a87"
    Then avatar A is told a new version is available
```

- [ ] **Step 2: Run** `npm install && npm run scenarios`. Expected: both scenarios **undefined/failing** (no steps yet).
- [ ] **Step 3: Implement** `port.mjs`, `FakeServer`, `FakeWorld` (connect resolves with a userId when `versionHash` is accepted; otherwise it rejects with a `ServerRejectedError` whose code `isVersionRejection` recognises, or emits `rejected` after join when `rejectAfterJoin`), the World, the `After` hook (`close()` every avatar created), and the steps. "Is told a new version is available" passes if `connect()` rejected *or* a `rejected` event arrived within the timeout, judged with `isVersionRejection`.
- [ ] **Step 4: Run** `npm run scenarios`. Expected: 2 passed. Then `npm test`. Expected: unchanged pass.
- [ ] **Step 5: Commit** `feat(world-port): scenario harness, minimal port, fake world, connecting scenarios (#125)`.

---

### Task 2: Driven-port seam, recorder, live world

**Files:**
- Modify: `src/wa-client.mjs` (constructor options `fetch` and `WebSocketImpl`, used at the `fetch(` call sites in `_anonymLogin`/`_loadAreas` and at `new WebSocket(` in `connect()`; defaults are the current globals/imports)
- Create: `test/wa-client-driven-ports.test.mjs`
- Create: `world-port/recorder.mjs`, `test/world-port-recorder.test.mjs`
- Create: `world-port/live/live-world.mjs`
- Modify: `.gitignore` (add `world-port/recordings/*` and `!world-port/recordings/redacted/`)

**Interfaces:**
- Consumes: `WorldPort`, `EVENTS`, `waitFor` (Task 1); `WorkAdventureClient` and its events (`joined`, `error`, `playerJoined`, `playerMoved`, `playerLeft`, `areaEnter`, `areaLeave`, `spaceJoined`, `spaceLeft`, `inviteReceived`, `chatMessage`, `emote`).
- Produces, in `world-port/recorder.mjs`:
  - `export function record({ fetch, WebSocketImpl }, sink): { fetch, WebSocketImpl }`. The wrapped versions push `{ t: ms since start, port: "http"|"ws", dir: "out"|"in", url?, status?, bytes?: base64 }` into `sink` (an array).
  - `export function redact(entries): entries`, which blanks `authToken`, any JWT-looking string, uuid-shaped strings, and replaces names/chat text the recorder decoded with `"<redacted>"`.
  - `export function save(entries, name): string`, which writes `world-port/recordings/<name>-<ISO time>.jsonl` and returns the path.
- Produces, in `world-port/live/live-world.mjs`: `export class LiveWorld extends EventEmitter /* implements WorldPort */ { constructor({ roomUrl, name, versionHash = null, recordTo = null }) }`. It maps client events onto `EVENTS` (`areaEnter`→`areaEntered`, `spaceJoined`→`meetingJoined`, client `error` with `isVersionRejection`→`rejected`). `versionHash` is passed to the client's `version` option. When `RECORD=1` it records via `record()`.

- [ ] **Step 1: Write failing unit tests.**
  - `wa-client-driven-ports.test.mjs`: `test("connect uses the injected fetch and WebSocketImpl")`, using a stub `fetch` (returns `{authToken:"t", userUuid:"u"}` for `/anonymLogin`, `{}` for `/map`) and a stub `WebSocketImpl` class that records its `url` and `protocols`. Assert the stub's url starts with `wss://` (or the pusher's ws scheme) and `protocols` equals `["t"]`. Use `adapter: { envelope: "seq-len-v1", protoPath: "proto/wa-1.34/messages.proto", endpoints: { anonymLogin: "/anonymLogin", map: "/map" }, apiVersionHashes: ["23c8eb8c"] }` and don't await the join (stub never answers).
  - `world-port-recorder.test.mjs`: `test("record captures http out/in and ws in/out")`; `test("redact blanks authToken, JWTs, uuids, names and chat text")`, which asserts none of `"t0k3n"`, `"eyJhbGciOi"`, `"6f1c2a3e-1111-2222-3333-444455556666"`, `"Ana"`, `"hello there"` appears in `JSON.stringify(redact(entries))`.
- [ ] **Step 2: Run** `node --test test/wa-client-driven-ports.test.mjs test/world-port-recorder.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the seam, the recorder and `LiveWorld`. `LiveWorld.close()` is idempotent.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the old tests. Then `node scripts/selfcheck.mjs --target production`. Expected: `OK`. Then `WORLD=live npm run scenarios -- world-port/features/connecting.feature`. Expected: 2 passed (needs network to play.workadventu.re).
- [ ] **Step 5: Commit** `feat(world-port): driven-port seam, recorder and live world (#125)`.

---

### Task 3: Probe runner and the first probes

**Files:**
- Create: `world-port/probes/run.mjs`, `world-port/probes/version-hash.mjs`, `world-port/probes/spawn.mjs`, `world-port/probes/README.md`

**Interfaces:**
- Consumes: `LiveWorld`, `record`, `redact`, `save` (Task 2).
- Produces: a probe module shape `export default { question: string, world: string /* key of WORLDS */, async run(ctx): { observed: object, verdict: "confirms"|"contradicts"|"new", note: string } }`, where `ctx = { avatar(role): LiveWorld, log(msg) }`. `node world-port/probes/run.mjs <probe> [--world <key>]` runs it with recording on, prints the question, the observed values and the verdict, saves the recording, and closes all avatars.

Probes (each confirms or contradicts a note, per the spec's "only re-tested fact"):
- `version-hash`: "Does prod accept `23c8eb8c` and turn away `05489a87` with a new-version error?" (source: "When prod bumps", `docs/field-notes.md`).
- `spawn`: "Where does an avatar appear: the `.wam` start area or the Tiled `start` layer?" Avatar B joins first; avatar A joins; B reports A's joined position. Observed: the start area's rectangle (from the client's areas with a `start` property), A's position as B saw it, and whether it is inside. Run for both worlds.

- [ ] **Step 1: Write** `run.mjs` and the two probes. (Probes are live tools, not unit-tested; the runner's argument parsing is trivial.)
- [ ] **Step 2: Run** `node world-port/probes/run.mjs version-hash` and `node world-port/probes/run.mjs spawn --world "afrolabs open space"`, then `--world "the academy"`. Expected: each prints a verdict and a recording path.
- [ ] **Step 3: Write** `probes/README.md`: one paragraph on what a probe is and how to run one, plus a results table (probe, world, date, verdict, note). Fill it with these runs. If a verdict is `contradicts`, correct the note in `docs/field-notes.md` in this commit.
- [ ] **Step 4: Commit** `feat(world-port): probe runner; probes confirm version-hash and spawn notes (#125)`.

---

### Task 4: World facts; spawn and wall scenarios

**Files:**
- Create: `world-port/worlds/afrolabs-open-space.json`, `world-port/worlds/lean-iterator-campus.json`
- Create: `world-port/probes/landmarks.mjs`
- Create: `world-port/features/spawn.feature`, `world-port/features/walls.feature`, `world-port/features/steps/world.steps.mjs`
- Modify: `world-port/port.mjs` (add `startArea(): {x,y,w,h}|null` and `isSolid(x:number, y:number): boolean` to the typedef), `fake/fake-world.mjs`, `live/live-world.mjs`

**Interfaces:**
- Consumes: Task 1 to 3.
- Produces: facts JSON shape `{ "startArea": { "x", "y", "w", "h", "confirmedBy" }, "landmarks": [ { "name": string, "x": number, "y": number, "solid": boolean, "confirmedBy": string } ] }`. `LiveWorld.startArea()` reads the client's `.wam` area with a `start` property (preferring `isDefault`, same rule as `_wamSpawnPoint`). `LiveWorld.isSolid` uses `client.nav.isPxBlocked`, or throws `Error("no collision map for this room")` if `nav` is null. `FakeWorld.startArea()`/`isSolid()` answer from the facts file only; an unknown point is a thrown `Error("fake has no fact for (x,y)")`, never a guess.

- [ ] **Step 1: Write** `probes/landmarks.mjs`: for a world, print the adapter's `isSolid` reading at each candidate landmark given on the command line (`--at "name:x,y"` repeated). A person then checks each in a browser (walk into it) and marks `confirmedBy: "campey, browser, <date>"` or drops it. Choose at least 2 solid and 2 open landmarks per world, including one piece of `.wam` furniture on the campus and the afrolabs fire. Write the confirmed set and the `spawn` probe's start area into the two JSON files.
- [ ] **Step 2: Write the failing scenarios:**

```gherkin
Feature: Spawn
  Scenario Outline: I appear in the world's start area
    Given the world "<world>"
    And avatar B is in the world
    When avatar A connects
    Then avatar B sees avatar A inside the start area
    Examples:
      | world               |
      | afrolabs open space |
      | the academy         |
```

```gherkin
Feature: Walls
  Scenario Outline: The world says what is solid
    Given the world "<world>"
    When avatar A connects
    Then the world says "<landmark>" is <state>
    Examples:
      | world               | landmark | state |
      # one row per confirmed landmark from the facts files
```

- [ ] **Step 3: Run** `npm run scenarios`. Expected: the new scenarios FAIL on the fake.
- [ ] **Step 4: Implement** `startArea`/`isSolid` on both worlds and the steps (`<state>` is `solid` or `open`). The fake places a joining avatar at the start area's centre. Comment each fake method with its scenario.
- [ ] **Step 5: Run** `npm run scenarios`. Expected: all pass. Then `WORLD=live npm run scenarios -- world-port/features/spawn.feature world-port/features/walls.feature`. Expected: spawn passes. **A wall row that fails live is a gap to report, not a test to delete.** Note each failure in `probes/README.md` and link #92 if it is campus furniture.
- [ ] **Step 6: Commit** `feat(world-port): world facts; spawn and wall scenarios (#125)`.

---

### Task 5: Presence, proximity and area-meeting scenarios

**Files:**
- Create: `world-port/features/presence.feature`, `world-port/features/meetings.feature`, `world-port/features/steps/presence.steps.mjs`, `world-port/features/steps/meetings.steps.mjs`
- Modify: `fake/fake-server.mjs`, `fake/fake-world.mjs` (relay join/move/leave; groups within 64 px; meeting areas from facts), the facts JSON (add `"meetingAreas": [{ name, x, y, w, h, confirmedBy }]`), `live/live-world.mjs` if a mapping is missing

**Interfaces:**
- Consumes: `waitFor`, `avatar(role)`, `moveTo`, facts.
- Produces: steps `avatar {word} sees avatar {word} arrive|move|leave`, `avatar {word} walks next to avatar {word}`, `avatars {word} and {word} are in the same meeting`, `avatar {word} walks into the meeting area {string}`, `avatar {word} joins the meeting for {string}`. Presence steps match by our avatar's **name**, so strangers in the live world are ignored.

Scenarios: a player's arrival, movement and departure are seen; walking next to another of our avatars puts both in the same meeting (`meetingJoined` with equal `spaceName`); walking into a meeting area joins its meeting after the dwell debounce ("Map areas: dwell debounce"). The proximity scenario first moves B 400 px from A. A fake-only scenario `@fake` adds a stranger named `Someone` and proves presence steps ignore them. Meeting areas go into the facts files after a probe run confirms them (reuse `run.mjs` with a `meeting-area` probe if needed).

- [ ] **Step 1: Write the failing scenarios.** **Step 2: Run** (expected FAIL). **Step 3: Implement** the fake behaviours and steps. **Step 4: Run** fake (expected PASS) then `WORLD=live` for these features (expected PASS; failures go to `probes/README.md` as gaps). **Step 5: Commit** `feat(world-port): presence, proximity and area-meeting scenarios (#125)`.

---

### Task 6: Chat, bubbles and emotes scenarios

**Files:**
- Create: `world-port/features/social.feature`, `world-port/features/steps/social.steps.mjs`
- Modify: `port.mjs` (add `chat(spaceName, text)`, `speechBubble(text)`, `thoughtBubble(text)`, `clearBubble()`, `emote(emoji)`), both worlds

**Interfaces:**
- Consumes: the meeting steps (chat needs a shared space).
- Produces: `chatMessage` events `{spaceName, name, text}`, and `emote` events `{name, emote}`.

Scenarios: in a shared meeting, A's chat message reaches B with the exact text and A's name ("Chat" in `docs/field-notes.md`); A sets and clears a speech bubble and a thought bubble and stays connected for 5 s; A's emote reaches B. Whether bubbles render is a manual check: say so in a comment in the feature.

- [ ] Steps as in Task 5: failing scenarios → run → implement → run fake and live → commit `feat(world-port): chat, bubble and emote scenarios (#125)`.

---

### Task 7: New abilities: sending invites, reading others' mic state

**Files:**
- Modify: `src/wa-client.mjs`: add `sendMeetingInvitation(receiverUuid: string, receiverUserId: number|null): void` (sends `meetingInvitationRequestMessage { receiverUserUuid, receiverUserId }`); emit `inviteAnswered { accepted: boolean, name: string }` from `meetingInvitationResponseReceivedMessage { accepted, responderName }` (today it's ignored); emit `peerMic { spaceName, spaceUserId, name, on }` from `initSpaceUsersMessage` users and from `addSpaceUserMessage`/`updateSpaceUserMessage` when the user's `microphoneState` is present (for an update, only when `updateMask.paths` includes `"microphoneState"`). It never fires for our own `spaceUserId`.
- Modify: `test/wa-invite.test.mjs`, create `test/wa-peer-mic.test.mjs`
- Create: `world-port/features/invites.feature`, `world-port/features/mic.feature`, steps
- Modify: `port.mjs` (`invite(playerName)`, `acceptInvite(fromName)`, `setMic(on)`), both worlds

**Interfaces:**
- Consumes: the existing `_handle`/`_handleSub` test pattern (`client()` helper with `_send` stubbed, as in `test/wa-invite.test.mjs`).
- Produces: the three client additions above, and port events `inviteReceived {name}`, `inviteAnswered {accepted, name}`, `peerMic {name, on}`.

- [ ] **Step 1: Write failing unit tests:** `test("sendMeetingInvitation sends meetingInvitationRequestMessage")` asserts `sent[0]` deep-equals `{ meetingInvitationRequestMessage: { receiverUserUuid: "u-2", receiverUserId: 9 } }`; `test("meetingInvitationResponseReceivedMessage -> inviteAnswered")`; `test("updateSpaceUserMessage with microphoneState in the mask -> peerMic")`; `test("peerMic is not emitted for our own spaceUserId")`; `test("updateSpaceUserMessage without microphoneState in the mask -> no peerMic")`.
- [ ] **Step 2: Run** `node --test test/wa-invite.test.mjs test/wa-peer-mic.test.mjs`. Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` (PASS) and `node scripts/selfcheck.mjs --target production` (OK).
- [ ] **Step 5: Write the scenarios:** A invites B; B accepts; A is told B accepted; A and B end up in the same meeting. In a shared meeting, A turns the mic on and B sees A's mic on; A turns it off and B sees it off. Implement in the fake, run fake then live, and record gaps.
- [ ] **Step 6: Commit** `feat: send meeting invitations and surface peers' mic state; invite and mic scenarios (#125)`.

---

### Task 8: Voice signalling scenarios

**Files:**
- Create: `world-port/probes/voice-signalling.mjs`, `world-port/features/voice.feature`, steps
- Modify: `port.mjs` (add event `voiceSignal { kind: "webrtc"|"livekit", with: string|null }`), both worlds

**Interfaces:**
- Consumes: `WaAudio` from `src/wa-audio.mjs` only inside `LiveWorld` (construct it the way `src/wa-daemon.mjs` does). Read `docs/livekit.md` and the "werift constraints" section of `docs/field-notes.md` before starting.
- Produces: the `voiceSignal` event.

- [ ] **Step 1: Probe first.** `voice-signalling.mjs` puts A and B in proximity, then in an area meeting, and records which signalling the pair observes (WEBRTC peer signalling between them; a LiveKit invitation in the area meeting). Run it in both worlds and record the result in `probes/README.md`.
- [ ] **Step 2: Write the scenarios from what the probe showed**, as outcomes: "when A and B meet, a voice connection between them starts to be set up" (webrtc) and "in the meeting area, A is invited to the LiveKit room" (livekit). If the probe contradicts either, write the scenario for what it showed and note the contradiction.
- [ ] **Step 3: Implement** in the fake, run fake then live. **Step 4: Commit** `feat(world-port): voice signalling probe and scenarios (#125)`.

---

### Task 9: The "fakes with probes" doc and pointers

**Files:**
- Create: `docs/fakes-with-probes.md`
- Modify: `CLAUDE.md` (add it to the Docs list), `docs/field-notes.md` "Testing approach" (add `npm run scenarios`, `WORLD=live`, and `world-port/probes/run.mjs`)

Content of `docs/fakes-with-probes.md`, titled **"How we use fakes with probes for ports & adapters"**: the five-step loop (probe → recorder → scenario → fake test-first → gap), "probes are not the gate; the scenarios run live are", the recorder as a recorder on the driven ports (not a mock), "the fake only does what a scenario requires, and states facts instead of computing them", the `confirmedBy` rule, how to run each piece, and how a "fake passes, live fails" result becomes a new probe. Link the spec and #124.

- [ ] **Step 1: Write the doc and the pointers.** **Step 2: Verify** that every command in it runs as written (`npm run scenarios`; `node world-port/probes/run.mjs version-hash`). **Step 3: Commit** `docs: how we use fakes with probes for ports & adapters (#125)`.
