# Downloadable adapters: design (#126, with #127 and #128's catalog side)

Status: for approval. Epic #124. Builds on `2026-10-10-probes-fakes-scenarios-design.md` (the scenario suite that
gates new versions) and `2026-09-10-wa-version-adapters-design.md` (today's per-version adapters).

## Why

WorkAdventure's production server changes version without notice, and a changed version means a changed API hash. A
client that sends the old hash is refused with a "new version available" error screen. In the last five weeks production
moved v1.33.8 → v1.34.0 → .1 → .2 → .4, and each time the CLI and the Android app stopped connecting until a person
edited the hash by hand in two places (the CLI adapter and the Android constants) and shipped a new build. The Android
APK is the worst case: the user is away from a computer and the app is simply broken.

Not one of those bumps needed more than a new hash. v1.34.1 changed no wire message at all (the hash also covers
analytics JSON files).

## Goal

When the server's version moves, the CLI and the Android app recover on their own, with the user's consent, by fetching
the matching **adapter** from a catalog, and the catalog only ever contains adapters that a machine has proven
sufficient. Nobody ships a new APK or CLI for a routine bump.

**Staging is tracked too** [campey, 2026-11-10], from the start. Staging runs `master`, so its hash changes with
nearly every upstream change to the protocol or the shared JSON files, far more often than production's, and today it is
already ahead of what we ship (its home page says `master@10b19f83`, hash `69f76fed`; our built-in staging adapter is at
`d2d82672`; the Android app hardcodes a staging hash as well).

Success: the next ordinary prod bump is absorbed with no human edit and no new APK, and a bump that is *not* ordinary
shows up as an issue, with the app telling its user plainly that this server version isn't supported yet.

### Non-goals

- Downloaded **code**. Adapters are data (decided [campey]; see "Decided").
- Changing the compiled-in protocol of the Android app. A catalog entry cannot add or reshape messages.
- Signing adapters. The catalog is a folder in this repo; see the trust note below.
- Better discovery than "read the server's own hash from its home page" [campey: improve later].

### Anti-goals (a failure even if it technically works)

- A client downloads anything without the user's consent, unless they chose "don't ask again".
- An adapter reaches the catalog without having passed the gate (a wrong adapter is worse than a missing one).
- A client that works today stops working offline, or when the catalog or GitHub is down. Built-in adapters still work.
- Alarm fatigue: an hourly job that opens a new issue every hour.

## Decided by campey

1. **The adapter is data only, for now.** Hash(es), the behaviour numbers (meeting dwell and linger, walk and run
   speeds, and the like), and which built-in protocol family it is wire-compatible with. Code in adapters is a later
   step if a version ever needs it. Reason: Google Play forbids downloading executable code (an interpreter-run script
   is the exception), and a data adapter already covers every bump so far.
2. **The flow.** When connecting fails with the server's "new version" refusal, the client itself notices, tells the
   user there is a new world adapter, asks permission to download it (with a "don't ask again" choice, which means
   auto-update from then on), fetches it from the catalog and reconnects with it. The CLI and the app do the same thing.
3. **The catalog is a GitHub folder** (`catalog/` in this repo) and both clients download from it.
4. **Every bump is tested before it is published.** A scheduled job builds a candidate adapter, runs the live
   scenario suite with it, and publishes only on a pass. On a fail it publishes a **placeholder** saying the version
   needs attention.
5. **When something needs attention you hear about it through a GitHub issue** (one per server version) plus the
   placeholder in the catalog [campey: "1 plus placeholder"].

## Discovery [verified 2026-11-10, production and staging]

The server's home page names its own API hash: `<meta name="wa-api-version" content="f4cfe455">`, and shows the release
string (`v1.34.4`). So the client never has to guess or try hashes. It reads the page, takes the hash, and looks it up
in the catalog index by that hash. Staging (`play.staging.workadventu.re`) serves the same tag and shows `master@<sha>`
where production shows a release string. (The Android constants already cite this tag. The CLI's `probeVersion` already reads
the release string from the same page.) Self-hosted servers that do not serve the tag are out of scope: the client
behaves as it does today.

## Parts

### 1. The catalog (`catalog/`)

- `catalog/index.json`: `{ "schema": 1, "updated": "<ISO time>", "entries": { "<apiVersionHash>": { "status": "ok" | "needs-attention", "server": "production" | "staging", "version": "1.34.4" or "master@10b19f83", "file": "adapters/<hash>.json", "sha256": "<of the file>", "gate": {...}, "issue": <number|null> } } }`
- `catalog/adapters/<hash>.json`: the adapter data, shaped like today's `wa-1.34` adapter minus code and proto path:
  `{ "schema": 1, "id", "waVersion", "apiVersionHash": "<one hash, equal to its index key>", "protoFamily": "wa-1.34", "meeting": {...}, "movement": {...} }`.
  `protoFamily` names a built-in adapter the Node client starts from (wa-1.33, wa-1.34, or wa-master for staging); the catalog file only
  overrides the whitelisted fields (below) on top of it, so it cannot carry functions or message plumbing.
  **The Android app compiles in only the wa-1.33 proto** (`android/protocol/build.gradle.kts`), which still decodes
  1.34.x because every change since has been additive. So an entry is usable by Android only if it is wire-compatible
  with the 1.33 proto, and the gate checks that separately from the Node check (see the gate).
- **Whitelisted fields and bounds** (my call): `meeting.areaDwellMs` and `areaLingerMs` 0 to 10000 ms,
  `movement.walkPxPerS` and `runPxPerS` 50 to 1000, `apiVersionHash` must match `^[0-9a-f]{8}$`. Anything else in the
  file is ignored.
- **The Android app applies only the hash for now** (my call): its meeting timing and walking are native and hardcoded
  (dwell 1500 / linger 2500, no walk/run), so it ignores the behaviour numbers. This keeps a first download from
  changing how the app behaves. Applying them is a later change to the app, not to the catalog.
- A **placeholder** is an index entry with `status: "needs-attention"`, no `file`, and `gate` holding the failure summary.
- URL: `https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json` (my call; a client setting
  `WA_CATALOG_URL` / an app setting overrides it, which the gate and tests use).
- Seeded with the hashes we already know and have verified (production v1.34.0, .1, .2, .4; staging `d2d82672`; v1.34.3 is left out because it was never seen live). Staging is already past its seed entry: the watcher's first run produces the current one.
- **Staging entries are pruned**: the catalog keeps the newest five staging entries, because staging produces a new hash every few days and old ones are never asked for again. Production entries are kept forever. Built-in hashes always win over the catalog, and a test checks the seed agrees with the built-in hash lists and each `SOURCE` file.

### 2. Client side (CLI and Android)

On the server's "new version" refusal (CLI: `isVersionRejection`; Android: the error screen it shows today as "couldn't
join... please refresh"):

1. Read the server's hash and release string from its home page. If that fails, behave as today (report the refusal).
   Two pieces do not exist yet and are part of the work: the Node `probeVersion` only parses the release string (it
   must also read the `wa-api-version` tag), and the Android app turns the error screen into a plain message and drops
   its `code` (`PusherConnection.kt`), so it must keep a typed "new version" refusal. Reading the home page and the small
   index is not "downloading an adapter": consent covers fetching and applying the adapter file (my call).
2. Fetch `index.json`. No entry for the hash: say "no adapter for this server version yet" and stop (no retry storm).
3. Entry `needs-attention`: say "this server version isn't supported yet, it needs attention" and stop.
4. Entry `ok`: if the user's saved choice is "auto", go on. Otherwise ask. CLI: a y / N / always prompt when attached to
   a terminal; in the daemon (no terminal) the refusal is reported with the exact command or flag to allow it. Android:
   a dialog with Download and "Don't ask again". The connecting happens in the detached daemon, so `wa join` (which is
   attached to the terminal) learns of the refusal from the daemon and does the prompt and the retry itself; under
   `--keep-alive` a bump mid-session with the choice "ask" exits with the existing refusal code rather than waiting, and
   with "auto" the daemon applies the adapter by itself (my call).
5. Download the adapter file, verify its sha256 against the index and that its hash equals the index key, validate it
   strictly (schema 1, whitelisted fields only, numbers inside the bounds above, `protoFamily` one we have built in),
   save it to the client's own cache, reconnect with it. A catalog fetch that fails, times out or 404s counts as "no
   adapter": the original refusal is reported (my call). The raw GitHub host may cache for a few minutes: accepted.
6. Next start: cached adapters for the server's hash are used without asking again. Built-in adapters stay as the
   fallback when offline.

The user's choice is stored per client and can be reset: CLI `adapterUpdates: ask|auto|never` in its config file (also
`WA_ADAPTER_UPDATES`), cache in `~/.workadventurer/adapters/<hash>.json`; Android in app preferences (my call).

### 3. The gate and the watcher (#127)

A GitHub Action named `adapter-watch`, triggered three ways:

- **Hourly schedule**, the safety net that needs nobody's cooperation.
- **Manual run**, with an optional hash/version to test.
- **A push from WorkAdventure** (`repository_dispatch`, event type `wa-release`), if David at WorkAdventure sets up the hook
  he offered [campey]. It would fire on a release or deploy, so we learn of a new version in minutes instead of up to an
  hour, and, if it fires **before** production switches, the candidate can be gated against the release or staging and the
  adapter can already be in the catalog when the bump lands. What we would need from the hook: the version (a tag) and,
  if easily available, the hash; it must authenticate to GitHub with a fine-grained token that can only trigger
  dispatches on this repository (nothing else), kept as a secret on their side. The watcher does not trust the payload:
  it re-reads the server's own home page and recomputes the hash itself, so a wrong or forged payload can at worst cause
  an extra run. Until that hook exists, nothing depends on it.

Steps of a run, **for each of production and staging**:

1. Read the server's hash and version from its home page (or the hook's version for a not-yet-live release). If the
   hash is already in the catalog as `ok`, stop.
2. Build a candidate: find the upstream release or commit for that version, compute the hash from it, run `proto-diff`
   against the protocol family in use, take the newest `ok` entry as the base for behaviour numbers.
3. **Gate**, all must pass: (a) the proto diff has no wire change the clients use: `proto-diff` today scans only
   `src/`, so it must also scan `android/` and be run against both the proto family the Node client uses and the
   wa-1.33 proto the Android app has built in (additive changes only); (b) the CLI
   `selfcheck` against production with the candidate (join, move, bubble, area meeting); (c) the live scenario suite
   (`WORLD=live`) with the candidate; (d) a Kotlin smoke with the candidate's hash (`wa-cli`: join and walk to an area).
   For (b) to (d) the clients need to take a candidate from a file or flag without it being in the catalog:
   `--adapter-file` (also `WA_ADAPTER_FILE`) on `selfcheck`, the scenario runner and the CLI; the Android `wa-cli`
   already has `--api-version`, which is enough because the app applies only the hash. The candidate's hash comes from
   `vendor-proto --check <tag>` using the Actions token (for staging, the `master` commit the page names).
   **Staging gate** (my call): the same checks, but against staging with the staging pusher, woka and room the
   Android app and `scripts/selfcheck.mjs --target wa-master` already know. The live scenario suite (c) is
   production-only for now, because the scenarios' world facts are production worlds; staging relies on `selfcheck`
   and the Kotlin smoke until a staging world has facts.
4. Pass: open a pull request that adds the adapter and the index entry (branch `adapter/<hash>`, touching only
   `catalog/`) and merge it from the workflow. `main` is protected and requires a PR with 0 approvals [campey], so
   this is the route; no person is in the loop. The gate above *is* the check, and the PR needs no other workflow
   to pass: a PR opened with the default Actions token does not start other workflows, so the watcher must not
   depend on any required status check. Two things the builder must confirm with a dry run on a throwaway hash:
   the repo setting "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General) has to
   be ticked, and `main`'s rules must not require status checks (a required check would never report on a bot PR).
   If either does not hold, the fix is a repo setting or a small token secret, not a design change.
5. Fail: put a placeholder entry through the same pull request route, and open or update **one GitHub issue per server hash**
   ("Server v1.34.5 needs attention"), labelled, with what failed, the run link, and the candidate. A later passing
   run replaces the placeholder with the real entry and closes the issue itself.
6. Do not open a new issue each hour: the issue is found by a label plus the hash in its title. **Staging gets one
   open issue, not one per hash** (my call): "Staging needs attention" is updated to name the newest failing hash and
   closed when a staging hash passes, because staging's hash churns and per-hash issues would flood. A hash already marked
   `needs-attention` is **not** re-tested every hour (it would put live avatars on production each time for the same
   answer): it is re-run only on a manual run, or when `main` has changed since the placeholder recorded its commit,
   or when the server's version string changes (my call).
7. A release that is not live yet (the hook case) is **not** gated: the gate needs production to accept the hash, and
   staging runs `master`, not the release. The hook only makes us notice sooner; the gate runs once production switches.
   Gating ahead of the switch against staging is a possible later extension (my call).

The same machinery later extends to staging.

### 4. What a person still does

A bump the gate fails is fixed by a person (or a later automated investigator): the issue says what failed. Examples:
a new message the clients need, a behaviour change the scenarios catch. Fixing it means a client release (the existing
`Android release` workflow, #128) and then a catalog entry.

## Trust (my call)

A downloaded adapter can change the hash and some numbers; it cannot run code. The worst a bad entry can do is make a
client fail to connect or walk oddly. Protection: only `main` of this repo is the source, entries land by PR after the
gate, the index carries each file's sha256, and clients reject anything outside the schema or the sane bounds.
Signing adds nothing against the realistic risk (a bad merge to `main`) and is left for if adapters ever carry code.

## Backtest: when would a data-only adapter have been insufficient? [2026-11-10]

`node scripts/adapter-backtest.mjs --from v1.20.0` compares every upstream release (131 tags, v1.20.0 to v1.34.5) and
the `master` branch with the one before it, on the two things a hash-only change cannot absorb: protocol messages our
clients use (`proto-diff` for the Node client, a message-plus-field name search in the Kotlin sources for Android)
and the `/ws/room` handshake contract (the server's `queryValidator`: which query parameters are required).

| | count |
|---|---|
| releases compared | 131 (v1.20.0 to v1.34.5) |
| proto changed | 34, of which 14 purely additive |
| **would have needed more than a hash** | **6 refs in 4 episodes** |

The episodes: **v1.21.0** (handshake gained required `chatID`, `roomName`); **v1.26.11 to v1.26.15** (`cameraState` and
`microphoneState` became required, then optional again at 1.26.12, then required again at **v1.27.0**; the same refactor
removed `SubMessage.groupUsersUpdateMessage` and reshaped the space filter types); **v1.31.0** (`tabId` became required).
**None in the 36 releases since v1.31.1**, which covers everything our clients were written against: v1.33.6, .7 and
v1.34.0 changed the proto with wire-breaking items, but none that either client touches.

**The upcoming release (`master`, last commit Nov 10; `develop` is stale since Oct 21): a data adapter is
sufficient as far as the wire shows.** Against v1.34.5 the proto has 0 wire-breaking and 29 additive items, the
handshake is unchanged, and the shared JSON changes are analytics files plus one optional new field
(`cameraBackgrounds`) in the `/map` response (`MapDetailsData`). The hash will change; nothing else a client needs does.

**What the backtest cannot see**, and what the gate must therefore catch: behaviour behind an unchanged message shape
(for example the server grouping us into a proximity bubble unless we announce LIVEKIT, found by probing, #177), the
other HTTP endpoints and their shapes (`/anonymLogin`, the `/map` fields we read), and the error screens. These are
what the live scenarios and `selfcheck` are for. Android's check is a name search, so it can miss a rename.

**Finding: four of the six flagged refs were handshake-only changes**, constant query parameters a client simply has to
send (`chatID=""`, `roomName=""`, `cameraState=false`, `tabId=<id>`). That is data, not code. If the adapter carries
the handshake's query parameters (below), only the two space-message refactors (v1.26.12, v1.26.15) would have needed
code. Recommended addition to the adapter schema, decided with the user: see "Open: handshake parameters as data".

## What is left to the builder

- The exact JSON schema and bounds, within the shape above.
- How the CLI loads a candidate or downloaded adapter into `resolveAdapter` (it keeps today's precedence: explicit
  override > this > probe > allowlist > default), and the Android equivalent around `RoomConfig`.
- Config and preference storage, prompt wording, tests (the fake pusher already can answer with the refusal; the Android
  side needs a fake catalog server).
- The candidate builder script and the workflow, reusing `vendor-proto`, `proto-diff`, `selfcheck`, the scenario runner.
- Documentation: field notes ("When prod bumps" becomes "When the watcher says needs attention").

## Order of work (proposed)

1. Catalog format, seeding, and the CLI recovery flow, with the fake pusher and a fake catalog.
2. Android recovery flow.
3. The watcher workflow with the gate, placeholders and issues.
4. Switch the manual "When prod bumps" procedure over to the issue.

Each step ships on its own; steps 1 and 2 alone would already have fixed this month's three bumps.
