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

Success: the next ordinary prod bump is absorbed with no human edit and no new APK, and a bump that is *not* ordinary
shows up as an issue, with the app telling its user plainly that this server version isn't supported yet.

### Non-goals

- Downloaded **code**. Adapters are data (decided [campey]; see "Decided").
- Changing the compiled-in protocol of the Android app. A catalog entry cannot add or reshape messages.
- Staging / `master` tracking. Production first [campey]; staging can use the same machinery later.
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

## Discovery [verified 2026-11-10]

The server's home page names its own API hash: `<meta name="wa-api-version" content="f4cfe455">`, and shows the release
string (`v1.34.4`). So the client never has to guess or try hashes. It reads the page, takes the hash, and looks it up
in the catalog index by that hash. (The Android constants already cite this tag. The CLI's `probeVersion` already reads
the release string from the same page.) Self-hosted servers that do not serve the tag are out of scope: the client
behaves as it does today.

## Parts

### 1. The catalog (`catalog/`)

- `catalog/index.json`: `{ "schema": 1, "updated": "<ISO time>", "entries": { "<apiVersionHash>": { "status": "ok" | "needs-attention", "version": "1.34.4", "file": "adapters/<hash>.json", "sha256": "<of the file>", "gate": {...}, "issue": <number|null> } } }`
- `catalog/adapters/<hash>.json`: the adapter data, shaped like today's `wa-1.34` adapter minus code and proto path:
  `{ "schema": 1, "id", "waVersion", "apiVersionHashes": [...], "protoFamily": "wa-1.34", "meeting": {...}, "movement": {...} }`.
  `protoFamily` names a protocol the client already has built in (wa-1.33 / wa-1.34 today). The Node client reads its
  proto from the repo; the Android app has it compiled in, which is why a catalog entry cannot change messages.
- A **placeholder** is an index entry with `status: "needs-attention"`, no `file`, and `gate` holding the failure summary.
- URL: `https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json` (my call; a client setting
  `WA_CATALOG_URL` / an app setting overrides it, which the gate and tests use).
- Seeded with the hashes we already know (v1.34.0, .1, .2, .4) so day one needs no download.

### 2. Client side (CLI and Android)

On the server's "new version" refusal (CLI: `isVersionRejection`; Android: the error screen it shows today as "couldn't
join... please refresh"):

1. Read the server's hash and release string from its home page. If that fails, behave as today (report the refusal).
2. Fetch `index.json`. No entry for the hash: say "no adapter for this server version yet" and stop (no retry storm).
3. Entry `needs-attention`: say "this server version isn't supported yet, it needs attention" and stop.
4. Entry `ok`: if the user's saved choice is "auto", go on. Otherwise ask. CLI: a y / N / always prompt when attached to
   a terminal; in the daemon (no terminal) the refusal is reported with the exact command or flag to allow it. Android:
   a dialog with Download and "Don't ask again".
5. Download the adapter file, verify its sha256 against the index, validate it strictly (schema 1, known fields only,
   numbers inside sane bounds, `protoFamily` one we have built in), save it to the app's own cache, reconnect with it.
6. Next start: cached adapters for the server's hash are used without asking again. Built-in adapters stay as the
   fallback when offline.

The user's choice is stored per client (CLI: its config file; Android: app preferences) and can be reset.

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

Steps of a run:

1. Read the production hash and version from the home page (or the hook's version for a not-yet-live release). If the
   hash is already in the catalog as `ok`, stop.
2. Build a candidate: find the upstream release or commit for that version, compute the hash from it, run `proto-diff`
   against the protocol family in use, take the newest `ok` entry as the base for behaviour numbers.
3. **Gate**, all must pass: (a) the proto diff has no wire change the clients use (additive only); (b) the CLI
   `selfcheck` against production with the candidate (join, move, bubble, area meeting); (c) the live scenario suite
   (`WORLD=live`) with the candidate; (d) a Kotlin smoke with the candidate's hash (`wa-cli`: join and walk to an area).
   For (b) to (d) the clients need to take a candidate from a file or flag without it being in the catalog
   (`--adapter-file` / `WA_ADAPTER_FILE` for the CLI; the Android CLI already has `--api-version`).
4. Pass: commit the adapter and the index entry on a branch and open a PR with auto-merge, so it lands on `main` once
   checks are green and shows as a reviewable diff.
5. Fail: commit a placeholder entry the same way, and open or update **one GitHub issue per server hash**
   ("Server v1.34.5 needs attention"), labelled, with what failed, the run link, and the candidate. A later passing
   run replaces the placeholder with the real entry and closes the issue itself.
6. Do not open a new issue each hour: the issue is found by its hash.

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
