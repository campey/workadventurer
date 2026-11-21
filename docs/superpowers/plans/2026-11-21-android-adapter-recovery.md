# Android adapter recovery (#188): implementation plan

Spec: `docs/superpowers/specs/2026-11-10-downloadable-adapters-design.md`, section 2 "Client side" (binding), plus
"Handshake parameters". The CLI side (#184) is the reference implementation: `src/catalog/*.mjs`, `docs/field-notes.md`
"With the catalog". Android must behave the same where the spec says so, with these Android-specific facts:

- Only the wa-1.33 proto is compiled in, so the app applies **only** an adapter's `apiVersionHash` and `handshake.query`.
  Rule: the app applies any `ok` catalog entry (that is what the watcher's gate means: `proto-diff` against wa-1.33 plus a
  Kotlin smoke with the hash passed); `protoFamily` is not a refusal reason on Android. It never reads `meeting` or
  `movement` numbers from a file (it has its own behaviour), and unknown fields stay ignored by the validator's whitelist.
- Pure-JVM code goes in `:protocol` (`app.workadventurer.protocol`), testable with `./gradlew :protocol:test` here
  (JDK 17 + Gradle; no Android SDK needed). UI and storage go in `:app` and are verified by the release workflow build.
- Nothing in `android/` may reach outside `android/` (android/CLAUDE.md). The catalog URL is a constant with a build-time
  override, not read from `../catalog`.

## Global constraints (reviewers check these)

- Catalog fetch: default `https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json`; index <= 1 MiB,
  adapter file <= 64 KiB, any 3xx is a failure (no redirects followed), the file URL must be same-origin as the index and
  under the index's directory, sha256 over the raw bytes must match the index entry, the file's `apiVersionHash` must equal
  its index key, `schema` must be 1, `server`/`status` known, handshake query validated exactly like the Node validator
  (<= 12 params, names `^[A-Za-z][A-Za-z0-9]{0,31}$`, values <= 64 chars of `[A-Za-z0-9._:{}-]`, placeholders `{tabId}` and
  `{uuid}` only, forbidden names roomId / version / characterTextureIds / token, compared case-insensitively, never
  overriding a parameter the client already sends). Any fetch/validation failure = "unavailable" = behave as today.
- Consent: preference `ask | auto | never` (default `ask`); "Don't ask again" persists `auto`; no download without consent;
  consent fails closed. Reading the home page and the small index is not a download.
- A built-in hash always wins over the catalog. The catalog is consulted only after a typed NEW_VERSION refusal.
- Recovery runs at most once per refusal (no retry storm); after a refusal that persists with the applied adapter the
  user sees the original message, never a loop.
- Hostile catalog data must not crash the app, change anything but hash + handshake query, or put unsanitised text in the
  UI (cap and strip control characters from `gate` text before display).
- The adapter cache is the app's private files dir; a corrupt cache file is ignored and overwritten.

## Tasks

### Task 1: typed NEW_VERSION refusal and handshake query (`:protocol`)

- `PusherConnection`: keep the `ErrorScreenMessage` `code`; a refusal whose code (or type, whichever the server uses;
  check `docs/field-notes.md`, `src/server-rejected.mjs` and the fake pusher) means NEW_VERSION is thrown as a
  `NewVersionRefused : JoinFailed` carrying the message text. Other error screens stay plain `JoinFailed`.
- `RoomConfig`: `handshakeQuery: Map<String, String> = emptyMap()`; `wsUrl` appends it with the same rules as Node
  `_wsUrl()` (never overrides a client parameter, forbidden names dropped case-insensitively, `{tabId}`/`{uuid}`
  substituted per connection).
- Tests (`:protocol:test`, MockWebServer): refusal typed; other error screens not; handshake params appended, never
  overriding, substituted, forbidden dropped; `wsUrl` unchanged when the map is empty.

### Task 2: catalog module and `recoverAdapter` (`:protocol`, pure JVM)

- `catalog/` package: `ServerVersion.read(roomUrl)` (home page, `<meta name="wa-api-version" content="<8 hex>">` and
  release string, size/time capped), `CatalogClient` (index + adapter file per the constraints above), `AdapterStore`
  interface plus a file implementation (atomic write, never throws on read, ignores a corrupt file), and
  `recoverAdapter(roomUrl, mode, ask, onAlways, ...)` returning `Unavailable | Known | NoEntry | NeedsAttention(hash, detail) | Never |
  Declined | Applied(hash, handshakeQuery, waVersion)` — mirror `src/catalog/recover.mjs` outcomes.
- HTTP through the OkHttp client already used by `:protocol` (injected, so tests use MockWebServer).
- Tests: every outcome; each failure mode (404, timeout, 3xx, oversize, bad sha256, hash mismatch, wrong schema, cross-origin
  file, bad handshake names/values, forbidden names, corrupt cache); consent fails closed; built-in hash wins;
  `gate` text sanitised and capped.

### Task 3: session wiring and UI (`:app`)

- `WaSession.run`: on `NewVersionRefused` with no earlier success (and, once, after an earlier success), call an injected
  `AdapterRecovery` port; `Applied` -> rebuild `RoomConfig` with the hash and handshake query and retry once;
  other outcomes -> `Connection.Failed` with a specific message (no entry yet / needs attention / unsupported / never /
  declined / unavailable), not the generic refresh text. New `Connection` state `NeedsConsent(info)` for the dialog.
- UI: a dialog with **Download** (apply once), **Don't ask again** (persist `auto`, apply) and **Cancel**; Settings entry
  for the preference (ask/auto/never); storage in SharedPreferences; the cache in the app's private files dir; the
  catalog URL a `BuildConfig` constant with a debug-only override.
- Unit tests for `WaSession` with a fake recovery port (JVM tests under `:app` as the existing `WaSessionTest`); the UI
  itself is checked by the release workflow build.

### Task 4: docs and test APK

- `android/docs/field-notes.md`: how recovery works, how to test it (point `WA_CATALOG_URL`-equivalent at a local server,
  fake pusher), what the app does not apply (behaviour numbers, other proto families).
- `docs/field-notes.md` "With the catalog": one paragraph that Android now does the same.
- Build a test APK with the Android release workflow (manual run, no publish) from the branch.

## Order and dependencies

1 -> 2 -> 3 -> 4. Tasks 1 and 2 are testable in this container with `./gradlew :protocol:test`; Task 3's UI is verified
by CI and by the APK.

## Risks and open questions

- The exact `ErrorScreenMessage` code for a stale hash on the Android pusher path (confirm from field notes / live).
- `:app` UI cannot be compiled here without the Android SDK; the release workflow is the compile check. Keep the UI layer
  thin and the logic in testable classes.
- Hash-only adapters for wa-1.34 are applied to the wa-1.33 wire; if a server change breaks the wire, the join fails and
  the user sees the original refusal. The watcher's gate (proto-diff vs wa-1.33 plus Kotlin smoke with the hash) is what
  keeps that rare.
