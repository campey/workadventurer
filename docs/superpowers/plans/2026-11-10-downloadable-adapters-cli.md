# Downloadable adapters, part 1: the catalog and the CLI recovery flow: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When production's API hash is one the CLI doesn't know, `wa join` finds the matching adapter in a catalog, asks permission (or applies it automatically), downloads it, and connects, with no new CLI release.

**Architecture:** A new `src/catalog/` package: a strict validator and builder for catalog adapter files (data only, laid over a built-in adapter), a reader for the server's own `wa-api-version` hash, a downloader with sha256 verification and a local cache, and one orchestrating `recoverAdapter()` with an injected prompt. `resolveAdapter` gains a "cached catalog adapter" step, `wa join` runs the recovery before spawning the daemon, and the daemon applies it by itself in `auto` mode. The catalog itself (`catalog/`) is seeded from the hashes we already know.

**Tech Stack:** Node 22 ESM, `node:test`, `node:http` for fake servers, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-downloadable-adapters-design.md` (parts 1 and 2, and the CLI half of the order of work). Parts for the Android app and the watcher workflow get their own plans.

## Global Constraints

- Adapters are **data only**: no code, no functions, no proto files in a catalog adapter.
- Catalog index URL default: `https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json`; override with `WA_CATALOG_URL`.
- Adapter file shape: `{ "schema": 1, "id", "waVersion", "apiVersionHash": "<8 hex>", "server": "production"|"staging", "protoFamily": "wa-1.33"|"wa-1.34"|"wa-master", "meeting": {...}, "movement": {...} }`. One hash per file, equal to its index key. Hash regex `^[0-9a-f]{8}$`.
- A catalog adapter file also carries `"server"` (`"production"` or `"staging"`), validated as one of those two; it is informational for the client (the index and the watcher use it).
- Whitelisted overrides and bounds: `meeting.areaDwellMs`, `meeting.areaLingerMs`: integers 0 to 10000; `movement.walkPxPerS`, `movement.runPxPerS`: numbers 50 to 1000. Any other field is dropped.
- Index shape: `{ "schema": 1, "updated": "<ISO>", "entries": { "<hash>": { "status": "ok"|"needs-attention", "server": "production"|"staging", "version", "file", "sha256", "gate", "issue" } } }`. A placeholder has `status: "needs-attention"` and no `file`. Staging servers (which show `master@<sha>`) work exactly like production: the hash is the key; `version` is the release (`v1.34.4`) or `master@<sha>`.
- Built-in hashes always win over the catalog; a built-in or cached hash never triggers a prompt.
- Consent covers downloading and applying the adapter file. Reading the server home page and the index needs no consent.
- CLI setting `adapterUpdates`: `"ask"` (default) | `"auto"` | `"never"`; env `WA_ADAPTER_UPDATES`; saved in `~/.config/workadventurer/config.json`.
- Cache: `~/.workadventurer/adapters/<hash>.json`.
- A catalog or page fetch that fails, times out, or returns something invalid means "unavailable": behave exactly as today (no new failure, no hang). Offline use must not get worse.
- With no terminal, `ask` never blocks on input: it answers "no".
- Messages say plainly: "no adapter for this server version yet", "this server version isn't supported yet, it needs attention".
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_01WQMLMiLr3CYZeTx99GUPMk`.

## Review Focus

Failure modes the spec implies that no single task's happy path exercises (each has its test in the task named):

1. A hostile or damaged catalog file: out-of-bounds numbers, extra fields, wrong hash, wrong sha256, unknown `protoFamily` (while `wa-master` is valid), HTML where JSON should be. Must be rejected, never applied or crashing (Tasks 1, 3).
2. A corrupt cache file left by a crashed write or two `wa join` runs at once. Must be ignored, and writes must be atomic (Task 2).
3. Catalog unreachable, slow, or 404 while the server's hash is unknown. `wa join` must proceed as it does today within seconds (Tasks 4, 7).
4. `ask` mode with no terminal (cron, daemon, CI). Must not hang; must print how to allow it (Tasks 5, 7).
5. A server home page with no `wa-api-version` tag (self-hosted). Must not prompt or block (Tasks 3, 7).

---

### Task 1: Adapter file schema and builder

**Files:**
- Create: `src/catalog/schema.mjs`
- Test: `test/catalog-schema.test.mjs`

**Interfaces:**
- Consumes: built-in adapter objects keyed by id, as `ADAPTERS` in `src/adapters/index.mjs` (each has `id`, `waVersion`, `apiVersionHashes`, `meeting`, optionally `movement`).
- Produces:
  - `export const HASH_RE`, `export const BOUNDS = { dwellMs: [0, 10000], lingerMs: [0, 10000], speed: [50, 1000] }`.
  - `export function validateAdapterFile(file: unknown, builtins: Record<string, object>): { ok: true, file: AdapterFile } | { ok: false, reason: string }` where `AdapterFile` is the normalised file with only whitelisted fields.
  - `export function buildAdapter(file: AdapterFile, builtins): object`: a full adapter: the `builtins[file.protoFamily]` object with `id`, `waVersion` from the file, `stability: "catalog"`, `apiVersionHashes: [file.apiVersionHash, ...base hashes without it]`, `meeting` and `movement` merged over the base's.

- [ ] **Step 1: Write the failing tests** in `test/catalog-schema.test.mjs`: a good file passes and normalises; each rejection has its own test with a `reason` that names the field: non-object, `schema !== 1`, bad hash (`"XYZ"`, 9 chars), unknown `protoFamily` (while `wa-master` is valid), `server: "elsewhere"`, `areaDwellMs: 99999`, `areaLingerMs: -1`, `walkPxPerS: "fast"`, `runPxPerS: 5000`; an extra field (`"code": "..."`, `meeting.evil`) is dropped from the normalised file; `buildAdapter` puts the file's hash first, keeps the base's other hashes once each, overrides only the given numbers, and leaves the built-in object unmutated (`builtins["wa-1.34"].meeting` unchanged after the call).
- [ ] **Step 2: Run** `node --test test/catalog-schema.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `validateAdapterFile` and `buildAdapter` in `src/catalog/schema.mjs` per the signatures above. Plain checks, no schema library.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(catalog): adapter file schema, bounds and builder (#126)`).

### Task 2: Local adapter cache

**Files:**
- Create: `src/catalog/store.mjs`
- Test: `test/catalog-store.test.mjs`

**Interfaces:**
- Consumes: `validateAdapterFile`, `buildAdapter` from Task 1.
- Produces:
  - `export const defaultCacheDir: () => string` (`~/.workadventurer/adapters`).
  - `export async function saveCached(hash: string, text: string, opts?: { dir?: string }): Promise<void>`: writes `<dir>/<hash>.json` atomically (write a temp file in the same directory, then rename), creating the directory.
  - `export async function loadCached(hash: string, opts: { dir?: string, builtins: object }): Promise<object | null>`: the built adapter, or `null` if missing, unparsable, invalid, or its `apiVersionHash` differs from `hash`.
  - `export async function cachedHashes(opts?: { dir?: string }): Promise<Set<string>>`: hashes with a `.json` file whose name matches `HASH_RE`.

- [ ] **Step 1: Write the failing tests** using a temp directory per test: save then load round-trips to a built adapter; a corrupt file (`"{not json"`), a file whose hash field differs from its name, and an out-of-bounds file each load as `null` and do not throw; `saveCached` leaves no `*.tmp` files behind and two concurrent saves of the same hash (`Promise.all`) leave one valid file; `cachedHashes` ignores non-hash file names.
- [ ] **Step 2: Run** `node --test test/catalog-store.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions in `src/catalog/store.mjs`. Use a unique temp file name per call (pid + random) so concurrent writers never share one.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(catalog): atomic adapter cache (#126)`).

### Task 3: Read the server's own hash

**Files:**
- Create: `src/catalog/server-version.mjs`
- Modify: `src/adapters/index.mjs:24-48` (`probeVersion` also returns `hash` when the page has the tag)
- Test: `test/catalog-server-version.test.mjs`; extend `test/adapters.test.mjs` for `probeVersion`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function matchApiHash(html: string): string | null`: the content of `<meta name="wa-api-version" content="f4cfe455">` if it matches `HASH_RE` (attribute order and quote style may vary: also accept `content` before `name`).
  - `export async function readServerVersion(roomUrl: string, opts?: { fetch?: typeof fetch, timeoutMs?: number }): Promise<{ hash: string | null, release: string | null } | null>`: GET of the room URL's origin (`/`), `release` from the existing `matchVersion` (e.g. `"v1.34.4"`, the `raw` field), `null` on any failure or when neither value is found. Default `timeoutMs` 8000.
  - `probeVersion(roomUrl)` result gains `hash` (string) when the tag is present; its existing fields and `matchVersion`'s exact output do not change (`test/adapters.test.mjs` deep-equals `matchVersion`).

- [ ] **Step 1: Write the failing tests:** `matchApiHash` on the real tag text `<meta name="wa-api-version" content="f4cfe455">`, reversed attribute order, a non-hex value (null), a 9-char value (null), no tag (null); `readServerVersion` against a local `http.createServer` returning that HTML (hash and release both set), HTML without the tag (hash null, release set), a 500 (null), and a server that never answers with `timeoutMs: 100` (null, returns within 1 s); `probeVersion` adds `hash`.
- [ ] **Step 2: Run both test files.** Expected: FAIL.
- [ ] **Step 3: Implement** `matchApiHash` and `readServerVersion`; thread `hash` into `probeVersion` without changing `matchVersion`.
- [ ] **Step 4: Run** `node --test test/catalog-server-version.test.mjs test/adapters.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(catalog): read the server's wa-api-version (#126)`).

### Task 4: Fetch the index and adapter files

**Files:**
- Create: `src/catalog/client.mjs`
- Test: `test/catalog-client.test.mjs`

**Interfaces:**
- Consumes: `validateAdapterFile` (Task 1).
- Produces:
  - `export const DEFAULT_CATALOG_URL`; `export function catalogUrl(env = process.env): string` (`WA_CATALOG_URL` or the default).
  - `export async function fetchIndex(opts?: { url?: string, fetch?: typeof fetch, timeoutMs?: number }): Promise<{ ok: true, url: string, index: Index } | { ok: false, reason: string }>`: fails on a non-2xx, non-JSON, `schema !== 1`, or missing `entries` object; default `timeoutMs` 8000.
  - `export async function fetchAdapterFile(opts: { indexUrl: string, hash: string, entry: IndexEntry, builtins: object, fetch?: typeof fetch, timeoutMs?: number }): Promise<{ ok: true, text: string, file: AdapterFile } | { ok: false, reason: string }>`: the URL is `new URL(entry.file, indexUrl)`; the body's sha256 (hex) must equal `entry.sha256`; the parsed file must pass `validateAdapterFile` and have `apiVersionHash === hash`.

- [ ] **Step 1: Write the failing tests** against a local `http.createServer` serving an index and files: happy path; index 404; index is HTML; index `schema: 2`; adapter file with a different sha256 than the index says; file whose hash field differs from the key; file with `areaDwellMs: 99999`; a hanging server with a 100 ms timeout; `catalogUrl` honours `WA_CATALOG_URL`.
- [ ] **Step 2: Run** `node --test test/catalog-client.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions; sha256 via `node:crypto` over the raw bytes, not the re-serialised JSON.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(catalog): fetch and verify the catalog index and adapter files (#126)`).

### Task 5: Config setting and the prompt

**Files:**
- Modify: `src/config.mjs` (add `adapterUpdates`; add a config-file writer)
- Create: `src/catalog/prompt.mjs`
- Test: `test/catalog-prompt.test.mjs`; extend the existing config tests (find them with `grep -l resolveConfig test/*.mjs`).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveConfig(...)` result has `adapterUpdates: "ask" | "auto" | "never"`: default `"ask"`, env `WA_ADAPTER_UPDATES`, file key `adapterUpdates`; any other value falls back to `"ask"`.
  - `export function writeConfigField(field: string, value: unknown, path?: string): void` in `src/config.mjs`: merges one field into the JSON config file (creating directories and the file), keeping the other fields; `path` defaults to `CONFIG_PATH`.
  - `export async function askYesNoAlways(question: string, opts?: { input?: Readable, output?: Writable }): Promise<"yes" | "no" | "always">` in `src/catalog/prompt.mjs`: writes the question plus `[y/N/always]` to `output` (default `process.stderr`), reads one line from `input` (default `process.stdin`); `y`/`yes` → yes, `a`/`always` → always, anything else (including empty) → no; if `input.isTTY` is falsy it returns `"no"` immediately without reading.

- [ ] **Step 1: Write the failing tests:** config precedence for `adapterUpdates` (default, file, env, junk value); `writeConfigField` on a missing file and on a file with other fields (both kept) using a temp path; `askYesNoAlways` with a fake TTY `PassThrough` for `y`, `YES`, `always`, empty line, `n`, and a non-TTY input (resolves `"no"` at once and never reads: assert it resolves within 50 ms with no data written to the stream).
- [ ] **Step 2: Run** the new and extended test files. Expected: FAIL.
- [ ] **Step 3: Implement** the three pieces. `readline` is enough for the prompt.
- [ ] **Step 4: Run again, then `npm test`.** Expected: PASS, no existing config test changes.
- [ ] **Step 5: Commit** (`feat(cli): adapterUpdates setting and a terminal-safe prompt (#126)`).

### Task 6: `resolveAdapter` uses a cached catalog adapter

**Files:**
- Modify: `src/adapters/index.mjs` (`resolveAdapter`)
- Modify: `src/wa-client.mjs:255` (pass the cache lookup)
- Test: extend `test/adapters.test.mjs`

**Interfaces:**
- Consumes: `loadCached` (Task 2); the `hash` field `probeVersion` now returns (Task 3).
- Produces: `resolveAdapter({ roomUrl, override, probeFn, cachedFor })` where `cachedFor?: (hash: string) => Promise<object | null>`. New precedence: explicit override > **cached catalog adapter for the probed hash** > the existing probe, allowlist, default steps. The cached step applies only when the probe has a `hash` that is **not** in any built-in adapter's `apiVersionHashes` and `cachedFor(hash)` returns an adapter; the result is `{ adapter, why: "catalog adapter <id> (<hash>) from the local cache" }`. `WorkAdventureClient.connect()` passes `cachedFor: (h) => loadCached(h, { builtins: ADAPTERS })`.

- [ ] **Step 1: Write the failing tests** with an injected `probeFn` returning `{ kind: "release", minor: "1.34", raw: "v1.34.9", hash: "deadbeef" }` and an injected `cachedFor`: cached adapter wins over the probe's default; a hash that is built in never consults `cachedFor` (assert it is not called); an explicit `override` still wins; `cachedFor` returning `null` or throwing falls through to today's result (a throw must not break connecting).
- [ ] **Step 2: Run** `node --test test/adapters.test.mjs`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the precedence change and the `connect()` wiring; the `catch` around `cachedFor` logs nothing and falls through.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(adapters): resolve a cached catalog adapter by the server's hash (#126)`).

### Task 7: `recoverAdapter` and the `wa join` pre-flight

**Files:**
- Create: `src/catalog/recover.mjs`
- Modify: `bin/wa.mjs` (`case "join"`, around line 128: run the pre-flight before spawning)
- Test: `test/catalog-recover.test.mjs`

**Interfaces:**
- Consumes: `readServerVersion` (3), `fetchIndex`/`fetchAdapterFile`/`catalogUrl` (4), `saveCached`/`cachedHashes` (2), `askYesNoAlways`/`writeConfigField` and `resolveConfig().adapterUpdates` (5), `ADAPTERS` and `buildAdapter`.
- Produces: `export async function recoverAdapter(opts: { roomUrl: string, mode: "ask"|"auto"|"never", ask?: (q: string) => Promise<"yes"|"no"|"always">, onAlways?: () => void, fetch?, indexUrl?, dir?, builtins: object, log?: (m: string) => void }): Promise<Outcome>` with
  - `{ status: "unavailable", reason }`: the page or catalog could not be read or is invalid, or the page has no hash. Nothing else happened.
  - `{ status: "known", hash }`: the hash is built in or already cached.
  - `{ status: "unsupported", hash, reason: "no-entry" | "needs-attention", detail?: string }`
  - `{ status: "never", hash }`: mode `never` and an adapter exists.
  - `{ status: "declined", hash }`
  - `{ status: "applied", hash, adapter }`: downloaded, verified, saved to the cache, built.
  Flow: read the server version → known? → fetch the index → entry missing → `unsupported/no-entry`; `needs-attention` → `unsupported/needs-attention` with the entry's `gate` summary as `detail`; entry ok and mode `never` → `never`; mode `ask` → `ask("…new world adapter for <release or hash>… download it?")`, `"no"` → `declined`, `"always"` → call `onAlways()` then continue; mode `auto` continues without asking; then `fetchAdapterFile`, any failure → `unavailable`; `saveCached`; `applied`.
  - In `bin/wa.mjs`: before spawning the daemon in `join`, unless `cfg.version` (an explicit `WA_VERSION`/flag) or `cfg.target !== "auto"` is set, call `recoverAdapter` with `mode: cfg.adapterUpdates`, `ask: askYesNoAlways`, `onAlways: () => writeConfigField("adapterUpdates", "auto")`, `builtins: ADAPTERS`, `log: note`. Then: `applied` → `note("using adapter <id> (<hash>)")` and continue; `known` or `unavailable` → continue silently as today; `unsupported/no-entry` → print "no adapter for this server version yet", exit 4; `unsupported/needs-attention` → print "this server version isn't supported yet, it needs attention" plus the detail, exit 4; `declined` or `never` → print how to allow it (`wa join` again and answer y, or set `adapterUpdates` to `auto` with `WA_ADAPTER_UPDATES=auto`), exit 4. Exit 4 is the existing refused code (`REFUSED_EXIT`).

- [ ] **Step 1: Write the failing tests** for `recoverAdapter` with a local server serving a home page, an index and an adapter file: each outcome above has a test; in `auto` mode `ask` is never called (a throwing `ask` stub); in `ask` mode a `"no"` leaves the cache empty and a `"yes"` fills it; `"always"` calls `onAlways` exactly once; a catalog that 404s gives `unavailable` in under 2 s with `timeoutMs` small; a page with no tag gives `unavailable`; a tampered adapter file (sha mismatch) gives `unavailable` and nothing cached; a built-in hash gives `known` without any index request (assert the server saw none). Add one process-level test: run `node bin/wa.mjs join` as a child with `WA_ROOM` pointing at the local server, `WA_CATALOG_URL` at its index, `WA_ADAPTER_UPDATES=ask` and no TTY: it exits 4 within 5 s and its output says how to allow the update (this proves the no-hang case through the real entry point).
- [ ] **Step 2: Run** `node --test test/catalog-recover.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `recoverAdapter` and the `join` wiring. Keep `bin/wa.mjs` additions to a short call plus the outcome switch.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): wa join recovers an unknown server hash from the catalog (#126)`).

### Task 8: The daemon applies the adapter by itself in `auto` mode

**Files:**
- Modify: `src/wa-daemon.mjs` (initial connect catch at ~line 482; `watchLive` give-up path at ~line 175)
- Test: `test/wa-daemon-adapter-recovery.test.mjs` (use the fake pusher in `test/helpers/fake-pusher.mjs`, which can answer `NEW_VERSION`; see `test/wa-error-screen.test.mjs` for how it is driven)

**Interfaces:**
- Consumes: `recoverAdapter` (Task 7), `isVersionRejection` (`src/server-rejected.mjs`), `cfg.adapterUpdates`.
- Produces: a small helper `async function tryAdapterRecovery(): Promise<boolean>` inside the daemon: true only when `cfg.adapterUpdates === "auto"`, no explicit `cfg.version`, and `recoverAdapter({ mode: "auto", … })` returns `applied`; used (a) at initial connect: on a version rejection, if it returns true build a fresh client with `newClient()` and `connect()` once more, any second failure exits as today; (b) when the reconnect chain gives up with a version rejection: if it returns true, run `attemptReconnect()` once more before `shutdown(REFUSED_EXIT)`. At most one recovery per rejection (no loops).

- [ ] **Step 1: Write the failing test:** a fake pusher that rejects with `NEW_VERSION` until it sees the new hash in the `version` query parameter, plus a local catalog serving an adapter with that hash, run the daemon in `auto` mode (child process, env pointing at both): it joins. In `ask` mode the same setup exits with the refused code (4) and does not touch the cache.
- [ ] **Step 2: Run** the new test. Expected: FAIL.
- [ ] **Step 3: Implement** `tryAdapterRecovery` and the two call sites.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(daemon): auto mode applies a catalog adapter after a NEW_VERSION refusal (#126)`).

### Task 9: Seed the catalog

**Files:**
- Create: `catalog/index.json`, `catalog/adapters/<hash>.json` for the production hashes `23c8eb8c`, `b82fc568`, `62e25483`, `f4cfe455` and the staging hash `d2d82672` (protoFamily `wa-master`, server `staging`, version `master@118dd84c`)
- Create: `scripts/catalog-index.mjs`
- Test: `test/catalog-seed.test.mjs`

**Interfaces:**
- Consumes: `validateAdapterFile` (Task 1), built-in adapters.
- Produces: `node scripts/catalog-index.mjs [catalogDir]` rebuilds `index.json` from `adapters/*.json`: an `ok` entry per file (`server` from the file's `server` field, `version` from `waVersion`, `file` relative, `sha256` of the file bytes, `gate` null, `issue` null), **keeping** any existing entry that has `status: "needs-attention"` and no file, and setting `updated`. Each seed file has `protoFamily: "wa-1.34"` (`"wa-1.33"` is not seeded; the staging seed uses `"wa-master"`), `meeting`/`movement` copied from `wa-1.34`, and `id` like `wa-1.34.4`.

- [ ] **Step 1: Write the failing test:** every seed file validates; its hash is in `ADAPTERS[protoFamily].apiVersionHashes`; the index has exactly one entry per file with the right sha256 (recomputed in the test); running the index script into a temp copy of the catalog is idempotent apart from `updated`, and preserves a hand-added placeholder entry.
- [ ] **Step 2: Run** `node --test test/catalog-seed.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Write** `scripts/catalog-index.mjs`, the four adapter files, and run the script to generate `catalog/index.json`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(catalog): seed the catalog with the known prod hashes (#126)`).

### Task 10: Docs

**Files:**
- Modify: `docs/field-notes.md` ("When prod bumps" gets a short "With the catalog" paragraph above the manual procedure), `CLAUDE.md` (one line under Docs pointing at the design and this flow), `README.md` only if it documents `wa join` options.

- [ ] **Step 1: Write** the paragraph: what `wa join` now does on an unknown hash, the `adapterUpdates` setting and `WA_ADAPTER_UPDATES`, the cache path, `WA_CATALOG_URL`, and that the manual hash procedure remains the fallback until the watcher (plan 3) exists. Keep each fact where a reader of that section would look.
- [ ] **Step 2: Run `npm test` and `npm run scenarios`.** Expected: PASS.
- [ ] **Step 3: Commit** (`docs: catalog recovery for the CLI (#126)`).

---

## Self-review

- **Spec coverage (CLI half):** catalog format and seed (Tasks 1, 4, 9); reading the hash and release from the home page (3); consent, `ask`/`auto`/`never`, "always" persisting, no-terminal behaviour (5, 7); download, sha256, strict validation, cache, cached use next start (2, 4, 6); "no adapter yet" and "needs attention" messages (7); daemon `auto` path including mid-session (8); offline and failure behaviour (4, 7). **Not in this plan, by design:** Android flow, the watcher workflow and gate, `--adapter-file`, David's hook.
- **Type consistency:** `validateAdapterFile`/`buildAdapter` (1) are consumed unchanged by 2, 4, 9; `loadCached(hash, { dir, builtins })` (2) is the `cachedFor` source in 6; `recoverAdapter` (7) is the one entry used by `bin/wa.mjs` and the daemon (8); `Outcome.status` values are the same strings in 7 and 8.
- **Proportion:** ten tasks, one new directory, no new dependency; tests carry the assertions, code bodies are left to the implementer.
