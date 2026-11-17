# Adapter watcher (#127): implementation plan

Spec: `docs/superpowers/specs/2026-11-10-downloadable-adapters-design.md`, section 3 "The gate and the watcher" (binding).
Builds on #184 (catalog, CLI recovery), already on `main`. The Android recovery flow (#188) is a separate plan and does not block this one.

## Goal

A GitHub Action `adapter-watch` notices a new WorkAdventure API hash on production or staging, gates it with live
checks, and either publishes the adapter to `catalog/` (through a PR it merges itself) or publishes a
`needs-attention` placeholder plus one issue. No person in the loop for the pass case.

## Global constraints (copied from the spec; reviewers check these)

- The watcher never trusts a `repository_dispatch` payload: it re-reads the server's home page and recomputes the hash.
- `main` is protected (PR, 0 approvals). A PR opened with the Actions token starts no other workflows, so nothing the
  watcher needs may depend on a required status check. Branch `adapter/<hash>`, touching only `catalog/`.
- Production: one issue per hash ("Server v1.34.5 needs attention"), found by label plus hash in the title, never a
  new one per hour. Staging: one open issue, updated to the newest failing hash, closed when a staging hash passes.
- A hash already marked `needs-attention` is re-tested only on a manual run, when `main` changed since the
  placeholder recorded its commit, or when the server's version string changes.
- A release that is not live yet is not gated (the hook only makes us notice sooner).
- Staging gate: `selfcheck` plus the Kotlin smoke; the live scenario suite is production-only.
- Staging `waVersion` is `master-<sha>` (the catalog displays it as `master@<sha>`); see issue #189.
- The gate must not put live avatars on a server more than once per new hash (no hourly re-testing of failures).

## Tasks

Each task: implementer + task review, as for the CLI plan. Tests use fakes (fake pusher, fake GitHub API, fake home
page); live runs happen only in Task 8.

### Task 1: candidate adapters from a file (`--adapter-file`, `WA_ADAPTER_FILE`)

The gate must run the clients with an adapter that is not in the catalog yet.
- `resolveConfig`/`resolveAdapter`: `adapterFile` (flag, env, config key) loads and validates a file with
  `validateAdapterFile`/`buildAdapter`; precedence: explicit override > adapter file > cached catalog > probe > allowlist > default.
- Wire into `scripts/selfcheck.mjs`, the scenario runner (`WORLD=live`) and `wa join`.
- Tests: file wins over probe, invalid file fails loudly (never silently falls back), built-in hash still wins over a file only when no flag is given.

### Task 2: candidate builder (`scripts/watch/candidate.mjs`)

- `readServer(target)` for production and staging via `readServerVersion`/`matchApiHash` (reuse, do not copy).
- Export the hash/proto computation from `scripts/vendor-proto.mjs` as a function (today it is CLI-only), taking `GITHUB_TOKEN`.
- `buildCandidate({hash, version, server, catalogIndex})`: base = newest `ok` entry for the same server, copy its
  behaviour numbers and `protoFamily`, set id/waVersion/apiVersionHash; staging uses `master-<sha>`.
- Output: a candidate adapter file that passes `validateAdapterFile`. Decision output: `skip` (hash already `ok`, or
  `needs-attention` and no retest trigger) | `gate`.
- Tests: fake home page + fake catalog; every skip rule; staging naming.

### Task 3: the gate (`scripts/watch/gate.mjs`)

Runs, in order, and records each step's result and first failure text (sanitised and capped like `gateDetail`):
(a) `proto-diff` against the family in use and the wa-1.33 proto, scanning `src/` **and** `android/` (extend
`proto-diff` and the backtest's Kotlin matching), additive-only for the Android proto;
(b) `selfcheck --adapter-file`; (c) production only: `npm run scenarios` with `WORLD=live` and `--adapter-file`;
(d) Kotlin smoke: `wa-cli` with `--api-version <hash>` joining and walking to an area (staging and production).
- Result object `{pass, steps:[{name,status,detail}], candidateFile}`; a timeout per step; never throws.
- Tests: fake steps via injected runners (pass, fail at each step, timeout, step crashes).

### Task 4: publish (`scripts/watch/publish.mjs`)

- Pass: write `catalog/adapters/<hash>.json`, run `rebuildIndex`, branch `adapter/<hash>`, commit, open PR, merge.
- Fail: write a `needs-attention` placeholder (status, server, version, gate text, issue number, the `main` commit it was
  recorded at) through the same PR route.
- GitHub access behind a small port (`createBranch/commit/openPr/merge`) so tests use a fake; real adapter uses the
  REST API with `GITHUB_TOKEN`.
- Tests: file set touched is only `catalog/`; PR merge failure leaves nothing half-published and reports it; idempotent
  re-run on an existing `adapter/<hash>` branch.

### Task 5: issues (`scripts/watch/issues.mjs`)

- Production: find by label `adapter-watch` + hash in title; create or update with what failed, run link, candidate;
  close on a later pass. Staging: single issue, updated to the newest failing hash, closed on a staging pass.
- Never more than one open issue per production hash; never one issue per hour.
- Tests with a fake issues port: create, update, close, dedupe, staging single-issue behaviour.

### Task 6: orchestrator and workflow

- `scripts/watch/run.mjs`: for each of production and staging: read, decide, gate, publish, issue. Exit non-zero only
  on watcher faults, not on a failed gate (a failed gate is a normal outcome). `--dry-run` does everything except the
  PR, merge and issue writes and prints what it would do.
- `.github/workflows/adapter-watch.yml`: `schedule` hourly (minute off the hour), `workflow_dispatch` (inputs: `hash`/`version`, `force`, `dry_run`),
  `repository_dispatch` type `wa-release`. `concurrency` group so two runs never overlap; permissions `contents: write`,
  `pull-requests: write`, `issues: write`. The job needs `dl.google.com`-free steps only except the Kotlin smoke (JDK, Gradle).
- Test: workflow YAML parses; orchestrator end-to-end against fakes, covering pass, fail, skip, retest triggers.

### Task 7: the repository settings and secrets (needs campey)

Not code. Checked in a dry run, and stated plainly if not met:
- Settings, Actions, General: "Allow GitHub Actions to create and approve pull requests" is ticked.
- `main`'s rules require no status checks (a bot PR would never get one).
- If either fails, the fix is a setting or a small token secret, not a design change.
- Optional: David's `repository_dispatch` hook needs a fine-grained token limited to dispatches on this repo, held on their side.

### Task 8: dry run, then a real throwaway

- Dry run on `main` for production and staging (nothing to do: current hashes are `ok`).
- Real run with `force` and a throwaway hash on a branch of the catalog to prove PR, merge and issue paths, then clean up.
- Record results in the ledger and in `docs/field-notes.md`.

### Task 9: docs

`docs/field-notes.md`: "When prod bumps" becomes "When the watcher says needs attention" (what the issue contains, how
to fix a failed gate, how to force a retest). Update CLAUDE.md docs list if a new doc is added.

## Order and dependencies

1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 (can start any time) -> 8 -> 9. Tasks 4 and 5 touch different files and could be
parallel in principle, but SDD runs them sequentially.

## Risks and open questions

- The gate needs the live server and the Kotlin smoke needs a Gradle build: the GitHub-hosted runner has UDP, but the
  gate does not test audio; the audio-join check stays a manual one from a normal network.
- Staging `master` churns constantly: the issue policy above exists for that; the first real staging run may show how
  noisy it is and whether the hourly cadence is too tight.
- The Kotlin smoke only validates the hash (the app applies only the hash). A server bump that changes the wa-1.33 proto
  must be caught by (a), not (d).
- A watcher that merges to `main` by itself is the main trust surface: its token's scope and the "touches only
  `catalog/`" check are load-bearing; the reviewer of Task 4 checks both.
