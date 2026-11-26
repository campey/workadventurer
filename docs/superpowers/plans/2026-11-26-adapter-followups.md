# Adapter refactor follow-ups

The downloadable-adapters work (#126 CLI, #127 watcher, #188 Android) shipped with a list of known follow-ups. This plan
does them instead of filing them. Specs: `docs/superpowers/specs/2026-11-10-downloadable-adapters-design.md`; earlier plans:
`2026-11-10-downloadable-adapters-cli.md`, `2026-11-17-adapter-watcher.md`, `2026-11-21-android-adapter-recovery.md`.
Issues this closes: #185 (rollback case), #186 (test gaps), #187 (cleanups), #189 (staging `master-<sha>` naming, already
done in the watcher; confirm and close).

## Global constraints

- Everything the earlier plans fixed stays fixed (consent fails closed, size caps, sanitised text, the gate/publish job
  split, merge pinned to the commit the run made, only `catalog/` writable by the watcher, no live avatars re-gated hourly).
- A catalog change needs no client release: new optional index fields must be ignored by older clients (CLI and Android
  validators keep whitelists; unknown fields never fail a parse).
- Durable reasoning goes in docs, not PR text.

## Tasks

### Task 1: CLI follow-ups (#185, #186, #187)

- **Rollback case (#185):** a probed hash that is in the chosen built-in adapter's list but not first (e.g. `62e25483`)
  is "known" yet refused, because the client always sends `apiVersionHashes[0]`. Send the probed hash (the adapter's
  own list entry the server announced) instead. Also pass the pre-flight's probed hash to the daemon so a failed second
  home-page GET cannot defeat a cached adapter.
- **One `isBuiltinHash`:** export a single check (from `src/adapters/index.mjs`) and inject it where `recover.mjs` and
  `wa-daemon.mjs` each test "is this a built-in hash" today.
- **Unavailable reason (#187):** print the sanitised reason in `wa join` (pre-flight) and in the daemon log (auto mode logs
  only "adapter recovery: unavailable").
- **Pre-flight budget (#187):** the 3 s pre-flight timeout applies per fetch (page, index, file); make it one total budget.
- **Repo rename / 3xx (#187):** a 3xx on the index or file is a failure by design (documented); make the failure message say
  "the catalog moved (HTTP 301 to <host>)" with the host only, so a rename is diagnosable. No redirect following.
- **Tests (#186):** the daemon reconnect give-up path (`acceptHashes` whose accepted set changes after the first join);
  "retry after recovery also rejected -> exit 4" on both the initial-connect and reconnect paths; the seed adapters'
  hashes agree with the proto sources and the built-in hash lists (spec section 1).

### Task 2: watcher follow-ups

- **Staging pruning:** the catalog keeps the newest five `ok` staging entries (and their files); production entries are
  kept forever; built-in hashes are never pruned; a `needs-attention` placeholder for staging is dropped once a newer
  staging entry is `ok`. Done by the publish step in the same PR as the new adapter (so pruning needs no extra workflow),
  touching only `catalog/` (deleted adapter files included), with `assertCatalogPaths` allowing deletes only under
  `catalog/adapters/`. Needs an ordering: record `added` (below).
- **Per-adapter date:** the index entry gets an optional `added` ISO-8601 timestamp, set by `rebuildIndex` for a new `ok`
  entry (never rewritten for an existing one) and preserved across rebuilds. Backfill the current entries from git history
  (commit date of each adapter file) in one catalog commit made by the same script run, no network. Both clients ignore
  unknown fields today; the validators keep it only when it parses as an instant.
- **Staging issue without its label:** staging issues are found by label only, so removing the label makes a duplicate.
  Use the same unlabelled marker-based fallback production has.
- **Marker spoofing:** adopt an issue only if it carries the marker AND was authored by the Actions bot or carries the
  label (so a lookalike issue by anyone else is never edited or closed); say so in the docs.

### Task 3: Android follow-ups

- **Bad cached adapter:** when the server refuses the config built from a cached adapter (`Known` with a cached file),
  delete that cache file (`AdapterStore.delete`) so the next join consults the catalog again; test.
- **Consent mid-session:** `Routes` sends `NeedsConsent` to Join, so after an earlier success the user is pulled off Users
  or a conversation screen and `popUpTo(inclusive)` clears the back stack. Keep the current route while the question is
  open (the dialog is drawn at the AppRoot level already); test the route function.
- **`startsNewCall`:** stop inferring "same call" from the previous state; carry a join generation (call id) in
  `SessionState` that a `Command.Join` increments and a consent answer does not, and key the call log / traffic totals on
  it; tests for Join during the question and a conflated Leave+Join.
- **Self-hosted servers without the version tag:** split "couldn't read the server's version" from catalog failures in
  the message ("this server doesn't publish its version, so the app can't check for an update").
- **Date in the dialog:** show the adapter's `added` instant (label "Adapter added") when the catalog has it, else the
  existing "Catalog updated"; update the formatter and tests.
- Deferred minors from the Android recovery review: non-overlapping meta scan, cancel test proving `call.cancel()` runs,
  non-BMP format characters in the sanitiser, CPU work off the caller's dispatcher.

### Task 4: docs audit

Fix every doc that still describes the pre-refactor world or omits the new pieces: README "Version targets" (the
catalog, `adapterUpdates`, `--adapter-file`, the watcher, and that an unknown hash no longer just fails), the spec status
(approved and built, plus where the build deviated: code-fingerprint retests, the job split, merge commits, server-aware
decide, enable switch, Android applying any `ok` entry), CHANGELOG `[Unreleased]` (catalog and recovery, watcher,
Android recovery, `wa-cli` staging fix, `--adapter-file`), the roadmap (a short "adapters and the watcher" note under
goal 1 and the "how the pieces fit" diagram), `android/CLAUDE.md` and `android/docs/field-notes.md` (the old
"Prod bump broke the APK" note says what #126 would remove: mark it resolved), and the root CLAUDE.md docs list.

## Order

1 -> 2 -> 3 -> 4. Each task has its own review; Task 2 (it deletes catalog files through an automated merge) gets the
stronger reviewer.
